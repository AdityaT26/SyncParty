// Runs at document_start. Saves an invite code from the URL hash
// into sessionStorage before the site gets a chance to redirect.
"use strict";
(function () {
  if (window !== window.top) return;
  try {
    const h = location.hash || "";
    const m = h.match(/[#&]syncparty=([A-Za-z0-9]{4,10})/);
    if (!m) return;
    const roleM = h.match(/[#&]sprole=(host|guest)/);
    const navM = /[#&]spnav=1/.test(h);
    sessionStorage.setItem("__syncparty_pending__", JSON.stringify({
      code: m[1].toUpperCase(),
      role: roleM ? roleM[1] : "guest",
      nav: navM,
      ts: Date.now()
    }));
    history.replaceState(null, "", location.pathname + location.search);
  } catch (_) {}
})();
