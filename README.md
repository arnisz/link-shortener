# aadd.li – Secure & Serverless Open Source URL Shortener

🚀 **Official Hosted Instance:** [aadd.li](https://aadd.li)

**aadd.li** is a lightning-fast, privacy-focused open-source URL shortener. Built entirely on a serverless edge architecture using Cloudflare Workers and D1, it provides a clean, secure, and production-ready alternative to bloated commercial link management tools.

Whether you need anonymous short links that expire automatically or a hardened backend for per-user link management, aadd.li is designed for simplicity and maximum security.

## 🌟 Why aadd.li? (Core Features)

We focus on robust architecture and privacy rather than feature bloat. The official instance at [aadd.li](https://aadd.li) showcases this hardened MVP:

* **Privacy-First & Auto-Expiration:** Anonymous links expire automatically (e.g., after 48h), leaving no permanent trace.
* **Secure User Management:** Google OAuth integration for session-based management, custom aliases, and permanent links.
* **Edge-First Performance:** Zero cold starts and global low latency thanks to Cloudflare Workers.
* **Abuse-Resistant:** Strict input validation, rate limiting, and safe redirect handling with proper HTTP status codes.

## 🛡️ Enterprise-Grade Security (As of Mai 2026)

Security isn't an afterthought. The backend is fully test-covered (Vitest) and hardened against common web vulnerabilities:

* **Open Redirect Protection:** Strict URL schema whitelisting and SSRF prevention.
* **TOCTOU-Resistant Access Control:** Atomic permission checks prevent race conditions.
* **XSS & CSRF Prevention:** Comprehensive HTML escaping utilities, Token-based + Legacy Origin checks for CSRF.
* **Session Security:** Strict `__Host-` cookie prefixes.
* **Rate Limiting:** Intelligent, CF-Connecting-IP aware throttling.

> 📖 **See [SECURITY_PATCHES.md](./SECURITY_PATCHES.md)** for deep dives into our security implementation.

## 💻 Technical Stack & Architecture

aadd.li requires no traditional server backend, making it highly scalable and cheap to operate. It serves as a perfect blueprint for modern SaaS applications, browser extensions, or productivity tools.

* **Runtime:** Cloudflare Workers (Edge runtime)
* **Database:** Cloudflare D1 (Serverless SQLite)
* **API Design:** Clean, strict separation between frontend and a fully tested API.
* **Security Context:** Nonce validation, strict input checks, zero information leaks.

## 📄 License & Copyright

This project is licensed under the **GNU General Public License v3 (GPLv3)**.
See [LICENSE](./LICENSE) for the full license text and [COPYRIGHT](./COPYRIGHT) for third-party dependency details.

© 2024–2026 Arnold Szathmary & Contributors — Home of [aadd.li](https://aadd.li)

