import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, deviceFp } from '../../lib/api';
import { BusyButton, useShowError, useToast } from '../../components/ui';

export const Route = createFileRoute('/app/signup')({
  component: SignupPage,
});

const COUNTRIES = [
  ['NG', 'Nigeria'],
  ['KE', 'Kenya'],
  ['IN', 'India'],
  ['PH', 'Philippines'],
  ['ID', 'Indonesia'],
  ['GH', 'Ghana'],
  ['ZA', 'South Africa'],
  ['UG', 'Uganda'],
  ['TZ', 'Tanzania'],
  ['US', 'United States'],
] as const;

type Step = 'phone' | 'code' | 'profile' | 'done';

function SignupPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const showError = useShowError();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [err, setErr] = useState('');
  const [err2, setErr2] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [creating, setCreating] = useState(false);
  const [triesLeft, setTriesLeft] = useState(5);
  const [resendIn, setResendIn] = useState(0);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('NG');
  const [welcome, setWelcome] = useState('');
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const resendTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    document.title = 'Sign up — KudiWatch';
    return () => {
      if (resendTimer.current) clearInterval(resendTimer.current);
    };
  }, []);

  const startResendCooldown = (sec: number) => {
    if (resendTimer.current) clearInterval(resendTimer.current);
    setResendIn(sec);
    resendTimer.current = setInterval(() => {
      setResendIn((left) => {
        if (left <= 1) {
          if (resendTimer.current) clearInterval(resendTimer.current);
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };

  const sendCode = async () => {
    const p = phoneInput.trim();
    if (!/^\+\d{7,15}$/.test(p)) {
      setErr('Use international format, e.g. +2348012345678.');
      return;
    }
    setErr('');
    setSending(true);
    try {
      const data = await api<{ dev_code?: string; resend_after_s?: number }>('POST', '/v1/auth/otp/request', {
        phone_e164: p,
      });
      setPhone(p);
      setDevCode(data.dev_code || null);
      setStep('code');
      startResendCooldown(data.resend_after_s || 60);
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    } catch (e: any) {
      setErr(e?.message || 'Could not send code.');
    }
    setSending(false);
  };

  const code = digits.join('');

  const verify = async () => {
    if (code.length !== 6) {
      setErr2('Enter all 6 digits.');
      return;
    }
    setErr2('');
    setVerifying(true);
    try {
      const data = await api<{ new_user: boolean }>('POST', '/v1/auth/otp/verify', {
        phone_e164: phone,
        code,
        display_name: '',
        country_code: 'NG',
        device: { fingerprint: deviceFp(), user_agent: navigator.userAgent, platform: navigator.platform },
      });
      if (data.new_user) setStep('profile');
      else navigate({ to: '/app' });
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'otp_mismatch') {
        const m = /(\d+) tries? left/.exec(e.message);
        setTriesLeft(m ? Number(m[1]) : Math.max(0, triesLeft - 1));
        setErr2(e.message);
      } else if (e instanceof ApiError && e.code === 'otp_locked') {
        setErr2('Too many tries. Wait 1 hour, then request a new code.');
      } else {
        setErr2(e?.message || 'Verification failed.');
      }
    }
    setVerifying(false);
  };

  const create = async () => {
    if (!name.trim()) {
      toast('Tell us what to call you.', 'warn');
      return;
    }
    setCreating(true);
    try {
      await api('PATCH', '/v1/me', { display_name: name.trim(), country_code: country });
      const me = await api<{ user: { display_name: string } }>('GET', '/v1/me');
      setWelcome(`Welcome, ${me.user.display_name}.`);
      setStep('done');
    } catch (e: any) {
      showError(e?.message || 'Could not create account.', e?.requestId);
    }
    setCreating(false);
  };

  const setDigit = (i: number, v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = d;
      return next;
    });
    if (d && i < 5) setTimeout(() => inputRefs.current[i + 1]?.focus(), 0);
  };

  const onPaste = (i: number, e: React.ClipboardEvent) => {
    const t = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!t) return;
    e.preventDefault();
    setDigits((prev) => {
      const next = [...prev];
      t.split('').forEach((ch, j) => {
        if (i + j < 6) next[i + j] = ch;
      });
      return next;
    });
    const last = Math.min(5, i + t.length - 1);
    setTimeout(() => inputRefs.current[last]?.focus(), 0);
  };

  return (
    <div className="wrap">
      {step === 'phone' && (
        <div>
          <h1>Enter your phone number</h1>
          <p>
            We use your phone number to keep things fair — one person, one account. We never sell your number, and
            we never share it with advertisers.
          </p>
          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            placeholder="+2348012345678"
            autoComplete="tel"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
          />
          <p className="hint">International format, starting with +.</p>
          <BusyButton className="btn primary" busy={sending} busyLabel="Sending…" onClick={sendCode}>
            Send code
          </BusyButton>
          {err && <div className="banner err">{err}</div>}
        </div>
      )}

      {step === 'code' && (
        <div>
          <h1>Enter your code</h1>
          <p>We sent a 6-digit code to {phone}. It expires in 10 minutes.</p>
          {devCode && (
            <div className="banner warn">
              <span>
                Demo build — your code is <strong className="mono">{devCode}</strong>. Real builds send it by SMS.
              </span>
            </div>
          )}
          <div className="otp-row" role="group" aria-label="6-digit code">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputRefs.current[i] = el;
                }}
                inputMode="numeric"
                maxLength={1}
                aria-label={`Digit ${i + 1}`}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Backspace' && !d && i > 0) inputRefs.current[i - 1]?.focus();
                }}
                onPaste={(e) => onPaste(i, e)}
              />
            ))}
          </div>
          {err2 && <div className="banner err">{err2}</div>}
          <BusyButton className="btn primary" busy={verifying} busyLabel="Verifying…" onClick={verify}>
            Verify
          </BusyButton>
          <p>
            <button className="btn ghost" disabled={resendIn > 0} onClick={sendCode}>
              {resendIn > 0 ? `Resend code in 0:${String(resendIn).padStart(2, '0')}` : 'Resend code'}
            </button>
          </p>
        </div>
      )}

      {step === 'profile' && (
        <div>
          <h1>Tell us about you</h1>
          <label htmlFor="name">What should we call you?</label>
          <input id="name" type="text" placeholder="e.g. Adaeze" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="country">Country</label>
          <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <label htmlFor="lang">Language</label>
          <select id="lang" disabled>
            <option>English for now. More languages are coming.</option>
          </select>
          <p className="small">
            By creating an account you agree to watch videos honestly — one account per person, no tricks. Accounts
            that cheat are removed.
          </p>
          <BusyButton className="btn primary" busy={creating} busyLabel="Creating…" onClick={create}>
            Create account
          </BusyButton>
        </div>
      )}

      {step === 'done' && (
        <div>
          <h1>{welcome}</h1>
          <p>Here&apos;s how earning works:</p>
          <ol>
            <li>Pick a video and watch it all the way through.</li>
            <li>Answer a quick check to prove you watched.</li>
            <li>Get paid — $0.01 to $0.03 per video, straight to your balance.</li>
          </ol>
          <p className="small">No fees to join. Watching is always free. We will never ask for your bank password.</p>
          <button className="btn primary" onClick={() => navigate({ to: '/app' })}>
            Find videos
          </button>
        </div>
      )}
    </div>
  );
}
