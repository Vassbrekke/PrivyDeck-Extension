/**
 * Firefox-oriented helpers shared with the Chromium DNR path.
 * Firefox builds also enable webRequestBlocking + dns for CNAME uncloaking.
 */

export function firefoxCosmeticLimit() {
  return 2000;
}

export function chromiumCosmeticLimit() {
  return 800;
}

export function engineLabel(isFx) {
  return isFx
    ? "Maximum protection on Firefox (webRequest + DNS CNAME uncloak + cosmetics)"
    : "Optimized MV3 engine on Chromium (live DNR sync + static category rulesets + cosmetics)";
}
