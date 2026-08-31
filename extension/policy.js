/** Local allowlist / rule-set policy: verify, pin, rollback, audit log. No telemetry. */

export const RULE_SIGN_ALG = "ES256";
export const RULE_SIGN_KID = "v1";
export const POLICY_LOG_MAX = 80;

const RULE_SIGN_FIELDS = [
  "allowDomains",
  "blockDomains",
  "categories",
  "cnameMapVersion",
  "cosmeticRules",
  "dnrRules",
  "enabledLists",
  "engine",
  "lockdownMode",
  "rulesIssuedAt",
  "rulesVersion",
  "securityAllowDomains",
  "subscribeUrls",
  "tier",
  "wsUrl",
];

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function ruleSignBody(config) {
  const body = {};
  for (const key of RULE_SIGN_FIELDS) {
    if (config[key] !== undefined) body[key] = config[key];
  }
  return body;
}

function b64urlToBytes(b64url) {
  const b64 = String(b64url || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s/g, "");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function spkiToBytes(b64) {
  const clean = String(b64 || "").replace(/\s/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyRuleSignature(config, publicKeyB64, requireSig) {
  const envelope = config?.ruleSig;
  if (!envelope?.sig) {
    if (requireSig) return { ok: false, reason: "missing rule signature" };
    return { ok: true, unsigned: true };
  }
  if (envelope.alg !== RULE_SIGN_ALG || envelope.kid !== RULE_SIGN_KID) {
    return { ok: false, reason: "unsupported rule signature" };
  }
  if (!publicKeyB64) {
    if (requireSig) return { ok: false, reason: "this build has no pinned rule-signing public key" };
    return { ok: true, unsigned: true };
  }

  try {
    const key = await crypto.subtle.importKey(
      "spki",
      spkiToBytes(publicKeyB64),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const payload = new TextEncoder().encode(canonicalJson(ruleSignBody(config)));
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlToBytes(envelope.sig),
      payload
    );
    return ok ? { ok: true, unsigned: false } : { ok: false, reason: "invalid rule signature" };
  } catch {
    return { ok: false, reason: "rule signature verification failed" };
  }
}

export function compactSnapshot(config) {
  return {
    allowDomains: config.allowDomains ?? [],
    securityAllowDomains: config.securityAllowDomains ?? [],
    blockDomains: config.blockDomains ?? [],
    dnrRules: config.dnrRules ?? [],
    cosmeticRules: config.cosmeticRules ?? [],
    categories: config.categories ?? null,
    rulesVersion: config.rulesVersion ?? null,
    rulesIssuedAt: Number(config.rulesIssuedAt) || 0,
    enabledLists: config.enabledLists ?? [],
    lockdownMode: config.lockdownMode ?? null,
    engine: config.engine ?? null,
    cnameMapVersion: config.cnameMapVersion ?? null,
  };
}

export async function appendPolicyLog(entry) {
  const { policyLog } = await chrome.storage.local.get(["policyLog"]);
  const next = Array.isArray(policyLog) ? policyLog : [];
  next.unshift({
    at: Date.now(),
    action: String(entry.action || "change").slice(0, 40),
    domain: entry.domain ? String(entry.domain).slice(0, 253) : undefined,
    detail: entry.detail ? String(entry.detail).slice(0, 240) : undefined,
  });
  await chrome.storage.local.set({ policyLog: next.slice(0, POLICY_LOG_MAX) });
}

export async function readPolicyState() {
  return chrome.storage.local.get([
    "policyLog",
    "rulesSnapshot",
    "rulesSnapshotPrev",
    "rulesPinned",
    "rulesIssuedAt",
    "rulesVersion",
  ]);
}

export async function rememberSnapshot(config) {
  const { rulesSnapshot } = await chrome.storage.local.get(["rulesSnapshot"]);
  const next = compactSnapshot(config);
  const store = { rulesSnapshot: next, rulesIssuedAt: next.rulesIssuedAt };
  if (rulesSnapshot?.rulesVersion && rulesSnapshot.rulesVersion !== next.rulesVersion) {
    store.rulesSnapshotPrev = rulesSnapshot;
  }
  try {
    await chrome.storage.local.set(store);
  } catch {
    delete next.cosmeticRules;
    try {
      await chrome.storage.local.set({ ...store, rulesSnapshot: next });
    } catch {
      delete next.dnrRules;
      await chrome.storage.local.set({ ...store, rulesSnapshot: next }).catch(() => {});
    }
  }
}

export async function rollbackToPrevious() {
  const { rulesSnapshot, rulesSnapshotPrev } = await chrome.storage.local.get([
    "rulesSnapshot",
    "rulesSnapshotPrev",
  ]);
  if (!rulesSnapshotPrev) return null;
  await chrome.storage.local.set({
    rulesSnapshot: rulesSnapshotPrev,
    rulesSnapshotPrev: rulesSnapshot ?? null,
    rulesPinned: true,
    rulesIssuedAt: Number(rulesSnapshotPrev.rulesIssuedAt) || 0,
    rulesVersion: rulesSnapshotPrev.rulesVersion ?? null,
  });
  await appendPolicyLog({
    action: "rollback",
    detail: `Restored ${rulesSnapshotPrev.rulesVersion || "previous rules"}; updates paused`,
  });
  return rulesSnapshotPrev;
}

export async function setRulesPinned(pinned) {
  await chrome.storage.local.set({ rulesPinned: Boolean(pinned) });
  await appendPolicyLog({
    action: pinned ? "pin" : "unpin",
    detail: pinned ? "Paused remote rule updates" : "Resumed remote rule updates",
  });
}

export function isReplay(config, pinnedIssuedAt) {
  const issued = Number(config?.rulesIssuedAt) || 0;
  const prev = Number(pinnedIssuedAt) || 0;
  if (!issued) return true;
  if (issued > Date.now() + 10 * 60 * 1000) return true;
  return Boolean(prev && issued < prev);
}
