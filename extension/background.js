import { PRIVYDECK_EXTENSION_CONFIG } from "./config.js";
import { categorizeHost, uncloakHostname, CNAME_TRACKER_MAP, CNAME_MAP_VERSION } from "./cname-map.js";
import {
  chromiumCosmeticLimit,
  engineLabel,
  firefoxCosmeticLimit,
} from "./engine-info.js";
import {
  appendPolicyLog,
  isReplay,
  readPolicyState,
  rememberSnapshot,
  rollbackToPrevious,
  setRulesPinned,
  verifyRuleSignature,
} from "./policy.js";

const SYNC_ALARM = "privydeck-sync";
const VERSION_ALARM = "privydeck-version";
const BLOCK_RULE_OFFSET = 1000;
const ALLOW_RULE_OFFSET = 5000;
const FILTER_RULE_OFFSET = 10_000;
const SESSION_ALLOW_OFFSET = 20_000;
const MAX_PAUSED_SITES = 20;
const MAX_LOCAL_COSMETIC_HOSTS = 50;
const MAX_LOCAL_SELECTORS = 30;
/** Fallback when the API constant is missing (Firefox=5k, Chromium=30k). */
const FALLBACK_DYNAMIC_RULES = { firefox: 5_000, chromium: 30_000 };
const CATEGORY_RULESETS = ["ads", "trackers", "malware", "annoyances"];
const MANIFEST = chrome.runtime.getManifest();

/** Firefox is capped at 5k dynamic DNR rules; Chromium allows 30k safe rules. */
function getMaxDynamicRules() {
  const apiLimit = chrome.declarativeNetRequest?.MAX_NUMBER_OF_DYNAMIC_RULES;
  const fallback = isFirefox() ? FALLBACK_DYNAMIC_RULES.firefox : FALLBACK_DYNAMIC_RULES.chromium;
  const limit = typeof apiLimit === "number" && apiLimit > 0 ? apiLimit : fallback;
  // Leave a little headroom so batching / concurrent updates cannot tip over the hard cap.
  return Math.max(100, limit - 50);
}

let rulesSocket = null;
let rulesSocketUserId = null;
let syncInFlight = null;
/** Firefox webRequest in-memory sets */
let fxBlockSet = new Set();
let fxAllowSet = new Set();
let fxWebRequestInstalled = false;
let blockedByCategory = { ads: 0, trackers: 0, malware: 0, annoyances: 0 };
/** tabId → Map(host → count). In-memory only; never synced. */
const pageBlocks = new Map();
let blockLoggerInstalled = false;

function isFirefox() {
  return typeof browser !== "undefined" && !!browser.runtime?.getBrowserInfo;
}

function isLocalHubUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function resolveHubUrl(stored) {
  const defaultHub = (PRIVYDECK_EXTENSION_CONFIG.defaultHubUrl || "").replace(/\/$/, "");
  if (!defaultHub) throw new Error("Hub URL not configured");
  if (!isLocalHubUrl(defaultHub)) return defaultHub;
  return (stored || defaultHub).replace(/\/$/, "");
}

async function getSettings() {
  return chrome.storage.local.get([
    "hubUrl",
    "token",
    "deviceName",
    "platform",
    "lastSync",
    "rulesVersion",
    "rulesIssuedAt",
    "rulesPinned",
    "connected",
    "wsUrl",
    "blockedTotal",
    "lastMatchedAt",
    "allowDomains",
    "cosmeticRules",
    "engine",
    "categories",
    "blockedByCategory",
    "blockDomains",
  ]);
}

function loadCategoryCounts(stored) {
  blockedByCategory = {
    ads: Number(stored?.ads) || 0,
    trackers: Number(stored?.trackers) || 0,
    malware: Number(stored?.malware) || 0,
    annoyances: Number(stored?.annoyances) || 0,
  };
}

function bumpBlockedCategory(hostname) {
  const cat = categorizeHost(hostname);
  blockedByCategory[cat] = (blockedByCategory[cat] || 0) + 1;
  chrome.storage.local.set({ blockedByCategory }).catch(() => {});
}

async function syncStaticRulesets(categories, useAccountRules) {
  const cats = categories || {};
  const enable = [];
  const disable = ["top_trackers"];
  if (!useAccountRules) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: ["top_trackers"],
      disableRulesetIds: CATEGORY_RULESETS,
    });
    return;
  }
  for (const id of CATEGORY_RULESETS) {
    if (cats[id]) enable.push(id);
    else disable.push(id);
  }
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enable,
    disableRulesetIds: disable,
  });
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatchesSet(hostname, set) {
  if (!hostname || !set?.size) return false;
  let host = hostname;
  while (host) {
    if (set.has(host)) return true;
    const dot = host.indexOf(".");
    if (dot < 0) return false;
    host = host.slice(dot + 1);
  }
  return false;
}

