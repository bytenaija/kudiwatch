/* WatchPlayer — hardened HTML5 player for KudiWatch.
   - 1x rate lock (re-set on ratechange; deviation pauses + flags)
   - Seek clamp: cannot seek past max verified position
   - Page Visibility: hidden → pause + immediate heartbeat(visible:false)
   - Heartbeat loop every 10 s (+ sendBeacon on pagehide)
   - Attention overlay: server-scheduled, pauses video, 15 s countdown
   - Verified-segments progress bar (from accepted heartbeats), not raw playhead
*/
(function () {
  'use strict';

  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  class WatchPlayer {
    constructor(opts) {
      this.sid = opts.sessionId;
      this.video = opts.videoEl;
      this.streamUrl = opts.streamUrl;
      this.checks = opts.checks || [];
      this.duration = opts.duration || 0;
      this.onDone = opts.onDone || (() => {});
      this.onFail = opts.onFail || (() => {});
      this.seq = 0;
      this.maxPos = 0;
      this.intervals = [];
      this.answered = new Set();
      this.presented = new Map(); // checkId -> dueAt timestamp
      this.hbTimer = null;
      this.failed = false;
      this.barEls = opts.barEls || {};
    }

    async start() {
      const v = this.video;
      v.src = this.streamUrl;
      v.preload = 'metadata';
      v.controlsList = 'nodownload';
      v.disablePictureInPicture = true;
      v.setAttribute('controlsList', 'nodownload');

      v.addEventListener('ratechange', () => {
        if (v.playbackRate !== 1) {
          v.playbackRate = 1; // force back; the heartbeat will carry the deviation
          v.pause();
          KW.toast('Speed is locked at 1× — faster playback doesn\u2019t count.', 'warn');
        }
      });
      v.addEventListener('seeking', () => {
        if (v.currentTime > this.maxPos + 0.5) {
          v.currentTime = this.maxPos; // clamp forward seeks
        }
      });
      v.addEventListener('contextmenu', (e) => e.preventDefault());
      v.addEventListener('timeupdate', () => this.onTimeUpdate());
      v.addEventListener('ended', () => this.finish());
      v.addEventListener('waiting', () => { this._bufferStart = performance.now(); });
      v.addEventListener('playing', () => {
        if (this._bufferStart) {
          this.bufferingS = (this.bufferingS || 0) + (performance.now() - this._bufferStart) / 1000;
          this._bufferStart = null;
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          v.pause();
          this.showHiddenOverlay(true);
          // Immediate heartbeat: visible=false (zero credit for hidden intervals).
          this.heartbeat(true).catch(() => {});
        } else {
          this.showHiddenOverlay(false);
        }
      });
      window.addEventListener('pagehide', () => {
        // Final beat via beacon (fire-and-forget).
        try {
          const blob = new Blob([JSON.stringify({
            seq: this.seq + 1, position_s: v.currentTime, visible: false,
            playback_rate: 1, client_ts: Date.now() / 1000,
          })], { type: 'application/json' });
          navigator.sendBeacon(`/v1/watch/${this.sid}/heartbeat`, blob);
        } catch { /* noop */ }
      });

      // Keyboard: Space/K play-pause, arrows seek ±5s (clamped), F fullscreen, M mute.
      v.tabIndex = 0;
      v.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'k' || e.key === 'K') { e.preventDefault(); this.toggle(); }
        else if (e.key === 'ArrowRight') { v.currentTime = Math.min(this.maxPos, v.currentTime + 5); }
        else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); }
        else if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.(); }
        else if (e.key === 'm' || e.key === 'M') { v.muted = !v.muted; }
      });

      this.hbTimer = setInterval(() => this.heartbeat(false).catch(() => {}), 10_000);
      this.updateChecklist();
      try { await v.play(); } catch { /* user gesture needed */ }
      // First heartbeat shortly after start so the session is alive server-side.
      setTimeout(() => this.heartbeat(false).catch(() => {}), 2000);
    }

    toggle() {
      const v = this.video;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }

    onTimeUpdate() {
      const v = this.video;
      const pos = v.currentTime;
      if (pos > this.maxPos) this.maxPos = pos;
      this.renderBar();
      this.updateChecklist();
      // Due attention checks → pause + present.
      for (const chk of this.checks) {
        if (this.answered.has(chk.id) || this.presented.has(chk.id)) continue;
        if (pos >= chk.scheduled_at_s) this.presentCheck(chk);
      }
    }

    async heartbeat(forceHidden) {
      if (this.failed) return;
      const v = this.video;
      this.seq += 1;
      const payload = {
        seq: this.seq,
        position_s: Math.round(v.currentTime * 10) / 10,
        visible: forceHidden ? false : !document.hidden,
        playback_rate: v.playbackRate || 1,
        client_ts: Date.now() / 1000,
        buffering_s: Math.round((this.bufferingS || 0) * 10) / 10,
      };
      this.bufferingS = 0;
      let data;
      try {
        data = await KW.api('POST', `/v1/watch/${this.sid}/heartbeat`, payload);
      } catch (e) {
        // Offline → queue the beat; the bar keeps local state.
        await KW.OfflineQ.push({ kind: 'heartbeat', sid: this.sid, payload });
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
      if (Array.isArray(data.intervals)) this.intervals = data.intervals;
      this.renderBar();
      this.updateChecklist(data.watched_pct);
    }

    async presentCheck(chk) {
      this.video.pause();
      let data;
      try {
        data = await KW.api('POST', `/v1/watch/${this.sid}/attention`, { check_id: chk.id });
      } catch (e) { KW.showError('Could not load the attention check.', e.requestId); this.video.play().catch(() => {}); return; }
      if (!data.presented) return;
      this.presented.set(chk.id, Date.now() + data.due_in_s * 1000);
      this.showAttentionModal(chk, data);
      this.updateChecklist();
    }

    async answerCheck(chk, choiceIdx) {
      const body = { check_id: chk.id };
      if (chk.type === 'quiz') body.response = { choice_idx: choiceIdx };
      else body.response = {};
      let data;
      try {
        data = await KW.api('POST', `/v1/watch/${this.sid}/attention`, body);
      } catch (e) { KW.showError('Could not send your answer.', e.requestId); return; }
      this.hideAttentionModal();
      this.presented.delete(chk.id);
      if (data.passed) {
        this.answered.add(chk.id);
        KW.toast('Checked — keep watching.');
        this.video.play().catch(() => {});
      } else {
        this.failSession('attention_failed',
          chk.type === 'quiz'
            ? 'That answer wasn\u2019t right. No money was added — that\u2019s the rule for everyone.'
            : 'The attention check wasn\u2019t answered in time. No money was added — that\u2019s the rule for everyone.');
      }
      this.updateChecklist();
    }

    async finish() {
      clearInterval(this.hbTimer);
      // Final heartbeat at the ended position, then complete.
      await this.heartbeat(false).catch(() => {});
      let data;
      try {
        data = await KW.api('POST', `/v1/watch/${this.sid}/complete`, {});
      } catch (e) { this.onFail('complete_error', e.message); return; }
      if (data.status === 'completed') this.onDone(data);
      else this.onFail(data.reason, data.message);
    }

    failSession(reason, message) {
      if (this.failed) return;
      this.failed = true;
      clearInterval(this.hbTimer);
      this.video.pause();
      this.hideAttentionModal();
      this.onFail(reason, message);
    }

    // ---- rendering ----

    renderBar() {
      const { segBar, playhead, timeLabel } = this.barEls;
      if (!segBar || !this.duration) return;
      // Verified segments fill solid; playhead is a thin marker.
      segBar.innerHTML = '';
      for (const [a, b] of this.intervals) {
        const d = document.createElement('i');
        d.style.cssText = `position:absolute;top:0;bottom:0;left:${(a / this.duration) * 100}%;width:${((b - a) / this.duration) * 100}%;background:var(--primary);border-radius:999px;`;
        segBar.appendChild(d);
      }
      if (playhead) playhead.style.left = `${(this.video.currentTime / this.duration) * 100}%`;
      if (timeLabel) {
        timeLabel.textContent = `${fmt(this.video.currentTime)} / ${fmt(this.duration)}`;
        const pct = this.intervals.reduce((s, [a, b]) => s + (b - a), 0) / this.duration * 100;
        segBar.setAttribute('aria-valuenow', String(Math.round(pct)));
        segBar.setAttribute('aria-valuetext', `${Math.round(pct)} percent verified`);
      }
    }

    updateChecklist(pct) {
      const el = this.barEls.checklist;
      if (!el) return;
      const watchedPct = pct ?? (this.intervals.reduce((s, [a, b]) => s + (b - a), 0) / (this.duration || 1) * 100);
      const checksDone = this.checks.length === 0 || this.checks.every((c) => this.answered.has(c.id));
      const checkDue = this.checks.some((c) => !this.answered.has(c.id) && this.video.currentTime >= c.scheduled_at_s - 5);
      const items = [
        { done: watchedPct >= 90, label: watchedPct >= 90 ? 'Watched 90% of the video' : 'Watch 90% of the video' },
        { done: checksDone, label: checksDone ? 'Attention check passed' : checkDue ? 'Attention check — due soon' : 'Attention check — coming up' },
        { done: !document.hidden, label: document.hidden ? 'This tab is hidden — paused' : 'Keep this tab visible' },
      ];
      el.innerHTML = items.map((i) => `
        <li class="${i.done ? 'done' : ''}">
          <span class="ic" aria-hidden="true">${i.done ? '✓' : ''}</span>
          <span>${KW.esc(i.label)}</span>
        </li>`).join('');
    }

    showHiddenOverlay(show) {
      const el = this.barEls.hiddenOverlay;
      if (el) el.style.display = show ? 'flex' : 'none';
    }

    showAttentionModal(chk, data) {
      this.hideAttentionModal();
      const isQuiz = chk.type === 'quiz';
      const overlay = document.createElement('div');
      overlay.className = 'dialog';
      overlay.id = 'kw-attention';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Attention check');
      const dueIn = data.due_in_s || 15;
      overlay.innerHTML = `
        <div class="box">
          <div class="row" style="justify-content:space-between">
            <h3 style="margin:0">${isQuiz ? 'Quick question about the video' : 'Quick check — are you still watching?'}</h3>
            <span class="count-ring" id="kw-count" aria-live="polite">${dueIn}</span>
          </div>
          ${isQuiz ? `<p><strong>${KW.esc(data.payload.q || '')}</strong></p>` : `<p>Answer within 15 seconds to keep earning.</p>`}
          <div id="kw-choices">
          ${isQuiz
            ? (data.payload.choices || []).map((ch, i) => `
              <button class="method-card" data-i="${i}" style="min-height:48px">
                <span>${KW.esc(ch)}</span>
              </button>`).join('')
            : `<button class="btn primary" id="kw-imwatching">I'm watching</button>`}
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const deadline = Date.now() + dueIn * 1000;
      const ring = overlay.querySelector('#kw-count');
      const tick = setInterval(() => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        if (ring) ring.textContent = String(left);
        if (left <= 0) {
          clearInterval(tick);
          this.answerCheck(chk); // no response → server marks timeout
        }
      }, 250);
      overlay._tick = tick;
      if (isQuiz) {
        overlay.querySelectorAll('[data-i]').forEach((btn) => {
          btn.addEventListener('click', () => { clearInterval(tick); this.answerCheck(chk, Number(btn.dataset.i)); });
        });
      } else {
        overlay.querySelector('#kw-imwatching').addEventListener('click', () => { clearInterval(tick); this.answerCheck(chk); });
      }
      const first = overlay.querySelector('button');
      if (first) first.focus();
    }

    hideAttentionModal() {
      const el = document.getElementById('kw-attention');
      if (el) { clearInterval(el._tick); el.remove(); }
    }
  }

  window.WatchPlayer = WatchPlayer;
})();
