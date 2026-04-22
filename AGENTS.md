# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Project Overview

**aadd.li** — a serverless link shortener. Backend: Cloudflare Workers + D1. Frontend: static files in `public/` (SPA, served via Workers Assets).

- Entry point: `src/index.ts` — plain `if`-chain router, no framework
- Handlers: `src/handlers/` (`auth.ts`, `links.ts`)
- Auth: Google OAuth (`src/auth/google.ts`, `src/auth/session.ts`)
- CSRF protection: `src/csrf.ts` (`validateCsrf`, `validateCsrfToken`, `generateCsrfToken`, `validateMutationCsrf`)
- Rate limiting: `src/rateLimit.ts` (`checkRateLimit`, `extractClientIp`)
- Shared helpers: `src/utils.ts` (`jsonResponse`, `errResponse`, `applySecurityHeaders`, `log`, `randomId`, `escapeHtml`, `getCookie`, `makeSessionCookie`, `clearSessionCookie`, `base64UrlDecode`)
- Constants/limits: `src/config.ts`
- Input validation: `src/validation.ts` (`generateShortCode`, `isValidHttpUrl`, `validateTargetUrl`, `validateAlias`, `buildGeoUrl`, `isValidFutureIso`, `requireJson`, `checkSpamFilter`, `validateTag`, `_resetSpamKeywordCache`)
- DB schema migrations: `sql/` (apply in order: `init.sql` → `auth.sql` → `links.sql` → …)
- Type-safe env: `src/types.ts` → `Env` interface

## Bindings & Secrets

D1 binding name: `hello_cf_spa_db` (defined in `wrangler.jsonc`).

