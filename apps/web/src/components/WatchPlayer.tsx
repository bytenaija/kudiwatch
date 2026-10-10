// WatchPlayer — YouTube IFrame player with the hardened PlayerCore.
// FAITHFUL PORT of the anti-fraud trust chain (was HTML5 <video>, now a
// driver abstraction over the YouTube IFrame Player API, decision #39):
// 1x rate lock, seek clamp (no forward-skip past verified position),
// tab-visibility pause, 10s heartbeat sequencing, server-scheduled attention
// overlays (tap + quiz), verified-segments progress bar.
// The security logic in PlayerCore is player-agnostic — only DOM manipulation
// was adapted to React state (via the UiSink interface).

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

/** React-side rendering sink for the player core. */
interface UiSink {
  setIntervals(iv: Array<[number, number]>): void;
  setPosition(pos: number): void;
  setDuration(d: number): void;
  setChecklist(items: ChecklistItem[]): void;
  setHidden(show: boolean): void;
  setAttention(a: AttentionState | null): void;
  onDone(data: CompleteData): void;
  onFail(reason: string, message: string): void;
  toast(msg: string, kind?: 'info' | 'warn' | 'err'): void;
}

/**
 * PlayerDriver — the minimal surface PlayerCore needs. The YouTube IFrame
 * player implements it; tests inject a fake. PlayerCore never touches the
 * DOM video element or the YT API directly.
 */
export interface PlayerDriver {
  /** Build the player inside container for videoId. Resolves with the player's ground-truth duration. */
  init(container: HTMLElement, videoId: string): Promise<number>;
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  getPosition(): number;
  getRate(): number;
  seekTo(s: number): void;
  setRate(r: number): void;
  onTick(cb: (pos: number) => void): void;
  onRateChange(cb: () => void): void;
  onEnded(cb: () => void): void;
  onError(cb: (code: number | string) => void): void;
  destroy(): void;
}

let ytApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window !== 'undefined' && window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise<void>((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('yt_api_load_failed'));
      const first = document.getElementsByTagName('script')[0];
      if (first?.parentNode) first.parentNode.insertBefore(tag, first);
      else document.head.appendChild(tag);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve();
      };
      setTimeout(() => reject(new Error('yt_api_load_timeout')), 15000);
    });
  }
  return ytApiPromise;
}

/** YouTube IFrame Player API implementation of PlayerDriver. */
export class YouTubeDriver implements PlayerDriver {
  private player: YT.Player | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCb: ((pos: number) => void) | null = null;
  private rateCb: (() => void) | null = null;
  private endedCb: (() => void) | null = null;
  private errorCb: ((code: number | string) => void) | null = null;
  private bufferStart: number | null = null;
  bufferingS = 0;

  async init(container: HTMLElement, videoId: string): Promise<number> {
    await loadYouTubeApi();
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      try {
        this.player = new window.YT!.Player(container, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            controls: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            disablekb: 1,
            iv_load_policy: 3,
            fs: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              const d = e.target.getDuration();
              this.tickTimer = setInterval(() => {
                if (this.player && this.tickCb) {
                  try {
                    this.tickCb(this.player.getCurrentTime());
                  } catch {
                    /* player gone */
                  }
                }
              }, 500);
              done(() => resolve(d));
            },
            onStateChange: (e) => {
              if (e.data === YT.PlayerState.ENDED && this.endedCb) this.endedCb();
              else if (e.data === YT.PlayerState.BUFFERING) this.bufferStart = performance.now();
              else if (e.data === YT.PlayerState.PLAYING && this.bufferStart) {
                this.bufferingS += (performance.now() - this.bufferStart) / 1000;
                this.bufferStart = null;
              }
            },
            onPlaybackRateChange: () => {
              if (this.rateCb) this.rateCb();
            },
            onError: (e) => {
              if (!settled) done(() => reject(new Error(`yt_error_${e.data}`)));
              else if (this.errorCb) this.errorCb(e.data);
            },
          },
        });
      } catch (err) {
        done(() => reject(err instanceof Error ? err : new Error('yt_init_failed')));
      }
      setTimeout(() => done(() => reject(new Error('yt_ready_timeout'))), 20000);
    });
  }

  play() {
    try {
      this.player?.playVideo();
    } catch {
      /* noop */
    }
  }
  pause() {
    try {
      this.player?.pauseVideo();
    } catch {
      /* noop */
    }
  }
  isPlaying(): boolean {
    try {
      return this.player?.getPlayerState() === YT.PlayerState.PLAYING;
    } catch {
      return false;
    }
  }
  getPosition(): number {
    try {
      return this.player?.getCurrentTime() ?? 0;
    } catch {
      return 0;
    }
  }
  getRate(): number {
    try {
      return this.player?.getPlaybackRate() ?? 1;
    } catch {
      return 1;
    }
  }
  seekTo(s: number) {
    try {
      this.player?.seekTo(Math.max(0, s), true);
    } catch {
      /* noop */
    }
  }
  setRate(r: number) {
    try {
      this.player?.setPlaybackRate(r);
    } catch {
      /* noop */
    }
  }
  onTick(cb: (pos: number) => void) {
    this.tickCb = cb;
  }
  onRateChange(cb: () => void) {
    this.rateCb = cb;
  }
  onEnded(cb: () => void) {
    this.endedCb = cb;
  }
  onError(cb: (code: number | string) => void) {
    this.errorCb = cb;
  }
  destroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    try {
      this.player?.destroy();
    } catch {
      /* noop */
    }
    this.player = null;
  }
}