function normalizeHost(value) {
  const host = String(value || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..")) return "";
  return host;
}

function recordPageBlock(tabId, host) {
  const bare = normalizeHost(host);
  if (!Number.isInteger(tabId) || tabId < 0 || !bare) return;
  let hosts = pageBlocks.get(tabId);
  if (!hosts) {
    if (pageBlocks.size >= 30) {
      const oldest = pageBlocks.keys().next().value;
      pageBlocks.delete(oldest);
    }
    hosts = new Map();
    pageBlocks.set(tabId, hosts);
  }
  hosts.set(bare, (hosts.get(bare) || 0) + 1);
  if (hosts.size > 24) {
    const first = hosts.keys().next().value;
    hosts.delete(first);
  }
}

function pageBlockList(tabId) {
  const hosts = pageBlocks.get(tabId);
  if (!hosts) return [];
  return [...hosts.entries()]
    .map(([host, count]) => ({ host, count, category: categorizeHost(host) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function installBlockLogger() {
  if (blockLoggerInstalled || isFirefox() || !chrome.webRequest?.onErrorOccurred) return;
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
      recordPageBlock(details.tabId, hostFromUrl(details.url));
    },
    { urls: ["http://*/*", "https://*/*"] }
  );
  blockLoggerInstalled = true;
}

function recordFirefoxBlock(host, tabId) {
  bumpBlockedCategory(host);
  recordPageBlock(tabId, host);
  chrome.storage.local.get(["blockedTotal"], (data) => {
    chrome.storage.local.set({ blockedTotal: (data.blockedTotal || 0) + 1 });
  });
}

async function dnsUncloakShouldBlock(host) {
  try {
    if (typeof browser === "undefined" || !browser.dns?.resolve) return false;
    const result = await browser.dns.resolve(host, ["canonical_name"]);
    const cname = String(result?.canonicalName || "")
      .toLowerCase()
      .replace(/\.$/, "");
    if (!cname || cname === host) return false;
    const mapped = uncloakHostname(cname) || cname;
    if (domainMatchesSet(mapped, fxAllowSet) || domainMatchesSet(cname, fxAllowSet)) {
      return false;
    }
    return domainMatchesSet(mapped, fxBlockSet) || domainMatchesSet(cname, fxBlockSet);
  } catch {
    return false;
  }
}

function installFirefoxWebRequest() {
  if (!isFirefox() || fxWebRequestInstalled) return;
  const api = typeof browser !== "undefined" ? browser : chrome;
  if (!api.webRequest?.onBeforeRequest) return;

  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      const host = hostFromUrl(details.url);
      if (!host) return {};
      if (domainMatchesSet(host, fxAllowSet)) return {};
      const uncloaked = uncloakHostname(host);
      if (uncloaked && domainMatchesSet(uncloaked, fxAllowSet)) return {};
      if (domainMatchesSet(host, fxBlockSet) || (uncloaked && domainMatchesSet(uncloaked, fxBlockSet))) {
        recordFirefoxBlock(host, details.tabId);
        return { cancel: true };
      }
      // Live DNS CNAME uncloak (Firefox blocking listeners may return a Promise)
      return dnsUncloakShouldBlock(host).then((block) => {
        if (!block) return {};
        recordFirefoxBlock(host, details.tabId);
        return { cancel: true };
      });
    },
    { urls: ["<all_urls>"] },
    ["blocking"]
  );
  fxWebRequestInstalled = true;
}

function updateFirefoxSets(blockDomains, allowDomains) {
  fxBlockSet = new Set((blockDomains || []).map((d) => String(d).toLowerCase()));
  fxAllowSet = new Set((allowDomains || []).map((d) => String(d).toLowerCase()));
  // If a tracker identity is blocked, also block known CNAME aliases that resolve to it.
  for (const [alias, target] of Object.entries(CNAME_TRACKER_MAP)) {
    if (domainMatchesSet(target, fxBlockSet) && !domainMatchesSet(alias, fxAllowSet)) {
      fxBlockSet.add(alias.toLowerCase());
    }
  }
  installFirefoxWebRequest();
}

/** Restore in-memory Firefox sets (and Chromium DNR if the browser dropped them). */
async function rehydrateEngine() {
  const s = await getSettings();
  if (!s.token) return;
  const allow = s.allowDomains || [];
  const block = s.blockDomains || [];
  if (isFirefox()) {
    updateFirefoxSets(block, allow);
    return;
  }
  if (syncInFlight) return;
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length > 0 || (!block.length && !allow.length)) return;
    const { rulesSnapshot } = await chrome.storage.local.get(["rulesSnapshot"]);
    await applyProtectionRules(
      block,
      allow,
      true,
      rulesSnapshot?.dnrRules ?? [],
      s.categories ?? null
    );
  } catch {
    /* ignore */
  }
}

