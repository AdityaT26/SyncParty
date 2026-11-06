// Prime Video: no usable player API, so this is the generic adapter
// with scoring tweaks to skip trailers and previews.
"use strict";
(function () {
  const SP = window.__SP;

  class PrimeAdapter extends SP.GenericAdapter {
    constructor() {
      super();
      this.name = "prime";
    }

    _score(v) {
      let s = super._score(v);
      const src = v.currentSrc || v.src || "";
      if (src.startsWith("blob:")) s += 300;              // MSE/EME playback = the real player
      if (isFinite(v.duration) && v.duration < 180) s -= 300; // trailers/previews
      return s;
    }
  }

  SP.PrimeAdapter = PrimeAdapter;
})();
