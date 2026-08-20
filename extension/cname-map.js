/** Known CNAME cloaking map (mirrors server cname-trackers). */
export const CNAME_MAP_VERSION = "1";

export const CNAME_TRACKER_MAP = {
  "metrics.apple.com": "apple.com",
  "analytics.twitter.com": "twitter.com",
  "t.co": "twitter.com",
  "pixel.facebook.com": "facebook.com",
  "an.facebook.com": "facebook.com",
  "ads-api.twitter.com": "twitter.com",
  "static.ads-twitter.com": "twitter.com",
  "adservice.google.com": "googleadservices.com",
  "pagead2.googlesyndication.com": "googlesyndication.com",
  "www.googleadservices.com": "googleadservices.com",
  "googleads.g.doubleclick.net": "doubleclick.net",
  "ad.doubleclick.net": "doubleclick.net",
  "stats.g.doubleclick.net": "doubleclick.net",
  "cm.g.doubleclick.net": "doubleclick.net",
  "securepubads.g.doubleclick.net": "doubleclick.net",
  "partner.googleadservices.com": "googleadservices.com",
  "www.googletagmanager.com": "googletagmanager.com",
  "www.google-analytics.com": "google-analytics.com",
  "ssl.google-analytics.com": "google-analytics.com",
  "region1.google-analytics.com": "google-analytics.com",
  "bat.bing.com": "bing.com",
  "c.bing.com": "bing.com",
  "px.ads.linkedin.com": "linkedin.com",
  "snap.licdn.com": "linkedin.com",
  "alb.reddit.com": "reddit.com",
  "pixel.reddit.com": "reddit.com",
  "events.reddit.com": "reddit.com",
  "sp.analytics.yahoo.com": "yahoo.com",
  "udc.yahoo.com": "yahoo.com",
  "ads.yahoo.com": "yahoo.com",
  "pixel.wp.com": "wordpress.com",
  "stats.wp.com": "wordpress.com",
  "ct.pinterest.com": "pinterest.com",
  "s.pinimg.com": "pinterest.com",
  "tr.snapchat.com": "snapchat.com",
  "sc-static.net": "snapchat.com",
  "analytics.tiktok.com": "tiktok.com",
  "business-api.tiktok.com": "tiktok.com",
  "log.byteoversea.com": "tiktok.com",
};

export function uncloakHostname(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (CNAME_TRACKER_MAP[h]) return CNAME_TRACKER_MAP[h];
  for (const [alias, target] of Object.entries(CNAME_TRACKER_MAP)) {
    if (h === alias || h.endsWith(`.${alias}`)) return target;
  }
  return null;
}

export function categorizeHost(hostname) {
  const bare = String(hostname || "")
    .toLowerCase()
    .replace(/^www\./, "");
  const identity = uncloakHostname(bare) || bare;
  if (
    /doubleclick|googlesyndication|googleadservices|adservice|taboola|outbrain|adnxs|criteo|amazon-adsystem/.test(
      identity
    )
  ) {
    return "ads";
  }
  if (/urlhaus|malware|phishing|secure-login|account-verify/.test(identity)) {
    return "malware";
  }
  if (/facebook|twitter|linkedin|pinterest|tiktok|snapchat|widgets\.|platform\./.test(identity)) {
    return "annoyances";
  }
  return "trackers";
}
