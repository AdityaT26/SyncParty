// Toolbar popup. A thin UI over the content script in the active tab.
"use strict";

const $ = (id) => document.getElementById(id);
let tabId = null;
// Baseline defaults ship in default_settings.json (single source of truth);
// this inline copy is only the fallback if that file can't be read.
let SETTINGS = { chatLayout: "float", sidebarPush: true, notifyActions: true, adPause: true,
                 bufferPause: true, controlMode: "everyone", controlOverrides: {} };

async function loadDefaults() {
  try {
    const resp = await fetch(chrome.runtime.getURL("default_settings.json"));
    const d = await resp.json();
    for (const k of Object.keys(SETTINGS)) if (k in d) SETTINGS[k] = d[k];
  } catch (_) {}
}

function send(cmd, extra) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, Object.assign({ sp: true, cmd }, extra || {}), (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

function saveSettings() {
  return chrome.storage.local.set({ spSettings: SETTINGS });
}

function show(panelId) {
  for (const id of ["unsupported", "idle", "active"]) $(id).classList.add("hidden");
  $(panelId).classList.remove("hidden");
}

function render(st) {
  if (!st) { show("unsupported"); $("platform").textContent = ""; return; }

  $("platform").textContent = st.platform && st.platform !== "generic" ? st.platform : "";

  if (!st.active) {
    show("idle");
    $("videoStatus").textContent = st.videoFound
      ? "✓ Video detected on this page."
      : "No video detected in the page yet. If the player is embedded (or hasn't started), that's fine - create or join now and SyncParty will find it once the session starts.";
    if (st.error) { $("idleError").textContent = st.error; $("idleError").classList.remove("hidden"); }
    else $("idleError").classList.add("hidden");
    return;
  }

  show("active");
  const dot = $("stateDot"), txt = $("stateText"), codeBox = $("codeBox");
  codeBox.classList.toggle("hidden", !(st.role === "host" && st.code));
  if (st.code) $("codeText").textContent = st.code;

  const inviteBtn = $("inviteBtn");
  inviteBtn.classList.toggle("hidden", !st.inviteLink);
  inviteBtn.dataset.link = st.inviteLink || "";

  const members = st.members || [];
  const isHost = st.role === "host";
  $("membersBox").classList.toggle("hidden", members.length === 0);
  $("hostHint").classList.toggle("hidden", !(isHost && members.length > 1));
  const ul = $("members");
  ul.innerHTML = "";
  for (const m of members) {
    const li = document.createElement("li");
    const mdot = document.createElement("span"); mdot.className = "mDot";
    const name = document.createElement("span");
    name.textContent = m.name + (m.platform && m.platform !== "generic" ? " - " + m.platform : "");
    li.appendChild(mdot); li.appendChild(name);
    if (m.role === "host") {
      const tag = document.createElement("span"); tag.className = "mRole"; tag.textContent = "host";
      li.appendChild(tag);
    } else if (isHost) {
      // Host tools: per-member control toggle + kick.
      const ctl = document.createElement("button");
      ctl.className = "mBtn" + (m.canControl ? "" : " denied");
      ctl.textContent = "\u{1F3AE}";
      ctl.title = m.canControl ? "Click to DENY " + m.name + " playback control"
                               : "Click to ALLOW " + m.name + " playback control";
      ctl.style.marginLeft = "auto";
      ctl.addEventListener("click", async () => {
        const allow = !m.canControl;
        if (SETTINGS.controlMode === "host") {
          if (allow) SETTINGS.controlOverrides[m.name] = true;
          else delete SETTINGS.controlOverrides[m.name];
        } else {
          if (allow) delete SETTINGS.controlOverrides[m.name];
          else SETTINGS.controlOverrides[m.name] = false;
        }
        await saveSettings();
        setTimeout(refresh, 400);
      });
      const kick = document.createElement("button");
      kick.className = "mBtn kick";
      kick.textContent = "×";
      kick.title = "Remove " + m.name + " from the party (party code rotates so they can't rejoin)";
      kick.addEventListener("click", async () => {
        kick.disabled = true;
        render(await send("kick", { name: m.name }));
      });
      li.appendChild(ctl); li.appendChild(kick);
    }
    ul.appendChild(li);
  }

  const map = {
    "waiting":        ["warn", st.role === "host" ? "Waiting for friends to join..." : "Connecting to room..."],
    "reconnecting":   ["warn", "Re-syncing..."],
    "connected":      ["ok", "Connected & syncing"],
    "buffering-self": ["warn", "You're buffering - party paused"],
    "buffering-peer": ["warn", "Someone is buffering - paused"],
    "peer-left":      ["bad", "Disconnected"],
    "error":          ["bad", st.error || "Connection error"]
  };
  const [k, t] = map[st.state] || ["", st.state];
  dot.className = "dot " + k;
  txt.textContent = t;
}

async function refresh() {
  render(await send("get-status"));
}

function bindSettingsControls() {
  $("setLayout").value = SETTINGS.chatLayout;
  $("setPush").checked = SETTINGS.sidebarPush !== false;
  $("setNotify").checked = SETTINGS.notifyActions !== false;
  $("setAdPause").checked = SETTINGS.adPause !== false;
  $("setBufPause").checked = SETTINGS.bufferPause !== false;
  $("setControlMode").value = SETTINGS.controlMode === "host" ? "host" : "everyone";

  $("setLayout").addEventListener("change", () => { SETTINGS.chatLayout = $("setLayout").value; saveSettings(); });
  $("setPush").addEventListener("change", () => { SETTINGS.sidebarPush = $("setPush").checked; saveSettings(); });
  $("setNotify").addEventListener("change", () => { SETTINGS.notifyActions = $("setNotify").checked; saveSettings(); });
  $("setAdPause").addEventListener("change", () => { SETTINGS.adPause = $("setAdPause").checked; saveSettings(); });
  $("setBufPause").addEventListener("change", () => { SETTINGS.bufferPause = $("setBufPause").checked; saveSettings(); });
  $("setControlMode").addEventListener("change", () => {
    SETTINGS.controlMode = $("setControlMode").value;
    SETTINGS.controlOverrides = {}; // fresh slate when switching modes
    saveSettings();
    setTimeout(refresh, 400);
  });
}

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) { show("unsupported"); return; }
  tabId = tabs[0].id;

  const TURNCFG = (typeof SYNCPARTY_TURN_CONFIG !== "undefined") ? SYNCPARTY_TURN_CONFIG : { ASK_USER_API: true };
  if (TURNCFG.ASK_USER_API === false) $("relaySettings").remove();

  await loadDefaults();
  const saved = await chrome.storage.local.get(["displayName", "turnAppName", "turnApiKey", "spSettings"]);
  if (saved.displayName) $("name").value = saved.displayName;
  if (saved.spSettings) Object.assign(SETTINGS, saved.spSettings); // user choices override defaults
  bindSettingsControls();

  if (TURNCFG.ASK_USER_API !== false) {
    if (saved.turnAppName) $("turnAppName").value = saved.turnAppName;
    if (saved.turnApiKey) $("turnApiKey").value = saved.turnApiKey;
    if (saved.turnAppName && saved.turnApiKey) $("turnStatus").textContent = "TURN relay configured ✓";

    $("helpLink").addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("help/guide.html") });
    });

    $("turnSaveBtn").addEventListener("click", async () => {
      const turnAppName = $("turnAppName").value.trim().replace(/^https?:\/\//, "").split(".")[0];
      const turnApiKey = $("turnApiKey").value.trim();
      await chrome.storage.local.set({ turnAppName, turnApiKey });
      $("turnAppName").value = turnAppName;
      $("turnStatus").textContent = (turnAppName && turnApiKey)
        ? "Saved ✓ - takes effect when you next create/join a room."
        : "Cleared - back to direct connections only.";
    });

    $("turnTestBtn").addEventListener("click", async () => {
      const app = $("turnAppName").value.trim().replace(/^https?:\/\//, "").split(".")[0];
      const key = $("turnApiKey").value.trim();
      const out = $("turnStatus");
      if (!app || !key) { out.textContent = "Enter both the app name and API key first."; return; }
      out.textContent = "Testing...";
      try {
        const resp = await fetch("https://" + encodeURIComponent(app) +
          ".metered.live/api/v1/turn/credentials?apiKey=" + encodeURIComponent(key));
        const body = await resp.json().catch(() => null);
        if (resp.ok && Array.isArray(body) && body.length) {
          const relays = body.filter((s2) => String(s2.urls).startsWith("turn")).length;
          await chrome.storage.local.set({ turnAppName: app, turnApiKey: key });
          out.textContent = "✓ Working! Got " + relays + " relay server(s). Saved - next session will use them.";
        } else if (body && body.error) {
          out.textContent = "✗ Rejected: " + body.error + ". Use the TURN API key from the guide (not the Developers-page secret key).";
        } else {
          out.textContent = "✗ Failed (HTTP " + resp.status + "). Check the app name - just the subdomain, e.g. \"syncparty\".";
        }
      } catch (e) {
        out.textContent = "✗ Network error: " + (e && e.message || e) + ". Check the app name spelling.";
      }
    });
  }

  $("createBtn").addEventListener("click", async () => {
    const name = $("name").value.trim() || "Host";
    await chrome.storage.local.set({ displayName: name });
    render(await send("create-room", { name }));
  });

  $("joinBtn").addEventListener("click", async () => {
    const name = $("name").value.trim() || "Guest";
    await chrome.storage.local.set({ displayName: name });
    render(await send("join-room", { name, code: $("joinCode").value }));
  });
  $("joinCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinBtn").click();
  });

  $("copyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText($("codeText").textContent).then(() => {
      $("copyBtn").textContent = "Copied!";
      setTimeout(() => { $("copyBtn").textContent = "Copy"; }, 1200);
    });
  });

  $("inviteBtn").addEventListener("click", async () => {
    // Re-fetch right now so the link always carries the current video URL
    // (episode switches update it live).
    const st = await send("get-status");
    const link = (st && st.inviteLink) || $("inviteBtn").dataset.link;
    if (!link) return;
    navigator.clipboard.writeText(link).then(() => {
      $("inviteBtn").textContent = "Invite link copied!";
      setTimeout(() => { $("inviteBtn").textContent = "Copy invite link"; }, 1400);
    });
  });

  $("syncNowBtn").addEventListener("click", () => send("sync-now"));
  $("overlayBtn").addEventListener("click", () => send("show-overlay"));
  $("leaveBtn").addEventListener("click", async () => render(await send("leave")));

  await refresh();
  setInterval(refresh, 1500);
}

init();
