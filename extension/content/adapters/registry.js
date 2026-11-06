// Picks an adapter for the current site.
"use strict";
(function () {
  const SP = window.__SP;

  SP.createAdapter = function () {
    const h = location.hostname;
    if (/(^|\.)netflix\.com$/.test(h))                        return new SP.NetflixAdapter();
    if (/(^|\.)youtube\.com$/.test(h))                        return new SP.YouTubeAdapter();
    if (/(^|\.)primevideo\.com$/.test(h) ||
        (/(^|\.)amazon\./.test(h) && /video|gp\/video/.test(location.pathname)))
                                                              return new SP.PrimeAdapter();
    if (/(^|\.)hotstar\.com$/.test(h) ||
        /(^|\.)jiohotstar\.com$/.test(h) ||
        /(^|\.)jiocinema\.com$/.test(h))                      return new SP.HotstarAdapter();
    return new SP.GenericAdapter();
  };
})();
