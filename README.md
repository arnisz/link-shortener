# aadd.li — Serverless Link Shortener

aadd.li is a performance-oriented, security-conscious, fully serverless URL shortener built on the Cloudflare developer platform using Cloudflare Workers, Cloudflare D1, and Cloudflare KV.

This repository is the open-source home of aadd.li. The public service at [aadd.li](https://aadd.li) runs on this codebase as its core URL shortener, with additional private modules used for hosted analytics and operational tooling.

The frontend is a lightweight Single Page Application served directly from the `public/` directory without the overhead of heavy web frameworks.

## Core Features

- **Fast serverless redirects:** Low-latency redirects powered by Cloudflare Workers and a read-through KV caching layer.
- **User management:** Google OAuth 2.0 authentication for user-based link management.
- **Anonymous links:** Create short links without an account, with a hard 48-hour expiration.
- **Custom aliases:** Authenticated users can claim human-readable short URLs.
- **Hashtag system:** Organize links with up to 10 custom tags per URL.

## Security & Threat Intelligence: The Guardian / Wächter

aadd.li is designed to reduce abuse from spam, phishing, and malware through a two-tier security architecture.

### 1. Static check: first line of defense

Newly created links are synchronously checked against a snapshot of known malicious domains, such as URLhaus-derived threat data stored in Cloudflare KV.

Positive matches can be blocked before insertion into the database, without requiring heavyweight external lookups in the request path.

### 2. The Guardian: asynchronous scanner

An external scanner, for example a Python service running on a Raspberry Pi, VPS, or dedicated host, can continuously fetch pending links via the `/api/internal/links/pending` API.

The scanner can perform deeper checks outside the Cloudflare request path, including:

- revalidation of newly created links
- repeated checks for links marked as `warning`
- periodic revalidation of active links
- Google Safe Browsing checks
- heuristic URL analysis
- optional antivirus scanning
- aggregated threat scoring

The scanner reports the resulting safety status back to the Worker.

### Link status handling

aadd.li supports different link safety states:

- `active`: normal redirect flow
- `warning`: redirect is intercepted by a warning page at `/warning`
- `blocked`: redirect is denied with `404 Not Found`

For warning pages, bypass events can be logged in a privacy-conscious way, for example without storing IP addresses.

## Technology Stack

- **Backend:** Cloudflare Workers, TypeScript, esbuild, Wrangler
- **Database:** Cloudflare D1
- **Cache and threat lookup:** Cloudflare KV
- **Testing:** Vitest with `@cloudflare/vitest-pool-workers`
- **Frontend:** Vanilla HTML/CSS/JavaScript SPA

## Local Development

Use the Wrangler CLI for local development and deployment:

```bash
# Install dependencies
npm install

# Initialize local D1 database schema
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/init.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/auth.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links.sql

# Run all remaining SQL migrations in the order documented in AGENTS.md

# Start the local development server
npx wrangler dev --env dev
