import { PRIVYDECK_EXTENSION_CONFIG } from "./config.js";

const connectView = document.getElementById("connectView");
const dashView = document.getElementById("dashView");
const connBadge = document.getElementById("connBadge");
const tokenEl = document.getElementById("token");
const deviceNameEl = document.getElementById("deviceName");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const saveBtn = document.getElementById("saveBtn");
const syncBtn = document.getElementById("syncBtn");
const rulesBtn = document.getElementById("rulesBtn");
const scoreRing = document.getElementById("scoreRing");
const scoreValue = document.getElementById("scoreValue");
const scoreTrend = document.getElementById("scoreTrend");
const gamificationEl = document.getElementById("gamification");
const blockedPageEl = document.getElementById("blockedPage");
const blockedTotalEl = document.getElementById("blockedTotal");
const categoryBreakdownEl = document.getElementById("categoryBreakdown");
const siteBox = document.getElementById("siteBox");
const siteDomainEl = document.getElementById("siteDomain");
const trustSiteBtn = document.getElementById("trustSiteBtn");
const reportFpBtn = document.getElementById("reportFpBtn");
const blockSiteBtn = document.getElementById("blockSiteBtn");
const lockdownSelect = document.getElementById("lockdownSelect");
const alertsBtn = document.getElementById("alertsBtn");
const alertsCountEl = document.getElementById("alertsCount");
const notifsBtn = document.getElementById("notifsBtn");
const notifsCountEl = document.getElementById("notifsCount");
const dashboardLink = document.getElementById("dashboardLink");
const disconnectLink = document.getElementById("disconnectLink");

let currentSiteDomain = null;

function hubUrl() {
  return PRIVYDECK_EXTENSION_CONFIG.defaultHubUrl;
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

function detectPlatform() {
  const p = navigator.platform.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macos";
  if (p.includes("linux")) return "linux";
  return "other";
}

function sendBackgroundMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError?.message;
      if (err) {
        resolve({ ok: false, error: err });
        return;
      }
      resolve(res ?? { ok: false, error: "Extension background did not respond. Try again." });
    });
  });
}

