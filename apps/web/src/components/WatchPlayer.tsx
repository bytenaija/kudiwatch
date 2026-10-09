// WatchPlayer — hardened HTML5 player, React port of public/js/player.js.
// FAITHFUL PORT: 1x rate lock, seek clamp (no forward-skip past verified
// position), tab-visibility pause, 10s heartbeat sequencing, server-scheduled
// attention overlays (tap + quiz), verified-segments progress bar.
// This is part of the anti-fraud trust chain — the security logic below must
// stay behavior-identical to the original. Only DOM manipulation was adapted
// to React state (via the UiSink interface).

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { OfflineQ, api, fmtTime, money, moneyA11y, type AttentionCheck, type ClaimResponse } from '../lib/api';
import { useToast } from './ui';

interface ChecklistItem {
  done: boolean;
  label: string;
}

interface AttentionState {
  chk: AttentionCheck;
  dueInS: number;
  payload: any;
}

interface CompleteData {
  status: string;
  credited_cents: number;
  receipt: { attention_score: number; watched_pct: number };
  reason?: string;
  message?: string;
}

/** React-side rendering sink for the player core (replaces barEls DOM handles). */
interface UiSink {
  setIntervals(iv: Array<[number, number]>): void;
  setPosition(pos: number): void;
  setChecklist(items: ChecklistItem[]): void;
  setHidden(show: boolean): void;
  setAttention(a: AttentionState | null): void;
  onDone(data: CompleteData): void;
  onFail(reason: string, message: string): void;
  toast(msg: string, kind?: 'info' | 'warn' | 'err'): void;
}

export class PlayerCore {
  private sid: string;
  private video: HTMLVideoElement;
  private streamUrl: string;
  private checks: AttentionCheck[];
  private ui: UiSink;
  duration: number;
  private seq = 0;
  private maxPos = 0;
  private intervals: Array<[number, number]> = [];
  private answered = new Set<string>();
  private presented = new Map<string, number>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private failed = false;
  private destroyed = false;
  private bufferingS = 0;
  private bufferStart: number | null = null;

  constructor(opts: {
    sessionId: string;
    videoEl: HTMLVideoElement;
    streamUrl: string;
    checks: AttentionCheck[];
    duration: number;
    ui: UiSink;
  }) {
    this.sid = opts.sessionId;
    this.video = opts.videoEl;
    this.streamUrl = opts.streamUrl;
    this.checks = opts.checks || [];
    this.duration = opts.duration || 60;
    this.ui = opts.ui;
  }

  // ---- lifecycle ---------------------------------------------------------

  async start() {
    const v = this.video;
    v.src = this.streamUrl;
    v.preload = 'metadata';
    (v as HTMLVideoElement & { controlsList?: string }).controlsList = 'nodownload';
    v.disablePictureInPicture = true;
    v.setAttribute('controlsList', 'nodownload');

    v.addEventListener('ratechange', this.onRateChange);
    v.addEventListener('seeking', this.onSeeking);
    v.addEventListener('contextmenu', this.onContextMenu);
    v.addEventListener('timeupdate', this.onTimeUpdate);
    v.addEventListener('ended', this.onEnded);
    v.addEventListener('waiting', this.onWaiting);
    v.addEventListener('playing', this.onPlaying);
    v.addEventListener('keydown', this.onKeydown);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);

