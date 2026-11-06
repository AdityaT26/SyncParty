// In-page overlay: status pill, chat, and the docked sidebar.
// Lives in a closed shadow root so page CSS can't reach it.
"use strict";
(function () {
  const SP = window.__SP;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
    .wrap {
      position: fixed; top: 14px; right: 14px; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      transition: opacity .3s ease;
    }
    .wrap.fs-hidden { opacity: 0; pointer-events: none; }
    .pill {
      display: flex; align-items: center; gap: 8px;
      background: rgba(17, 17, 27, .92); color: #eee;
      border: 1px solid rgba(255,255,255,.14); border-radius: 999px;
      padding: 7px 12px; font-size: 12.5px; line-height: 1;
      box-shadow: 0 4px 18px rgba(0,0,0,.45); cursor: default; user-select: none;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex: none; }
    .dot.ok { background: #34d399; } .dot.warn { background: #fbbf24; } .dot.bad { background: #f87171; }
    .code { font-weight: 700; letter-spacing: 1px; color: #c4b5fd; cursor: pointer; }
    .code:hover { text-decoration: underline; }
    .count { color: #9ca3af; font-size: 12px; }
    .roster {
      padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.12);
      color: #9ca3af; font-size: 11.5px; line-height: 1.4;
    }
    .roster b { color: #c4b5fd; font-weight: 600; }
    /* Docked sidebar. Overlays the page edge; hidden
       automatically in fullscreen since the fullscreen element covers it. */
    .wrap.dock {
      top: 0; bottom: 0; gap: 0; align-items: stretch; width: 300px;
    }
    .wrap.dock-right { right: 0; left: auto; }
    .wrap.dock-left { left: 0; right: auto; }
    .wrap.dock .pill {
      border-radius: 0; width: 100%; padding: 12px;
      background: rgba(13, 13, 20, .98); border: none;
      border-bottom: 1px solid rgba(255,255,255,.12);
    }
    .wrap.dock-left .pill { border-right: 1px solid rgba(255,255,255,.12); }
    .wrap.dock-right .pill { border-left: 1px solid rgba(255,255,255,.12); }
    .wrap.dock .chat {
      display: flex; flex: 1; width: 100%; max-height: none;
      border-radius: 0; border: none;
      background: rgba(13, 13, 20, .98);
    }
    .wrap.dock-left .chat { border-right: 1px solid rgba(255,255,255,.12); }
    .wrap.dock-right .chat { border-left: 1px solid rgba(255,255,255,.12); }
    .wrap.dock .msgs { max-height: none; flex: 1; }
    .wrap.dock.collapsed { bottom: auto; width: auto; }
    .wrap.dock.collapsed .pill {
      border-radius: 999px; border: 1px solid rgba(255,255,255,.14);
      margin: 14px; width: auto; background: rgba(17,17,27,.92);
    }
    .wrap.dock.collapsed .chat { display: none; }
    .btn {
      background: none; border: none; color: #aaa; cursor: pointer;
      font-size: 13px; padding: 2px 4px; border-radius: 4px;
    }
    .btn:hover { color: #fff; background: rgba(255,255,255,.12); }
    .chat {
      width: 280px; max-height: 320px; display: none; flex-direction: column;
      background: rgba(17, 17, 27, .95); color: #eee;
      border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,.5); overflow: hidden;
    }
    .chat.open { display: flex; }
    .msgs { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; min-height: 60px; max-height: 240px; }
    .msg { font-size: 12.5px; line-height: 1.35; word-wrap: break-word; }
    .msg .who { font-weight: 700; color: #c4b5fd; margin-right: 5px; }
    .msg.sys { color: #9ca3af; font-style: italic; }
    .inp { display: flex; border-top: 1px solid rgba(255,255,255,.12); }
    .inp input {
      flex: 1; background: none; border: none; outline: none; color: #eee;
      padding: 9px 10px; font-size: 12.5px;
    }
    .inp button {
      background: none; border: none; color: #c4b5fd; font-weight: 700;
      cursor: pointer; padding: 0 12px; font-size: 12.5px;
    }
  `;

  class Overlay {
    constructor() {
      this._root = null;
      this._els = {};
      this._onSend = null;
      this._onCodeClick = null;
      this._onSyncNow = null;
      this._onLayoutChange = null;
      this._layout = "float";
      this._push = true;
      this._visible = false;
      this._unread = 0;
      this._fsIdleTimer = null;
      this._fsMoveHandler = null;
      this._pushVerifyT = null;
      this._sheetGuard = null;
      this._nonFsScale = false;
      this._fsMode = "native";
      this._fsHandler = () => this._onFullscreenChange();
    }

    mount() {
      if (this._root) return;
      const hostEl = document.createElement("div");
      hostEl.id = "syncparty-overlay-host";
      const shadow = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);

      const wrap = document.createElement("div");
      wrap.className = "wrap";
      wrap.innerHTML = `
        <div class="pill">
          <span class="dot"></span>
          <span class="label">SyncParty</span>
          <span class="code" title="Copy invite link"></span>
          <span class="count" title="People connected"></span>
          <button class="btn syncBtn" title="Sync everyone now">&#8635;</button>
          <button class="btn layoutBtn" title="Chat layout: floating / right bar / left bar">&#10697;</button>
          <button class="btn chatBtn" title="Chat">&#128172;</button>
          <button class="btn closeBtn" title="Hide (reopen from the toolbar popup)">&times;</button>
        </div>
        <div class="chat">
          <div class="roster"></div>
          <div class="msgs"></div>
          <div class="inp">
            <input type="text" maxlength="500" placeholder="Message...">
            <button class="sendBtn">Send</button>
          </div>
        </div>`;
      shadow.appendChild(wrap);
      document.documentElement.appendChild(hostEl); // on <html>: body transforms can't touch it

      this._root = hostEl;
      this._els = {
        dot: wrap.querySelector(".dot"),
        label: wrap.querySelector(".label"),
        code: wrap.querySelector(".code"),
        count: wrap.querySelector(".count"),
        roster: wrap.querySelector(".roster"),
        chat: wrap.querySelector(".chat"),
        chatBtn: wrap.querySelector(".chatBtn"),
        msgs: wrap.querySelector(".msgs"),
        input: wrap.querySelector("input"),
        wrap
      };

      this._els.code.addEventListener("click", () => {
        if (this._onCodeClick) this._onCodeClick();
      });
      wrap.querySelector(".syncBtn").addEventListener("click", () => {
        if (this._onSyncNow) this._onSyncNow();
      });
      wrap.querySelector(".layoutBtn").addEventListener("click", () => {
        const order = ["float", "right", "left"];
        const next = order[(order.indexOf(this._layout) + 1) % order.length];
        this.setLayout(next);
        if (this._onLayoutChange) this._onLayoutChange(next);
      });
      this._applyLayout();
      wrap.querySelector(".closeBtn").addEventListener("click", () => this.hide());
      this._els.chatBtn.addEventListener("click", () => {
        const open = this._els.chat.classList.toggle("open");
        this._unread = 0;
        this._els.chatBtn.textContent = "\u{1F4AC}";
        this._els.wrap.classList.toggle("collapsed",
          !open && (this._layout === "right" || this._layout === "left"));
        this._applyPush();
        if (this._fsMoveHandler) this._fsMoveHandler(); // reset fade state in fullscreen
        if (open) this._els.input.focus();
      });
      const submit = () => {
        const text = this._els.input.value.trim();
        if (!text || !this._onSend) return;
        this._els.input.value = "";
        this._onSend(text);
      };
      wrap.querySelector(".sendBtn").addEventListener("click", submit);
      this._els.input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // don't trigger the site's hotkeys (space = pause etc.)
        if (e.key === "Enter") submit();
      });
      this._els.input.addEventListener("keyup", (e) => e.stopPropagation());
      this._els.input.addEventListener("keypress", (e) => e.stopPropagation());

      document.addEventListener("fullscreenchange", this._fsHandler);
      if (document.fullscreenElement) this._onFullscreenChange();
    }

    // fullscreen support
    // The overlay lives in <body>, which isn't rendered while another element
    // is fullscreen - so we reparent the host into the fullscreen element.
    _onFullscreenChange() {
      if (!this._root) return;
      this._fsMode = "native"; // re-learn capabilities per fullscreen session
      const fs = document.fullscreenElement;
      if (fs && fs !== this._root && fs.appendChild && fs.tagName !== "VIDEO") {
        // Become a direct child of the fullscreen element (works for the
        // document root too, e.g. YouTube) - visible, clickable, and excluded
        // from the child-scaling rule by our id.
        try { fs.appendChild(this._root); this._startFsAutoHide(fs); } catch (_) {}
      } else if (!fs) {
        this._stopFsAutoHide();
        try { document.documentElement.appendChild(this._root); } catch (_) {}
      }
      this._applyPush();
    }

    _startFsAutoHide(fsEl) {
      this._stopFsAutoHide();
      const wake = () => {
        this._els.wrap.classList.remove("fs-hidden");
        clearTimeout(this._fsIdleTimer);
        this._fsIdleTimer = setTimeout(() => {
          // Pinned = docked sidebar + push-aside + chat open: it occupies its
          // own strip of the screen, so it never fades.
          const typing = this.shadowActive && this.shadowActive();
          const pinned = this._pushWanted();
          if (!typing && !pinned) this._els.wrap.classList.add("fs-hidden");
        }, 3200);
      };
      this._fsMoveHandler = wake;
      fsEl.addEventListener("mousemove", wake, { passive: true });
      fsEl.addEventListener("touchstart", wake, { passive: true });
      this._fsSourceEl = fsEl;
      wake();
    }

    _stopFsAutoHide() {
      clearTimeout(this._fsIdleTimer);
      this._fsIdleTimer = null;
      if (this._fsSourceEl && this._fsMoveHandler) {
        this._fsSourceEl.removeEventListener("mousemove", this._fsMoveHandler);
        this._fsSourceEl.removeEventListener("touchstart", this._fsMoveHandler);
      }
      this._fsSourceEl = null;
      this._fsMoveHandler = null;
      if (this._els.wrap) this._els.wrap.classList.remove("fs-hidden");
    }

    shadowActive() {
      return this._els.input && this._els.input.matches(":focus");
    }

    show() {
      this.mount();
      this._visible = true;
      this._root.style.display = "";
      this._applyPush();
    }
    hide() {
      this._visible = false;
      if (this._root) this._root.style.display = "none";
      this._clearPush();
    }
    unmount() {
      this._visible = false;
      this._clearPush();
      this._stopFsAutoHide();
      document.removeEventListener("fullscreenchange", this._fsHandler);
      if (this._root) { this._root.remove(); this._root = null; }
    }
    onSend(fn) { this._onSend = fn; }
    onCodeClick(fn) { this._onCodeClick = fn; }
    onSyncNow(fn) { this._onSyncNow = fn; }
    onLayoutChange(fn) { this._onLayoutChange = fn; }

    setLayout(mode, push) {
      this._layout = (mode === "right" || mode === "left") ? mode : "float";
      if (push !== undefined) this._push = push !== false;
      this._nonFsScale = false;
      this._fsMode = "native";
      this._applyLayout();
    }

    _applyLayout() {
      if (!this._root) return;
      const w = this._els.wrap;
      w.classList.remove("dock", "dock-right", "dock-left", "collapsed");
      if (this._layout === "right" || this._layout === "left") {
        w.classList.add("dock", "dock-" + this._layout);
        this._els.chat.classList.add("open"); // docked chat starts visible
        this._unread = 0;
        this._els.chatBtn.textContent = "\u{1F4AC}";
      }
      this._applyPush();
    }

    // Push mode: shrink the page rather than shifting it.
    _pushWanted() {
      const visible = this._root && this._visible;
      const docked = this._layout === "right" || this._layout === "left";
      const open = this._els.chat && this._els.chat.classList.contains("open");
      return visible && docked && this._push && open;
    }

    // push engine
    // All page-shrinking styles live in an injected <style> sheet, never
    // inline: sites like Netflix wipe inline style attributes on every React
    // re-render, but they don't touch foreign stylesheets.

    _sheet() {
      let el = document.getElementById("__syncparty_push_style__");
      if (!el) {
        el = document.createElement("style");
        el.id = "__syncparty_push_style__";
        (document.head || document.documentElement).appendChild(el);
      }
      return el;
    }
    _setSheet(css) {
      const el = this._sheet();
      if (el.textContent !== css) el.textContent = css;
    }
    _removeSheet() {
      const el = document.getElementById("__syncparty_push_style__");
      if (el) el.remove();
    }

    _largestVideoRect() {
      let best = null;
      for (const v of document.querySelectorAll("video")) {
        const r = v.getBoundingClientRect();
        if (!best || r.width * r.height > best.width * best.height) best = r;
      }
      return best;
    }

    // Did the page actually clear the sidebar strip?
    _stripClear() {
      const W = window.innerWidth;
      const r = this._largestVideoRect();
      if (!r || r.width < 50) return true; // nothing to judge by
      return this._layout === "right" ? (r.right <= W - 300 + 60) : (r.left >= 300 - 60);
    }

    _transformCss(selector) {
      const W = Math.max(window.innerWidth, 640), H = window.innerHeight;
      const k = Math.max(0.5, (W - 300) / W);
      const tx = this._layout === "left" ? (1 - k) * W : 0;
      const ty = (1 - k) * H / 2;
      return selector + " { transform: translate(" + tx + "px, " + ty + "px) scale(" + k +
        ") !important; transform-origin: 0 0 !important; transition: none !important; }";
    }

    _applyPush() {
      clearTimeout(this._pushVerifyT);
      const want = this._pushWanted();
      const fs = document.fullscreenElement;
      // Signal fs-hijack.js (MAIN world): while present, sites' fullscreen
      // requests are redirected to the page root, where a native reflow works.
      try { document.documentElement.toggleAttribute("data-syncparty-push", want); } catch (_) {}
      if (!want) { this._clearPushStyles(); return; }

      if (fs && fs !== this._root && fs.tagName !== "VIDEO") {
        if (this._fsMode === "off") { this._removeSheet(); return; }
        const isRoot = fs === document.documentElement;
        if (isRoot && this._fsMode !== "children") {
          // native reflow: shrink the fullscreen root and anchor the site's
          // intended player box beside the sidebar. Full-height video, no
          // scaling, no letterbox.
          const side = this._layout === "left"
            ? "left: 300px !important; right: 0 !important;"
            : "left: 0 !important; right: 300px !important;";
          this._setSheet(
            ":root { position: relative !important; width: calc(100% - 300px) !important;" +
            " min-width: 0 !important; overflow-x: hidden !important; margin: 0 !important; }\n" +
            "[data-syncparty-fsroot] { position: fixed !important; top: 0 !important;" +
            " bottom: 0 !important; " + side + " width: auto !important;" +
            " height: auto !important; background: #000 !important; }");
        } else {
          // Children-scale fallback: the UA sheet pins the fullscreen element
          // itself, but not its children.
          this._setSheet(this._transformCss(":fullscreen > :not(#syncparty-overlay-host)"));
        }
        this._pushVerifyT = setTimeout(() => {
          if (this._stripClear()) return;
          if (isRoot && this._fsMode !== "children") {
            this._fsMode = "children"; // native reflow refused: scale instead
            this._applyPush();
          } else {
            this._fsMode = "off"; // nothing works here: interactive overlay
            this._removeSheet();
          }
        }, 700);
      } else if (!fs) {
        if (this._nonFsScale) {
          this._setSheet(this._transformCss("body"));
        } else {
          this._setSheet(
            ":root { position: relative !important; width: calc(100% - 300px) !important;" +
            " min-width: 0 !important; overflow-x: hidden !important;" +
            " margin-left: " + (this._layout === "left" ? "300px" : "0") + " !important;" +
            " margin-right: 0 !important; }");
          this._pushVerifyT = setTimeout(() => {
            if (!this._stripClear()) {
              // viewport-sized player ignoring:root width: escalate to a
              // compositor transform on <body> (our host lives on <html>).
              this._nonFsScale = true;
              this._applyPush();
            }
          }, 800);
        }
      } else {
        this._removeSheet();
      }

      if (!this._sheetGuard) {
        this._sheetGuard = setInterval(() => {
          // re-create the sheet if a site removed it; refresh on resize
          if (!this._pushWanted()) return;
          const el = document.getElementById("__syncparty_push_style__");
          if (!el && this._fsMode !== "off") this._applyPush();
        }, 2500);
      }
      this._fireResize();
    }

    _clearPushStyles() {
      clearTimeout(this._pushVerifyT);
      this._pushVerifyT = null;
      this._removeSheet();
      this._fireResize();
    }

    _clearPush() {
      this._clearPushStyles();
      try { document.documentElement.removeAttribute("data-syncparty-push"); } catch (_) {}
      if (this._sheetGuard) { clearInterval(this._sheetGuard); this._sheetGuard = null; }
      this._nonFsScale = false;
      this._fsMode = "native";
    }

    _fireResize() {
      // Players size themselves from JS on window resize; nudge them now and
      // once more after layout settles.
      try { window.dispatchEvent(new Event("resize")); } catch (_) {}
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => {
        try { window.dispatchEvent(new Event("resize")); } catch (_) {}
      }, 350);
    }

    setRoster(members, selfName) {
      if (!this._root) return;
      members = members || [];
      this._els.count.textContent = members.length > 1 ? "\u{1F465}" + members.length : "";
      if (!members.length) { this._els.roster.textContent = ""; return; }
      this._els.roster.innerHTML = "";
      const label = document.createElement("span");
      label.textContent = "Watching: ";
      this._els.roster.appendChild(label);
      members.forEach((m, i) => {
        const b = document.createElement("b");
        b.textContent = m.name
          + (m.role === "host" ? " (host)" : "")
          + (selfName && m.name === selfName ? " (you)" : "");
        this._els.roster.appendChild(b);
        if (i < members.length - 1) this._els.roster.appendChild(document.createTextNode(" \u00B7 "));
      });
    }

    setStatus(kind, text, code) {
      if (!this._root) return;
      this._els.dot.className = "dot " + kind;
      this._els.label.textContent = text;
      this._els.code.textContent = code ? " " + code : "";
    }

    addChat(who, text, sys) {
      if (!this._root) return;
      const div = document.createElement("div");
      div.className = "msg" + (sys ? " sys" : "");
      if (sys) {
        div.textContent = text;
      } else {
        const whoEl = document.createElement("span");
        whoEl.className = "who";
        whoEl.textContent = who + ":";
        div.appendChild(whoEl);
        div.appendChild(document.createTextNode(text));
      }
      this._els.msgs.appendChild(div);
      this._els.msgs.scrollTop = this._els.msgs.scrollHeight;
      if (!this._els.chat.classList.contains("open") && !sys) {
        this._unread++;
        this._els.chatBtn.textContent = `\u{1F4AC}(${this._unread})`;
      }
    }
  }

  SP.Overlay = Overlay;
})();
