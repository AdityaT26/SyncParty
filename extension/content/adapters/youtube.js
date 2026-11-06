// YouTube: commands go through #movie_player, events from <video>.
"use strict";
(function () {
  const SP = window.__SP;

  class YouTubeAdapter extends SP.GenericAdapter {
    constructor() {
      super();
      this.name = "youtube";
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
      this._probeTimer = setInterval(probe, 5000);
    }

    stop() {
      if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
      super.stop();
    }

    // Only sync on actual watch pages, not the home feed's inline previews.
    isActive() {
      const watching = /\/watch|\/shorts\/|\/live\//.test(location.pathname);
      return watching && super.isActive();
    }

    play()  { this._apiOk ? this._rpc.call("play")  : super.play(); }
    pause() { this._apiOk ? this._rpc.call("pause") : super.pause(); }
    seek(seconds) {
      this._apiOk ? this._rpc.call("seek", { seconds }) : super.seek(seconds);
    }
  }

  SP.YouTubeAdapter = YouTubeAdapter;
})();
