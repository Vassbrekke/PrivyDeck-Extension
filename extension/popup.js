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
const siteResourceEl = document.getElementById("siteResource");
const siteActions = document.getElementById("siteActions");
const trustSiteBtn = document.getElementById("trustSiteBtn");
const reportFpBtn = document.getElementById("reportFpBtn");
const blockSiteBtn = document.getElementById("blockSiteBtn");
const confirmBox = document.getElementById("confirmBox");
const confirmTitle = document.getElementById("confirmTitle");
const confirmDomain = document.getElementById("confirmDomain");
const confirmDetail = document.getElementById("confirmDetail");
const confirmSecurityLabel = document.getElementById("confirmSecurityLabel");
const confirmSecurityAck = document.getElementById("confirmSecurityAck");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const confirmOkBtn = document.getElementById("confirmOkBtn");
const lockdownSelect = document.getElementById("lockdownSelect");
const alertsBtn = document.getElementById("alertsBtn");
const alertsCountEl = document.getElementById("alertsCount");
const notifsBtn = document.getElementById("notifsBtn");
const notifsCountEl = document.getElementById("notifsCount");
const dashboardLink = document.getElementById("dashboardLink");
const disconnectLink = document.getElementById("disconnectLink");

let currentSiteDomain = null;
let currentSiteOrigin = null;
let currentTabId = null;
let pendingConfirm = null;

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
      currentTabId = tab.id ?? null;
      const parsed = new URL(tab.url);
      currentSiteDomain = parsed.hostname.replace(/^www\./, "");
      currentSiteOrigin = parsed.origin;
      siteDomainEl.textContent = currentSiteDomain;
      if (siteResourceEl) {
        siteResourceEl.textContent = `Resource: ${currentSiteOrigin}`;
        siteResourceEl.classList.remove("hidden");
      }
      siteBox.classList.remove("hidden");
      hideConfirm();
    } else {
      currentTabId = null;
      currentSiteOrigin = null;
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
  await beginConfirm("allow");
});

reportFpBtn?.addEventListener("click", async () => {
  if (!currentSiteDomain) return;
  await beginConfirm("false-positive");
});

blockSiteBtn.addEventListener("click", async () => {
  if (!currentSiteDomain) return;
  await beginConfirm("block");
});

function hideConfirm() {
  pendingConfirm = null;
  confirmBox?.classList.add("hidden");
  siteActions?.classList.remove("hidden");
  if (confirmSecurityAck) confirmSecurityAck.checked = false;
}

async function beginConfirm(kind) {
  const preview = await sendBackgroundMessage({
    type: "PRIVYDECK_SITE_PREVIEW",
    domain: currentSiteDomain,
    tabId: currentTabId,
  });
  const category = preview?.category || "trackers";
  const security = Boolean(preview?.securityCategory);
  pendingConfirm = { kind, domain: currentSiteDomain, origin: currentSiteOrigin, category, security };

  confirmTitle.textContent =
    kind === "allow"
      ? "Permanently allow this domain?"
      : kind === "false-positive"
        ? "Report as a false positive?"
        : "Block this domain everywhere?";
  confirmDomain.textContent = currentSiteDomain;
  if (kind === "allow") {
    confirmDetail.textContent = security
      ? `${currentSiteOrigin} is malware-category. Allowing it disables blocking for this host. This is not a false-positive report.`
      : `Permanently allow ${currentSiteDomain} (${currentSiteOrigin}, ${category}). This is an allowlist exception, not a false-positive report.`;
  } else if (kind === "false-positive") {
    confirmDetail.textContent = `Report ${currentSiteDomain} (${currentSiteOrigin}, ${category}) as a possible false positive. It stays blocked until you separately allow it.`;
  } else {
    confirmDetail.textContent = `Block ${currentSiteDomain} (${currentSiteOrigin}) on this account.`;
  }
  confirmSecurityLabel.classList.toggle("hidden", !(kind === "allow" && security));
  confirmOkBtn.textContent =
    kind === "allow" ? "Allow permanently" : kind === "false-positive" ? "Report only" : "Block";
  confirmOkBtn.disabled = kind === "allow" && security;
  siteActions.classList.add("hidden");
  confirmBox.classList.remove("hidden");
}

confirmCancelBtn?.addEventListener("click", hideConfirm);

confirmSecurityAck?.addEventListener("change", () => {
  if (pendingConfirm?.kind === "allow" && pendingConfirm.security) {
    confirmOkBtn.disabled = !confirmSecurityAck.checked;
  }
});

confirmOkBtn?.addEventListener("click", async () => {
  if (!pendingConfirm?.domain) return;
  const { kind, domain, security } = pendingConfirm;
  if (kind === "allow" && security && !confirmSecurityAck?.checked) return;

  const label =
    kind === "allow" ? `Allowing ${domain}…` : kind === "false-positive" ? `Reporting ${domain}…` : `Blocking ${domain}…`;
  setStatus(label);
  try {
    if (kind === "allow") {
      try {
        await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({
            action: "addAllowDomain",
            domain,
            acknowledgeSecurityCategory: security,
          }),
        });
      } catch (err) {
        const msg = String(err.message || err);
        if (/malware-category domain requires explicit confirmation/i.test(msg)) {
          pendingConfirm.security = true;
          confirmDetail.textContent = `${currentSiteOrigin} is a malware-category host. Allowing ${domain} permanently disables blocking for this exact domain.`;
          confirmSecurityLabel.classList.remove("hidden");
          confirmOkBtn.disabled = !confirmSecurityAck?.checked;
          setStatus("This host is malware-category. Confirm below to allow it.", "err");
          return;
        }
        throw err;
      }
      await sendBackgroundMessage({
        type: "PRIVYDECK_POLICY_LOG",
        action: "allow",
        domain,
        detail: `Permanent allowlist${security || pendingConfirm.security ? " (malware ack)" : ""}`,
      });
      await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
      setStatus(`${domain} added to the allowlist.`, "ok");
    } else if (kind === "false-positive") {
      await api("/api/extension/rules", {
        method: "PATCH",
        body: JSON.stringify({ action: "reportFalsePositive", domain }),
      });
      await sendBackgroundMessage({
        type: "PRIVYDECK_POLICY_LOG",
        action: "false-positive",
        domain,
        detail: "Reported; not allowlisted",
      });
      setStatus(`${domain} reported. It is not allowlisted.`, "ok");
    } else {
      await api("/api/extension/rules", {
        method: "PATCH",
        body: JSON.stringify({ action: "addDomain", domain }),
      });
      await sendBackgroundMessage({
        type: "PRIVYDECK_POLICY_LOG",
        action: "block",
        domain,
        detail: "Custom block",
      });
      await sendBackgroundMessage({ type: "PRIVYDECK_SYNC" });
      setStatus(`${domain} blocked everywhere.`, "ok");
    }
    hideConfirm();
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
