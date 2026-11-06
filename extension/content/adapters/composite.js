// Wraps the page adapter and the child-frame agents behind one
// adapter, so players inside cross-origin iframes work too.
"use strict";
(function () {
  const SP = window.__SP;
  const TAG = SP.FRAME_TAG;

  // Recursively walk the frame tree. Cross-origin WindowProxy allows .length,
  // indexed access and postMessage - nothing else is touched.
  function walkFrames(w, fn, depth) {
    depth = depth || 0;
    let n = 0;
    try { n = w.length; } catch (_) { return; }
    for (let i = 0; i < n; i++) {
      let c = null;
      try { c = w[i]; } catch (_) { continue; }
      if (!c) continue;
      fn(c);
      if (depth < 4) walkFrames(c, fn, depth + 1);
    }
  }

  class CompositeAdapter {
    constructor(local) {
      this.local = local;
      this.name = local.name;
      this._frames = new Map();     // frameId -> {source, st, at}
      this._cb = null;
      this._current = null;         // null = local adapter, else frameId
      this._evalTimer = null;
      this._started = false;
      this._onMsg = (e) => this._handleMessage(e);

      this.local.onNativeStateChange((ev) => {
        if (ev.type === "videochange" || ev.type === "videolost") {
          this._evaluate();
          if (this._cb) this._cb(ev);
        } else if (this._current === null && this._cb) {
          this._cb(ev);
        }
      });
    }

    // lifecycle

    start() {
      if (this._started) return;
      this._started = true;
      this.local.start();
      window.addEventListener("message", this._onMsg);
      this._broadcast({ cmd: "scan-start" });
      this._evalTimer = setInterval(() => { this._prune(); this._evaluate(); }, 1000);
    }

    stop() {
      if (!this._started) return;
      this._started = false;
      clearInterval(this._evalTimer);
      this._evalTimer = null;
      this._broadcast({ cmd: "scan-stop" });
      window.removeEventListener("message", this._onMsg);
      this.local.stop();
      this._frames.clear();
      this._current = null;
    }

    scan() { this.local.scan(); } // popup idle-probe compatibility

    // frame messaging

    _broadcast(msg) {
      walkFrames(window, (w) => {
        try { w.postMessage(Object.assign({ [TAG]: true, dir: "down" }, msg), "*"); }
        catch (_) {}
      });
    }

    _sendTo(frameId, msg) {
      const f = this._frames.get(frameId);
      if (!f) return;
      try {
        f.source.postMessage(Object.assign({ [TAG]: true, dir: "down", frameId }, msg), "*");
      } catch (_) {}
    }

    _handleMessage(event) {
      const m = event.data;
      if (!m || m[TAG] !== true || m.dir !== "up" || !m.frameId) return;

      if (m.evt === "hello") {
        if (this._started) {
          try { event.source.postMessage({ [TAG]: true, dir: "down", cmd: "scan-start" }, "*"); }
          catch (_) {}
        }
        return;
      }
      if (m.evt === "state") {
        this._frames.set(m.frameId, { source: event.source, st: m, at: Date.now() });
        return;
      }
      if (m.evt === "media" && m.frameId === this._current && this._cb) {
        this._cb({ type: m.type, currentTime: m.currentTime,
                   paused: m.paused, emittedAt: m.emittedAt });
      }
    }

    _prune() {
      const cutoff = Date.now() - SP.FRAME_STALE_MS;
      for (const [id, f] of this._frames) {
        if (f.at < cutoff) {
          this._frames.delete(id);
          if (this._current === id) {
            this._current = null;
            if (this._cb) this._cb({ type: "videochange" });
          }
        }
      }
    }

    // source selection

    _localScore() {
      return (this.local.isActive() && this.local.video)
        ? this.local._score(this.local.video)
        : -Infinity;
    }

    _evaluate() {
      const ls = this._localScore();
      let bestId = null, bestScore = -Infinity;
      for (const [id, f] of this._frames) {
        if (f.st.active && f.st.score > bestScore) { bestScore = f.st.score; bestId = id; }
      }
      // Local wins ties: site adapters know their platform better.
      const cand = (ls >= bestScore) ? null : bestId;
      if (cand === this._current) return;

      const curEntry = this._current === null ? null : this._frames.get(this._current);
      const curActive = this._current === null ? (ls > -Infinity)
                                               : !!(curEntry && curEntry.st.active);
      const curScore = this._current === null ? ls
                     : (curEntry ? curEntry.st.score : -Infinity);
      const candScore = cand === null ? ls : bestScore;

      if (candScore === -Infinity) return;                       // nothing anywhere
      if (curActive && candScore < curScore * 1.25) return;      // hysteresis: ads don't flap the binding

      if (this._current !== null) this._sendTo(this._current, { cmd: "unbind" });
      this._current = cand;
      if (cand !== null) this._sendTo(cand, { cmd: "bind" });
      SP.log("composite: video source ->", cand === null ? "main page" : "embedded frame " + cand);
      if (this._cb) this._cb({ type: "videochange" });
    }

    _curSt() {
      const f = this._frames.get(this._current);
      return f ? f.st : null;
    }

    // PlayerAdapter interface

    isActive() {
      if (this._current === null) return this.local.isActive();
      const st = this._curSt();
      return !!(st && st.active);
    }

    getCurrentTime() {
      if (this._current === null) return this.local.getCurrentTime();
      const st = this._curSt();
      if (!st) return 0;
      const el = st.paused ? 0 : (Date.now() - st.ts) / 1000 * (st.rate || 1);
      return (st.currentTime || 0) + el;
    }

    getDuration() {
      if (this._current === null) return this.local.getDuration();
      const st = this._curSt();
      return st ? (st.duration || 0) : 0;
    }

    isPaused() {
      if (this._current === null) return this.local.isPaused();
      const st = this._curSt();
      return st ? !!st.paused : true;
    }

    play() {
      if (this._current === null) return this.local.play();
      const f = this._frames.get(this._current);
      if (f) { f.st.currentTime = this.getCurrentTime(); f.st.ts = Date.now(); f.st.paused = false; }
      this._sendTo(this._current, { cmd: "play" });
    }

    pause() {
      if (this._current === null) return this.local.pause();
      const f = this._frames.get(this._current);
      if (f) { f.st.currentTime = this.getCurrentTime(); f.st.ts = Date.now(); f.st.paused = true; }
      this._sendTo(this._current, { cmd: "pause" });
    }

    seek(seconds) {
      if (this._current === null) return this.local.seek(seconds);
      const f = this._frames.get(this._current);
      if (f) { f.st.currentTime = seconds; f.st.ts = Date.now(); } // optimistic, avoids stale re-seeks
      this._sendTo(this._current, { cmd: "seek", seconds });
    }

    setRate(rate) {
      if (this._current === null) return this.local.setRate(rate);
      const f = this._frames.get(this._current);
      if (f) f.st.rate = rate;
      this._sendTo(this._current, { cmd: "setRate", rate });
      return true;
    }

    getRate() {
      if (this._current === null) return this.local.getRate();
      const st = this._curSt();
      return st ? (st.rate || 1) : 1;
    }

    suppress() {
      const types = Array.prototype.slice.call(arguments);
      if (this._current === null) return this.local.suppress.apply(this.local, types);
      // postMessage ordering guarantees suppress lands before the command that
      // follows it
      this._sendTo(this._current, { cmd: "suppress", types });
    }

    onNativeStateChange(cb) { this._cb = cb; }
  }

  SP.CompositeAdapter = CompositeAdapter;
})();