function enableBadgeCounter() {
  try {
    chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: true,
    });
    chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ color: "#0a1f14" });
    }
  } catch {
    /* not supported on this browser */
  }
}

function isAllowRule(info) {
  if (info.rule.rulesetId !== "_dynamic") return false;
  const id = info.rule.ruleId;
  return (id >= ALLOW_RULE_OFFSET && id < FILTER_RULE_OFFSET) || id >= SESSION_ALLOW_OFFSET;
}

function isBlockMatch(info) {
  return !isAllowRule(info);
}

/** getMatchedRules only covers ~5 minutes, so accumulate a running total. */
async function accumulateBlockedCount() {
  try {
    const { blockedTotal, lastMatchedAt, blockedByCategory: storedCats } = await getSettings();
    loadCategoryCounts(storedCats);
    const since = lastMatchedAt ?? 0;
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({});
    const fresh = rulesMatchedInfo.filter((info) => info.timeStamp > since && isBlockMatch(info));
    for (const info of fresh) {
      const rs = info.rule.rulesetId;
      if (rs === "ads") blockedByCategory.ads++;
      else if (rs === "malware") blockedByCategory.malware++;
      else if (rs === "annoyances") blockedByCategory.annoyances++;
      else blockedByCategory.trackers++;
    }
    const newest = rulesMatchedInfo.reduce((max, info) => Math.max(max, info.timeStamp), since);
    const total = (blockedTotal ?? 0) + fresh.length;
    await chrome.storage.local.set({
      blockedTotal: total,
      lastMatchedAt: newest,
      blockedByCategory,
    });
    return total;
  } catch {
    const { blockedTotal } = await getSettings();
    return blockedTotal ?? 0;
  }
}

function chunkRules(domains, offset, actionType, priority) {
  const addRules = [];
  const chunkSize = 400;
  const resourceTypes = [
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "xmlhttprequest",
    "image",
    "font",
    "object",
    "ping",
    "media",
    "websocket",
    "other",
  ];

  for (let i = 0; i < domains.length; i += chunkSize) {
    const chunk = domains.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    addRules.push({
      id: offset + Math.floor(i / chunkSize),
      priority,
      action: { type: actionType },
      condition: {
        requestDomains: chunk,
        resourceTypes,
      },
    });
  }
  return addRules;
}

function compiledToDynamicRules(dnrRules, startId, budget, preferPathFilters = false) {
  const out = [];
  let id = startId;
  const allowedKeys = new Set([
    "urlFilter",
    "requestDomains",
    "resourceTypes",
    "excludedRequestDomains",
    "isUrlFilterCaseSensitive",
  ]);
  const source = dnrRules ?? [];
  // On Firefox, domain blocks already run via webRequest - keep DNR for path/url filters first.
  const ordered = preferPathFilters
    ? [
        ...source.filter((r) => r?.condition?.urlFilter),
        ...source.filter((r) => !r?.condition?.urlFilter),
      ]
    : source;

  for (const rule of ordered) {
    if (out.length >= budget) break;
    const raw = rule.condition || {};
    const condition = {};
    for (const key of allowedKeys) {
      if (raw[key] !== undefined) condition[key] = raw[key];
    }
    if (!condition.urlFilter && !(condition.requestDomains && condition.requestDomains.length)) {
      continue;
    }
    // Skip domain-only blocks on Firefox; webRequest already covers the domain set.
    if (preferPathFilters && !condition.urlFilter && rule.action?.type !== "allow") {
      continue;
    }
    out.push({
      id: id++,
      priority:
        rule.action?.type === "allow"
          ? 3
          : Math.min(2, Number(rule.priority) || 2),
      action: { type: rule.action?.type === "allow" ? "allow" : "block" },
      condition,
    });
  }
  return out;
}

