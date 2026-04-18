# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Project Overview

**aadd.li** — a serverless link shortener. Backend: Cloudflare Workers + D1. Frontend: static files in `public/` (SPA, served via Workers Assets).

- Entry point: `src/index.ts` — plain `if`-chain router, no framework
- Handlers: `src/handlers/` (auth, links, hello)
- Auth: Google OAuth (`src/auth/google.ts`, `src/auth/session.ts`)
- Shared helpers: `src/utils.ts` (`jsonResponse`, `errResponse`, `applySecurityHeaders`, `log`)
- Constants/limits: `src/config.ts`
- Input validation: `src/validation.ts`
- DB schema migrations: `sql/` (apply in order: `init.sql` → `auth.sql` → `links.sql` → …)
- Type-safe env: `src/types.ts` → `Env` interface

## Bindings & Secrets

D1 binding name: `hello_cf_spa_db` (defined in `wrangler.jsonc`).

Required **secrets** (set via `wrangler secret put`):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`

Var set in `wrangler.jsonc`: `APP_BASE_URL=https://aadd.li`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |
| `npm test` | Run Vitest test suite (`@cloudflare/vitest-pool-workers`) |

Run `wrangler types` after changing bindings in `wrangler.jsonc`.

### Local DB setup (fresh clone or after `.wrangler/` deletion)

The local D1 database (`.wrangler/state/v3/d1/`) is **not** auto-migrated. Apply all migrations once in order:

```powershell
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/init.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/auth.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase2.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase3.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/rate_limits.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/spam_filter.sql
```

For remote (production): replace `--local` with `--remote`.

## API Routes

| Method | Path | Handler |
|--------|------|---------|
| GET | `/login` | `handleLogin` |
| GET | `/api/auth/google/callback` | `handleGoogleCallback` |
| GET | `/api/me` | `handleGetMe` |
| POST | `/logout` | `handleLogout` |
| GET | `/api/hello` | `handleHello` |
| POST | `/api/links/anonymous` | `handleCreateAnonymousLink` |
| POST | `/api/links` | `handleCreateLink` |
| GET | `/api/links` | `handleGetLinks` |
| POST | `/api/links/:code/update` | `handleUpdateLink` |
| POST | `/api/links/:code/delete` | `handleDeleteLink` |
| GET | `/r/:code` | `handleRedirect` (307 redirect) |

## Conventions

- **Security headers** are applied globally in `applySecurityHeaders` (called in `fetch`); do not set them per-handler.
- **Error responses** always use `errResponse(message, status)` — never raw `new Response` for errors.
- **Session cookie** name is `sid`; managed via `makeSessionCookie` / `clearSessionCookie`.
- **Short codes**: 6-char alphanumeric, bias-free generation in `generateShortCode` (`src/validation.ts`).
- **Alias reserved words**: `["api", "login", "logout", "app", "r"]` — checked in `ALIAS_RESERVED`.
- **Logging**: use `log(category, message)` from `src/utils.ts`; it wraps `console.log` with `[category]` prefix.
- **No external npm runtime deps** — only devDependencies (wrangler, vitest, typescript).

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

(`nodejs_compat` flag enabled in `wrangler.jsonc`)

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
