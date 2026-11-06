// Main-world script. While the sidebar is pushing the page, redirect
// fullscreen requests to <html> so the page can reflow next to it.
"use strict";
(function () {
  if (window !== window.top) return;
  const doc = document;
  const H = () => doc.documentElement;
  const active = () => H() && H().hasAttribute("data-syncparty-push");
  const origReq = Element.prototype.requestFullscreen;
  if (!origReq) return;

  const fsDesc = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");
  const realFs = (fsDesc && fsDesc.get) ? () => fsDesc.get.call(doc) : () => null;

  let intended = null; // the element the site actually asked to fullscreen

  function cleanup() {
    if (intended) { try { intended.removeAttribute("data-syncparty-fsroot"); } catch (_) {} }
    intended = null;
  }

  Element.prototype.requestFullscreen = function (opts) {
    if (!active() || this === H()) {
      cleanup();
      return origReq.call(this, opts);
    }
    cleanup();
    intended = this;
    try { this.setAttribute("data-syncparty-fsroot", ""); } catch (_) {}
    const p = origReq.call(H(), opts);
    if (p && p.catch) p.catch(() => cleanup());
    return p;
  };
  if (Element.prototype.webkitRequestFullscreen) {
    Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  }

  // Site JS must keep believing its element is fullscreen.
  const spoof = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const real = d.get.call(this);
        return (real === H() && intended && intended.isConnected) ? intended : real;
      }
    });
  };
  spoof(Document.prototype, "fullscreenElement");
  spoof(Document.prototype, "webkitFullscreenElement");
  spoof(Document.prototype, "webkitCurrentFullScreenElement");

  doc.addEventListener("fullscreenchange", () => { if (!realFs()) cleanup(); });
})();
