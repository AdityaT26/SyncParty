// Session controller for the top frame. Owns the adapter, transport,
// sync engine and overlay, and answers the popup.
"use strict";
(function () {
  if (window !== window.top) return; // child frames run frame-agent.js instead
  const SP = window.__SP;
  const RESTORE_KEY = "__syncparty_restore__";

  function cleanUrl() { return location.href.split("#")[0]; }

  const session = {
    active: false,
    role: null,
    code: null,
    state: "idle",       // idle | waiting | connected | buffering-* | reconnecting | peer-left | error
    error: null,
    peerName: null,
    members: [],
    adapter: null,
    transport: null,
    engine: null,
    overlay: null,
    displayName: "Me",
    lastSharedUrl: null,
    navTimer: null,
    snapshotTimer: null,
    reconnectTimer: null,
    reconnectTries: 0,
    navigatingAway: false,
    lastNavAt: 0,
    navRejoin: false,      // this session is re-forming after a followed navigation
    rotating: false,       // party code rotation in progress
    inAd: false,
    lastLongDur: 0,
    adTimer: null,
    settings: { chatLayout: "float", sidebarPush: true, notifyActions: true, adPause: true,
                bufferPause: true, controlMode: "everyone", controlOverrides: {} }
  };

  function loadSettings(cb) {
    // defaults file first (single source of truth), then the user's choices
    fetch(chrome.runtime.getURL("default_settings.json"))
      .then((r) => r.json())
      .then((d) => {
        for (const k of Object.keys(session.settings)) if (k in d) session.settings[k] = d[k];
      })
      .catch(() => {})
      .finally(() => {
        chrome.storage.local.get(["spSettings"], (r) => {
          if (r && r.spSettings) Object.assign(session.settings, r.spSettings);
          if (cb) cb();
        });
      });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.spSettings) return;
    Object.assign(session.settings, changes.spSettings.newValue || {});
    if (session.engine) {
      session.engine.setSettings(session.settings);
      session.engine.setControlPrefs(session.settings.controlMode, session.settings.controlOverrides);
    }
    if (session.overlay) session.overlay.setLayout(session.settings.chatLayout, session.settings.sidebarPush);
  });

  function navQuiet() { return (Date.now() - session.lastNavAt) < 15000; }

  function buildInviteLink() {
    if (!session.code) return null;
    return cleanUrl() + "#" + SP.INVITE_PARAM + "=" + session.code;
  }

  function statusPayload() {
    return {
      active: session.active,
      role: session.role,
      code: session.code,
      state: session.state,
      error: session.error,
      peerName: session.peerName,
      members: session.members,
      platform: session.adapter ? session.adapter.name : null,
      videoFound: session.adapter ? session.adapter.isActive() : false,
      inviteLink: (session.active && session.role === "host") ? buildInviteLink() : null
    };
  }

  function setState(state, error) {
    session.state = state;
    session.error = error || null;
    renderOverlayStatus();
  }

  function renderOverlayStatus() {
    const o = session.overlay;
    if (!o) return;
    const code = session.code;
    switch (session.state) {
      case "waiting":        o.setStatus("warn", session.role === "host" ? "Share code" : "Joining...", code); break;
      case "connected":      o.setStatus("ok", "In sync", code); break;
      case "buffering-self": o.setStatus("warn", "Buffering...", code); break;
      case "buffering-peer": o.setStatus("warn", "Peer buffering", code); break;
      case "reconnecting":   o.setStatus("warn", "Re-syncing...", code); break;
      case "peer-left":      o.setStatus("bad", "Disconnected", code); break;
      case "error":          o.setStatus("bad", "Error", code); break;
      default:               o.setStatus("", "SyncParty", code);
    }
  }

  // session restore snapshot (survives reloads and followed navigations)

  function writeSnapshot() {
    try {
      sessionStorage.setItem(RESTORE_KEY, JSON.stringify({
        role: session.role, code: session.code, nav: session.navigatingAway,
        name: session.displayName, ts: Date.now()
      }));
    } catch (_) {}
  }
  function clearSnapshot() {
    try { sessionStorage.removeItem(RESTORE_KEY); } catch (_) {}
  }
  function readSnapshot() {
    try {
      const s = JSON.parse(sessionStorage.getItem(RESTORE_KEY));
      if (s && s.code && s.role && (Date.now() - s.ts) < SP.RESTORE_TTL_MS) return s;
    } catch (_) {}
    return null;
  }

  // pending invite (parked in sessionStorage by hash-catcher.js so
  // profile-picker/login redirects can't eat the invite hash; per-tab, so
  // codes never mix between tabs)

  const PENDING_KEY = "__syncparty_pending__";
  function readPendingInvite() {
    try {
      const s2 = JSON.parse(sessionStorage.getItem(PENDING_KEY));
      if (s2 && s2.code && (Date.now() - s2.ts) < SP.PENDING_INVITE_TTL) return s2;
    } catch (_) {}
    return null;
  }
  function clearPendingInvite() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
  }

  // reconnect (guest lost the host, e.g. host is reloading after a
  // navigate, or a blip)

  function beginReconnect() {
    if (!session.active || session.role !== "guest" || session.reconnectTimer || session.rotating) return;
    setState("reconnecting");
    session.overlay && session.overlay.addChat(null, session.navRejoin
      ? "Loading the new video - re-syncing with the party..."
      : "Connection hiccup - re-syncing...", true);
    session.reconnectTries = 0;
    session.reconnectTimer = setInterval(() => {
      if (++session.reconnectTries > SP.RECONNECT_MAX) {
        endReconnect();
        setState("peer-left");
        session.overlay && session.overlay.addChat(null, "Couldn't reconnect. The host may have left.", true);
        return;
      }
      session.transport.joinRoom(session.code);
    }, SP.RECONNECT_EVERY_MS);
  }
  function endReconnect() {
    if (session.reconnectTimer) { clearInterval(session.reconnectTimer); session.reconnectTimer = null; }
    session.reconnectTries = 0;
  }

  // navigation sync

  function applyNavigate(msg) {
    const target = msg.href;
    if (!target || session.navigatingAway) return;
    if (target === cleanUrl()) { session.lastSharedUrl = target; return; }
    session.navigatingAway = true;
    session.lastNavAt = Date.now();
    session.overlay && session.overlay.addChat(null,
      (msg.name || "Someone") + " changed the video/episode - following along...", true);
    writeSnapshot(); // same-origin fallback if the hash gets lost
    const hash = "#" + SP.INVITE_PARAM + "=" + session.code +
                 "&" + SP.ROLE_PARAM + "=" + session.role + "&spnav=1";
    // Hosts wait a beat so the relayed navigate flushes to other guests before
    // this tab tears down.
    setTimeout(() => { location.href = target + hash; },
               session.role === "host" ? 400 : 100);
  }

  function startNavWatcher() {
    session.lastSharedUrl = cleanUrl();
    session.navTimer = setInterval(() => {
      if (!session.active || session.navigatingAway) return;
      const cur = cleanUrl();
      if (cur === session.lastSharedUrl) return;
      // Only share the move once the new content actually starts playing -
      // browsing menus and search pages never drags the room around.
      if (session.adapter.isActive() && !session.adapter.isPaused()) {
        session.lastSharedUrl = cur;
        session.lastNavAt = Date.now();
        session.inAd = false;
        session.adSince = 0;
        session.lastLongDur = 0;
        session.engine.sendNavigate(cur);
        session.overlay && session.overlay.addChat(null,
          "Bringing everyone to this video...", true);
      }
    }, SP.NAV_POLL_MS);
  }

  // session lifecycle

  // rejoin=true when re-entering an existing room (after a followed
  // navigation, reload restore, or invite hash) - failures then mean "the room
  // is mid-reshuffle, retry" rather than "user error".
  function startSession(role, code, rejoin) {
    stopSession(false);

    session.active = true;
    session.role = role;
    session.code = code;
    session.rejoin = !!rejoin;
    session.createRetries = 0;
    session.navigatingAway = false;
    session.navRejoin = false; // callers set it after when relevant
    session.rotating = false;

    session.adapter = new SP.CompositeAdapter(SP.createAdapter());
    session.adapter.start();

    session.transport = new SP.Transport();
    session.engine = new SP.SyncEngine(session.adapter, session.transport);
    session.engine.setName(session.displayName);
    session.engine.setSettings(session.settings);
    session.engine.setControlPrefs(session.settings.controlMode, session.settings.controlOverrides);

    session.overlay = new SP.Overlay();
    session.overlay.show();
    session.overlay.onSend((text) => {
      const msg = session.engine.sendChat(text);
      session.overlay.addChat(msg.name, msg.text);
    });
    session.overlay.setLayout(session.settings.chatLayout, session.settings.sidebarPush);
    session.overlay.onLayoutChange((mode) => {
      session.settings.chatLayout = mode;
      chrome.storage.local.set({ spSettings: session.settings });
    });
    session.overlay.onSyncNow(() => {
      session.engine.requestSync();
      session.overlay.addChat(null, "Re-sync requested.", true);
    });
    session.overlay.onCodeClick(() => {
      const link = session.role === "host" ? buildInviteLink() : null;
      const value = link || session.code;
      navigator.clipboard.writeText(value).then(
        () => session.overlay.addChat(null, link ? "Invite link copied - send it to your friends." : "Room code copied.", true),
        () => session.overlay.addChat(null, "Copy failed - use the toolbar popup instead.", true)
      );
    });

    session.engine
      .on("status", (s) => {
        if (s.state === "connected") setState("connected");
        else if (s.state === "waiting") {
          setState("waiting");
          // During an episode change everyone briefly disconnects to follow -
          // don't announce that as "left".
          if (!navQuiet()) session.overlay.addChat(null, "Everyone else left the room.", true);
        }
        else if (s.state === "buffering-self") setState("buffering-self");
        else if (s.state === "buffering-peer") setState("buffering-peer");
        else if (s.state === "peer-left") beginReconnect();
      })
      .on("peerInfo", (info) => {
        session.peerName = info.name;
        session.overlay.addChat(null, info.name + " connected (watching on " + info.platform + ").", true);
        renderOverlayStatus();
      })
      .on("roster", (members) => {
        session.members = members || [];
        session.overlay.setRoster(session.members, session.displayName);
      })
      .on("memberLeft", (info) => {
        if (!navQuiet()) session.overlay.addChat(null, ((info && info.name) || "Someone") + " left.", true);
      })
      .on("chat", (msg) => session.overlay.addChat(msg.name || "Peer", msg.text))
      .on("versionMismatch", (m) => {
        session.overlay.addChat(null, "\u26A0 " + (m.name || "A member") + " is on SyncParty v" + m.theirs +
          " but you have v" + m.ours + " - update both to the same zip if anything misbehaves.", true);
      })
      .on("navigate", (msg) => applyNavigate(msg))
      .on("activity", (a) => session.overlay.addChat(null, a.text, true))
      .on("denied", () => session.overlay.addChat(null,
        "\u26A0 The host has restricted playback control for you - your player follows the party.", true))
      .on("rotate", (m) => {
        // Host rotated the party code (someone was kicked). Migrate quietly.
        session.rotating = true;
        endReconnect();
        session.code = m.code;
        writeSnapshot();
        session.overlay.addChat(null, "Party code changed to " + m.code + " (host updated the room). Reconnecting...", true);
        setTimeout(() => {
          session.rotating = false;
          session.rejoin = true;
          session.createRetries = 0;
          session.transport.joinRoom(session.code);
        }, 2500);
      })
      .on("kicked", () => {
        const ov = session.overlay;
        session.overlay = null; // keep it on screen after teardown
        stopSession(true);
        if (ov) {
          ov.setStatus("bad", "Removed from party", null);
          ov.addChat(null, "The host removed you from this party.", true);
          setTimeout(() => ov.unmount(), 12000);
        }
      })
      .on("drift", (d) => SP.log("drift", d.toFixed(2) + "s"));

    session.transport
      .on("room-created", () => {
        setState("waiting");
        clearPendingInvite();
        if (session.navRejoin) session.navRejoin = false;
        session.members = session.engine.getMembers();
        session.overlay.setRoster(session.members, session.displayName);
        session.overlay.addChat(null, "Room " + session.code + " created. Click the code above to copy an invite link. Any number of friends can join.", true);
      })
      .on("connected", () => {
        endReconnect();
        setState("connected");
        clearPendingInvite();
        if (session.navRejoin) {
          session.navRejoin = false;
          session.overlay.addChat(null, "Back in sync \u2713", true);
        }
      })
      .on("join-failed", (m) => {
        if (session.reconnectTimer) return; // reconnect loop already running
        if (session.rejoin) { beginReconnect(); return; } // host likely mid-reload
        setState("error", m.message);
        session.overlay.addChat(null, m.message, true);
      })
      .on("create-failed", () => {
        if (session.rejoin) {
          // Rejoining host: our previous peer id hasn't been released by the
          // broker yet.
          if (++session.createRetries > 20) {
            setState("error", "Couldn't reclaim the room. Create a new one.");
            return;
          }
          setTimeout(() => {
            if (session.active && session.role === "host") session.transport.createRoom(session.code);
          }, 1500);
        } else {
          // Fresh room: rare random collision - just take a different code.
          session.code = SP.makeRoomCode();
          session.transport.createRoom(session.code);
        }
      })
      .on("peer-error", (m) => {
        if (session.reconnectTimer) return;
        setState("error", m.message);
        session.overlay.addChat(null, "Connection error: " + m.message, true);
      })
      .on("ice-failed", (m) => {
        if (session.reconnectTimer) return;
        setState("error", m.message);
        session.overlay.addChat(null, m.message, true);
      })
      .on("turn-ready", () => {
        session.overlay.addChat(null, "TURN relay active \u2713 - works across any network.", true);
      })
      .on("turn-failed", (m) => {
        // Loud on purpose: a silent TURN failure on CG-NAT looks exactly like
        // "SyncParty is broken".
        session.overlay.addChat(null, "\u26A0 " + m.message, true);
      })
      .on("route", (m) => {
        session.overlay.addChat(null, m.relay
          ? "Connected via TURN relay \u2713 (works across any networks)."
          : "Connected directly (P2P).", true);
      })
      .on("warn", (m) => SP.log("transport warning:", m.message));

    if (role === "host") session.transport.createRoom(code);
    else session.transport.joinRoom(code);
    setState("waiting");

    startNavWatcher();
    writeSnapshot();
    session.snapshotTimer = setInterval(writeSnapshot, 4000);

    // Ad detection: feature content has a long duration; when the bound
    // video's duration suddenly drops to ad length (or YouTube flags
    // ad-showing), that's an ad.
    session.inAd = false;
    session.lastLongDur = 0;
    session.adSince = 0;
    session.adClearSince = 0; // ad pods flicker "no ad" for a beat between ads
    const isYouTube = /(^|\.)youtube\.com$/.test(location.hostname);
    const enterAd = () => {
      session.inAd = true;
      session.adSince = Date.now();
      session.adClearSince = 0;
      session.engine.sendAdStart();
      session.overlay.addChat(null, "Ad break on your side - the party waits for you.", true);
    };
    const exitAd = (forced) => {
      session.inAd = false;
      session.adSince = 0;
      session.engine.sendAdEnd();
      session.overlay.addChat(null, forced
        ? "Ad state looked stuck - resetting and re-syncing."
        : "Ad finished - back to the show.", true);
    };
    const checkAdState = () => {
      if (!session.active || !session.adapter || !session.engine) return;
      if (!session.settings.adPause) {
        if (session.inAd) exitAd(false); // toggle turned off mid-ad: unstick
        return;
      }
      const a = session.adapter;
      const d = a.getDuration();
      // Safety valve: no real ad break lasts 3+ minutes without transition. A
      // stuck inAd flag would otherwise mute this side forever.
      if (session.inAd && Date.now() - session.adSince > 180000) { exitAd(true); return; }

      if (isYouTube) {
        // YouTube: the player's own ad flag is authoritative for both edges.
        const yt = document.getElementById("movie_player");
        const ytAd = !!(yt && yt.classList && yt.classList.contains("ad-showing"));
        if (!session.inAd && ytAd) { enterAd(); return; }
        if (session.inAd) {
          if (ytAd) { session.adClearSince = 0; return; }
          if (!session.adClearSince) { session.adClearSince = Date.now(); return; }
          if (Date.now() - session.adClearSince > 1200) { session.adClearSince = 0; exitAd(false); }
        }
        return;
      }
      // Other platforms: duration-transition heuristic (feature = long, ad =
      // sudden short video), with the timeout above as backstop.
      if (!session.inAd) {
        if (isFinite(d) && d > SP.AD_LONG_S) session.lastLongDur = d;
        const durAd = session.lastLongDur > SP.AD_LONG_S && isFinite(d) && d > 0 && d < SP.AD_SHORT_S;
        if (durAd && a.isActive()) enterAd();
      } else {
        const backToContent = isFinite(d) &&
          (d > SP.AD_LONG_S || (session.lastLongDur && Math.abs(d - session.lastLongDur) < 10));
        if (!backToContent) { session.adClearSince = 0; return; }
        if (!session.adClearSince) { session.adClearSince = Date.now(); return; }
        if (Date.now() - session.adClearSince > 1200) { session.adClearSince = 0; exitAd(false); }
      }
    };
    // Event-driven (durationchange = the instant the player swaps to/from an
    // ad) + a fast poll as backstop.
    session.engine.on("durationchange", checkAdState);
    session.adTimer = setInterval(checkAdState, 750);
  }

  function stopSession(deliberate) {
    endReconnect();
    if (session.adTimer) { clearInterval(session.adTimer); session.adTimer = null; }
    if (session.navTimer) { clearInterval(session.navTimer); session.navTimer = null; }
    if (session.snapshotTimer) { clearInterval(session.snapshotTimer); session.snapshotTimer = null; }
    if (session.engine) session.engine.leave();
    if (session.transport) session.transport.leave();
    if (session.adapter) session.adapter.stop();
    if (session.overlay) session.overlay.unmount();
    if (deliberate) clearSnapshot();
    session.active = false;
    session.role = null;
    session.code = null;
    session.state = "idle";
    session.error = null;
    session.peerName = null;
    session.members = [];
    session.adapter = null;
    session.transport = null;
    session.engine = null;
    session.overlay = null;
    session.lastSharedUrl = null;
    session.navigatingAway = false;
  }

  // popup RPC

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.sp !== true) return;
    switch (msg.cmd) {
      case "get-status": {
        if (!session.active) {
          const probe = SP.createAdapter();
          probe.scan();
          const found = probe.isActive();
          const platform = probe.name;
          probe.stop();
          sendResponse(Object.assign(statusPayload(), { videoFound: found, platform }));
        } else {
          sendResponse(statusPayload());
        }
        break;
      }
      case "create-room": {
        session.displayName = msg.name || "Host";
        startSession("host", SP.makeRoomCode());
        sendResponse(statusPayload());
        break;
      }
      case "join-room": {
        session.displayName = msg.name || "Guest";
        const code = String(msg.code || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4,10}$/.test(code)) {
          sendResponse(Object.assign(statusPayload(), { error: "That doesn't look like a room code." }));
          break;
        }
        startSession("guest", code);
        sendResponse(statusPayload());
        break;
      }
      case "leave": {
        stopSession(true);
        sendResponse(statusPayload());
        break;
      }
      case "kick": {
        if (session.active && session.role === "host" && session.engine) {
          const kicked = session.engine.kickByName(msg.name);
          if (kicked) {
            // Rotate the party code so the removed member's old code stops
            // existing; everyone else migrates automatically.
            const newCode = SP.makeRoomCode();
            session.overlay.addChat(null, "Removed " + msg.name + ". Rotating party code to " + newCode + "...", true);
            session.engine.sendRotate(newCode);
            setTimeout(() => {
              if (!session.active || session.role !== "host") return;
              session.code = newCode;
              session.rejoin = true;
              session.createRetries = 0;
              writeSnapshot();
              session.transport.createRoom(newCode);
            }, 700);
          }
        }
        sendResponse(statusPayload());
        break;
      }
      case "sync-now": {
        if (session.active && session.engine) session.engine.requestSync();
        sendResponse(statusPayload());
        break;
      }
      case "show-overlay": {
        if (session.overlay) session.overlay.show();
        sendResponse(statusPayload());
        break;
      }
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    // Tear down live objects but keep the restore snapshot - if this is a
    // navigation/reload the next page load restores the session; if the tab is
    // closing, sessionStorage dies with it anyway.
    if (session.active) { writeSnapshot(); stopSession(false); }
  });

  // startup: invite hash first, then restore snapshot

  function startFromInvite(inv) {
    chrome.storage.local.get(["displayName"], (r) => {
      session.displayName = (r && r.displayName) || (inv.role === "host" ? "Host" : "Guest");
      SP.log("invite/rejoin detected:", inv.role, inv.code, inv.nav ? "(navigation)" : "");
      startSession(inv.role, inv.code, true);
      session.navRejoin = !!inv.nav;
    });
  }

  function tryRestore() {
    const snap = readSnapshot();
    if (!snap) return false;
    session.displayName = snap.name || "Me";
    SP.log("restoring session after reload:", snap.role, snap.code);
    startSession(snap.role, snap.code, true);
    session.navRejoin = !!snap.nav;
    return true;
  }

  loadSettings(() => {
    // hash-catcher.js (document_start) parks invites in sessionStorage so they
    // survive profile-selection/login redirects (JioHotstar etc.).
    const pend = readPendingInvite();
    if (pend) startFromInvite(pend);
    else tryRestore();
  });

  SP.log("SyncParty ready on", location.hostname);
})();