    this.hbTimer = setInterval(() => {
      this.heartbeat(false).catch(() => {});
    }, 10_000);
    this.updateChecklist();
    try {
      await v.play();
    } catch {
      /* user gesture needed */
    }
    // First heartbeat shortly after start so the session is alive server-side.
    setTimeout(() => {
      if (!this.destroyed) this.heartbeat(false).catch(() => {});
    }, 2000);
  }

  destroy() {
    this.destroyed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    const v = this.video;
    v.removeEventListener('ratechange', this.onRateChange);
    v.removeEventListener('seeking', this.onSeeking);
    v.removeEventListener('contextmenu', this.onContextMenu);
    v.removeEventListener('timeupdate', this.onTimeUpdate);
    v.removeEventListener('ended', this.onEnded);
    v.removeEventListener('waiting', this.onWaiting);
    v.removeEventListener('playing', this.onPlaying);
    v.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
  }

  /** User-initiated abort (skip): stop everything without completing. */
  abort() {
    this.failed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.video.pause();
  }

  toggle() {
    const v = this.video;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  // ---- event handlers (bound fields so destroy() can remove them) ---------

  private onRateChange = () => {
    const v = this.video;
    if (v.playbackRate !== 1) {
      v.playbackRate = 1; // force back; the heartbeat will carry the deviation
      v.pause();
      this.ui.toast('Speed is locked at 1× — faster playback doesn\u2019t count.', 'warn');
    }
  };

  private onSeeking = () => {
    const v = this.video;
    if (v.currentTime > this.maxPos + 0.5) {
      v.currentTime = this.maxPos; // clamp forward seeks
    }
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private onTimeUpdate = () => {
    const v = this.video;
    const pos = v.currentTime;
    if (pos > this.maxPos) this.maxPos = pos;
    this.ui.setPosition(pos);
    this.updateChecklist();
    // Due attention checks → pause + present.
    for (const chk of this.checks) {
      if (this.answered.has(chk.id) || this.presented.has(chk.id)) continue;
      if (pos >= chk.scheduled_at_s) this.presentCheck(chk);
    }
  };

  private onEnded = () => {
    this.finish();
  };

  private onWaiting = () => {
    this.bufferStart = performance.now();
  };

  private onPlaying = () => {
    if (this.bufferStart) {
      this.bufferingS += (performance.now() - this.bufferStart) / 1000;
      this.bufferStart = null;
    }
  };

  private onKeydown = (e: KeyboardEvent) => {
    const v = this.video;
    if (e.key === ' ' || e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'ArrowRight') {
      v.currentTime = Math.min(this.maxPos, v.currentTime + 5);
    } else if (e.key === 'ArrowLeft') {
      v.currentTime = Math.max(0, v.currentTime - 5);
    } else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else v.requestFullscreen?.();
    } else if (e.key === 'm' || e.key === 'M') {
      v.muted = !v.muted;
    }
  };

  private onVisibility = () => {
    if (document.hidden) {
      this.video.pause();
      this.ui.setHidden(true);
      // Immediate heartbeat: visible=false (zero credit for hidden intervals).
      this.heartbeat(true).catch(() => {});
    } else {
      this.ui.setHidden(false);
    }
  };

  private onPageHide = () => {
    // Final beat via beacon (fire-and-forget).
    try {
      const blob = new Blob(
        [
          JSON.stringify({
            seq: this.seq + 1,
            position_s: this.video.currentTime,
            visible: false,
            playback_rate: 1,
            client_ts: Date.now() / 1000,
          }),
        ],
        { type: 'application/json' },
      );
      navigator.sendBeacon(`/v1/watch/${this.sid}/heartbeat`, blob);
    } catch {
      /* noop */
    }
  };

  // ---- protocol -----------------------------------------------------------

  async heartbeat(forceHidden: boolean) {
    if (this.failed || this.destroyed) return;
    const v = this.video;
    this.seq += 1;
    const payload = {
      seq: this.seq,
      position_s: Math.round(v.currentTime * 10) / 10,
      visible: forceHidden ? false : !document.hidden,
      playback_rate: v.playbackRate || 1,
      client_ts: Date.now() / 1000,
      buffering_s: Math.round(this.bufferingS * 10) / 10,
    };
    this.bufferingS = 0;
    let data: any;
    try {
      data = await api('POST', `/v1/watch/${this.sid}/heartbeat`, payload);
    } catch {
      // Offline → queue the beat; the bar keeps local state.
      await OfflineQ.push({ kind: 'heartbeat', sid: this.sid, payload });
      return;
    }
    if (!data.ok) {
      if (data.reject_code === 'attention_timeout') {
        this.failSession('attention_timeout', 'The attention check wasn\u2019t answered in time.');
      } else if (data.reject_code && data.reject_code.startsWith('session_')) {
        this.failSession(data.reject_code, 'This watch is no longer active.');
      }
      // Other rejections (dup_seq etc.) are logged server-side; keep playing.
      return;
    }
    if (Array.isArray(data.intervals)) {
      this.intervals = data.intervals;
      this.ui.setIntervals(data.intervals);
    }
    this.updateChecklist(data.watched_pct);
  }

  async presentCheck(chk: AttentionCheck) {
    this.video.pause();
    let data: any;
    try {
      data = await api('POST', `/v1/watch/${this.sid}/attention`, { check_id: chk.id });
    } catch (e: any) {
      this.ui.toast(`Could not load the attention check.${e?.requestId ? ` (Ref: ${String(e.requestId).slice(0, 8)})` : ''}`, 'err');
      this.video.play().catch(() => {});
      return;
    }
    if (!data.presented) return;
    this.presented.set(chk.id, Date.now() + data.due_in_s * 1000);
    this.ui.setAttention({ chk, dueInS: data.due_in_s || 15, payload: data.payload });
    this.updateChecklist();
  }

  async answerCheck(chk: AttentionCheck, choiceIdx?: number) {
    const body: any = { check_id: chk.id };
    if (chk.type === 'quiz') body.response = { choice_idx: choiceIdx };
    else body.response = {};
    let data: any;
    try {
      data = await api('POST', `/v1/watch/${this.sid}/attention`, body);
    } catch (e: any) {
      this.ui.toast(`Could not send your answer.${e?.requestId ? ` (Ref: ${String(e.requestId).slice(0, 8)})` : ''}`, 'err');
      return;
    }
    this.ui.setAttention(null);
    this.presented.delete(chk.id);
    if (data.passed) {
      this.answered.add(chk.id);
      this.ui.toast('Checked — keep watching.');
      this.video.play().catch(() => {});
    } else {
      this.failSession(
        'attention_failed',
        chk.type === 'quiz'
          ? 'That answer wasn\u2019t right. No money was added — that\u2019s the rule for everyone.'
          : 'The attention check wasn\u2019t answered in time. No money was added — that\u2019s the rule for everyone.',
      );
    }
    this.updateChecklist();
  }

  async finish() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    // Final heartbeat at the ended position, then complete.
    await this.heartbeat(false).catch(() => {});
    let data: CompleteData;
    try {
      data = await api<CompleteData>('POST', `/v1/watch/${this.sid}/complete`, {});
    } catch (e: any) {
      this.ui.onFail('complete_error', e?.message || 'Could not complete.');
      return;
    }
    if (data.status === 'completed') this.ui.onDone(data);
    else this.ui.onFail(data.reason || 'failed', data.message || 'This watch did not count.');
  }

  private failSession(reason: string, message: string) {
    if (this.failed) return;
    this.failed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.video.pause();
    this.ui.setAttention(null);
    this.ui.onFail(reason, message);
  }

  private updateChecklist(pct?: number) {
    const watchedPct =
      pct ?? (this.intervals.reduce((s, [a, b]) => s + (b - a), 0) / (this.duration || 1)) * 100;
    const checksDone = this.checks.length === 0 || this.checks.every((c) => this.answered.has(c.id));
    const checkDue = this.checks.some(
      (c) => !this.answered.has(c.id) && this.video.currentTime >= c.scheduled_at_s - 5,
    );
    this.ui.setChecklist([
      {
        done: watchedPct >= 90,
        label: watchedPct >= 90 ? 'Watched 90% of the video' : 'Watch 90% of the video',
      },
      {
        done: checksDone,
        label: checksDone
          ? 'Attention check passed'
          : checkDue
            ? 'Attention check — due soon'
            : 'Attention check — coming up',
      },
      {
        done: !document.hidden,
        label: document.hidden ? 'This tab is hidden — paused' : 'Keep this tab visible',
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// React view
// ---------------------------------------------------------------------------

function AttentionModal({
  attention,
  onAnswer,
  onTimeout,
}: {
  attention: AttentionState;
  onAnswer: (choiceIdx?: number) => void;
  onTimeout: () => void;
}) {
  const [left, setLeft] = useState(attention.dueInS);
  const timeoutRef = useRef(onTimeout);
  timeoutRef.current = onTimeout;
  useEffect(() => {
    const deadline = Date.now() + attention.dueInS * 1000;
    const t = setInterval(() => {
      const l = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        timeoutRef.current();
      }
    }, 250);
    return () => clearInterval(t);
  }, [attention.dueInS]);

  const { chk, payload } = attention;
  const isQuiz = chk.type === 'quiz';
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label="Attention check">
      <div className="box">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{isQuiz ? 'Quick question about the video' : 'Quick check — are you still watching?'}</h3>
          <span className="count-ring" aria-live="polite">
            {left}
          </span>
        </div>
        {isQuiz ? (
          <p>
            <strong>{payload?.q || ''}</strong>
          </p>
        ) : (
          <p>Answer within 15 seconds to keep earning.</p>
        )}
        <div>
          {isQuiz ? (
            (payload?.choices || []).map((ch: string, i: number) => (
              <button key={i} className="method-card" style={{ minHeight: 48 }} onClick={() => onAnswer(i)} autoFocus={i === 0}>
                <span>{ch}</span>
              </button>
            ))
          ) : (
            <button className="btn primary" onClick={() => onAnswer()} autoFocus>
              I&apos;m watching
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function WatchPlayerView({ claim, sessionId }: { claim: ClaimResponse; sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const coreRef = useRef<PlayerCore | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const [intervals, setIntervals] = useState<Array<[number, number]>>([]);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(claim.video?.duration_s || 60);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [hidden, setHidden] = useState(false);
  const [attention, setAttention] = useState<AttentionState | null>(null);
  const [done, setDone] = useState<CompleteData | null>(null);
  const [failMsg, setFailMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const streamUrl = `${claim.stream_url}?wt=${encodeURIComponent(claim.watch_token)}`;
  const cp = claim.campaign || {};

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    const ui: UiSink = {
      setIntervals,
      setPosition,
      setChecklist,
      setHidden,
      setAttention,
      onDone: (d) => {
        if (!cancelled) setDone(d);
      },
      onFail: (_reason, message) => {
        if (!cancelled) setFailMsg(message || 'This watch did not count.');
      },
      toast,
    };

    // Duration probe (mirrors watch.html): metadata, else claim, else 60s.
    const probe = new Promise<number>((resolve) => {
      const onMeta = () => resolve(video.duration || claim.video?.duration_s || 60);
      video.addEventListener('loadedmetadata', onMeta, { once: true });
      video.src = streamUrl;
      setTimeout(() => resolve(video.duration || claim.video?.duration_s || 60), 5000);
    });

    probe.then((dur) => {
      if (cancelled) return;
      setDuration(dur);
      const core = new PlayerCore({
        sessionId,
        videoEl: video,
        streamUrl,
        checks: claim.checks || [],
        duration: dur,
        ui,
      });
      coreRef.current = core;
      core.start();
    });

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      cancelled = true;
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      coreRef.current?.destroy();
      coreRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchedPct = duration ? (intervals.reduce((s: number, [a, b]: [number, number]) => s + (b - a), 0) / duration) * 100 : 0;

  return (
    <div>
      <div id="meta">
        <h2 style={{ marginBottom: 4 }}>{cp.title || 'Video'}</h2>
        <p className="small" style={{ margin: 0 }}>
          Paid ad · Earn {money(cp.price_per_view_cents || 0)} when you finish
        </p>
      </div>

      <div className="stage" id="stage">
        <video ref={videoRef} playsInline preload="metadata" aria-label="Advertisement video" tabIndex={0} />
        <div className={`overlay${hidden ? ' show' : ''}`} role="alert">
          <div>
            <div style={{ fontSize: 40 }} aria-hidden="true">
              ⏸
            </div>
            <h3 style={{ color: '#fff' }}>Paused — this tab is hidden</h3>
            <p style={{ color: '#ddd' }}>Watching doesn&apos;t count while the tab is hidden. Come back to keep earning.</p>
            <button
              className="btn primary"
              style={{ maxWidth: 280, margin: '0 auto' }}
              onClick={() => videoRef.current?.play().catch(() => {})}
            >
              Resume watching
            </button>
          </div>
        </div>
        <div className={`overlay${done ? ' show' : ''}`}>
          <div style={{ width: '100%' }}>
            {done && (
              <div className="flash" style={{ borderRadius: 12, padding: 8 }}>
                <div className="money" style={{ fontSize: 28, color: 'var(--gold)' }} aria-label={`${moneyA11y(done.credited_cents)} added`}>
                  +{money(done.credited_cents)}
                </div>
                <p style={{ color: '#fff', margin: '4px 0' }}>added to your balance</p>
                <p className="small" style={{ color: '#ddd' }}>
                  Attention score: {done.receipt.attention_score}% · Watched: {done.receipt.watched_pct}%
                </p>
                <div className="row" style={{ justifyContent: 'center' }}>
                  <Link className="btn secondary" to="/app/earnings">
                    View receipt
                  </Link>
                  <Link className="btn primary" to="/app" style={{ width: 'auto' }}>
                    Next video
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className={`overlay${failMsg ? ' show' : ''}`}>
          <div>
            <h3 style={{ color: '#fff' }}>This watch didn&apos;t count.</h3>
            <p style={{ color: '#ddd' }}>{failMsg}</p>
            <Link className="btn primary" to="/app" style={{ maxWidth: 280, margin: '0 auto' }}>
              Back to videos
            </Link>
          </div>
        </div>
      </div>

      <div className="transport">
        <button
          className="tbtn"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            coreRef.current?.toggle();
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <span className="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {fmtTime(position)} / {fmtTime(duration)}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="lockbadge" title="Faster playback doesn't count. Everyone watches at normal speed.">
          🔒 1× — speed locked
        </span>
        <button
          className="tbtn"
          aria-label="Fullscreen"
          onClick={() => {
            const st = document.getElementById('stage');
            if (document.fullscreenElement) document.exitFullscreen();
            else (st as any)?.requestFullscreen?.();
          }}
        >
          ⛶
        </button>
      </div>

      <div
        className="segbar"
        role="progressbar"
        aria-label="Verified watched progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(watchedPct)}
        aria-valuetext={`${Math.round(watchedPct)} percent verified`}
      >
        {intervals.map(([a, b], i) => (
          <i
            key={i}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${(a / duration) * 100}%`,
              width: `${((b - a) / duration) * 100}%`,
              background: 'var(--primary)',
              borderRadius: 999,
            }}
          />
        ))}
        <div className="ph" style={{ left: `${(position / (duration || 1)) * 100}%` }} />
        <div className="touch" />
      </div>

      <ul className="checklist" aria-live="polite">
        {checklist.map((item, i) => (
          <li key={i} className={item.done ? 'done' : ''}>
            <span className="ic" aria-hidden="true">
              {item.done ? '✓' : ''}
            </span>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>

      <div className="between" style={{ marginTop: 8 }}>
        <button
          className="btn ghost"
          onClick={() => {
            if (!window.confirm('Skip this video? Skipped videos can come back after 24 hours. You won\u2019t earn for this one.'))
              return;
            coreRef.current?.abort();
            navigate({ to: '/app' });
          }}
        >
          Skip video
        </button>
        <span className="tiny mono">sid {sessionId.slice(0, 8)}…</span>
      </div>

      {attention && (
        <AttentionModal
          attention={attention}
          onAnswer={(choiceIdx) => coreRef.current?.answerCheck(attention.chk, choiceIdx)}
          onTimeout={() => coreRef.current?.answerCheck(attention.chk)}
        />
      )}
    </div>
  );
}
