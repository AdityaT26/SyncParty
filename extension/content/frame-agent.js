// Runs inside child frames. Idle until a session starts, then finds
// the video in this frame and relays state/commands to the top frame.
"use strict";
(function () {
  if (window === window.top) return; // top frame uses composite.js instead
  const SP = window.__SP;
  const TAG = SP.FRAME_TAG;
  const frameId = Math.random().toString(36).slice(2, 10);

  let adapter = null;
  let bound = false;       // only the bound frame forwards media events
  let stateTimer = null;

  function up(msg) {
    try {
      window.top.postMessage(Object.assign({ [TAG]: true, dir: "up", frameId }, msg), "*");
    } catch (_) {}
  }

  function currentState() {
    const active = !!(adapter && adapter.isActive());
    return {
      evt: "state",
      active,
      score: active ? adapter._score(adapter.video) : -1e9,
      currentTime: adapter ? adapter.getCurrentTime() : 0,
      paused: adapter ? adapter.isPaused() : true,
      rate: adapter ? adapter.getRate() : 1,
      duration: adapter ? adapter.getDuration() : 0,
      ts: Date.now()
    };
  }

  function startScan() {
    if (adapter) return;
    adapter = new SP.GenericAdapter();
    adapter.onNativeStateChange((ev) => {
      if (ev.type !== "videochange" && ev.type !== "videolost" && bound) {
        up({ evt: "media", type: ev.type, currentTime: ev.currentTime,
             paused: ev.paused, emittedAt: ev.emittedAt });
      }
      up(currentState());
    });
    adapter.start();
    stateTimer = setInterval(() => up(currentState()), SP.FRAME_STATE_MS);
    SP.log("frame-agent scanning in", location.hostname || "(opaque frame)");
  }

  function stopScan() {
    bound = false;
    if (stateTimer) { clearInterval(stateTimer); stateTimer = null; }
    if (adapter) { adapter.stop(); adapter = null; }
  }

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || m[TAG] !== true || m.dir !== "down") return;
    if (event.source !== window.top) return;          // only obey the top frame
    if (m.frameId && m.frameId !== frameId) return;   // targeted command for someone else

    switch (m.cmd) {
      case "scan-start": startScan(); break;
      case "scan-stop":  stopScan(); break;
      case "bind":       bound = true; up(currentState()); break;
      case "unbind":     bound = false; break;
      case "play":   if (adapter) adapter.play();  up(currentState()); break;
      case "pause":  if (adapter) adapter.pause(); up(currentState()); break;
      case "seek":   if (adapter) adapter.seek(m.seconds); up(currentState()); break;
      case "setRate": if (adapter) adapter.setRate(m.rate); break;
      case "suppress": if (adapter) adapter.suppress.apply(adapter, m.types || []); break;
    }
  });

  // Announce ourselves: if a session is already running, the top frame replies
  // with scan-start (covers players loaded after session start).
  up({ evt: "hello" });
})();
