/**
 * Cosmetic filtering. Allowlisted and session-paused sites get no cosmetics.
 * Element hiding is opt-in per click and stored only on this device.
 */

const STYLE_ID = "privydeck-cosmetic-style";

function isSafeSelector(selector) {
  return (
    typeof selector === "string" &&
    selector.length > 0 &&
    selector.length < 400 &&
    !/[{};@]|\/\*|<\/style|url\s*\(|[`\\]|<\/?script/i.test(selector) &&
    /^[#.\[\]\w\s\-:>+~="'(),*^$|]+$/.test(selector)
  );
}

function applySelectors(selectors) {
  const safe = (selectors || []).filter(isSafeSelector);
  if (!safe.length) {
    document.getElementById(STYLE_ID)?.remove();
    return;
  }
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.documentElement || document.head || document.body).appendChild(style);
  }
  style.textContent = safe
    .map(
      (s) =>
        `${s}{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;}`
    )
    .join("\n");
}

let cachedSelectors = [];

function refresh() {
  const hostname = location.hostname.toLowerCase();
  chrome.runtime.sendMessage({ type: "PRIVYDECK_GET_COSMETICS", hostname }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    cachedSelectors = res.selectors || [];
    applySelectors(cachedSelectors);
  });
}

function selectorFor(el) {
  if (!(el instanceof Element)) return "";
  if (el.id && /^[A-Za-z][\w-]{0,80}$/.test(el.id)) {
    const sel = `#${el.id}`;
    return isSafeSelector(sel) ? sel : "";
  }
  const tag = el.tagName.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return "";
  const classes = [...el.classList].filter((c) => /^[A-Za-z][\w-]{0,40}$/.test(c)).slice(0, 2);
  if (!classes.length) return "";
  const sel = `${tag}.${classes.join(".")}`;
  return isSafeSelector(sel) ? sel : "";
}

function startZapper() {
  if (window.top !== window) return;
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const bar = document.createElement("div");
  bar.textContent = "Click an element to hide it on this site. Esc cancels.";
  bar.setAttribute(
    "style",
    "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0a1f14;color:#f4f4f7;border:1px solid #4ade80;border-radius:8px;padding:8px 12px;font:13px system-ui,sans-serif;"
  );
  root.appendChild(bar);
  document.documentElement.appendChild(host);

  const cleanup = () => {
    host.remove();
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event) => {
    if (event.key === "Escape") cleanup();
  };
  const onClick = (event) => {
    const target = event.composedPath().find((node) => node instanceof Element && node !== host);
    if (!target || event.composedPath().includes(host)) return;
    event.preventDefault();
    event.stopPropagation();
    const selector = selectorFor(target);
    cleanup();
    if (!selector) return;
    chrome.runtime.sendMessage({ type: "PRIVYDECK_ZAP_SAVE", selector }, () => {
      cachedSelectors = [...cachedSelectors, selector];
      applySelectors(cachedSelectors);
    });
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onClick, true);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "PRIVYDECK_ZAP_ARM") return;
  startZapper();
  sendResponse({ ok: true });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.cosmeticRules || changes.localCosmetics || changes.allowDomains || changes.pausedSites) {
    refresh();
  }
});

refresh();

let scheduled = false;
const mo = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    applySelectors(cachedSelectors);
  }, 800);
});
try {
  mo.observe(document.documentElement, { childList: true, subtree: true });
} catch {
  /* ignore */
}
