// JioHotstar / JioCinema: generic adapter, tuned to ignore short
// ad and trailer videos.
"use strict";
(function () {
  const SP = window.__SP;

  class HotstarAdapter extends SP.GenericAdapter {
    constructor() {
      super();
      this.name = "hotstar";
    }

    _score(v) {
      let s = super._score(v);
      const src = v.currentSrc || v.src || "";
      if (src.startsWith("blob:")) s += 300;
      if (isFinite(v.duration) && v.duration < 120) s -= 300; // ad/trailer length
      return s;
    }
  }

  SP.HotstarAdapter = HotstarAdapter;
})();
