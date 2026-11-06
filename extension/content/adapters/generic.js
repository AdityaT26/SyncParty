// Generic <video> adapter. Finds the main video on the page (shadow
// roots and same-origin iframes included) and drives it directly.
"use strict";
(function () {
  const SP = window.__SP;

  class GenericAdapter {
    constructor() {
      this.name = "generic";
      this.video = null;
      this._listeners = [];        // [event, handler] bound to current video
      this._stateCb = null;        // onNativeStateChange callback
      this._observer = null;
      this._scanTimer = null;
      this._urlPollTimer = null;
      this._lastUrl = location.href;
      this._started = false;
      this._suppress = new Map();  // eventName -> expiry ts (echo-loop guard)
      this._onVisibility = () => this.scheduleScan();
      this._onPopstate = () => this.scheduleScan();
    }

    // discovery

    start() {
      if (this._started) return;
      this._started = true;
      this.scan();
      this._observer = new MutationObserver(() => this.scheduleScan());
      this._observer.observe(document.body || document.documentElement, {
        subtree: true, childList: true
      });
      document.addEventListener("visibilitychange", this._onVisibility);
      window.addEventListener("popstate", this._onPopstate);
      // SPA route changes (pushState in the page world is invisible to the
      // isolated world, so poll the URL cheaply).
      this._urlPollTimer = setInterval(() => {
        if (location.href !== this._lastUrl) {
          this._lastUrl = location.href;
          this.scheduleScan();
        }
      }, 1000);
    }

    stop() {
      this._started = false;
      if (this._observer) { this._observer.disconnect(); this._observer = null; }
      if (this._urlPollTimer) { clearInterval(this._urlPollTimer); this._urlPollTimer = null; }
      if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
      document.removeEventListener("visibilitychange", this._onVisibility);
      window.removeEventListener("popstate", this._onPopstate);
      this._unbind();
      this.video = null;
    }

    scheduleScan() {
      if (!this._started || this._scanTimer) return;
      this._scanTimer = setTimeout(() => {
        this._scanTimer = null;
        this.scan();
      }, 400); // debounce bursts of DOM mutations
    }

    // Collect candidate <video> elements: document + open shadow roots +
    // same-origin iframes (recursively, best effort).
    _collectVideos(root, out, depth) {
      if (!root || depth > 4) return;
      let vids;
      try { vids = root.querySelectorAll("video"); } catch (_) { return; }
      vids.forEach((v) => out.push(v));
      // open shadow roots
      let all;
      try { all = root.querySelectorAll("*"); } catch (_) { return; }
      for (const el of all) {
        if (el.shadowRoot) this._collectVideos(el.shadowRoot, out, depth + 1);
        if (el.tagName === "IFRAME") {
          try {
            const idoc = el.contentDocument; // throws / null if cross-origin
            if (idoc) this._collectVideos(idoc, out, depth + 1);
          } catch (_) { /* cross-origin, skip */ }
        }
      }
    }

    // Score candidates so ads / thumbnails / background loops lose to the main
    // feature: rendered area + duration dominate.
    _score(v) {
      let score = 0;
      const r = v.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      score += Math.min(area / 1000, 2000);            // rendered size
      const d = v.duration;
      if (isFinite(d) && d > 0) score += Math.min(d, 7200) / 10; // longer wins
      if (v.readyState >= 1) score += 200;             // actually has media
      if (!v.paused) score += 150;                     // currently playing
      if (area < 200 * 100) score -= 500;              // tiny = thumbnail/ad slot
      if (v.ended) score -= 200;
      return score;
    }

    scan() {
      const out = [];
      this._collectVideos(document, out, 0);
      if (!out.length) { this._setVideo(null); return; }
      let best = null, bestScore = -Infinity;
      for (const v of out) {
        const s = this._score(v);
        if (s > bestScore) { bestScore = s; best = v; }
      }
      // Re-evaluate on every scan so mid-roll ads don't permanently steal
      // focus - when the ad video is removed, the next scan rebinds.
      this._setVideo(best);
    }

    _setVideo(v) {
      if (v === this.video) return;
      this._unbind();
      this.video = v;
      if (v) {
        this._bind(v);
        SP.log(`${this.name}: bound to video`, { duration: v.duration, src: (v.currentSrc || "").slice(0, 80) });
      }
      if (this._stateCb) this._stateCb({ type: v ? "videochange" : "videolost" });
    }

    // events

    _bind(v) {
      const events = ["play", "pause", "seeking", "seeked", "ratechange",
                      "waiting", "playing", "durationchange", "ended"];
      for (const ev of events) {
        const h = () => this._emit(ev);
        v.addEventListener(ev, h);
        this._listeners.push([ev, h]);
      }
    }

    _unbind() {
      if (this.video) {
        for (const [ev, h] of this._listeners) this.video.removeEventListener(ev, h);
      }
      this._listeners = [];
    }

    _emit(type) {
      if (!this._stateCb) return;
      // Echo guard: swallow events we caused ourselves via applyRemote.
      const until = this._suppress.get(type) || 0;
      if (SP.now() < until) {
        this._suppress.delete(type);
        return;
      }
      this._stateCb({
        type,
        currentTime: this.getCurrentTime(),
        paused: this.isPaused(),
        emittedAt: SP.now()
      });
    }

    // Called by the sync engine right before it applies a remote command, so
    // the resulting local events aren't broadcast back (echo loop guard).
    suppress(...eventTypes) {
      const until = SP.now() + SP.ECHO_SUPPRESS_MS;
      for (const t of eventTypes) this._suppress.set(t, until);
    }

    // PlayerAdapter interface

    isActive() {
      return !!(this.video && this.video.readyState >= 1 && isFinite(this.video.duration));
    }
    getCurrentTime() { return this.video ? (this.video.currentTime || 0) : 0; }
    getDuration()    { return this.video && isFinite(this.video.duration) ? this.video.duration : 0; }
    isPaused()       { return this.video ? this.video.paused : true; }

    play() {
      if (!this.video) return;
      const p = this.video.play();
      if (p && p.catch) p.catch((e) => SP.log("play() rejected:", e && e.name));
    }
    pause() { if (this.video) this.video.pause(); }
    seek(seconds) {
      if (!this.video) return;
      try { this.video.currentTime = Math.max(0, seconds); }
      catch (e) { SP.log("seek failed:", e); }
    }

    // Soft drift correction. Returns true if rate-nudging is supported.
    setRate(rate) {
      if (!this.video) return false;
      try { this.video.playbackRate = rate; return true; }
      catch (_) { return false; }
    }
    getRate() { return this.video ? (this.video.playbackRate || 1) : 1; }

    onNativeStateChange(cb) { this._stateCb = cb; }
  }

  SP.GenericAdapter = GenericAdapter;
})();
