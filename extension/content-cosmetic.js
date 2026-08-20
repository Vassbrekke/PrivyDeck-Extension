/**
 * Cosmetic filtering - hides ad/tracker UI elements using synced filter rules.
 * Trust/allowlisted sites skip cosmetics entirely (see background PRIVYDECK_GET_COSMETICS).
 */

const STYLE_ID = "privydeck-cosmetic-style";
const SCRIPTLET_FLAG = "data-privydeck-scriptlets";

/** Minimal high-value scriptlet stubs (safe no-ops for common trackers). */
const SCRIPTLETS = {
  "abort-current-inline-script": () => {},
  "abort-on-property-read": (props) => {
    try {
      const path = String(props || "").split(".");
      if (!path[0]) return;
      let obj = window;
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]];
        if (!obj) return;
      }
      const last = path[path.length - 1];
      Object.defineProperty(obj, last, {
        configurable: true,
        get() {
          throw new ReferenceError("PrivyDeck blocked property read");
        },
      });
    } catch {
      /* ignore */
    }
  },
  "set-constant": (props, value) => {
    try {
      const path = String(props || "").split(".");
      if (!path[0]) return;
      let v = value;
      if (value === "true") v = true;
      else if (value === "false") v = false;
      else if (value === "undefined") v = undefined;
      else if (value === "null") v = null;
      else if (value === "noopFunc") v = () => {};
      else if (value === "trueFunc") v = () => true;
      else if (value === "falseFunc") v = () => false;
      let obj = window;
      for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]]) obj[path[i]] = {};
        obj = obj[path[i]];
      }
      Object.defineProperty(obj, path[path.length - 1], {
        configurable: true,
        get() {
          return v;
        },
      });
    } catch {
      /* ignore */
    }
  },
};

function applySelectors(selectors) {
  if (!selectors.length) {
    document.getElementById(STYLE_ID)?.remove();
    return;
  }
  const safe = selectors.filter(
    (s) =>
      typeof s === "string" &&
      s.length > 0 &&
      s.length < 400 &&
      !/[{};@]|\/\*|<\/style|url\s*\(|[`\\]|<\/?script/i.test(s) &&
      /^[#.\[\]\w\s\-:>+~="'(),*^$|]+$/.test(s)
  );
  if (!safe.length) return;

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.documentElement || document.head || document.body).appendChild(style);
  }
  // One rule per selector avoids comma-join surprises
  style.textContent = safe
    .map(
      (s) =>
        `${s}{display:none!important;visibility:hidden!important;height:0!important;min-height:0!important;max-height:0!important;overflow:hidden!important;}`
    )
    .join("\n");
}

function applyBasicScriptlets() {
  if (document.documentElement?.hasAttribute(SCRIPTLET_FLAG)) return;
  document.documentElement?.setAttribute(SCRIPTLET_FLAG, "1");
  // Lightweight stubs for common analytics globals when still injected same-origin
  try {
    SCRIPTLETS["set-constant"]("ga", "noopFunc");
    SCRIPTLETS["set-constant"]("__gaTracker", "noopFunc");
    SCRIPTLETS["set-constant"]("GoogleAnalyticsObject", "undefined");
  } catch {
    /* ignore */
  }
}

function run() {
  const hostname = location.hostname.toLowerCase();
  chrome.runtime.sendMessage(
    { type: "PRIVYDECK_GET_COSMETICS", hostname },
    (res) => {
      if (chrome.runtime.lastError || !res?.ok) return;
      applySelectors(res.selectors || []);
      if ((res.selectors || []).length > 0 || res.engine === "hybrid" || res.engine === "firefox") {
        applyBasicScriptlets();
      }
    }
  );
}

// Apply as early as possible at document_start (documentElement is available).
run();

// Re-apply after late SPA mutations (throttled)
let scheduled = false;
const mo = new MutationObserver(() => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    run();
  }, 1500);
});
try {
  mo.observe(document.documentElement, { childList: true, subtree: true });
} catch {
  /* ignore */
}
