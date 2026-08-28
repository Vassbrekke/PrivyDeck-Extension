import { PRIVYDECK_HUB_URL } from "./hub.js";

export const PRIVYDECK_EXTENSION_CONFIG = {
  defaultHubUrl: PRIVYDECK_HUB_URL,
  allowedHubOrigins: ["https://privydeck.com", "https://www.privydeck.com"],
  rulesSigningPublicKey: "",
  requireRuleSignature: false,
};
