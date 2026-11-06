// Netflix: commands go through Netflix's own player API (seeking via
// video.currentTime is unreliable there); events come from <video>.
"use strict";
(function () {
  const SP = window.__SP;
  const TAG = SP.PAGE_TAG;

  class PageRpc {
    constructor() {
      this._pending = new Map();
      this._seq = 0;
      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const m = event.data;
        if (!m || m[TAG] !== true || m.dir !== "to-content") return;
        const p = this._pending.get(m.id);
        if (!p) return;
        this._pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m.ok ? m.result : null);
      });
    }
    call(cmd, args = {}, timeoutMs = 800) {
      return new Promise((resolve) => {
        const id = ++this._seq;
        const timer = setTimeout(() => {
          this._pending.delete(id);
          resolve(null);
        }, timeoutMs);
        this._pending.set(id, { resolve, timer });
        window.postMessage(Object.assign({ [TAG]: true, dir: "to-page", id, cmd }, args), "*");
      });
    }
  }
  // Singleton: one window 'message' listener per page, however many adapter
  // instances get created (the popup's idle probe makes short-lived ones).
  SP.getPageRpc = () => (SP._pageRpc || (SP._pageRpc = new PageRpc()));

  class NetflixAdapter extends SP.GenericAdapter {
    constructor() {
      super();
      this.name = "netflix";
      this._rpc = SP.getPageRpc();
      this._apiOk = false;
      this._probeTimer = null;
    }

    start() {
      super.start();
      const probe = async () => {
        this._apiOk = (await this._rpc.call("probe")) === true;
      };
      probe();
      this._probeTimer = setInterval(probe, 5000); // player sessions come and go
    }

    stop() {
      if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
      super.stop();
    }

    play() {
      if (this._apiOk) this._rpc.call("play");
      else super.play();
    }
    pause() {
      if (this._apiOk) this._rpc.call("pause");
      else super.pause();
    }
    seek(seconds) {
      if (this._apiOk) this._rpc.call("seek", { seconds });
      else {
        SP.log("netflix: internal API unavailable, falling back to DOM seek (may be unreliable)");
        super.seek(seconds);
      }
    }
  }

  SP.NetflixAdapter = NetflixAdapter;
})();