export class PlayerCore {
  private sid: string;
  private driver: PlayerDriver;
  private checks: AttentionCheck[];
  private ui: UiSink;
  duration: number;
  private playerDuration: number | null = null;
  private beatsSent = 0;
  private seq = 0;
  private maxPos = 0;
  private lastTickTs: number | null = null;
  private intervals: Array<[number, number]> = [];
  private answered = new Set<string>();
  private presented = new Map<string, number>();
  private presentFailed = new Set<string>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private failed = false;
  private destroyed = false;

  constructor(opts: {
    sessionId: string;
    driver: PlayerDriver;
    checks: AttentionCheck[];
    duration: number;
    ui: UiSink;
  }) {
    this.sid = opts.sessionId;
    this.driver = opts.driver;
    this.checks = opts.checks || [];
    this.duration = opts.duration || 60;
    this.ui = opts.ui;
  }

  // ---- lifecycle ---------------------------------------------------------

  async start(container: HTMLElement, youtubeVideoId: string) {
    let playerDur: number;
    try {
      playerDur = await this.driver.init(container, youtubeVideoId);
    } catch (e: any) {
      const code = /yt_error_(\d+)/.exec(String(e?.message || ''))?.[1];
      await this.reportPlayerError(code ? `yt_${code}` : 'player_load_failed');
      this.failSession(
        'video_unavailable',
        code
          ? 'This video can\u2019t play here right now — we\u2019ve flagged it. No money was added, and this one isn\u2019t on you.'
          : 'The video player couldn\u2019t load. Check your connection and try again.',
      );
      return;
    }
    if (!Number.isFinite(playerDur) || playerDur <= 0) {
      // Live streams and unknown durations can't be verified — not watchable for pay.
      await this.reportPlayerError('live_or_unknown_duration');
      this.failSession(
        'video_unavailable',
        'This video can\u2019t be verified for watching right now. No money was added, and this one isn\u2019t on you.',
      );
      return;
    }
    this.playerDuration = playerDur;

    this.driver.onTick((pos) => this.onTimeUpdate(pos));
    this.driver.onRateChange(() => this.onRateViolation());
    this.driver.onEnded(() => this.finish());
    this.driver.onError((code) => this.onDriverError(code));

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);

