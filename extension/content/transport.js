// Content-script side of the peer connection. The actual WebRTC
// connection lives in a hidden extension iframe (peer/peer-frame.js).
"use strict";
(function () {
  const SP = window.__SP;
  const TAG = SP.MSG_TAG;

  class Transport {
    constructor() {
      this._frame = null;
      this._frameReady = false;
      this._queue = [];        // commands sent before the frame is ready
      this._handlers = {};     // evt -> [fn]
      window.addEventListener("message", (event) => {
        if (!this._frame || event.source !== this._frame.contentWindow) return;
        const m = event.data;
        if (!m || m[TAG] !== true || m.dir !== "to-content") return;
        if (m.evt === "frame-ready") {
          this._frameReady = true;
          const q = this._queue.splice(0);
          for (const cmd of q) this._post(cmd);
          return;
        }
        this._fire(m.evt, m);
      });
    }

    on(evt, fn) {
      (this._handlers[evt] = this._handlers[evt] || []).push(fn);
      return this;
    }
    _fire(evt, m) {
      for (const fn of (this._handlers[evt] || [])) {
        try { fn(m); } catch (e) { SP.log("handler error", evt, e); }
      }
    }

    _ensureFrame() {
      if (this._frame && this._frame.isConnected) return;
      this._frameReady = false;
      const f = document.createElement("iframe");
      f.src = chrome.runtime.getURL("peer/peer-frame.html");
      f.setAttribute("aria-hidden", "true");
      f.style.cssText = "display:none!important;width:0;height:0;border:0;position:absolute;";
      (document.body || document.documentElement).appendChild(f);
      this._frame = f;
    }

    _post(msg) {
      this._ensureFrame();
      if (!this._frameReady) { this._queue.push(msg); return; }
      this._frame.contentWindow.postMessage(
        Object.assign({ [TAG]: true, dir: "to-frame" }, msg), "*");
    }

    createRoom(code) { this._post({ cmd: "create-room", code }); }
    kick(connId)     { this._post({ cmd: "kick", connId }); }
    joinRoom(code)   { this._post({ cmd: "join-room", code }); }
    // opts: {to: connId} targeted, {except: connId} broadcast-minus-one
    send(payload, opts) {
      this._post(Object.assign({ cmd: "send", payload }, opts || {}));
    }
    leave() {
      this._post({ cmd: "leave" });
      if (this._frame) {
        const f = this._frame;
        setTimeout(() => { try { f.remove(); } catch (_) {} }, 250);
        this._frame = null;
        this._frameReady = false;
      }
    }
  }

  SP.Transport = Transport;
})();
