// Shared namespace and tuning values.
"use strict";
(function () {
  if (window.__SP) return;

  window.__SP = {
    VERSION: "1.0.0",

    // window.postMessage envelope tags
    MSG_TAG: "__syncparty__",          // content <-> peer iframe
    PAGE_TAG: "__syncparty_page__",    // content <-> MAIN-world page agent
    FRAME_TAG: "__syncparty_frame__",  // top frame <-> child-frame agents

    INVITE_PARAM: "syncparty",         // invite links: <watch url>#syncparty=code

    // Sync tuning
    HEARTBEAT_MS: 4000,        // host -> guest drift heartbeat
    DRIFT_IGNORE_S: 0.35,      // below this: do nothing
    DRIFT_HARD_S: 2.5,         // above this: hard seek
    NUDGE_RATE: 0.08,          // playbackRate delta used for soft correction
    NUDGE_MAX_MS: 6000,        // give up nudging after this long, hard seek instead
    ECHO_SUPPRESS_MS: 1500,    // ignore local events caused by an applied remote command
    SEEK_EPSILON_S: 0.6,       // local seeks smaller than this are not broadcast
    CLOCK_PINGS: 5,            // ping samples used to estimate clock offset
    NAV_POLL_MS: 800,          // how often to check for local URL changes
    NAV_GRACE_MS: 20000,       // after we broadcast a navigate, ignore heartbeat URL-pull this long
    NAV_HB_MISMATCH: 3,        // heartbeats on a different URL before following the host
    RECONNECT_EVERY_MS: 9000,  // rejoin cadence; must exceed TURN ICE setup time (5-10s)
    RECONNECT_MAX: 10,         // ~90s of retries before giving up
    RESTORE_TTL_MS: 30000,     // session snapshot freshness for auto-restore after reload
    ROLE_PARAM: "sprole",      // invite-hash role carrier for navigation rejoin
    AD_LONG_S: 600,            // durations above this = feature content
    AD_SHORT_S: 180,           // sudden drop below this = probably an ad
    PENDING_INVITE_TTL: 600000, // sessionStorage invite survives redirects for 10 min
    FRAME_STATE_MS: 500,       // child frames stream player state this often
    FRAME_STALE_MS: 3000,      // drop a child frame not heard from for this long

    now: () => Date.now(),

    log: (...a) => {
      try { console.debug("[SyncParty]", ...a); } catch (_) {}
    },

    // Generate a human-friendly room code (unambiguous alphabet).
    makeRoomCode: () => {
      const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      let s = "";
      const buf = new Uint8Array(6);
      crypto.getRandomValues(buf);
      for (const b of buf) s += alphabet[b % alphabet.length];
      return s;
    },

    fmtTime: (sec) => {
      if (!isFinite(sec)) return "-:--";
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
      return h ? h + ":" + mm + ":" + ss : m + ":" + ss;
    }
  };
})();
