# Security policy

PrivyDeck welcomes reports of security vulnerabilities in the hosted service, Personal Shield (browser extension), and the optional home-hub agent.

**Do not** open a public GitHub issue for an unpatched vulnerability.

## Contact

- Email: [security@privydeck.com](mailto:security@privydeck.com)
- Privacy / data-protection requests that are not vulnerabilities: [privacy@privydeck.com](mailto:privacy@privydeck.com)
- Public process: [https://privydeck.com/trust#disclosure](https://privydeck.com/trust#disclosure)
- Machine-readable: [https://privydeck.com/.well-known/security.txt](https://privydeck.com/.well-known/security.txt)

If the mailbox is not yet monitored, use [privacy@privydeck.com](mailto:privacy@privydeck.com) with subject `SECURITY`.

## What to include

- Product area: extension, vault, API, auth, DNS/hub, filter compiler, or website
- Impact (what an attacker could do)
- Affected version or git commit when you know it
- Steps that stay inside **your own** test account
- Proof-of-concept only as far as needed to reproduce — no exploits against other users, no stolen data

Encrypted mail (PGP) is not published yet. Say so in the report if you need a key before sending details.

## Response targets

| Stage | Target |
|-------|--------|
| Acknowledgement | 3 business days |
| Initial triage | 7 days |
| Fix or public status for High / Critical | 90 days (sooner if we believe it is being exploited) |

We may ask for more detail. We will not ask you to keep a High/Critical issue secret past 90 days without a documented reason.

## Safe harbor

If you report in good faith, avoid privacy violations, service disruption, and access to other people's data, we will not pursue legal action for that research. Do not:

- Run scans or exploits against production users
- Exfiltrate data that is not yours
- Use social engineering against staff or customers
- Demand payment as a condition of disclosure (we do not currently run a bug bounty)

## After a fix

We prefer coordinated disclosure. Credit is optional and on request. Independent audit reports, when commissioned, will be linked in full from [/trust](https://privydeck.com/trust#audit).
