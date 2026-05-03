# aadd.li – Secure Serverless Open Source URL Shortener

**Official hosted instance:** [aadd.li](https://aadd.li)

aadd.li is a fast, privacy-focused open-source URL shortener built on Cloudflare Workers and Cloudflare D1.

It provides a small, security-conscious alternative to heavy commercial link management tools. The project is designed for edge redirects, anonymous expiring links, session-based user management, and privacy-friendly analytics without storing IP addresses.

## Why aadd.li?

aadd.li focuses on a simple architecture, strong security boundaries, and low operational overhead.

### Core features

- **Anonymous short links:** Create links without an account.
- **Automatic expiration:** Anonymous links expire automatically, for example after 48 hours.
- **User accounts:** Google OAuth login for managing permanent links and custom aliases.
- **Edge-first redirects:** Runs on Cloudflare Workers for globally distributed redirects.
- **Cloudflare D1 storage:** Serverless SQLite database with low operational complexity.
- **Privacy-conscious analytics:** Click analytics without storing IP addresses.
- **Abuse resistance:** Input validation, rate limiting, and safe redirect handling.

## Security

Security is a core design goal of aadd.li. The backend is covered by Vitest-based integration and security-focused tests.

Implemented protections include:

- URL scheme validation and open redirect hardening
- SSRF prevention checks
- Atomic access-control checks to reduce TOCTOU risks
- CSRF protection for session-based browser requests
- HTML escaping utilities for XSS prevention
- Secure `__Host-` session cookie usage
- Rate limiting based on Cloudflare request metadata
- Careful separation of anonymous, authenticated, and API-key based flows

See [`SECURITY_PATCHES.md`](./SECURITY_PATCHES.md) for implementation notes.

## Technical stack

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1
- **Language:** TypeScript
- **Testing:** Vitest / Cloudflare Workers test environment
- **Authentication:** Google OAuth with secure session cookies
- **Architecture:** Serverless edge application with strict API boundaries

## Use cases

aadd.li can be used as:

- a self-hostable URL shortener
- a Cloudflare Workers reference project
- a small SaaS architecture blueprint
- a privacy-conscious link management backend
- a foundation for browser extensions or productivity tools

## License

This project is licensed under the GNU General Public License v3.0.

See [`LICENSE`](./LICENSE) for the full license text and [`COPYRIGHT`](./COPYRIGHT) for third-party dependency details.

© 2024–2026 Arnold Szathmary & Contributors