async function applyProtectionRules(
  blockDomains,
  allowDomains,
  useAccountRules,
  dnrRules = [],
  categories = null
) {
  const maxRules = getMaxDynamicRules();
  const firefox = isFirefox();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  // Allowlist stays in DNR so allow beats static rulesets on both engines.
  let allowRules = chunkRules(allowDomains ?? [], ALLOW_RULE_OFFSET, "allow", 3);
  // Firefox: domain lists are enforced by webRequest (+ DNS CNAME). Keep the 5k DNR
  // quota for path/urlFilter rules and a small allow set.
  let domainBlockRules = firefox
    ? []
    : chunkRules(blockDomains ?? [], BLOCK_RULE_OFFSET, "block", 2);

  if (allowRules.length > maxRules) {
    allowRules = allowRules.slice(0, maxRules);
  }
  const afterAllow = Math.max(0, maxRules - allowRules.length);
  if (domainBlockRules.length > afterAllow) {
    domainBlockRules = domainBlockRules.slice(0, afterAllow);
  }
  const remaining = Math.max(0, maxRules - allowRules.length - domainBlockRules.length);
  const filterRules = compiledToDynamicRules(dnrRules, FILTER_RULE_OFFSET, remaining, firefox);

  const addRules = [...allowRules, ...domainBlockRules, ...filterRules].slice(0, maxRules);

  const BATCH = Math.min(1_000, maxRules);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
  for (let i = 0; i < addRules.length; i += BATCH) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [],
        addRules: addRules.slice(i, i + BATCH),
      });
    } catch (err) {
      // Cap was hit (older browsers / concurrent updates) - keep what already applied.
      console.warn("[PrivyDeck] Dynamic DNR batch stopped:", String(err?.message || err));
      break;
    }
  }

  await syncStaticRulesets(categories, useAccountRules);
  updateFirefoxSets(blockDomains, allowDomains);
  await ensureSessionAllows();

  return {
    domainRules: domainBlockRules.length,
    filterRules: filterRules.length,
    allowRules: allowRules.length,
  };
}

export async function syncConfig() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = keepAliveWhile(runSync()).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

function keepAliveWhile(promise) {
  const tick = () => {
    try {
      chrome.runtime.getPlatformInfo(() => {});
    } catch {
      /* ignore */
    }
  };
  tick();
  const id = setInterval(tick, 20_000);
  return Promise.resolve(promise).finally(() => clearInterval(id));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hubFetch(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: options.signal ?? AbortSignal.timeout(45_000),
      });
      if (res.status >= 500 && attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Network error");
}

function engineHeader() {
  return isFirefox() ? "firefox" : "chromium";
}

function deviceQuery(deviceName, platform) {
  const qs = new URLSearchParams();
  if (deviceName) qs.set("deviceName", deviceName);
  if (platform) qs.set("platform", platform);
  return qs.toString() ? `?${qs}` : "";
}