    this.hbTimer = setInterval(() => {
      this.heartbeat(false).catch(() => {});
    }, 10_000);
    this.updateChecklist();
    this.driver.play();
    // First heartbeat shortly after start so the session is alive server-side.
    setTimeout(() => {
      if (!this.destroyed) this.heartbeat(false).catch(() => {});
    }, 2000);
  }

  destroy() {
    this.destroyed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    this.driver.destroy();
  }

  /** User-initiated abort (skip): stop everything without completing. */
  abort() {
    this.failed = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.driver.pause();
  }

  toggle() {
    if (this.driver.isPlaying()) this.driver.pause();
    else this.driver.play();
  }

  // ---- enforcement (behavior-identical to the original HTML5 core) --------

  private onRateViolation = () => {
    if (this.failed || this.destroyed) return;
    if (this.driver.getRate() !== 1) {
      this.driver.setRate(1); // force back; the heartbeat will carry the deviation
      this.driver.pause();
      this.ui.toast('Speed is locked at 1× — faster playback doesn\u2019t count.', 'warn');
    }
  };

  private onTimeUpdate = (pos: number) => {
    if (this.failed || this.destroyed) return;
    // Forward-seek clamp: a position jump the elapsed wall-clock can't explain
    // is a seek past the verified frontier — pull it back. The elapsed-based
    // allowance (mirroring the server's continuity window) keeps throttled
    // timers on slow devices from false-clamping.
    const now = performance.now();
    const elapsed = this.lastTickTs == null ? 0.5 : Math.max(0, (now - this.lastTickTs) / 1000);
    this.lastTickTs = now;
    const allowed = this.maxPos + Math.max(0.5, elapsed * 1.5 + 0.5);
    if (pos > allowed) {
      this.driver.seekTo(this.maxPos);
      return;
    }
    if (pos > this.maxPos) this.maxPos = pos;
    this.ui.setPosition(pos);
    this.updateChecklist();
    // Due attention checks → pause + present. A check whose present call failed
    // is retried on the next successful heartbeat, not every tick (that
    // spammed an error toast per second when the server position lagged).
    for (const chk of this.checks) {
      if (this.answered.has(chk.id) || this.presented.has(chk.id) || this.presentFailed.has(chk.id)) continue;
      if (pos >= chk.scheduled_at_s) this.presentCheck(chk);
    }
  };

  private onDriverError = (code: number | string) => {
    // YouTube player errors: 2 bad param, 5 HTML5, 100 not found/private,
    // 101/150 embedding not allowed by owner.
    this.reportPlayerError(`yt_${code}`).catch(() => {});
    this.failSession(
      'video_unavailable',
      'This video can\u2019t play here right now — we\u2019ve flagged it. No money was added, and this one isn\u2019t on you.',
    );
  };

  private async reportPlayerError(code: string) {
    try {
      await api('POST', `/v1/watch/${this.sid}/player-error`, { error_code: code });
    } catch {
      /* best effort — the fail UI is what the watcher sees */
    }
  }

  private onVisibility = () => {
    if (document.hidden) {
      this.driver.pause();
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
            position_s: this.driver.getPosition(),
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
    this.seq += 1;
    const buffering = (this.driver as YouTubeDriver).bufferingS ?? 0;
    (this.driver as YouTubeDriver).bufferingS = 0;
    const payload: Record<string, unknown> = {
      seq: this.seq,
      position_s: Math.round(this.driver.getPosition() * 10) / 10,
      visible: forceHidden ? false : !document.hidden,
      playback_rate: this.driver.getRate() || 1,
      client_ts: Date.now() / 1000,
      buffering_s: Math.round(buffering * 10) / 10,
    };
    // Report the player's ground-truth duration on the first beats; the
    // server reconciles it against the admin-declared duration (tolerance-
    // bounded) and echoes the effective duration back.
    if (this.playerDuration != null && this.beatsSent < 3) {
      payload.player_duration_s = Math.round(this.playerDuration * 10) / 10;
    }
    this.beatsSent += 1;
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
    // A successful heartbeat means the server position is fresh — allow
    // failed attention-check presents another attempt.
    if (this.presentFailed.size > 0) this.presentFailed.clear();
    if (typeof data.duration_s === 'number' && data.duration_s > 0 && data.duration_s !== this.duration) {
      this.duration = data.duration_s;
      this.ui.setDuration(data.duration_s);
    }
    this.updateChecklist(data.watched_pct);
  }

  async presentCheck(chk: AttentionCheck) {
    this.driver.pause();
    let data: any;
    try {
      data = await api('POST', `/v1/watch/${this.sid}/attention`, { check_id: chk.id });
    } catch (e: any) {
      // One toast per check: the tick retries every second, so without this
      // guard a transient failure (e.g. server position lagging the player)
      // stacks a toast per second. The next successful heartbeat clears the
      // flag for another attempt.
      if (!this.presentFailed.has(chk.id)) {
        this.ui.toast(`Could not load the attention check.${e?.requestId ? ` (Ref: ${String(e.requestId).slice(0, 8)})` : ''}`, 'err');
      }
      this.presentFailed.add(chk.id);
      this.driver.play();
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
      this.driver.play();
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
    this.driver.pause();
    this.ui.setAttention(null);
    this.ui.onFail(reason, message);
  }

  private updateChecklist(pct?: number) {
    const watchedPct =
      pct ?? (this.intervals.reduce((s, [a, b]) => s + (b - a), 0) / (this.duration || 1)) * 100;
    const checksDone = this.checks.length === 0 || this.checks.every((c) => this.answered.has(c.id));
    const pos = this.driver.getPosition();
    const checkDue = this.checks.some(
      (c) => !this.answered.has(c.id) && pos >= c.scheduled_at_s - 5,
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
  const containerRef = useRef<HTMLDivElement>(null);
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

  const cp = claim.campaign || {};
  const ytId = claim.youtube_video_id || claim.video?.youtube_video_id || '';
  const ytTitle = claim.video?.youtube_title || cp.title || 'Video';

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ytId) {
      setFailMsg('This video isn\u2019t available right now.');
      return;
    }
    let cancelled = false;

    const ui: UiSink = {
      setIntervals,
      setPosition,
      setDuration,
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

    const driver = new YouTubeDriver();
    const core = new PlayerCore({
      sessionId,
      driver,
      checks: claim.checks || [],
      duration: claim.video?.duration_s || 60,
      ui,
    });
    coreRef.current = core;
    core.start(container, ytId).catch(() => {});

    // Poll play state for the transport button (the YT API has no play/pause events on the driver).
    const pt = setInterval(() => {
      if (!cancelled) setPlaying(driver.isPlaying());
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(pt);
      coreRef.current?.destroy();
      coreRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const watchedPct = duration ? (intervals.reduce((s: number, [a, b]: [number, number]) => s + (b - a), 0) / duration) * 100 : 0;

  return (
    <div>
      <div id="meta">
        <h2 style={{ marginBottom: 4 }}>{ytTitle}</h2>
        <p className="small" style={{ margin: 0 }}>
          Paid ad · Earn {money(cp.price_per_view_cents || 0)} when you finish
        </p>
      </div>

      <div className="stage" id="stage">
        <div ref={containerRef} className="yt-frame" aria-label="Advertisement video" />
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
              onClick={() => coreRef.current?.toggle()}
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
            // Best-effort: free the server session so the next claim isn't blocked.
            api('POST', `/v1/watch/${sessionId}/abandon`, {}).catch(() => {});
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
