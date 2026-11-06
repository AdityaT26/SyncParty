// Sync engine: turns local player events into messages and applies
// remote ones. Host is the hub and the clock authority.
"use strict";
(function () {
  const SP = window.__SP;

  function cleanUrl() { return location.href.split("#")[0]; }

  class SyncEngine {
    constructor(adapter, transport) {
      this.adapter = adapter;
      this.transport = transport;
      this.role = null;              // "host" | "guest"
      this.connected = false;

      // guest: single clock (vs host). host: per-connection clocks.
      this._clockOffset = 0;         // remoteClock - localClock (ms)
      this._pings = [];
      this._pingSeq = 0;
      this._connClocks = new Map();  // host: connId -> {offset, pings:[]}

      this._roster = new Map();      // host: connId -> {name, platform}
      this._lastRoster = [];         // guest: latest roster from host

      this._hbTimer = null;
      this._nudging = false;
      this._nudgeResetTimer = null;
      this._selfBuffering = false;
      this._peerBuffering = false;
      this._lastSeekSentAt = 0;
      this._hrefMismatch = 0;
      this._navGraceUntil = 0;
      this._selfAd = false;          // we're watching an ad right now
      this._adPeers = new Map();     // name -> ts of members currently in an ad
      this._pausedForAd = false;     // we paused because someone else has ads
      this._peerBufferingSince = 0;
      this._joinQuietUntil = 0;      // fresh joiners adopt state, don't broadcast
      this._deferred = null;         // pending play/pause (coalesced around seeks)
      this._deferTimer = null;
      this._deniedNotified = false;
      this._settings = { adPause: true, bufferPause: true, notifyActions: true };
      this._perm = { mode: "everyone", overrides: {} }; // host-side control policy

      this._ui = {};

      this.transport
        .on("room-created", () => this._onHostReady())
        .on("conn-open", (m) => this._onConnOpen(m.connId))
        .on("conn-closed", (m) => this._onConnClosed(m.connId))
        .on("connected", (m) => this._onGuestConnected(m))
        .on("data", (m) => this._onMessage(m.payload, m.connId))
        .on("peer-left", () => this._onPeerLeft());

      this.adapter.onNativeStateChange((ev) => this._onLocalEvent(ev));
    }

    on(evt, fn) { this._ui[evt] = fn; return this; }
    _fire(evt, data) { if (this._ui[evt]) { try { this._ui[evt](data); } catch (_) {} } }

    setName(name) { this._name = name; }
    setSettings(s) { Object.assign(this._settings, s || {}); }
    setControlPrefs(mode, overrides) {
      this._perm.mode = mode === "host" ? "host" : "everyone";
      this._perm.overrides = overrides || {};
      if (this.role === "host") this._broadcastRoster();
    }

    // Host-side: may this member drive playback?
    _canControl(name, role) {
      if (role === "host") return true;
      const o = this._perm.overrides[name];
      return this._perm.mode === "host" ? o === true : o !== false;
    }

    kickByName(name) {
      if (this.role !== "host") return null;
      for (const [connId, g] of this._roster) {
        if (g.name === name) {
          this.transport.send({ kind: "kicked" }, { to: connId });
          setTimeout(() => this.transport.kick(connId), 300); // let the message land first
          return connId;
        }
      }
      return null;
    }

    sendRotate(newCode) {
      this._send({ kind: "rotate", code: newCode, emittedAt: SP.now() });
    }

    requestSync() {
      if (this.role === "host") this._broadcastSyncNow();
      else this._send({ kind: "sync-request" });
    }

    _broadcastSyncNow(toConnId) {
      const msg = { kind: "sync-now", currentTime: this.adapter.getCurrentTime(),
                    paused: this.adapter.isPaused(), emittedAt: SP.now() };
      this._send(msg, toConnId ? { to: toConnId } : undefined);
    }

    sendAdStart() {
      this._selfAd = true;
      this._send({ kind: "ad-start", name: this._name || "Someone" });
    }
    sendAdEnd() {
      this._selfAd = false;
      this._send({ kind: "ad-end", name: this._name || "Someone",
                   currentTime: this.adapter.getCurrentTime(), emittedAt: SP.now() });
      // Catch-all after the ad: adopt the party's true state rather than
      // blind-playing (blind play resurrected pauses the party wanted).
      setTimeout(() => {
        if (this._selfAd || !this.connected) return; // next ad in the pod started
        if (this.role === "host") {
          if (this.adapter.isPaused() && this._adPeers.size === 0) {
            this.adapter.suppress("play", "playing", "waiting");
            this.adapter.play();
          }
          this._broadcastSyncNow();
        } else {
          this.requestSync();
        }
      }, 800);
    }

    _activity(text) {
      if (this._settings.notifyActions) this._fire("activity", { text });
    }

    // A user scrub emits pause -> seeked -> play as separate events.
    _deferPlayPause(kind, ev) {
      clearTimeout(this._deferTimer);
      this._deferred = { kind, ev };
      this._deferTimer = setTimeout(() => this._flushDeferred(), 350);
    }
    _flushDeferred() {
      clearTimeout(this._deferTimer);
      this._deferTimer = null;
      const d = this._deferred;
      this._deferred = null;
      if (!d || !this.connected) return;
      const me = this._name || "Someone";
      this._send({ kind: d.kind, name: me, currentTime: d.ev.currentTime, emittedAt: d.ev.emittedAt });
      this._activity(d.kind === "play" ? "You started playing." : "You paused.");
    }
    _cancelDeferred() {
      clearTimeout(this._deferTimer);
      this._deferTimer = null;
      this._deferred = null;
    }

    // Clear everything derived from peers/old context.
    resetPeerTransient() {
      this._adPeers.clear();
      this._pausedForAd = false;
      this._peerBuffering = false;
      this._peerBufferingSince = 0;
      this._selfBuffering = false;
      this._endNudge();
    }

    _expireStaleFlags() {
      const now = SP.now();
      for (const [name, ts] of this._adPeers) {
        if (now - ts > 180000) { this._adPeers.delete(name); SP.log("expired stale ad flag for", name); }
      }
      if (this._peerBuffering && now - this._peerBufferingSince > 30000) {
        SP.log("clearing stuck peer-buffering flag");
        this._peerBuffering = false;
      }
    }

    _adRecalc() {
      this._expireStaleFlags();
      const names = Array.from(this._adPeers.keys());
      this._fire("adPeers", names);
      if (names.length && !this._selfAd && this._settings.adPause) {
        if (!this.adapter.isPaused()) {
          this.adapter.suppress("pause");
          this.adapter.pause();
          this._pausedForAd = true;
        }
        this._activity(names.length > 2 ? "Ads are playing for several people - waiting..."
                                        : "Ads are playing for " + names.join(", ") + " - waiting...");
      }
    }
    _self() { return { name: this._name || "Me", platform: this.adapter.name, role: this.role }; }

    getMembers() {
      if (this.role === "host") {
        const list = [Object.assign({}, this._self(), { role: "host", canControl: true })];
        for (const [connId, g] of this._roster) {
          list.push({ name: g.name, platform: g.platform, role: "guest",
                      connId, canControl: this._canControl(g.name, "guest") });
        }
        return list;
      }
      return this._lastRoster;
    }

    // connection lifecycle

    _onHostReady() {
      this.role = "host";
      this.connected = true;
      this.resetPeerTransient();
      this._startHeartbeat();
    }

    _onConnOpen(connId) {
      // new guest connected to us (host)
      this._connClocks.set(connId, { offset: 0, pings: [] });
      this._syncClocksWith(connId);
      this.transport.send({ kind: "hello", name: this._name || "Host", v: SP.VERSION,
                            platform: this.adapter.name, role: "host" }, { to: connId });
      this._fire("status", { state: "connected", role: this.role });
    }

    _onConnClosed(connId) {
      this._connClocks.delete(connId);
      const info = this._roster.get(connId);
      if (this._roster.delete(connId)) {
        if (info) {
          this._fire("memberLeft", info);
          this._adPeers.delete(info.name); // don't stay paused for someone who left
        }
        this._broadcastRoster();
      }
      if (this._roster.size === 0) {
        this.resetPeerTransient();
        this._fire("status", { state: "waiting", role: this.role });
      }
    }

    _onGuestConnected(m) {
      this.role = "guest";
      this.connected = true;
      this._fire("status", { state: "connected", role: this.role });
      this.resetPeerTransient();
      this._joinQuietUntil = SP.now() + 8000;
      this._pings = [];
      this._syncClocksWith(null);
      this._send({ kind: "hello", name: this._name || "Guest", v: SP.VERSION,
                   platform: this.adapter.name, role: "guest" });
      // If we're mid-ad (a pre-roll right after joining), tell the party; the earlier
      // attempt was dropped while the channel wasn't open yet.
      if (this._selfAd) this._send({ kind: "ad-start", name: this._name || "Someone" });
    }

    _onPeerLeft() {
      // guest side: lost the host
      this.connected = false;
      this._fire("status", { state: "peer-left", role: this.role });
    }

    leave() {
      this._cancelDeferred();
      this.connected = false;
      this._stopHeartbeat();
      this._roster.clear();
      this._connClocks.clear();
    }

    sendChat(text) {
      const msg = { kind: "chat", text: String(text).slice(0, 500),
                    name: this._name || "Me", emittedAt: SP.now() };
      this._send(msg);
      return msg;
    }

    sendNavigate(href) {
      this._navGraceUntil = SP.now() + SP.NAV_GRACE_MS;
      this.resetPeerTransient();
      this._send({ kind: "navigate", href, name: this._name || "Someone", emittedAt: SP.now() });
    }

    _send(msg, opts) {
      if (!this.connected) return;
      this.transport.send(msg, opts);
    }

    _relay(msg, exceptConnId) {
      if (this.role !== "host") return;
      this.transport.send(msg, { except: exceptConnId });
    }

    _broadcastRoster() {
      const members = this.getMembers();
      this._send({ kind: "roster", members });
      this._fire("roster", members);
    }

    // clock sync

    _syncClocksWith(connId) {
      for (let i = 0; i < SP.CLOCK_PINGS; i++) {
        setTimeout(() => {
          this._send({ kind: "ping", seq: ++this._pingSeq, t0: SP.now() },
                     connId ? { to: connId } : undefined);
        }, i * 200);
      }
    }

    _onPong(m, connId) {
      const t2 = SP.now();
      const rtt = t2 - m.t0;
      const offset = m.t1 - (m.t0 + rtt / 2); // remote - local
      if (this.role === "host") {
        const c = this._connClocks.get(connId);
        if (!c) return;
        c.pings.push(offset);
        const sorted = c.pings.slice().sort((a, b) => a - b);
        c.offset = sorted[Math.floor(sorted.length / 2)];
      } else {
        this._pings.push(offset);
        const sorted = this._pings.slice().sort((a, b) => a - b);
        this._clockOffset = sorted[Math.floor(sorted.length / 2)];
      }
    }

    _elapsed(remoteEmittedAt, connId) {
      const offset = (this.role === "host")
        ? ((this._connClocks.get(connId) || {}).offset || 0)
        : this._clockOffset;
      const localEmit = remoteEmittedAt - offset;
      return Math.max(0, SP.now() - localEmit) / 1000;
    }

    // local player events -> outgoing messages

    _onLocalEvent(ev) {
      if (ev.type === "videochange" || ev.type === "videolost") {
        this._fire("status", { state: this.connected ? "connected" : "idle",
                               role: this.role, video: this.adapter.isActive() });
        return;
      }
      if (!this.connected || !this.adapter.isActive()) return;

      // While an ad plays locally, the player fires pause/play/seek and
      // waiting/playing storms - none of it may leak to the party (a leaked
      // 'resume' from ad buffering cleared everyone's paused-for-ad state).
      if (ev.type === "durationchange") { this._fire("durationchange", {}); return; }
      if (this._selfAd) return;
      // Just joined: adopt the party's state instead of broadcasting our
      // player's autoplay/initial events at everyone.
      if (this.role === "guest" && SP.now() < this._joinQuietUntil &&
          (ev.type === "play" || ev.type === "pause" || ev.type === "seeked")) return;

      const me = this._name || "Someone";
      switch (ev.type) {
        case "play":
        case "pause":
          this._deferPlayPause(ev.type, ev);
          break;
        case "seeked": {
          // The pause/play flanking a scrub are part of the seek - drop them.
          this._cancelDeferred();
          const nowMs = SP.now();
          if (nowMs - this._lastSeekSentAt < 400) break; // rate-limit scrub storms
          this._lastSeekSentAt = nowMs;
          this._send({ kind: "seek", name: me, currentTime: ev.currentTime,
                       paused: ev.paused, emittedAt: ev.emittedAt });
          this._activity("You skipped to " + SP.fmtTime(ev.currentTime) + ".");
          break;
        }
        case "waiting":
          this._flushDeferred(); // don't let a held pause/play jump the queue
          if (!this._selfBuffering && !ev.paused) {
            this._selfBuffering = true;
            this._send({ kind: "buffering" });
            this._fire("status", { state: "buffering-self", role: this.role });
          }
          break;
        case "playing":
          if (this._selfBuffering) {
            this._selfBuffering = false;
            this._send({ kind: "resume", currentTime: this.adapter.getCurrentTime(),
                         emittedAt: SP.now() });
            this._fire("status", { state: "connected", role: this.role });
          }
          break;
        case "ended":
          this._cancelDeferred();
          this._send({ kind: "pause", name: me, currentTime: ev.currentTime, emittedAt: ev.emittedAt });
          break;
      }
    }

    // incoming messages -> applied to local player

    _onMessage(msg, connId) {
      if (!msg || !msg.kind) return;
      switch (msg.kind) {
        case "ping":
          this.transport.send({ kind: "pong", seq: msg.seq, t0: msg.t0, t1: SP.now() },
                              connId ? { to: connId } : undefined);
          break;
        case "pong": this._onPong(msg, connId); break;

        case "hello": {
          if (msg.v && msg.v !== SP.VERSION) {
            this._fire("versionMismatch", { theirs: msg.v || "pre-1.3", ours: SP.VERSION, name: msg.name });
          }
          if (this.role === "host") {
            this._roster.set(connId, { name: msg.name, platform: msg.platform });
            this._fire("peerInfo", msg);
            this._broadcastRoster();
            // Bring the newcomer to whatever we're already watching.
            if (this.adapter.isActive()) {
              this.transport.send({ kind: "navigate", href: cleanUrl(),
                                    name: this._name || "Host", emittedAt: SP.now() },
                                  { to: connId });
            }
            // Snap them to the party's exact position & play state right away
            // (their autoplay must not win; heartbeat alone takes 4s).
            this._broadcastSyncNow(connId);
            // Tell them about ads in progress (theirs arrive via their hello).
            if (this._selfAd) this.transport.send({ kind: "ad-start", name: this._name || "Host" }, { to: connId });
            for (const name of this._adPeers.keys()) {
              this.transport.send({ kind: "ad-start", name }, { to: connId });
            }
          } else {
            this._fire("peerInfo", msg);
          }
          break;
        }

        case "roster":
          this._lastRoster = msg.members || [];
          this._fire("roster", this._lastRoster);
          break;

        case "chat":
          this._fire("chat", msg);
          this._relay(msg, connId);
          break;

        case "sync-request":
          if (this.role === "host") this._broadcastSyncNow();
          break;

        case "sync-now": {
          if (this._selfAd) break; // never yank an ad; we resync after it
          const target = msg.paused ? msg.currentTime
                       : msg.currentTime + this._elapsed(msg.emittedAt, connId);
          this.adapter.suppress("seeking", "seeked", "waiting", "playing", "play", "pause");
          this.adapter.seek(target);
          if (msg.paused && !this.adapter.isPaused()) this.adapter.pause();
          if (!msg.paused && this.adapter.isPaused()) this.adapter.play();
          this._fire("activity", { text: "Synced everyone to " + SP.fmtTime(target) + "." });
          break;
        }

        case "denied":
          if (!this._deniedNotified) {
            this._deniedNotified = true;
            this._fire("denied", {});
          }
          break;

        case "rotate":
          this._fire("rotate", { code: msg.code });
          break;

        case "kicked":
          this._fire("kicked", {});
          break;

        case "ad-start": {
          if (msg.name && msg.name !== this._name) this._adPeers.set(msg.name, SP.now());
          this._relay(msg, connId);
          this._adRecalc();
          break;
        }
        case "ad-end": {
          if (msg.name) this._adPeers.delete(msg.name);
          this._relay(msg, connId);
          if (this._adPeers.size === 0) {
            this._activity("Ads finished for " + (msg.name || "everyone") + " - resuming.");
            if (this._pausedForAd) {
              this._pausedForAd = false;
              const target = msg.currentTime + this._elapsed(msg.emittedAt, connId);
              this.adapter.suppress("seeking", "seeked", "play", "playing", "waiting");
              if (Math.abs(this.adapter.getCurrentTime() - target) > 0.75) this.adapter.seek(target);
              this.adapter.play();
            }
          } else {
            this._adRecalc();
          }
          break;
        }

        case "navigate": {
          if (this.role === "host" && !this._allowedControl(msg, connId)) break;
          this._relay(msg, connId);       // relay before we might reload away
          this.resetPeerTransient();      // old video's ad/buffer flags are meaningless now
          this._fire("navigate", msg);
          break;
        }

        case "play": {
          if (this.role === "host" && !this._allowedControl(msg, connId)) break;
          if (this._selfAd) break; // don't yank our ad around; we resync after
          const target = msg.currentTime + this._elapsed(msg.emittedAt, connId);
          this.adapter.suppress("play", "playing", "waiting");
          if (Math.abs(this.adapter.getCurrentTime() - target) > 0.5) {
            this.adapter.suppress("seeking", "seeked");
            this.adapter.seek(target);
          }
          this.adapter.play();
          this._relay({ kind: "play", name: msg.name, currentTime: target, emittedAt: SP.now() }, connId);
          if (msg.name) this._activity(msg.name + " started playing.");
          break;
        }
        case "pause": {
          if (this.role === "host" && !this._allowedControl(msg, connId)) break;
          if (this._selfAd) break;
          this.adapter.suppress("pause");
          this.adapter.pause();
          if (Math.abs(this.adapter.getCurrentTime() - msg.currentTime) > 0.3) {
            this.adapter.suppress("seeking", "seeked", "waiting");
            this.adapter.seek(msg.currentTime);
          }
          this._relay({ kind: "pause", name: msg.name, currentTime: msg.currentTime, emittedAt: SP.now() }, connId);
          if (msg.name) this._activity(msg.name + " paused.");
          break;
        }
        case "seek": {
          if (this.role === "host" && !this._allowedControl(msg, connId)) break;
          if (this._selfAd) break;
          const target = msg.paused
            ? msg.currentTime
            : msg.currentTime + this._elapsed(msg.emittedAt, connId);
          this.adapter.suppress("seeking", "seeked", "waiting", "playing", "play", "pause");
          this.adapter.seek(target);
          if (msg.paused && !this.adapter.isPaused()) this.adapter.pause();
          if (!msg.paused && this.adapter.isPaused()) this.adapter.play();
          this._relay({ kind: "seek", name: msg.name, currentTime: target, paused: msg.paused,
                        emittedAt: SP.now() }, connId);
          if (msg.name) this._activity(msg.name + " skipped to " + SP.fmtTime(target) + ".");
          break;
        }
        case "buffering": {
          this._relay(msg, connId);
          if (!this._settings.bufferPause) break; // user opted out of buffer-pausing
          this._peerBuffering = true;
          this._peerBufferingSince = SP.now();
          if (!this.adapter.isPaused()) {
            this.adapter.suppress("pause");
            this.adapter.pause();
          }
          this._fire("status", { state: "buffering-peer", role: this.role });
          break;
        }
        case "resume": {
          this._relay({ kind: "resume", currentTime: msg.currentTime + this._elapsed(msg.emittedAt, connId),
                        emittedAt: SP.now() }, connId);
          if (!this._peerBuffering) break; // we never paused (toggle off or already fine)
          this._peerBuffering = false;
          const target = msg.currentTime + this._elapsed(msg.emittedAt, connId);
          this.adapter.suppress("seeking", "seeked", "play", "playing", "waiting");
          this.adapter.seek(target);
          this.adapter.play();
          this._fire("status", { state: "connected", role: this.role });
          break;
        }
        case "heartbeat": this._onHeartbeat(msg); break;
      }
    }

    // Host: check sender's permission; if denied, tell them and re-align them.
    _allowedControl(msg, connId) {
      const g = this._roster.get(connId);
      const name = (g && g.name) || msg.name;
      if (this._canControl(name, "guest")) return true;
      this.transport.send({ kind: "denied" }, { to: connId });
      this._broadcastSyncNow(connId); // snap them back to the party state
      return false;
    }

    // heartbeat & drift correction (host = authority)

    _startHeartbeat() {
      this._stopHeartbeat();
      this._hbTimer = setInterval(() => {
        if (!this.connected || this.role !== "host") return;
        this._expireStaleFlags();
        if (this._roster.size === 0) return;
        if (!this.adapter.isActive()) return;
        if (this._selfBuffering || this._peerBuffering) return;
        if (this._selfAd || this._adPeers.size) return; // positions diverge during ads
        this._send({
          kind: "heartbeat",
          currentTime: this.adapter.getCurrentTime(),
          paused: this.adapter.isPaused(),
          href: cleanUrl(),
          emittedAt: SP.now()
        });
      }, SP.HEARTBEAT_MS);
    }
    _stopHeartbeat() {
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
      this._endNudge();
    }

    _onHeartbeat(msg) {
      // Guest side: measure drift against the host and correct.
      if (this.role !== "guest") return;

      // Safety net: if the host is on a different page (we missed a navigate,
      // e.g. it raced a reload), follow after a few consistent mismatches.
      if (msg.href && msg.href !== cleanUrl()) {
        let sameOrigin = false;
        try { sameOrigin = new URL(msg.href).origin === location.origin; } catch (_) {}
        if (sameOrigin && SP.now() > this._navGraceUntil) {
          if (++this._hrefMismatch >= SP.NAV_HB_MISMATCH) {
            this._hrefMismatch = 0;
            this._fire("navigate", { href: msg.href, name: "the host" });
          }
        }
        return; // never drift-correct against a different video
      }
      this._hrefMismatch = 0;

      this._expireStaleFlags();
      if (!this.adapter.isActive() || this._selfBuffering || this._peerBuffering) return;
      if (this._selfAd || this._adPeers.size) return;

      if (msg.paused !== this.adapter.isPaused()) {
        if (msg.paused) {
          this.adapter.suppress("pause");
          this.adapter.pause();
          this.adapter.suppress("seeking", "seeked");
          this.adapter.seek(msg.currentTime);
        } else {
          this.adapter.suppress("play", "playing", "waiting", "seeking", "seeked");
          this.adapter.seek(msg.currentTime + this._elapsed(msg.emittedAt, null));
          this.adapter.play();
        }
        return;
      }
      if (msg.paused) return;

      const target = msg.currentTime + this._elapsed(msg.emittedAt, null);
      const drift = this.adapter.getCurrentTime() - target; // + = we're ahead

      // Race guard: if our bound video is short (ad-length) and drift is
      // enormous, we're almost certainly inside an ad the detector hasn't
      // flagged yet - do not seek/pause the ad.
      const localDur = this.adapter.getDuration();
      if (localDur > 0 && localDur < SP.AD_SHORT_S && Math.abs(drift) > 30) return;

      this._fire("drift", drift);

      if (Math.abs(drift) < SP.DRIFT_IGNORE_S) { this._endNudge(); return; }
      if (Math.abs(drift) >= SP.DRIFT_HARD_S) {
        this._endNudge();
        SP.log("hard resync, drift", drift.toFixed(2));
        this.adapter.suppress("seeking", "seeked", "waiting", "playing");
        this.adapter.seek(target);
        return;
      }
      this._beginNudge(drift);
    }

    _beginNudge(drift) {
      const rate = drift > 0 ? (1 - SP.NUDGE_RATE) : (1 + SP.NUDGE_RATE);
      const ok = this.adapter.setRate(rate);
      if (!ok) {
        this.adapter.suppress("seeking", "seeked", "waiting");
        this.adapter.seek(this.adapter.getCurrentTime() - drift);
        return;
      }
      this._nudging = true;
      const needMs = Math.min(Math.abs(drift) / SP.NUDGE_RATE * 1000, SP.NUDGE_MAX_MS);
      clearTimeout(this._nudgeResetTimer);
      this._nudgeResetTimer = setTimeout(() => this._endNudge(), needMs);
    }

    _endNudge() {
      clearTimeout(this._nudgeResetTimer);
      this._nudgeResetTimer = null;
      if (this._nudging) {
        this._nudging = false;
        this.adapter.setRate(1);
      }
    }
  }

  SP.SyncEngine = SyncEngine;
})();