async function runSync() {
  const { hubUrl, token, deviceName, platform, rulesVersion } = await getSettings();
  if (!token) throw new Error("Sign in from PrivyDeck and connect your account");

  const base = resolveHubUrl(hubUrl);
  let configRes;
  try {
    configRes = await hubFetch(`${base}/api/extension/config${deviceQuery(deviceName, platform)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-PrivyDeck-Engine": engineHeader(),
        ...(rulesVersion ? { "If-None-Match": `"${rulesVersion}"` } : {}),
      },
    });
  } catch {
    throw new Error(
      `Could not reach PrivyDeck at ${base}. Check the server URL matches where you signed in.`
    );
  }

  if (configRes.status === 304) {
    await chrome.storage.local.set({ lastSync: Date.now(), connected: true, hubUrl: base });
    await rehydrateEngine();
    const stored = await getSettings();
    connectRulesSocket(stored.wsUrl, token);
    return { rulesVersion, unchanged: true };
  }

  if (!configRes.ok) {
    let serverError = "";
    try {
      const body = await configRes.json();
      if (typeof body?.error === "string" && body.error.length > 0 && body.error.length <= 180) {
        serverError = body.error;
      }
    } catch {
      /* non-JSON error body */
    }
    if (configRes.status === 401) {
      throw new Error("Invalid or expired token. Generate a new token in Settings → Browser extension.");
    }
    if (configRes.status === 429) {
      throw new Error("Server is busy. Try sync again in a minute.");
    }
    if (configRes.status === 503) {
      throw new Error(
        serverError || "Could not sync protection rules. The server is not signing rule payloads."
      );
    }
    throw new Error(
      serverError || `Could not sync protection rules (${configRes.status}). Check the server URL.`
    );
  }

  const config = await configRes.json();
  const requireSig = Boolean(PRIVYDECK_EXTENSION_CONFIG.requireRuleSignature);
  const verified = await verifyRuleSignature(
    config,
    PRIVYDECK_EXTENSION_CONFIG.rulesSigningPublicKey || "",
    requireSig
  );
  if (!verified.ok) {
    await appendPolicyLog({ action: "reject", detail: verified.reason });
    throw new Error(`Rejected remote rules (${verified.reason}). Keeping last known-good set.`);
  }

  const policy = await readPolicyState();
  if (policy.rulesPinned) {
    return config;
  }
  if (isReplay(config, policy.rulesIssuedAt)) {
    await appendPolicyLog({
      action: "reject",
      detail: `Replay: issued ${config.rulesIssuedAt} older than pinned ${policy.rulesIssuedAt}`,
    });
    throw new Error("Rejected older signed rules. Use rollback only from Protection rules.");
  }

  const applied = await applyProtectionRules(
    config.blockDomains ?? [],
    [...(config.allowDomains ?? []), ...(config.securityAllowDomains ?? [])],
    true,
    config.dnrRules ?? [],
    config.categories ?? null
  );

  const stored = await getSettings();
  loadCategoryCounts(stored.blockedByCategory);

  await chrome.storage.local.set({
    allowDomains: [...(config.allowDomains ?? []), ...(config.securityAllowDomains ?? [])],
    blockDomains: config.blockDomains ?? [],
    cosmeticRules: config.cosmeticRules ?? [],
    engine: isFirefox() ? "hybrid" : config.engine ?? "dnr",
    categories: config.categories ?? null,
    cnameMapVersion: config.cnameMapVersion ?? CNAME_MAP_VERSION,
  });
  await rememberSnapshot(config);
  await appendPolicyLog({
    action: "apply",
    detail: `${config.rulesVersion || "rules"}${verified.unsigned ? " (unsigned)" : ""}`,
  });

  const blockedTotal = await accumulateBlockedCount();

  try {
    const syncRes = await hubFetch(`${base}/api/extension/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        deviceName: deviceName || "Browser (PrivyDeck Extension)",
        platform: platform || "other",
        rulesApplied: (config.blockDomains ?? []).length + (config.dnrRules ?? []).length,
        extensionVersion: MANIFEST.version,
        blockedCount: blockedTotal,
        blockedByCategory,
        engine: isFirefox() ? "hybrid" : "dnr",
        filterRules: applied.filterRules,
        cosmeticRules: (config.cosmeticRules ?? []).length,
      }),
    });
    if (!syncRes.ok && syncRes.status !== 429) {
      console.warn("[PrivyDeck] Account heartbeat failed:", syncRes.status);
    }
  } catch (err) {
    console.warn("[PrivyDeck] Account heartbeat failed:", String(err?.message || err));
  }

  await chrome.storage.local.set({
    hubUrl: base,
    wsUrl: config.wsUrl ?? null,
    lastSync: Date.now(),
    rulesVersion: config.rulesVersion ?? null,
    rulesIssuedAt: Number(config.rulesIssuedAt) || Date.now(),
    connected: true,
  });

  connectRulesSocket(config.wsUrl, token);
  return config;
}

