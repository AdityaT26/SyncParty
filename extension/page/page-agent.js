// Main-world bridge to Netflix/YouTube player APIs. Talks to the
// content script over window.postMessage.
"use strict";
(function () {
  const TAG = "__syncparty_page__";
  const host = location.hostname;

  // platform drivers

  const netflixDriver = {
    _player() {
      try {
        const api = window.netflix
          && window.netflix.appContext
          && window.netflix.appContext.state
          && window.netflix.appContext.state.playerApp
          && window.netflix.appContext.state.playerApp.getAPI();
        const vp = api && api.videoPlayer;
        if (!vp) return null;
        const ids = vp.getAllPlayerSessionIds ? vp.getAllPlayerSessionIds() : [];
        // Prefer a "watch" session if present (Netflix also creates preview
        // sessions)
        const id = ids.find((i) => /watch/i.test(String(i))) || ids[0];
        return id ? vp.getVideoPlayerBySessionId(id) : null;
      } catch (_) { return null; }
    },
    probe() { return !!this._player(); },
    play()  { const p = this._player(); if (p) p.play(); },
    pause() { const p = this._player(); if (p) p.pause(); },
    seek(seconds) { const p = this._player(); if (p) p.seek(Math.max(0, seconds) * 1000); }, // Netflix API is ms
    getCurrentTime() {
      const p = this._player();
      return p && p.getCurrentTime ? p.getCurrentTime() / 1000 : null;
    }
  };

  const youtubeDriver = {
    _player() {
      const el = document.getElementById("movie_player");
      return (el && typeof el.seekTo === "function") ? el : null;
    },
    probe() { return !!this._player(); },
    play()  { const p = this._player(); if (p) p.playVideo(); },
    pause() { const p = this._player(); if (p) p.pauseVideo(); },
    seek(seconds) { const p = this._player(); if (p) p.seekTo(Math.max(0, seconds), true); },
    getCurrentTime() {
      const p = this._player();
      return p && p.getCurrentTime ? p.getCurrentTime() : null;
    }
  };

  let driver = null;
  if (/(^|\.)netflix\.com$/.test(host)) driver = netflixDriver;
  else if (/(^|\.)youtube\.com$/.test(host)) driver = youtubeDriver;
  if (!driver) return;

  // postMessage RPC

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m[TAG] !== true || m.dir !== "to-page") return;

    let ok = true, result = null;
    try {
      switch (m.cmd) {
        case "probe": result = driver.probe(); break;
        case "play":  driver.play(); break;
        case "pause": driver.pause(); break;
        case "seek":  driver.seek(m.seconds); break;
        case "getCurrentTime": result = driver.getCurrentTime(); break;
        default: ok = false; result = "unknown cmd";
      }
    } catch (e) {
      ok = false;
      result = String(e && e.message || e);
    }
    window.postMessage({ [TAG]: true, dir: "to-content", id: m.id, ok, result }, "*");
  });
})();
