// Owns the PeerJS connection(s). Host accepts many guests, guests
// connect to the host. Only moves bytes; the protocol is in sync-engine.js.
"use strict";
(function () {
  const TAG = "__syncparty__";
  const PEER_PREFIX = "syncparty-w2g-";
  const ICE_TIMEOUT_MS = 25000;
  const ICE_CACHE_MS = 120000; // reuse fetched TURN creds for 2 min

  const STUN_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];
  // Zero-config best effort only; Metered closed static access, so these
  // likely yield nothing. The API-key path below is the reliable one.
  const LEGACY_TURN = [
    { urls: "turn:openrelay.metered.ca:80",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" }
  ];

  let peer = null;
  let conns = new Map();
  let role = null;
  let roomCode = null;
  let opGen = 0;            // generation counter: cancels superseded async create/join
  const blockedPeers = new Set(); // kicked peers can't slip back in pre-rotation
  let iceCache = null;      // { ts, servers }

  function send(evt, data) {
    parent.postMessage(Object.assign({ [TAG]: true, dir: "to-content", evt }, data || {}), "*");
  }

  // TURN account & ICE list

  function sanitizeAppName(s) {
    return String(s || "").trim()
      .replace(/^https?:\/\//, "")
      .replace(/\.metered\.(live|ca).*$/, "")
      .split("/")[0].split(".")[0];
  }

  // ../turn-config.js: ASK_USER_API=true -> user's own values from
  // chrome.storage (popup); false -> hardcoded values from that file.
  async function getTurnAccount() {
    const C = (typeof SYNCPARTY_TURN_CONFIG !== "undefined") ? SYNCPARTY_TURN_CONFIG : { ASK_USER_API: true };
    let cfg;
    if (C.ASK_USER_API === false) {
      cfg = { turnAppName: C.TURN_APP_NAME || "", turnApiKey: C.TURN_API_KEY || "" };
    } else {
      cfg = await chrome.storage.local.get(["turnAppName", "turnApiKey"]);
    }
    return { app: sanitizeAppName(cfg && cfg.turnAppName), key: (cfg && cfg.turnApiKey || "").trim() };
  }

  async function buildIceServers() {
    if (iceCache && (Date.now() - iceCache.ts) < ICE_CACHE_MS) return iceCache.servers;
    const servers = STUN_SERVERS.slice();
    try {
      const { app, key } = await getTurnAccount();
      if (app && key) {
        const url = "https://" + encodeURIComponent(app) +
          ".metered.live/api/v1/turn/credentials?apiKey=" + encodeURIComponent(key);
        const resp = await fetch(url);
        const body = await resp.json().catch(() => null);
        if (resp.ok && Array.isArray(body) && body.length) {
          send("turn-ready", { count: body.length });
          const result = servers.concat(body);
          iceCache = { ts: Date.now(), servers: result };
          return result;
        }
        // Make the failure loud and specific - a silent TURN failure on CG-NAT
        // looks exactly like "SyncParty doesn't work".
        const detail = (body && body.error) ? body.error : ("HTTP " + resp.status);
        send("turn-failed", { message: "TURN relay setup FAILED (" + detail + "). " +
          (resp.status === 401 || (body && /invalid/i.test(body.error || ""))
            ? "The API key was rejected - use the API key from the TURN Server page of your Metered dashboard (the account SECRET KEY from the Developers page may not work). Use the Test button in the popup section \"Can't connect with your friend?\"."
            : "Check the app name ('" + app + "') and API key in the popup section \"Can't connect with your friend?\", then use the Test button.") });
      } else if (app || key) {
        send("turn-failed", { message: "TURN relay not configured completely - both the app name and the API key are needed (see the popup section \"Can't connect with your friend?\")." });
      }
    } catch (e) {
      send("turn-failed", { message: "TURN credential fetch error: " + (e && e.message || e) });
    }
    // Do not cache failures: if the user fixes their key and immediately
    // rejoins, they should get a fresh fetch, not a cached no-TURN list.
    return servers.concat(LEGACY_TURN);
  }

  function peerOpts(iceServers) {
    return { debug: 1, config: { iceServers } };
  }

  // connection diagnostics

  // After a connection opens, report whether it went via TURN relay or
  // directly - the overlay shows this so "is TURN actually working?" is
  // answerable at a glance.
  async function reportRoute(c) {
    try {
      const pc = c.peerConnection;
      if (!pc) return;
      const stats = await pc.getStats();
      const pairs = {}, cands = {};
      let selectedId = null;
      stats.forEach((r) => {
        if (r.type === "candidate-pair") pairs[r.id] = r;
        else if (r.type === "local-candidate" || r.type === "remote-candidate") cands[r.id] = r;
        else if (r.type === "transport" && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
      });
      let pair = selectedId ? pairs[selectedId] : null;
      if (!pair) {
        for (const p of Object.values(pairs)) {
          if (p.nominated && p.state === "succeeded") { pair = p; break; }
        }
      }
      if (!pair) return;
      const l = cands[pair.localCandidateId] || {};
      const r = cands[pair.remoteCandidateId] || {};
      const relay = l.candidateType === "relay" || r.candidateType === "relay";
      send("route", { relay, local: l.candidateType, remote: r.candidateType });
    } catch (_) {}
  }

  function watchIce(c) {
    const timer = setTimeout(() => {
      if (!c.open) {
        send("ice-failed", { message: "Could not connect your networks (CG-NAT / strict firewall). Make sure the overlay showed 'TURN relay active' - if it didn't, fix the relay key via the Test button in the popup section \"Can't connect with your friend?\"." });
        try { c.close(); } catch (_) {}
      }
    }, ICE_TIMEOUT_MS);
    c.on("open", () => {
      clearTimeout(timer);
      setTimeout(() => reportRoute(c), 2000); // let stats settle
    });
    const hook = () => {
      const pc = c.peerConnection;
      if (!pc) return false;
      pc.addEventListener("iceconnectionstatechange", () => {
        if (pc.iceConnectionState === "failed" && !c.open) {
          clearTimeout(timer);
          send("ice-failed", { message: "Network-level connection failed (CG-NAT / strict firewall). Open the popup section \"Can't connect with your friend?\" in the SyncParty popup and use the Test button." });
        }
      });
      return true;
    };
    if (!hook()) setTimeout(hook, 1000);
  }

  // peer lifecycle

  function teardown() {
    opGen++; // cancel any in-flight async create/join
    for (const c of conns.values()) { try { c.close(); } catch (_) {} }
    conns.clear();
    try { if (peer) peer.destroy(); } catch (_) {}
    peer = null; role = null; roomCode = null;
  }

  function wireConnection(c) {
    watchIce(c);
    c.on("open", () => {
      conns.set(c.peer, c);
      if (role === "host") send("conn-open", { connId: c.peer });
      else send("connected", { role, code: roomCode });
    });
    c.on("data", (payload) => send("data", { payload, connId: c.peer }));
    c.on("close", () => {
      if (conns.delete(c.peer)) {
        if (role === "host") send("conn-closed", { connId: c.peer });
        else send("peer-left");
      }
    });
    c.on("error", (e) => send("warn", { message: "connection error: " + (e && e.message || e) }));
  }

  function wirePeer(p) {
    p.on("disconnected", () => {
      send("warn", { message: "signaling lost, reconnecting..." });
      try { p.reconnect(); } catch (_) {}
    });
    p.on("error", (e) => {
      const type = e && e.type;
      if (type === "peer-unavailable") {
        send("join-failed", { message: "No room found with that code. Check the code and make sure the host's tab is still open." });
      } else if (type === "unavailable-id") {
        send("create-failed", { message: "Room code collision, retrying...", retry: true });
      } else if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed") {
        send("peer-error", { message: "Can't reach the signaling server (0.peerjs.com). A firewall, VPN or DNS filter may be blocking it on this network." });
      } else {
        send("peer-error", { message: (type || "") + ": " + (e && e.message || e) });
      }
    });
  }

  async function createRoom(code) {
    teardown();
    const gen = opGen;
    role = "host";
    roomCode = code;
    const ice = await buildIceServers();
    if (gen !== opGen) return; // superseded by a newer create/join/leave
    peer = new Peer(PEER_PREFIX + code, peerOpts(ice));
    wirePeer(peer);
    peer.on("open", () => send("room-created", { code }));
    peer.on("connection", (c) => {
      if (blockedPeers.has(c.peer)) { try { c.close(); } catch (_) {} return; }
      wireConnection(c);
    });
  }

  async function joinRoom(code) {
    teardown();
    const gen = opGen;
    role = "guest";
    roomCode = code;
    const ice = await buildIceServers();
    if (gen !== opGen) return;
    peer = new Peer(peerOpts(ice));
    wirePeer(peer);
    peer.on("open", () => {
      const c = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: "json" });
      wireConnection(c);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const m = event.data;
    if (!m || m[TAG] !== true || m.dir !== "to-frame") return;

    switch (m.cmd) {
      case "create-room": createRoom(m.code); break;
      case "join-room":   joinRoom(m.code); break;
      case "send": {
        if (m.to) {
          const c = conns.get(m.to);
          if (c && c.open) { try { c.send(m.payload); } catch (_) {} }
        } else {
          for (const [id, c] of conns) {
            if (m.except && id === m.except) continue;
            if (c.open) { try { c.send(m.payload); } catch (_) {} }
          }
        }
        break;
      }
      case "kick": {
        blockedPeers.add(m.connId);
        const c = conns.get(m.connId);
        if (c) { try { c.close(); } catch (_) {} }
        break;
      }
      case "leave":
        teardown();
        send("left");
        break;
    }
  });

  send("frame-ready");
})();
