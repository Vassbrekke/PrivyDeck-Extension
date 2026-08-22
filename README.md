# PrivyDeck Personal Shield

Open-source browser extension for **ads**, **trackers**, and **malware** blocking, with optional sync from a [PrivyDeck](https://privydeck.com) account.

This is the published source for Personal Shield (Vassbrekke AS). Publishing the source lets you inspect it. That is not an independent third-party security audit.

> Store listings (Chrome Web Store, Firefox Add-ons, Edge) remain the supported install path for most people. This repository is for review, local builds, and contributions.

## What it does

- Baseline tracker blocking before any account sync
- Optional PrivyDeck account connect: live blocklists, lockdown categories, allowlist
- Chromium MV3 (declarativeNetRequest) and Firefox (DNR + webRequest + DNS CNAME uncloak)
- Cosmetic filtering on page content
- No telemetry from the extension itself

Source lives in [`extension/`](extension/). Production hub URL is `https://privydeck.com`.

## Load unpacked (inspect / develop)

Requires **Node.js 18+**. No `npm install` — the build uses Node’s standard library only.

```bash
git clone https://github.com/Vassbrekke/PrivyDeck-Extension.git
cd PrivyDeck-Extension
npm run build:dev
```

- **Chrome / Edge / Brave / Opera:** `chrome://extensions` → Developer mode → Load unpacked → `dist/extension-chromium`
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `dist/extension-firefox/manifest.json`

Dev builds point at `http://localhost:3010` (override with `NEXT_PUBLIC_APP_URL` in `.env.local`). Production packages bake in `https://privydeck.com`:

```bash
npm run build
# dist/privy-deck-extension-chromium.zip
# dist/privy-deck-extension-firefox.zip
```

## Architecture

| File | Role |
|------|------|
| `extension/background.js` | Rule sync, DNR / Firefox webRequest, block stats |
| `extension/content-bridge.js` | One-click connect from the PrivyDeck web app |
| `extension/content-cosmetic.js` | Page cosmetic filters |
| `extension/config.js` | Generated at build time with hub URL and allowed origins |
| `extension/rules/` | Static MV3 rule resources (baseline + category lists) |
| `scripts/build-extension.mjs` | Chromium + Firefox packages |

Dashboard false positives can suggest allowlist entries; the extension may still auto-allow locally for continuity.

## Releases

Version lives in `extension/manifest.json`. After bumping and committing:

```bash
npm run release
```

That pushes tag `v{version}`. GitHub Actions builds production zips and attaches them to the GitHub Release.

## License

[GNU GPL v2.0](LICENSE). Copyright © 2026 Vassbrekke AS.
