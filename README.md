YAQQ is a lightweight, serverless link shortener built on Cloudflare Workers and D1, designed as a clean and secure foundation for a production-ready web application.

The project focuses on simplicity, robustness, and practical architecture rather than feature bloat. It provides a minimal browser-based interface combined with a hardened backend and a fully tested API.

Core features:
- Google OAuth authentication
- Session-based user management
- Creation of short links with optional aliases
- Expiration dates and active/inactive state
- Safe redirect handling with proper HTTP status codes
- Per-user link management
- Input validation and abuse-resistant design
- Fully test-covered backend (Vitest)

Technical highlights:
- Cloudflare Workers (edge runtime)
- Cloudflare D1 (SQLite-based serverless database)
- No external backend or traditional server required
- Clean separation between API and frontend
- Security-focused implementation (nonce validation, strict input checks, no information leaks)

This project serves as a solid starting point for:
- SaaS-style web applications
- Edge-first architectures
- Browser-based productivity tools
- Future extensions like analytics, API access, or browser integrations

The current state represents a hardened MVP that is safe to deploy and operate.
