# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Project Overview

**aadd.li** â€” a serverless link shortener. Backend: Cloudflare Workers + D1. Frontend: static files in `public/` (SPA, served via Workers Assets).

- Entry point: `src/index.ts` â€” plain `if`-chain router, no framework
- Handlers: `src/handlers/` (`auth.ts`, `links.ts`, `internal.ts`, `warning.ts`)
- Auth: Google OAuth (`src/auth/google.ts`, `src/auth/session.ts`)
- CSRF protection: `src/csrf.ts` (`validateCsrf`, `validateCsrfToken`, `generateCsrfToken`, `validateMutationCsrf`, `generateSignedToken`, `verifySignedToken`)
- Rate limiting: `src/rateLimit.ts` (`checkRateLimit`, `extractClientIp`)
- Shared helpers: `src/utils.ts` (`jsonResponse`, `errResponse`, `applySecurityHeaders`, `log`, `randomId`, `escapeHtml`, `getCookie`, `makeSessionCookie`, `clearSessionCookie`, `base64UrlDecode`)
- Constants/limits: `src/config.ts`
- Input validation: `src/validation.ts` (`generateShortCode`, `isValidHttpUrl`, `validateTargetUrl`, `validateAlias`, `buildGeoUrl`, `isValidFutureIso`, `requireJson`, `checkSpamFilter`, `validateTag`, `_resetSpamKeywordCache`)
- DB schema migrations: `sql/` (apply in order: `init.sql` â†’ `auth.sql` â†’ `links.sql` â†’ â€¦)
- Type-safe env: `src/types.ts` â†’ `Env` interface

## Bindings & Secrets

D1 binding name: `hello_cf_spa_db` (defined in `wrangler.jsonc`).