async function api(path, options = {}) {
  const { token } = await chrome.storage.local.get(["token"]);
  if (!token) throw new Error("Not connected");
  const res = await fetch(`${hubUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showView(connected) {
  connectView.classList.toggle("hidden", connected);
  dashView.classList.toggle("hidden", !connected);
  connBadge.textContent = connected ? "Protected" : "Not connected";
  connBadge.classList.toggle("ok", connected);
}

function renderScore(score) {
  scoreValue.textContent = String(score.overall);
  scoreRing.className = "score-ring";
  if (score.overall >= 75) scoreRing.classList.add("good");
  else if (score.overall >= 50) scoreRing.classList.add("warn");
  else scoreRing.classList.add("bad");
  scoreTrend.textContent = score.trend === "up" ? "▲" : score.trend === "down" ? "▼" : "";
  gamificationEl.textContent = `Level ${score.level} · ${score.xp} XP · ${score.streakDays}-day streak`;
}

async function renderDashboard() {
  try {
    const dash = await api("/api/extension/dashboard");
    renderScore(dash.privacyScore);
    alertsCountEl.textContent = String(dash.alerts.length);
    notifsCountEl.textContent = String(dash.unreadNotifications);
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
}

async function renderTabStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith("http")) {
      currentSiteDomain = new URL(tab.url).hostname.replace(/^www\./, "");
      siteDomainEl.textContent = currentSiteDomain;
      siteBox.classList.remove("hidden");
    } else {
      siteBox.classList.add("hidden");
    }

    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules(
      tab?.id != null ? { tabId: tab.id } : {}
    );
    const blocked = rulesMatchedInfo.filter(
      (info) => !(info.rule.rulesetId === "_dynamic" && info.rule.ruleId >= 5000)
    );
    blockedPageEl.textContent = String(blocked.length);
  } catch {
    blockedPageEl.textContent = "-";
  }

  const res = await sendBackgroundMessage({ type: "PRIVYDECK_BLOCKED_TOTAL" });
  blockedTotalEl.textContent = res?.ok ? String(res.total) : "-";
  const cats = res?.blockedByCategory;
  if (categoryBreakdownEl && cats && typeof cats === "object") {
    const parts = [
      cats.ads ? `${cats.ads} ads` : null,
      cats.trackers ? `${cats.trackers} trackers` : null,
      cats.malware ? `${cats.malware} malware` : null,
      cats.annoyances ? `${cats.annoyances} annoyances` : null,
    ].filter(Boolean);
    if (parts.length) {
      categoryBreakdownEl.textContent = parts.join(" · ");
      categoryBreakdownEl.classList.remove("hidden");
    } else {
      categoryBreakdownEl.textContent = "";
      categoryBreakdownEl.classList.add("hidden");
    }
  }
}

async function renderLockdown() {
  try {
    const state = await api("/api/extension/rules");
    lockdownSelect.replaceChildren();

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "None (lists and custom rules only)";
    lockdownSelect.appendChild(none);

    for (const mode of state.lockdownModes) {
      const opt = document.createElement("option");
      opt.value = mode.id;
      opt.textContent = mode.name + (mode.premium && state.tier === "free" ? " (Premium)" : "");
      opt.disabled = mode.premium && state.tier === "free";
      if (mode.active) opt.selected = true;
      lockdownSelect.appendChild(opt);
    }
  } catch {
    /* rendered lazily; dashboard call reports errors */
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "token",
    "deviceName",
    "lastSync",
    "rulesVersion",
    "connected",
  ]);

  const connected = Boolean(data.connected && data.token);
  showView(connected);

  if (connected) {
    metaEl.textContent = data.lastSync
      ? `Last sync: ${new Date(data.lastSync).toLocaleString()}`
      : "";
    await Promise.all([renderDashboard(), renderTabStats(), renderLockdown()]);
  } else {
    tokenEl.value = data.token || "";
    deviceNameEl.value = data.deviceName || "My Browser";
    setStatus("Open privydeck.com → Setup and click Connect extension", "");
  }
}

saveBtn.addEventListener("click", async () => {
  setStatus("Connecting…");
  const settings = {
    hubUrl: hubUrl(),
    token: tokenEl.value.trim(),
    deviceName: deviceNameEl.value.trim() || "My Browser",
    platform: detectPlatform(),
  };

  if (!settings.token) {
    setStatus("Paste the token from PrivyDeck Setup or Settings.", "err");
    return;
  }

  const res = await sendBackgroundMessage({ type: "PRIVYDECK_SAVE", settings });
  if (res?.ok) {
    setStatus("Connected and synced.", "ok");
    await loadSettings();
  } else {
    setStatus(res?.error || "Connection failed", "err");
  }
});

syncBtn.addEventListener("click", async () => {
  setStatus("Syncing…");
  const res = await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
  if (res?.ok) {
    setStatus("Synced.", "ok");
    await loadSettings();
  } else {
    setStatus(res?.error || "Sync failed", "err");
  }
});

lockdownSelect.addEventListener("change", async () => {
  setStatus("Switching protection mode…");
  try {
    await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "setLockdown", modeId: lockdownSelect.value || null }),
    });
    await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
    setStatus("Protection mode updated.", "ok");
    await Promise.all([renderDashboard(), renderLockdown()]);
  } catch (err) {
    setStatus(String(err.message || err), "err");
    await renderLockdown();
  }
});

trustSiteBtn.addEventListener("click", async () => {
  if (!currentSiteDomain) return;
  setStatus(`Trusting ${currentSiteDomain}…`);
  try {
    await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "addAllowDomain", domain: currentSiteDomain }),
    });
    await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
    setStatus(`${currentSiteDomain} added to exceptions.`, "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

reportFpBtn?.addEventListener("click", async () => {
  if (!currentSiteDomain) return;
  setStatus(`Reporting false positive for ${currentSiteDomain}…`);
  try {
    await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "reportFalsePositive", domain: currentSiteDomain }),
    });
    await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
    setStatus(`${currentSiteDomain} allowlisted and reported.`, "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

blockSiteBtn.addEventListener("click", async () => {
  if (!currentSiteDomain) return;
  setStatus(`Blocking ${currentSiteDomain}…`);
  try {
    await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "addDomain", domain: currentSiteDomain }),
    });
    await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
    setStatus(`${currentSiteDomain} blocked everywhere.`, "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

function openOptions() {
  chrome.runtime.openOptionsPage();
}

rulesBtn.addEventListener("click", openOptions);
alertsBtn.addEventListener("click", openOptions);
notifsBtn.addEventListener("click", openOptions);

dashboardLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: hubUrl() });
});

disconnectLink.addEventListener("click", async (event) => {
  event.preventDefault();
  setStatus("Disconnecting…");
  const res = await sendBackgroundMessage({ type: "PRIVYDECK_DISCONNECT" });
  if (res?.ok) {
    setStatus("Disconnected. Baseline protection stays active.", "ok");
    await loadSettings();
  } else {
    setStatus(res?.error || "Disconnect failed", "err");
  }
});

loadSettings().catch(() => {});