Required **secrets** (set via `wrangler secret put`):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`

Var set in `wrangler.jsonc`: `APP_BASE_URL=https://aadd.li`. Observability is enabled (`"observability": { "enabled": true }`).

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev --env dev` | Local development (sets `APP_BASE_URL=http://127.0.0.1:8787` for CSRF) |
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
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/spam-keywords-extended.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase4_tags.sql
```

For remote (production): replace `--local` with `--remote`.

## API Routes

| Method | Path | Handler |
|--------|------|---------|
| GET | `/login` | `handleLogin` |
| GET | `/api/auth/google/callback` | `handleGoogleCallback` |
| GET | `/api/me` | `handleGetMe` — returns `{ authenticated: false }` or `{ authenticated: true, user, csrfToken }` |
| POST | `/logout` | `handleLogout` |
| POST | `/api/links/anonymous` | `handleCreateAnonymousLink` |
| POST | `/api/links` | `handleCreateLink` |
| GET | `/api/links` | `handleGetLinks` (cursor-based pagination: `?cursor=ISO\|id&limit=N`, default 50, max 100) |
| POST | `/api/links/:code/update` | `handleUpdateLink` |
| POST | `/api/links/:code/delete` | `handleDeleteLink` |
| GET, HEAD | `/r/:code` | `handleRedirect` (302 redirect) |

## Conventions

- **Security headers** are applied globally in `applySecurityHeaders` (called in `fetch`); do not set them per-handler.
- **Error responses** always use `errResponse(message, status, extraHeaders?)` — never raw `new Response` for errors. Use `extraHeaders` for headers like `Retry-After: 60` on 429 responses.
- **Session cookie** name is `__Host-sid`; managed via `makeSessionCookie` / `clearSessionCookie`. The `__Host-` prefix enforces Secure, Path=/, and no Domain attribute.
- **CSRF — two-layer protection**:
  1. Global: `validateCsrf(request, env)` in the router rejects cross-origin POSTs missing `X-Requested-With` (legacy layer, `src/csrf.ts`).
  2. Per-handler: authenticated mutation endpoints (`handleCreateLink`, `handleUpdateLink`, `handleDeleteLink`) call `validateMutationCsrf(request, env)` which returns `Response | null`:
     - Foreign `Origin` header → always rejected (403).
     - Same-origin request with `Origin: APP_BASE_URL` → requires either a valid `X-CSRF-Token` (HMAC-SHA256 of the session cookie value `__Host-sid`, via `validateCsrfToken`) **or** `X-Requested-With` header.
     - No `Origin` header (non-browser client) → allowed.
  - Clients must send `X-CSRF-Token: <token>` obtained from `generateCsrfToken(sessionId, secret)` where `sessionId` is the `__Host-sid` cookie value.
- **Rate limiting**: `checkRateLimit(key, db, limit?)` from `src/rateLimit.ts`; uses D1 `rate_limits` table with 1-minute tumbling windows. Default limit = 10 req/min. Keys are scoped by use-case: plain IP for anonymous links (10/min), `login:<ip>` for login (5/min), `redirect:<ip>` for redirects (60/min). **Fails open** on D1 error (deliberate — brief outage is acceptable given Cloudflare's own DDoS mitigation). Stale windows older than 5 minutes are cleaned up on each check.
- **Spam filter**: `checkSpamFilter(url, db)` from `src/validation.ts` — applied to anonymous link creation; returns `true` if blocked. Keywords are loaded from the `spam_keywords` table and **cached in module scope for 5 minutes** (TTL). Use `_resetSpamKeywordCache()` in tests to ensure isolation between test runs.
- **URL validation**: `validateTargetUrl(raw)` from `src/validation.ts` — validates scheme (http/https only) and blocks SSRF targets (localhost, private IPs, IPv6 ULA/link-local). Used in `handleRedirect` to re-validate stored URLs before serving the redirect; returns `{ ok: true, url: URL } | { ok: false, error: string }`.
- **Input requirements**: All mutation endpoints require `Content-Type: application/json`; enforced via `requireJson(request)`.
- **Alias normalization**: User-supplied aliases are NFKC-normalized and Unicode dashes (`‐‑‒–—−`) replaced with `-` before `validateAlias()` is called.
- **Short codes**: 6-char alphanumeric, bias-free generation in `generateShortCode` (`src/validation.ts`).
- **Hashtags**: Authenticated users can assign up to 10 tags per link (limit `TAG_MAX_PER_LINK`). Tags are normalized (NFKC, lowercase, leading # removed, trim), 1–50 chars, starting with alphanumeric `[a-z0-9][a-z0-9_-]*`. Tags are validated via `validateTag(raw)` in `src/validation.ts`. Tags are strictly user-scoped; orphaned tags are garbage collected after each mutation (`UPDATE`, `DELETE`). **Tag updates are full-replace**: sending `tags: []` removes all tags; sending `tags: ["foo"]` replaces all existing tags with `["foo"]`. D1 tag operations use **two-phase batching** because junction-table inserts (`link_tags`) need the AUTOINCREMENT `tag_id` — first batch inserts into `tags`, second batch inserts into `link_tags` using a `SELECT … WHERE name = ?` subquery.
- **Search**: `GET /api/links?q=<term>` searches via case-insensitive substring in alias, title, and tag names. Term is trimmed and capped at 100 chars. Case-insensitivity is ensured via `LOWER()` in SQL.
- **Alias reserved words**: `["api", "login", "logout", "app", "r"]` — checked in `ALIAS_RESERVED`.
- **Logging**: use `log(category, message)` from `src/utils.ts`; it wraps `console.log` with `[category]` prefix.
- **HTML escaping**: use `escapeHtml(str)` from `src/utils.ts` for any user-supplied content embedded in HTML contexts.
- **Ownership enforcement**: Update/delete queries include `AND user_id = ?` directly in the `WHERE` clause (atomic, prevents TOCTOU). `result.meta.changes === 0` returns 404 for both "not found" and "wrong owner" — intentionally no distinction to prevent user enumeration.
- **Async click counting**: `handleRedirect` increments `click_count` via `ctx.waitUntil(...)` (non-blocking, does not delay the 302 response).
- **Anonymous links**: always get a hard 48 h expiry (`expires_at = now + 48h`); no title or alias; `user_id` stored as `NULL`. Sending a `tags` field on `POST /api/links/anonymous` is rejected with 400.
- **Redirect anti-enumeration**: `handleRedirect` returns `404` for not-found, inactive (`is_active = 0`), **and** expired links — never `410`. This prevents short-code enumeration via status-code differences.
- **CSRF token acquisition**: call `GET /api/me` while authenticated; the `csrfToken` field in the JSON response is the value to send as `X-CSRF-Token` on subsequent mutation requests. The token is `HMAC-SHA256(sessionId, SESSION_SECRET)` where `sessionId` is the `__Host-sid` cookie value.
- **OAuth cookies**: `handleLogin` sets short-lived `oauth_state` and `oauth_nonce` cookies (`Max-Age=600`). After a successful callback, both are cleared and the user is redirected to `/app.html`. `getAllowedOrigins` (in `src/csrf.ts`) dynamically computes allowed origins from both `APP_BASE_URL` and the request's own origin, so CSRF validation works in every environment without extra config.
- **Config limits**: `TARGET_URL_MAX_LEN = 2000`, `TITLE_MAX_LEN = 200`, `TAG_MAX_PER_LINK = 10`, `TAG_NAME_MAX_LEN = 50`, `SHORT_CODE_GENERATION_RETRIES = 5` — all in `src/config.ts`; never hardcode these.

## Testing

Tests use `@cloudflare/vitest-pool-workers` (Miniflare). Shared utilities live in `test/helpers.ts`:

| Helper | Purpose |
|--------|---------|
| `setupTestDb(db)` | Creates `users` + `sessions` tables |
| `setupLinksTable(db)` | Creates `links` table and indexes |
| `setupTagsTables(db)` | Creates `tags` + `link_tags` tables |
| `setupSpamTable(db)` | Creates `spam_keywords` table with seed keywords |
| `setupRateLimitTable(db)` | Creates `rate_limits` table |
| `seedSession(db, opts?)` | Inserts a user + valid session; returns `{ userId, sessionId }` |
| `seedLink(db, opts)` | Inserts a link row; returns `{ id, shortCode }` |
| `makeRequest(url, method?, opts?)` | Builds a `Request` with cookies/headers/body |
| `buildFakeIdToken(payload, headerOverrides?)` | Creates a Base64-only (unsigned) JWT for mocking Google OAuth |

Call `setupTestDb` + `setupLinksTable` + `setupTagsTables` + `setupRateLimitTable` in `beforeAll`. Delete all rows from all tables in `beforeEach` to ensure isolation. Call `_resetSpamKeywordCache()` (from `src/validation.ts`) in `beforeEach` whenever spam-filter tests are involved.

`APP_HTML_CONTENT` is a **test-only** extra binding (injected by `vitest.config.mts` via `readFileSync("./public/app.html")`). It is not present in the production `Env` interface and must not be added to `src/types.ts`.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

(`nodejs_compat` flag enabled in `wrangler.jsonc`)

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`