Required **secrets** (set via `wrangler secret put`):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`
- `WAECHTER_TOKEN` â€” Bearer token for `/api/internal/*` endpoints

KV namespaces (**implemented**, configured in `wrangler.jsonc`):
- `LINKS_KV` â€” hot-path read-through cache (TTL 300 s), URLhaus domain snapshot (`urlhaus:blocked_hosts`), global-insert rate counter (`insert_count:<minute-bucket>`)

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
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase6_security.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/security_scans.sql
npx wrangler d1 execute hello-cf-spa-db --local --file=sql/bypass_clicks.sql
# Planned (Phase 6 â€” do not apply until implemented):
# npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase6_revalidation_index.sql
```

For remote (production): replace `--local` with `--remote`.

## API Routes

| Method | Path | Handler |
|--------|------|---------|
| GET | `/login` | `handleLogin` |
| GET | `/api/auth/google/callback` | `handleGoogleCallback` |
| GET | `/api/me` | `handleGetMe` â€” returns `{ authenticated: false }` or `{ authenticated: true, user, csrfToken }` |
| POST | `/logout` | `handleLogout` |
| POST | `/api/links/anonymous` | `handleCreateAnonymousLink` |
| POST | `/api/links` | `handleCreateLink` |
| GET | `/api/links` | `handleGetLinks` (cursor-based pagination: `?cursor=ISO\|id&limit=N`, default 50, max 100) |
| POST | `/api/links/:code/update` | `handleUpdateLink` |
| POST | `/api/links/:code/delete` | `handleDeleteLink` |
| GET, HEAD | `/r/:code` | `handleRedirect` (302 redirect with KV-cache) |
| GET | `/warning?code=:code` | `handleWarning` â€” Interstitial page for `status='warning'` links |
| GET | `/warning/proceed?code=:code&t=:token` | `handleWarningProceed` â€” CSRF-token-protected bypass redirect |
| GET | `/api/internal/health` | `handleInternalHealth` â€” trivial 200 OK, Bearer auth |
| GET | `/api/internal/links/pending` | `handleInternalLinksPending` â€” atomically claims links for scanning |
| POST | `/api/internal/links/:id/scan-result` | `handleInternalScanResult` â€” writes score/status, KV update |
| POST | `/api/internal/links/release-stale` | `handleInternalReleaseStale` â€” releases expired claims |
| GET | `/api/internal/metrics` | `handleInternalMetrics` â€” queue depth, status distribution, scans 24h |
| POST | `/api/internal/kv/urlhaus` | `handleInternalUpdateUrlhaus` â€” updates URLhaus blocked-host snapshot in KV |

### Planned routes (Phase 6 â€” not yet implemented)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/internal/metrics` | Extended with `revalidation_aging` histogram (Â§9.5 Konzept v5) |

> All `/api/internal/*` routes are machine-to-machine only, authenticated via `Authorization: Bearer ${WAECHTER_TOKEN}`. Return a generic 401 on token mismatch. Rate-limit: 60 req/min per token.

## Conventions

- **Security headers** are applied globally in `applySecurityHeaders` (called in `fetch`); do not set them per-handler.
- **Error responses** always use `errResponse(message, status, extraHeaders?)` â€” never raw `new Response` for errors. Use `extraHeaders` for headers like `Retry-After: 60` on 429 responses.
- **Session cookie** name is `__Host-sid`; managed via `makeSessionCookie` / `clearSessionCookie`. The `__Host-` prefix enforces Secure, Path=/, and no Domain attribute.
- **CSRF â€” two-layer protection**:
	1. Global: `validateCsrf(request, env)` in the router rejects cross-origin POSTs missing `X-Requested-With` (legacy layer, `src/csrf.ts`).
	2. Per-handler: authenticated mutation endpoints (`handleCreateLink`, `handleUpdateLink`, `handleDeleteLink`) call `validateMutationCsrf(request, env)` which returns `Response | null`:
		- Foreign `Origin` header â†’ always rejected (403).
		- Same-origin request with `Origin: APP_BASE_URL` â†’ requires either a valid `X-CSRF-Token` (HMAC-SHA256 of the session cookie value `__Host-sid`, via `validateCsrfToken`) **or** `X-Requested-With` header.
		- No `Origin` header (non-browser client) â†’ allowed.
	- Clients must send `X-CSRF-Token: <token>` obtained from `generateCsrfToken(sessionId, secret)` where `sessionId` is the `__Host-sid` cookie value.
- **Signed tokens** (`src/csrf.ts`): `generateSignedToken(subject, secret, ttlMs?)` / `verifySignedToken(token, subject, secret)` â€” HMAC-SHA256 + expiry timestamp, subject-separated. Used for Warning-Bypass-Tokens (`subject = "warning:<shortCode>"`). Reuses `SESSION_SECRET`; subject-separation prevents cross-replay with session CSRF tokens.
- **Rate limiting**: `checkRateLimit(key, db, limit?)` from `src/rateLimit.ts`; uses D1 `rate_limits` table with 1-minute tumbling windows. Default limit = 10 req/min. Keys are scoped by use-case: plain IP for anonymous links (10/min), `login:<ip>` for login (5/min), `redirect:<ip>` for redirects (60/min), `internal:token` for internal endpoints (60/min). **Fails open** on D1 error.
- **Spam filter**: `checkSpamFilter(url, db)` from `src/validation.ts` â€” applied to anonymous link creation; returns `true` if blocked. Keywords are loaded from the `spam_keywords` table and **cached in module scope for 5 minutes** (TTL). Use `_resetSpamKeywordCache()` in tests to ensure isolation between test runs.
- **URLhaus static check**: Applied synchronously in `handleCreateLink` and `handleCreateAnonymousLink` before INSERT. Checks the target URL's hostname against the `urlhaus:blocked_hosts` KV key (JSON array of blocked hostnames). **Fails open** if KV is unavailable. No external network call during link creation. Snapshot is updated by the WÃ¤chter via `POST /api/internal/kv/urlhaus`.
- **URL validation**: `validateTargetUrl(raw)` from `src/validation.ts` â€” validates scheme (http/https only) and blocks SSRF targets (localhost, private IPs, IPv6 ULA/link-local). Used in `handleRedirect` to re-validate stored URLs before serving the redirect; returns `{ ok: true, url: URL } | { ok: false, error: string }`.
- **Input requirements**: All mutation endpoints require `Content-Type: application/json`; enforced via `requireJson(request)`.
- **Alias normalization**: User-supplied aliases are NFKC-normalized and Unicode dashes (`â€â€‘â€’â€“â€”âˆ’`) replaced with `-` before `validateAlias()` is called.
- **Short codes**: 6-char alphanumeric, bias-free generation in `generateShortCode` (`src/validation.ts`).
- **Hashtags**: Authenticated users can assign up to 10 tags per link (limit `TAG_MAX_PER_LINK`). Tags are normalized (NFKC, lowercase, leading # removed, trim), 1â€“50 chars, starting with alphanumeric `[a-z0-9][a-z0-9_-]*`. Tags are validated via `validateTag(raw)` in `src/validation.ts`. Tags are strictly user-scoped; orphaned tags are garbage collected after each mutation (`UPDATE`, `DELETE`). **Tag updates are full-replace**: sending `tags: []` removes all tags; sending `tags: ["foo"]` replaces all existing tags with `["foo"]`. D1 tag operations use **two-phase batching** because junction-table inserts (`link_tags`) need the AUTOINCREMENT `tag_id` â€” first batch inserts into `tags`, second batch inserts into `link_tags` using a `SELECT â€¦ WHERE name = ?` subquery.
- **Search**: `GET /api/links?q=<term>` searches via case-insensitive substring in alias, title, and tag names. Term is trimmed and capped at 100 chars. Case-insensitivity is ensured via `LOWER()` in SQL.
- **Alias reserved words**: `["api", "login", "logout", "app", "r", "stats", "warning"]` â€” checked in `ALIAS_RESERVED` (`src/validation.ts`). `stats` reserved for external stats/paywall worker. `warning` reserved for the Interstitial-Page route. Add every new top-level Worker path here immediately when introduced.
- **Logging**: use `log(category, message)` from `src/utils.ts`; it wraps `console.log` with `[category]` prefix. **Security constraints**: never log full cookie values, session IDs, OAuth tokens, or `SESSION_SECRET` â€” at most log the first 8 characters of a session ID for correlation (e.g. `sid=4fc38ab5â€¦`). On auth-related rejections, always include a short `reason` string (e.g. `session_not_found`, `expired`, `csrf_mismatch`) so Tail Logs are interpretable without consulting source code.
- **HTML escaping**: use `escapeHtml(str)` from `src/utils.ts` for any user-supplied content embedded in HTML contexts. Mandatory for `target_url` on `/warning` (Stored-XSS vector).
- **Ownership enforcement**: Update/delete queries include `AND user_id = ?` directly in the `WHERE` clause (atomic, prevents TOCTOU). `result.meta.changes === 0` returns 404 for both "not found" and "wrong owner" â€” intentionally no distinction to prevent user enumeration.
- **Async click counting**: `handleRedirect` increments `click_count` via `ctx.waitUntil(...)` (non-blocking, does not delay the 302 response).
- **Anonymous links**: always get a hard 48 h expiry (`expires_at = now + 48h`); no title or alias; `user_id` stored as `NULL`. Sending a `tags` field on `POST /api/links/anonymous` is rejected with 400.
- **Redirect anti-enumeration**: `handleRedirect` returns `404` for not-found, inactive (`is_active = 0`), **and** expired links â€” never `410`. This prevents short-code enumeration via status-code differences.
- **CSRF token acquisition**: call `GET /api/me` while authenticated; the `csrfToken` field in the JSON response is the value to send as `X-CSRF-Token` on subsequent mutation requests. The token is `HMAC-SHA256(sessionId, SESSION_SECRET)` where `sessionId` is the `__Host-sid` cookie value.
- **OAuth cookies**: `handleLogin` sets short-lived `__Host-oauth_state` and `__Host-oauth_nonce` cookies (`Max-Age=600`). After a successful callback, both are cleared and the user is redirected to `/app.html`. `getAllowedOrigins` (in `src/csrf.ts`) dynamically computes allowed origins from both `APP_BASE_URL` and the request's own origin, so CSRF validation works in every environment without extra config.
- **Config limits**: `TARGET_URL_MAX_LEN = 2000`, `TITLE_MAX_LEN = 200`, `TAG_MAX_PER_LINK = 10`, `TAG_NAME_MAX_LEN = 50`, `SHORT_CODE_GENERATION_RETRIES = 5`, `GLOBAL_INSERT_CAP = 1000`, `QUEUE_DEPTH_THROTTLE_LIMIT = 5000`, `QUEUE_DEPTH_CACHE_TTL_MS = 30_000` â€” all in `src/config.ts`; never hardcode these.

## Data Format Contracts

The following fields are stored in D1 and may be consumed by external workers. **These formats are contractual** â€” changes are breaking.

| Field | Type / Regex | Generator in code | Example |
|-------|-------------|-------------------|---------|
| `users.id` | 32-char lowercase hex, no dashes â€” `/^[0-9a-f]{32}$/` | `randomId(16)` in `src/utils.ts` | `e1fe7f45be35276067ab8118d4e2f257` |
| `sessions.id` | 48-char lowercase hex, no dashes â€” `/^[0-9a-f]{48}$/` | `randomId(24)` in `src/utils.ts` | `4fc38ab5e1d209ca3e16440648410a54b8dffddf1cbcec37` |
| `sessions.user_id` | Foreign key â†’ same format as `users.id` | â€” | see above |
| `sessions.expires_at` | ISO-8601 with milliseconds + `Z` suffix â€” **not** a Unix timestamp, **not** SQLite `datetime()` | `new Date(Date.now() + SESSION_DURATION_MS).toISOString()` | `2026-05-29T15:51:47.452Z` |
| `sessions.created_at` | Same ISO-8601 format as `expires_at` | `new Date().toISOString()` | `2026-04-29T18:33:00.123Z` |
| `links.id` | 6-char alphanumeric (`[a-zA-Z0-9]{6}`) â€” also used as `short_code` | `generateShortCode()` in `src/validation.ts` | `aB3xY9` |
| `links.user_id` | Foreign key â†’ same format as `users.id`, or `NULL` for anonymous links | â€” | see above |
| `links.created_at` / `links.updated_at` / `links.expires_at` | ISO-8601 same as sessions; `expires_at` is `NULL` for authenticated non-expiring links | `new Date().toISOString()` | `2026-04-29T18:33:00.123Z` |
| `__Host-sid` cookie | Identical to `sessions.id` â€” 48-char lowercase hex | `randomId(24)` | `4fc38ab5e1d209ca3e16440648410a54b8dffddf1cbcec37` |

### WÃ¤chter API Contracts

The following names and values are part of the machine-to-machine contract between Worker and WÃ¤chter (see `waechter-konzept.md` for the full specification, currently at v5).

| Category | Convention | Examples |
|----------|------------|----------|
| **Provider Names** | `snake_case` | `google_safe_browsing`, `heuristic`, `virustotal` |
| **Status Values** | Lowercase string | `active`, `warning`, `blocked` |
| **Score Range** | Float `0.0`â€“`1.0` | `0.0`, `1.0`, `0.83` |
| **Link ID in API paths** | 32-char hex â€” `links.id`, immutable | `a3f8c1e9b2d4f6e8a1c3b5d7e9f2a4c6` |

**The `:id` in `/api/internal/links/:id/scan-result` is always `links.id` (32-char hex), never `short_code`.** `short_code` is mutable (user can change alias); `links.id` is immutable and the stable internal identifier.

**Consumers must parse timestamps** with `new Date(expires_at) > new Date()` â€” not integer comparison.

## Shared Database Consumers

This D1 database is also read by an external stats/paywall worker. Schema changes to `users`, `sessions`, or format changes to any field listed in **Data Format Contracts** above are **breaking changes** for external consumers and must be versioned and coordinated. In particular:

- Cookie name `__Host-sid` is part of the contract.
- Format of `users.id` and `sessions.id` (32- and 48-char hex) is part of the contract.
- `SESSION_SECRET` is the shared secret if external workers want to validate CSRF tokens (`HMAC-SHA256(sessionId, SESSION_SECRET)`).
- Never rename or reorder columns in `users` or `sessions` without coordinating with all consumers.

## Testing

Tests use `@cloudflare/vitest-pool-workers` (Miniflare). Shared utilities live in `test/helpers.ts`:

| Helper | Purpose |
|--------|---------|
| `setupTestDb(db)` | Creates `users` + `sessions` tables |
| `setupLinksTable(db)` | Creates `links` table and indexes |
| `setupTagsTables(db)` | Creates `tags` + `link_tags` tables |
| `setupSpamTable(db)` | Creates `spam_keywords` table with seed keywords |
| `setupRateLimitTable(db)` | Creates `rate_limits` table |
| `setupSecurityScansTable(db)` | Creates `security_scans` table |
| `setupBypassClicksTable(db)` | Creates `bypass_clicks` table |
| `seedSession(db, opts?)` | Inserts a user + valid session; returns `{ userId, sessionId }` |
| `seedLink(db, opts)` | Inserts a link row; returns `{ id, shortCode }`. Accepts Phase-6 fields: `checked`, `status`, `manualOverride`, `claimedAt` |
| `makeRequest(url, method?, opts?)` | Builds a `Request` with cookies/headers/body |
| `buildFakeIdToken(payload, headerOverrides?)` | Creates a Base64-only (unsigned) JWT for mocking Google OAuth |
| `createLinksKvMock()` | Returns an in-memory KV mock with `reset()` method; assign to `LinksKvMock` type |

Call `setupTestDb` + `setupLinksTable` + `setupTagsTables` + `setupRateLimitTable` + `setupSecurityScansTable` in `beforeAll`. Delete all rows from all tables in `beforeEach`. Call `_resetSpamKeywordCache()` in `beforeEach` whenever spam-filter tests are involved. Call `linksKvMock.reset()` in `beforeEach` for tests involving KV.

`APP_HTML_CONTENT` is a **test-only** extra binding (injected by `vitest.config.mts` via `readFileSync("./public/app.html")`). It is not present in the production `Env` interface and must not be added to `src/types.ts`.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

(`nodejs_compat` flag enabled in `wrangler.jsonc`)

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` Â· `/r2/` Â· `/d1/` Â· `/durable-objects/` Â· `/queues/` Â· `/vectorize/` Â· `/workers-ai/` Â· `/agents/`

---

## WÃ¤chter-Dienst (Architekturkonzept v5)

> **Status:** Phasen 1–6 implementiert und deployed. Wächter-Projekt (separates Repo, Python, Hetzner VPS) ist nächster Schritt (Phase 2 Wächter-Rollout).

### Ãœberblick

Externer Sicherheitsdienst (Hetzner VPS), der per adaptivem Pull-Loop Links aus D1 pollt, sie gegen Threat-Intelligence-Provider prÃ¼ft (Google Safe Browsing, Heuristik, optional VirusTotal), einen aggregierten Spam-Score berechnet und das Ergebnis via HTTPS-API an den Worker zurÃ¼ckmeldet. Der Worker liest nur das aggregierte `status`-Feld â€” keine Kenntnis von Provider-Details.

Der Worker funktioniert **vollstÃ¤ndig ohne WÃ¤chter** weiter: Static-Check (Spam-Keywords + URLhaus-Snapshot) beim INSERT bleibt aktiv, dynamische Bewertung entfÃ¤llt einfach. Kein Default-Interstitial fÃ¼r `checked=0` (Cry-Wolf-Effekt).

### Implementierte DB-Felder in `links` (Migration `links_phase6_security.sql`)

| Spalte | Typ | Default | Bedeutung |
|--------|-----|---------|-----------|
| `checked` | INTEGER | 0 | 0 = noch nicht geprÃ¼ft, 1 = geprÃ¼ft |
| `spam_score` | REAL | 0.0 | Aggregierter Score 0.0â€“1.0 vom WÃ¤chter |
| `status` | TEXT | `'active'` | `CHECK (status IN ('active','warning','blocked'))` |
| `last_checked_at` | TEXT | NULL | ISO-8601, NULL = nie geprÃ¼ft |
| `claimed_at` | TEXT | NULL | WÃ¤chter-Locking (ersetzt `SELECT FOR UPDATE`) |
| `manual_override` | INTEGER | 0 | 1 = Admin-Freigabe; WÃ¤chter schreibt `status` nicht |

> `status` und `is_active` sind **zwei unabhÃ¤ngige Felder**: `is_active` (User-Intent) hat Vorrang vor `status` (System-Bewertung) â€” siehe Hot-Path-Hierarchie.

### Implementierte Tabelle `security_scans` (Migration `security_scans.sql`)

Audit-Trail je Provider-Scan. `link_id` ist `TEXT` (Foreign Key auf `links.id` = 32-char Hex). `raw_response` wird vom WÃ¤chter nur fÃ¼r `raw_score >= 0.3` gesendet (Retention-Strategie). Cleanup im `scheduled`-Handler: Score < 0.3 nach 7 Tagen, Score â‰¥ 0.3 nach 90 Tagen.

### Hot-Path mit KV-Cache (implementiert)

```
KV.get(`link:${code}`)
  HIT  â†’ { target_url, is_active, status, id, user_id, expires_at } aus Cache (TTL 300s)
  MISS â†’ SELECT target_url, is_active, status, id, user_id, expires_at
         FROM links WHERE short_code = ?
         â†’ KV.put(`link:${code}`, payload, {expirationTtl: 300})

Status-Hierarchie (User-Intent vor System-Intent):
  if (is_active === 0)         â†’ 404   // EigentÃ¼mer hat Link deaktiviert
  elif (status === 'blocked')  â†’ 404
  elif (status === 'warning')  â†’ 302 â†’ /warning?code=:code
  else                         â†’ 302 â†’ target_url
```

KV-Update nach WÃ¤chter-Scan: `handleInternalScanResult` schreibt `LINKS_KV.put()` mit dem aktualisierten Payload (nicht `delete()` â€” `put()` propagiert sofort an alle Edges, verhindert Drift-Fenster beim Status-Downgrade z.B. `blocked â†’ warning`).

Cache-Invalidierung nach User-Aktion: Toggle `is_active` und Inline-Edit `short_code` mÃ¼ssen `KV.delete` mitfÃ¼hren (noch TODO falls nicht bereits implementiert).

**Bekanntes Risiko:** Maximaler Drift zwischen D1 und KV wenn `LINKS_KV` Binding nicht konfiguriert: Worker schlÃ¤gt fehl open (kein Crash). Maximaler TTL-Drift: 5 Minuten. FÃ¼r Spam-Schutz akzeptiert.

### `/api/internal/links/pending` â€” Tiered Revalidation (Phase 6, implementiert)

Die aktuelle Implementierung fragt nur `checked = 0` ab. Phase 6 erweitert auf vier PrioritÃ¤tsklassen:

```
GET /api/internal/links/pending
  ?limit=50
  &max_age_warning_h=24
  &max_age_active_d=14
  &max_age_blocked_d=90
```

**Query-Parameter:**

| Parameter | Default | Wirkung |
|-----------|---------|---------|
| `limit` | 50 | max. 100 |
| `max_age_warning_h` | `24` | warning-Links Ã¤lter als N Stunden sind fÃ¤llig |
| `max_age_active_d` | `14` | active-Links Ã¤lter als N Tage sind fÃ¤llig |
| `max_age_blocked_d` | `90` | blocked-Links Ã¤lter als N Tage sind fÃ¤llig |

Alle Werte mÃ¼ssen positive Integer sein: `1 â‰¤ h â‰¤ 8760`, `1 â‰¤ d â‰¤ 3650`. Sonst 400.

**PrioritÃ¤tsklassen im atomischen UPDATE ... RETURNING:**

| Prio | Klasse | Intervall-Default | BegrÃ¼ndung |
|------|--------|-------------------|------------|
| 0 | `manual_override = 1` | **nie** â€” via WHERE ausgeschlossen | Admin-Entscheidung verbindlich |
| 1 | `checked = 0` | sofort | Neue Links mÃ¼ssen erstmals bewertet werden |
| 2 | `status = 'warning'` | 24h | False-Positive-Risiko hoch, schnelle Rehabilitierung |
| 3 | `status = 'active'` | 14d | Schutz vor nachtrÃ¤glich kompromittierten Hosts |
| 4 | `status = 'blocked'` | 90d | True Positives selten transient |

**ORDER BY innerhalb gleicher Prio:** `click_count DESC` (Reichweite = Risiko-Multiplikator), dann `last_checked_at ASC NULLS FIRST` (Ã¤lteste Bewertung zuerst).

**Response enthÃ¤lt zusÃ¤tzlich:** `click_count`, `created_at` (damit der WÃ¤chter eigene Priorisierungslogik implementieren kann ohne Folge-Query).

**Jitter-Verantwortung liegt beim WÃ¤chter** (Â±15% auf `max_age_*`-Parameter), nicht beim Worker. Worker liefert nur "fÃ¤llig nach Schwellwert".

### `/api/internal/links/:id/scan-result` â€” `manual_override`-Verhalten (Phase 6, implementiert)

Aktuell: `UPDATE links SET ... WHERE id = ? AND manual_override = 0` â€” schlÃ¤gt still fehl (0 rows affected).

Phase 6 ergÃ¤nzt eine explizite Response fÃ¼r override'd Links:

```json
// Wenn manual_override = 1:
{ "ok": true, "applied": false, "reason": "manual_override" }

// Normal (manual_override = 0):
{ "ok": true, "applied": true }
```

`INSERT INTO security_scans` lÃ¤uft auch fÃ¼r override'd Links durch â€” Audit-Trail bleibt vollstÃ¤ndig. Das erlaubt ein spÃ¤teres Admin-UI: "Diese Links sind manuell freigegeben, aber der WÃ¤chter wÃ¼rde sie als `blocked` einstufen."

### `GET /api/internal/metrics` â€” revalidation_aging Erweiterung (Phase 6, implementiert)

Aktuell: queue_depth, links_scanned_24h, status_distribution.

Phase 6 ergÃ¤nzt `revalidation_aging`:

```json
{
  "queue_depth": 42,
  "links_scanned_24h": 1287,
  "status_distribution": { "active": 9821, "warning": 12, "blocked": 3 },
  "revalidation_aging": {
    "active": {
      "never_scanned": 5,
      "fresh_lt_7d": 8420,
      "stale_7d_to_14d": 1320,
      "overdue_gt_14d": 76
    },
    "warning": {
      "never_scanned": 0,
      "fresh_lt_24h": 8,
      "overdue_gt_24h": 4
    },
    "blocked": {
      "fresh_lt_90d": 3,
      "overdue_gt_90d": 0
    }
  }
}
```

**Operations-Signal:** Wenn `overdue_*` Ã¼ber mehrere Tage wÃ¤chst statt zu schrumpfen, fÃ¤llt der WÃ¤chter strukturell zurÃ¼ck. Reaktionen: Schwellwerte verlÃ¤ngern, Provider-Quota erhÃ¶hen, zweite WÃ¤chter-Instanz deployen.

### Backpressure-Schichten (implementiert)

1. **Per-IP Rate-Limit** (existiert): 10/min anonym, 60/min authentifiziert
2. **Globaler Insert-Cap** via KV-Minute-Bucket (`insert_count:<bucket>`, TTL 120s): `GLOBAL_INSERT_CAP = 1000`, 503 bei Ãœberschreitung. **Fails open** bei KV-Fehler.
3. **Queue-Depth-Throttle**: Worker-Modul-Scope-Cache (30s, `QUEUE_DEPTH_CACHE_TTL_MS`), `COUNT(*) WHERE checked=0 AND claimed_at IS NULL`, `QUEUE_DEPTH_THROTTLE_LIMIT = 5000`, 503 bei Ãœberschreitung. **Fails open** bei DB-Fehler.
4. **WÃ¤chter-seitig** (im WÃ¤chter-Projekt): Quota-Tracking pro Provider (`QuotaExhaustedError`), Aggregation lÃ¤uft mit restlichen Providern weiter.

### Score-Aggregation (WÃ¤chter-seitig)

Gewichtetes Maximum (nicht Durchschnitt): ein hochvertrauenswÃ¼rdiger Treffer darf nicht durch viele unauffÃ¤llige Provider verwÃ¤ssert werden.

### Status-Mapping (Default-Schwellenwerte, WÃ¤chter-Env-Variablen)

| Score | Status | Hot-Path-Wirkung |
|-------|--------|-----------------|
| `< 0.70` | `active` | 302 Redirect (0.30â€“0.70: aktiv, aber im Audit-Trail) |
| `0.70 â€“ 0.94` | `warning` | Interstitial-Page (`/warning?code=:code`) |
| `â‰¥ 0.95` | `blocked` | 404 |

### Sicherheitskonventionen fÃ¼r `/api/internal/*`

- **Auth:** `Authorization: Bearer ${WAECHTER_TOKEN}` â€” generischer 401 bei Mismatch, kein Detail-Hinweis
- **Rate-Limit:** 60 req/min pro Token (`checkRateLimit("internal:token", ...)`)
- **CSRF auf `/warning/proceed`:** `generateSignedToken("warning:" + shortCode, SESSION_SECRET, 5 * 60 * 1000)`, TTL 5 min. Subject-Trennung verhindert Cross-Replay mit Session-CSRF-Tokens.
- **HTML-Escape:** `target_url` auf `/warning` immer mit `escapeHtml()` â€” `javascript:`-URL als `href` wÃ¤re Stored-XSS
- **Bypass-Endpoint `/warning/proceed`** ist separat und token-geschÃ¼tzt â€” darf **nicht** `/r/:code` sein
- **`manual_override=1`:** Worker-WHERE-Klausel schÃ¼tzt `links.status` vor WÃ¤chter-Updates; `security_scans`-Inserts laufen trotzdem (Audit-Trail)

### WÃ¤chter-Projekt (separates Repo, Python, Raspberry Pi)

Der WÃ¤chter wird als **separates Projekt** entwickelt und betrieben. Kein WÃ¤chter-Code in diesem Repo. Der API-Kontrakt ist vollstÃ¤ndig in `waechter-konzept.md` (v5) spezifiziert â€” das ist die Single Source of Truth fÃ¼r beide Repos.

**Rollout-Phasen:**

| Phase | Inhalt | Repo | Status |
|-------|--------|------|--------|
| **1** | DB-Migration, KV-Cache, Static-Check (URLhaus), `/api/internal/*`-Endpunkte | dieses Repo | âœ… done |
| **2** | WÃ¤chter deployen, nur HeuristicProvider, nur Beobachtung | WÃ¤chter-Projekt | â³ ausstehend |
| **3** | Status-Ãœbernahme aktivieren, KV-Invalidierung | WÃ¤chter-Projekt | â³ ausstehend |
| **4** | Google Safe Browsing als zweiter Provider | WÃ¤chter-Projekt | â³ ausstehend |
| **5** | Interstitial-Page (`/warning`, `/warning/proceed`) | dieses Repo | âœ… done |
| **5b** | `bypass_clicks`-Tabelle + Logging | dieses Repo | âœ… done |
| **6** | Tiered Revalidation (pending-Query), manual_override Audit-Response, revalidation_aging Metrics | dieses Repo | ðŸ”œ next |
| **7** | Push-Trigger (optional, nur bei messbarem TTFS-Problem) | beide | â¸ï¸ defer |

### Bewusst nicht im MVP

- Kein Default-Interstitial bei `checked=0` (Cry-Wolf-Effekt)
- Kein Push-Webhook vom Worker zum WÃ¤chter (Pull reicht, WÃ¤chter kann hinter NAT bleiben)
- Keine ML-Heuristik
- Kein synchroner externer Check im Worker (Static-Check ja, kein Live-Call zu Google)
- Kein mTLS zwischen Worker und WÃ¤chter
- Kein `/api/internal/links/queue-size`-Endpoint (nachrÃ¼stbar ohne Breaking Change)
- Kein Cloudflare Turnstile auf `POST /short` (defer bis Bot-Last messbar)
- Kein Admin-Dashboard fÃ¼r Scans (`wrangler d1 execute` reicht)

### Bypass-Click-Tracking (implementiert, Phase 5b, `sql/bypass_clicks.sql`)

```sql
CREATE TABLE bypass_clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  short_code  TEXT NOT NULL,
  asn         TEXT,             -- z. B. "AS3320" â€” nicht personenbezogen
  hour_bucket TEXT NOT NULL     -- strftime('%Y-%m-%d %H', 'now')
);
```

Insert in `handleWarningProceed` via `ctx.waitUntil(...)` (nicht blockierend). Kein sekundengenauer Timestamp. ASN nicht personenbezogen (DSGVO-neutral).
