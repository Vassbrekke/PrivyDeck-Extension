import { PRIVYDECK_EXTENSION_CONFIG } from "./config.js";
import { categorizeHost, uncloakHostname, CNAME_TRACKER_MAP, CNAME_MAP_VERSION } from "./cname-map.js";
import {
  chromiumCosmeticLimit,
  engineLabel,
  firefoxCosmeticLimit,
} from "./engine-info.js";

const SYNC_ALARM = "privydeck-sync";
const VERSION_ALARM = "privydeck-version";
const BLOCK_RULE_OFFSET = 1000;
const ALLOW_RULE_OFFSET = 5000;
const FILTER_RULE_OFFSET = 10_000;
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
/** Firefox webRequest in-memory sets */
let fxBlockSet = new Set();
let fxAllowSet = new Set();
let fxWebRequestInstalled = false;
let blockedByCategory = { ads: 0, trackers: 0, malware: 0, annoyances: 0 };

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
  if (set.has(hostname)) return true;
  for (const d of set) {
    if (hostname === d || hostname.endsWith(`.${d}`)) return true;
  }
  return false;
}

function recordFirefoxBlock(host) {
  bumpBlockedCategory(host);
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
        recordFirefoxBlock(host);
        return { cancel: true };
      }
      // Live DNS CNAME uncloak (Firefox blocking listeners may return a Promise)
      return dnsUncloakShouldBlock(host).then((block) => {
        if (!block) return {};
        recordFirefoxBlock(host);
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

function isBlockMatch(info) {
  return !(
    info.rule.rulesetId === "_dynamic" &&
    info.rule.ruleId >= ALLOW_RULE_OFFSET &&
    info.rule.ruleId < FILTER_RULE_OFFSET
  );
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

  return {
    domainRules: domainBlockRules.length,
    filterRules: filterRules.length,
    allowRules: allowRules.length,
  };
}

export async function syncConfig() {
  const { hubUrl, token, deviceName, platform } = await getSettings();
  if (!token) throw new Error("Sign in from PrivyDeck and connect your account");

  const base = resolveHubUrl(hubUrl);
  let configRes;
  try {
    const qs = new URLSearchParams();
    if (deviceName) qs.set("deviceName", deviceName);
    if (platform) qs.set("platform", platform);
    const q = qs.toString() ? `?${qs}` : "";
    configRes = await fetch(`${base}/api/extension/config${q}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-PrivyDeck-Engine": isFirefox() ? "firefox" : "chromium",
      },
    });
  } catch {
    throw new Error(
      `Could not reach PrivyDeck at ${base}. Check the server URL matches where you signed in.`
    );
  }

  if (!configRes.ok) {
    if (configRes.status === 401) {
      throw new Error("Invalid or expired token. Generate a new token in PrivyDeck Setup.");
    }
    throw new Error(`Could not sync protection rules (${configRes.status}). Check the server URL.`);
  }

  const config = await configRes.json();
  const applied = await applyProtectionRules(
    config.blockDomains ?? [],
    config.allowDomains ?? [],
    true,
    config.dnrRules ?? [],
    config.categories ?? null
  );

  const stored = await getSettings();
  loadCategoryCounts(stored.blockedByCategory);

  await chrome.storage.local.set({
    allowDomains: config.allowDomains ?? [],
    blockDomains: config.blockDomains ?? [],
    cosmeticRules: config.cosmeticRules ?? [],
    engine: isFirefox() ? "hybrid" : config.engine ?? "dnr",
    categories: config.categories ?? null,
    cnameMapVersion: config.cnameMapVersion ?? CNAME_MAP_VERSION,
  });

  const blockedTotal = await accumulateBlockedCount();

  const syncRes = await fetch(`${base}/api/extension/sync`, {
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

  if (!syncRes.ok) {
    throw new Error(`Account sync failed (${syncRes.status})`);
  }

  await chrome.storage.local.set({
    hubUrl: base,
    wsUrl: config.wsUrl ?? null,
    lastSync: Date.now(),
    rulesVersion: config.rulesVersion ?? null,
    connected: true,
  });

  connectRulesSocket(config.wsUrl, token);
  return config;
}

async function checkRulesVersion() {
  const { hubUrl, token, rulesVersion } = await getSettings();
  if (!token) return;

  const base = resolveHubUrl(hubUrl);
  try {
    const res = await fetch(`${base}/api/extension/config`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-PrivyDeck-Engine": isFirefox() ? "firefox" : "chromium",
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
  if (rulesSocket && rulesSocketUserId === token) return;

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
      .then((config) => sendResponse({ ok: true, config }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message?.type === "PRIVYDECK_SAVE") {
    saveAndSync(message.settings)
      .then((config) => sendResponse({ ok: true, config, message: "Connected and synced." }))
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
  if (message?.type === "PRIVYDECK_GET_COSMETICS") {
    const hostname = String(message.hostname || "").toLowerCase();
    chrome.storage.local.get(["cosmeticRules", "allowDomains"], (data) => {
      const allow = new Set((data.allowDomains || []).map((d) => String(d).toLowerCase()));
      if ([...allow].some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
        sendResponse({ ok: true, selectors: [] });
        return;
      }
      const selectors = [];
      for (const rule of data.cosmeticRules || []) {
        if (rule.exception) continue;
        const domains = rule.domains || [];
        const matches =
          domains.length === 0 ||
          domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
        if (!matches) continue;
        for (const s of rule.selectors || []) selectors.push(s);
      }
      const except = new Set();
      for (const rule of data.cosmeticRules || []) {
        if (!rule.exception) continue;
        const domains = rule.domains || [];
        const matches =
          domains.length === 0 ||
          domains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
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
    return true;
  }
});

chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
chrome.alarms.create(VERSION_ALARM, { periodInMinutes: 2 });
enableBadgeCounter();

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

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(["token", "wsUrl", "rulesVersion"], (data) => {
    if (data.token) {
      connectRulesSocket(data.wsUrl, data.token);
      checkRulesVersion().catch(() => {});
    }
  });
});
