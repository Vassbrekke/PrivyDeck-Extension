# Changelog — PrivyDeck Personal Shield

Format follows [Keep a Changelog](https://keepachangelog.com/). Version numbers live in `extension/manifest.json`.

## Unreleased

- Trust documentation for permissions, sync, and build verification: https://privydeck.com/trust
- Tagged GitHub Releases will attach `SHA256SUMS.txt` and Artifact Attestations so production zips can be verified against source.

## 1.4.4 — 2026-08

- Pin the official rule-signing public key in production builds so Connect can verify signed protection rules.
- Production builds fail closed if that public key is missing.
- Connect errors point to Settings → Browser extension, and a missing signing key on the server is shown clearly.

## 1.4.3 — 2026-08

- Faster, more reliable account sync on Chrome, Edge, Firefox, and Safari: skip unchanged rule payloads (304), keep one sync in flight, and stop posting the full rule set through extension messaging.
- Connect from the website waits for a real extension ack instead of giving up at 4 seconds.
- Firefox suffix matching no longer walks the entire block set on every request.

## 1.4.2 — 2026-08

- Signed remote rule payloads (ECDSA P-256); production builds reject unsigned or replayed sets and can roll back locally.
- Firefox hybrid blocking (declarativeNetRequest plus webRequest) and on-device CNAME uncloaking.