async function checkRulesVersion() {
  const { hubUrl, token, rulesVersion, rulesPinned, deviceName, platform } = await getSettings();
  if (!token || rulesPinned) return;

  const base = resolveHubUrl(hubUrl);
  try {
    const res = await hubFetch(`${base}/api/extension/config${deviceQuery(deviceName, platform)}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-PrivyDeck-Engine": engineHeader(),
      },
    });
    if (!res.ok) return;
    const nextVersion = res.headers.get("x-rules-version");
    if (nextVersion && rulesVersion && nextVersion !== rulesVersion) {
      await syncConfig();
    }
  } catch {
    /* offline */
  }
}

function connectRulesSocket(wsUrl, token) {
  if (!wsUrl || !token) return;
  const open =
    rulesSocket &&
    rulesSocketUserId === token &&
    (rulesSocket.readyState === WebSocket.CONNECTING || rulesSocket.readyState === WebSocket.OPEN);
  if (open) return;

  try {
    rulesSocket?.close();
  } catch {
    /* ignore */
  }

  const url = new URL(wsUrl);
  url.searchParams.set("role", "extension");

  const socket = new WebSocket(url.toString());
  rulesSocket = socket;
  rulesSocketUserId = token;

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "auth", token }));
  });

  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(String(event.data));
      if (payload.type === "rules-changed") {
        syncConfig().catch(() => {});
      }
    } catch {
      /* ignore */
    }
  });

  socket.addEventListener("close", () => {
    if (rulesSocket === socket) {
      rulesSocket = null;
      rulesSocketUserId = null;
    }
  });
}

async function saveAndSync(settings) {
  const hubUrl = resolveHubUrl(settings.hubUrl);
  await chrome.storage.local.set({ ...settings, hubUrl });
  return syncConfig();
}

function connectExternal(message, sendResponse) {
  saveAndSync({
    hubUrl: message.hubUrl,
    token: message.token,
    deviceName: message.deviceName,
    platform: message.platform,
  })
    .then(() => sendResponse({ ok: true, message: "Connected and synced." }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
}

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PRIVYDECK_CONNECT") return;
  connectExternal(message, sendResponse);
  return true;
});

async function readPausedSites() {
  try {
    if (chrome.storage.session) {
      const data = await chrome.storage.session.get("pausedSites");
      return (Array.isArray(data.pausedSites) ? data.pausedSites : [])
        .map(normalizeHost)
        .filter(Boolean)
        .slice(0, MAX_PAUSED_SITES);
    }
  } catch {
    /* session storage unavailable */
  }
  return [];
}

async function writePausedSites(sites) {
  const pausedSites = [...new Set(sites.map(normalizeHost).filter(Boolean))].slice(0, MAX_PAUSED_SITES);
  if (!chrome.storage.session) return pausedSites;
  await chrome.storage.session.set({ pausedSites });
  return pausedSites;
}

function sessionAllowRules(sites) {
  const types = [
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "xmlhttprequest",
    "image",
    "font",
    "object",
    "ping",
    "media",
    "websocket",
    "other",
  ];
  const rules = [];
  sites.forEach((domain, index) => {
    const base = SESSION_ALLOW_OFFSET + index * 2;
    rules.push(
      {
        id: base,
        priority: 4,
        action: { type: "allow" },
        condition: { initiatorDomains: [domain], resourceTypes: types },
      },
      {
        id: base + 1,
        priority: 4,
        action: { type: "allow" },
        condition: { requestDomains: [domain], resourceTypes: types },
      }
    );
  });
  return rules;
}

async function ensureSessionAllows() {
  const sites = await readPausedSites();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .map((rule) => rule.id)
    .filter((id) => id >= SESSION_ALLOW_OFFSET && id < SESSION_ALLOW_OFFSET + MAX_PAUSED_SITES * 2);
  if (!removeRuleIds.length && sites.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: sessionAllowRules(sites),
  });
}

async function hostIsPaused(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  const sites = await readPausedSites();
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

async function disconnectAccount() {
  try {
    rulesSocket?.close();
  } catch {
    /* ignore */
  }
  rulesSocket = null;
  rulesSocketUserId = null;

  await chrome.storage.local.remove([
    "token",
    "connected",
    "lastSync",
    "rulesVersion",
    "rulesIssuedAt",
    "rulesPinned",
    "rulesSnapshot",
    "rulesSnapshotPrev",
    "wsUrl",
    "blockedTotal",
    "lastMatchedAt",
    "allowDomains",
    "blockDomains",
    "cosmeticRules",
    "engine",
    "categories",
    "cnameMapVersion",
    "blockedByCategory",
  ]);
  blockedByCategory = { ads: 0, trackers: 0, malware: 0, annoyances: 0 };
  await writePausedSites([]);
  await appendPolicyLog({ action: "disconnect", detail: "Account disconnected; baseline lists stay on" });
  await applyProtectionRules([], [], false, [], null);
}

function isSafeCosmeticSelector(selector) {
  return (
    typeof selector === "string" &&
    selector.length > 0 &&
    selector.length < 400 &&
    !/[{};@]|\/\*|<\/style|url\s*\(|[`\\]|<\/?script/i.test(selector) &&
    /^[#.\[\]\w\s\-:>+~="'(),*^$|]+$/.test(selector)
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PRIVYDECK_SYNC") {
    syncConfig()
      .then((config) => sendResponse({ ok: true, rulesVersion: config?.rulesVersion ?? null }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_SAVE") {
    saveAndSync(message.settings)
      .then((config) =>
        sendResponse({ ok: true, rulesVersion: config?.rulesVersion ?? null, message: "Connected and synced." })
      )
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_DISCONNECT") {
    disconnectAccount()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_BLOCKED_TOTAL") {
    accumulateBlockedCount()
      .then(async (total) => {
        const { blockedByCategory: cats } = await getSettings();
        sendResponse({ ok: true, total, blockedByCategory: cats || blockedByCategory });
      })
      .catch(() => sendResponse({ ok: true, total: 0, blockedByCategory }));
    return true;
  }
  if (message?.type === "PRIVYDECK_SITE_PREVIEW") {
    const domain = String(message.domain || "").toLowerCase().replace(/^www\./, "");
    const tabId = Number.isInteger(message.tabId) ? message.tabId : undefined;
    const category = categorizeHost(domain);
    let securityCategory = category === "malware";
    const preview = async () => {
      if (tabId == null || !chrome.declarativeNetRequest?.getMatchedRules) {
        return { ok: true, domain, category, securityCategory };
      }
      try {
        const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
        if (rulesMatchedInfo.some((info) => info.rule.rulesetId === "malware")) {
          securityCategory = true;
        }
      } catch {
        /* matched-rule lookup is best-effort */
      }
      return { ok: true, domain, category, securityCategory };
    };
    preview().then(sendResponse).catch(() => sendResponse({ ok: true, domain, category, securityCategory }));
    return true;
  }
  if (message?.type === "PRIVYDECK_POLICY_STATE") {
    readPolicyState()
      .then((state) =>
        sendResponse({
          ok: true,
          pinned: Boolean(state.rulesPinned),
          rulesVersion: state.rulesVersion ?? state.rulesSnapshot?.rulesVersion ?? null,
          hasRollback: Boolean(state.rulesSnapshotPrev),
          policyLog: Array.isArray(state.policyLog) ? state.policyLog : [],
        })
      )
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_ROLLBACK") {
    rollbackToPrevious()
      .then(async (snapshot) => {
        if (!snapshot) {
          sendResponse({ ok: false, error: "No previous rule set to restore." });
          return;
        }
        await applyProtectionRules(
          snapshot.blockDomains ?? [],
          [...(snapshot.allowDomains ?? []), ...(snapshot.securityAllowDomains ?? [])],
          true,
          snapshot.dnrRules ?? [],
          snapshot.categories ?? null
        );
        await chrome.storage.local.set({
          allowDomains: [
            ...(snapshot.allowDomains ?? []),
            ...(snapshot.securityAllowDomains ?? []),
          ],
          blockDomains: snapshot.blockDomains ?? [],
          cosmeticRules: snapshot.cosmeticRules ?? [],
          categories: snapshot.categories ?? null,
        });
        sendResponse({ ok: true, rulesVersion: snapshot.rulesVersion });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_RESUME_RULES") {
    setRulesPinned(false)
      .then(() => syncConfig())
      .then((config) => sendResponse({ ok: true, rulesVersion: config?.rulesVersion ?? null }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_POLICY_LOG") {
    appendPolicyLog({
      action: String(message.action || "change"),
      domain: message.domain,
      detail: message.detail,
    })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_PAGE_STATS") {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : -1;
    const domain = normalizeHost(message.domain);
    (async () => {
      let blockedOnPage = 0;
      if (tabId >= 0 && chrome.declarativeNetRequest?.getMatchedRules) {
        try {
          const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
          blockedOnPage = rulesMatchedInfo.filter(isBlockMatch).length;
        } catch {
          blockedOnPage = 0;
        }
      }
      const paused = domain ? await hostIsPaused(domain) : false;
      sendResponse({ ok: true, blockedOnPage, paused, hosts: pageBlockList(tabId) });
    })().catch(() => sendResponse({ ok: false, blockedOnPage: 0, paused: false, hosts: [] }));
    return true;
  }
  if (message?.type === "PRIVYDECK_PAUSE_SITE") {
    const domain = normalizeHost(message.domain);
    if (!domain) {
      sendResponse({ ok: false, error: "That site cannot be paused." });
      return;
    }
    readPausedSites()
      .then((sites) => writePausedSites([...sites, domain]))
      .then(() => ensureSessionAllows())
      .then(() => appendPolicyLog({ action: "pause", domain, detail: "Session pause; not allowlisted" }))
      .then(() => sendResponse({ ok: true, domain }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_RESUME_SITE") {
    const domain = normalizeHost(message.domain);
    readPausedSites()
      .then((sites) => writePausedSites(sites.filter((site) => site !== domain)))
      .then(() => ensureSessionAllows())
      .then(() => appendPolicyLog({ action: "resume", domain, detail: "Session pause cleared" }))
      .then(() => sendResponse({ ok: true, domain }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_ZAP_SAVE") {
    const selector = String(message.selector || "");
    const host = normalizeHost(hostFromUrl(senderTabUrl(_sender)));
    if (!host || !isSafeCosmeticSelector(selector)) {
      sendResponse({ ok: false, error: "That element cannot be hidden safely." });
      return;
    }
    chrome.storage.local.get(["localCosmetics"], (data) => {
      const all = data.localCosmetics && typeof data.localCosmetics === "object" ? data.localCosmetics : {};
      const current = Array.isArray(all[host]) ? all[host].filter(isSafeCosmeticSelector) : [];
      if (!current.includes(selector)) current.push(selector);
      const nextHost = current.slice(-MAX_LOCAL_SELECTORS);
      const hosts = Object.keys(all);
      if (!all[host] && hosts.length >= MAX_LOCAL_COSMETIC_HOSTS) {
        delete all[hosts[0]];
      }
      all[host] = nextHost;
      chrome.storage.local.set({ localCosmetics: all }, () => {
        sendResponse({ ok: true, selector });
      });
    });
    return true;
  }
  if (message?.type === "PRIVYDECK_GET_COSMETICS") {
    const hostname = normalizeHost(message.hostname);
    hostIsPaused(hostname)
      .then((paused) => {
        if (paused) {
          sendResponse({ ok: true, selectors: [], paused: true });
          return;
        }
        chrome.storage.local.get(["cosmeticRules", "allowDomains", "localCosmetics"], (data) => {
          const allow = new Set((data.allowDomains || []).map((d) => normalizeHost(d)).filter(Boolean));
          if ([...allow].some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
            sendResponse({ ok: true, selectors: [] });
            return;
          }
          const selectors = [];
          for (const rule of data.cosmeticRules || []) {
            if (rule.exception) continue;
            const domains = (rule.domains || []).map(normalizeHost).filter(Boolean);
            const matches = domains.length === 0 || domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
            if (!matches) continue;
            for (const s of rule.selectors || []) selectors.push(s);
          }
          const local = data.localCosmetics?.[hostname];
          if (Array.isArray(local)) selectors.push(...local);
          const except = new Set();
          for (const rule of data.cosmeticRules || []) {
            if (!rule.exception) continue;
            const domains = (rule.domains || []).map(normalizeHost).filter(Boolean);
            const matches = domains.length === 0 || domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
            if (!matches) continue;
            for (const s of rule.selectors || []) except.add(s);
          }
          sendResponse({
            ok: true,
            selectors: selectors
              .filter((s) => !except.has(s) && isSafeCosmeticSelector(s))
              .slice(0, isFirefox() ? firefoxCosmeticLimit() : chromiumCosmeticLimit()),
            engine: isFirefox() ? "hybrid" : "dnr",
            engineHint: engineLabel(isFirefox()),
          });
        });
      })
      .catch(() => sendResponse({ ok: true, selectors: [] }));
    return true;
  }
});

function senderTabUrl(sender) {
  return sender?.tab?.url || sender?.url || "";
}

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
chrome.alarms.create(VERSION_ALARM, { periodInMinutes: 2 });
enableBadgeCounter();
installBlockLogger();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    syncConfig().catch(() => {});
    return;
  }
  if (alarm.name === VERSION_ALARM) {
    checkRulesVersion().catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(VERSION_ALARM, { periodInMinutes: 2 });
  enableBadgeCounter();
  chrome.storage.local.get(["hubUrl"], (data) => {
    if (!data.hubUrl && PRIVYDECK_EXTENSION_CONFIG.defaultHubUrl) {
      chrome.storage.local.set({ hubUrl: PRIVYDECK_EXTENSION_CONFIG.defaultHubUrl });
    }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.token) return;
  try {
    rulesSocket?.close();
  } catch {
    /* ignore */
  }
  rulesSocket = null;
  rulesSocketUserId = null;
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  pageBlocks.delete(tabId);
});

chrome.runtime.onStartup.addListener(() => {
  restoreSession()
    .then(() => checkRulesVersion())
    .catch(() => {});
});

restoreSession().catch(() => {});

async function restoreSession() {
  const data = await chrome.storage.local.get(["token", "wsUrl"]);
  if (!data.token) return;
  connectRulesSocket(data.wsUrl, data.token);
  await rehydrateEngine();
}
