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
- `WAECHTER_TOKEN` *(planned — Phase 1 of the Wächter feature; Bearer token for `/api/internal/*` endpoints)*

KV namespaces (planned — add to `wrangler.jsonc` and run `wrangler types`):
- `LINKS_KV` — hot-path read-through cache (TTL 300 s), URLhaus domain snapshot, global-insert rate counter

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
# Planned (Wächter feature — do not apply until Phase 1 is implemented):
# npx wrangler d1 execute hello-cf-spa-db --local --file=sql/links_phase6_security.sql
# npx wrangler d1 execute hello-cf-spa-db --local --file=sql/security_scans.sql
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

### Planned routes (Wächter feature — not yet implemented)

All `/api/internal/*` routes are **machine-to-machine only** and authenticated via `Authorization: Bearer ${WAECHTER_TOKEN}`. Return a generic 401 on token mismatch (no detail about _why_ authentication failed). Rate-limit: 60 req/min per token to contain damage in case of token leak.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/internal/health` | Wächter boot check — trivial 200 OK |
| GET | `/api/internal/links/pending?limit=N` | Atomically claims up to N unchecked/stale links for scanning |
| POST | `/api/internal/links/:id/scan-result` | Writes aggregated score + status + per-provider audit rows (`:id` = `links.id`, 32-char hex, immutable) |
| POST | `/api/internal/links/release-stale` | Releases claimed_at > 10 min (called on Wächter boot + every 5 min) |
| GET | `/api/internal/metrics` | Queue depth, scans last 24h, status distribution, provider quota (optional, auth) |
| GET | `/warning?code=:code` | Interstitial page for `status='warning'` links |
| GET | `/warning/proceed?code=:code&t=:token` | CSRF-token-protected bypass redirect for warning page |

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
- **Alias reserved words**: `["api", "login", "logout", "app", "r", "stats"]` — checked in `ALIAS_RESERVED` (`src/validation.ts`). `stats` is reserved to avoid collision with the external stats/paywall worker route.
- **Logging**: use `log(category, message)` from `src/utils.ts`; it wraps `console.log` with `[category]` prefix. **Security constraints**: never log full cookie values, session IDs, OAuth tokens, or `SESSION_SECRET` — at most log the first 8 characters of a session ID for correlation (e.g. `sid=4fc38ab5…`). On auth-related rejections, always include a short `reason` string (e.g. `session_not_found`, `expired`, `csrf_mismatch`) so Tail Logs are interpretable without consulting source code.
- **HTML escaping**: use `escapeHtml(str)` from `src/utils.ts` for any user-supplied content embedded in HTML contexts.
- **Ownership enforcement**: Update/delete queries include `AND user_id = ?` directly in the `WHERE` clause (atomic, prevents TOCTOU). `result.meta.changes === 0` returns 404 for both "not found" and "wrong owner" — intentionally no distinction to prevent user enumeration.
- **Async click counting**: `handleRedirect` increments `click_count` via `ctx.waitUntil(...)` (non-blocking, does not delay the 302 response).
- **Anonymous links**: always get a hard 48 h expiry (`expires_at = now + 48h`); no title or alias; `user_id` stored as `NULL`. Sending a `tags` field on `POST /api/links/anonymous` is rejected with 400.
- **Redirect anti-enumeration**: `handleRedirect` returns `404` for not-found, inactive (`is_active = 0`), **and** expired links — never `410`. This prevents short-code enumeration via status-code differences.
- **CSRF token acquisition**: call `GET /api/me` while authenticated; the `csrfToken` field in the JSON response is the value to send as `X-CSRF-Token` on subsequent mutation requests. The token is `HMAC-SHA256(sessionId, SESSION_SECRET)` where `sessionId` is the `__Host-sid` cookie value.
- **OAuth cookies**: `handleLogin` sets short-lived `oauth_state` and `oauth_nonce` cookies (`Max-Age=600`). After a successful callback, both are cleared and the user is redirected to `/app.html`. `getAllowedOrigins` (in `src/csrf.ts`) dynamically computes allowed origins from both `APP_BASE_URL` and the request's own origin, so CSRF validation works in every environment without extra config.
- **Config limits**: `TARGET_URL_MAX_LEN = 2000`, `TITLE_MAX_LEN = 200`, `TAG_MAX_PER_LINK = 10`, `TAG_NAME_MAX_LEN = 50`, `SHORT_CODE_GENERATION_RETRIES = 5` — all in `src/config.ts`; never hardcode these.

## Data Format Contracts

The following fields are stored in D1 and may be consumed by external workers. **These formats are contractual** — changes are breaking.

| Field | Type / Regex | Generator in code | Example |
|-------|-------------|-------------------|---------|
| `users.id` | 32-char lowercase hex, no dashes — `/^[0-9a-f]{32}$/` | `randomId(16)` in `src/utils.ts` | `e1fe7f45be35276067ab8118d4e2f257` |
| `sessions.id` | 48-char lowercase hex, no dashes — `/^[0-9a-f]{48}$/` | `randomId(24)` in `src/utils.ts` | `4fc38ab5e1d209ca3e16440648410a54b8dffddf1cbcec37` |
| `sessions.user_id` | Foreign key → same format as `users.id` | — | see above |
| `sessions.expires_at` | ISO-8601 with milliseconds + `Z` suffix — **not** a Unix timestamp, **not** SQLite `datetime()` | `new Date(Date.now() + SESSION_DURATION_MS).toISOString()` | `2026-05-29T15:51:47.452Z` |
| `sessions.created_at` | Same ISO-8601 format as `expires_at` | `new Date().toISOString()` | `2026-04-29T18:33:00.123Z` |
| `links.id` | 6-char alphanumeric (`[a-zA-Z0-9]{6}`) — also used as `short_code` | `generateShortCode()` in `src/validation.ts` | `aB3xY9` |
| `links.user_id` | Foreign key → same format as `users.id`, or `NULL` for anonymous links | — | see above |
| `links.created_at` / `links.updated_at` / `links.expires_at` | ISO-8601 same as sessions; `expires_at` is `NULL` for authenticated non-expiring links | `new Date().toISOString()` | `2026-04-29T18:33:00.123Z` |
| `__Host-sid` cookie | Identical to `sessions.id` — 48-char lowercase hex | `randomId(24)` | `4fc38ab5e1d209ca3e16440648410a54b8dffddf1cbcec37` |

**Consumers must parse timestamps** with `new Date(expires_at) > new Date()` — not integer comparison.

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

---

## Wächter-Dienst (geplant — Architekturkonzept v4)

> **Status:** Planungsphase. Kein Code geschrieben. Alle offenen Fragen aus v3 beantwortet (siehe `status.md` 2026-05-01). Restliche Diskussionspunkte (§14 v4) vor Phase 1 klären.

### Überblick

Externer Sicherheitsdienst (Hetzner VPS), der per adaptivem Pull-Loop Links aus D1 pollt, sie gegen Threat-Intelligence-Provider prüft und den Worker via HTTPS-API mit dem Scan-Ergebnis aktualisiert. Der Worker liest nur das aggregierte `status`-Feld — keine Kenntnis von Provider-Details.

Der Worker funktioniert **vollständig ohne Wächter** weiter: Static-Check beim INSERT bleibt aktiv, dynamische Bewertung entfällt einfach. Kein Default-Interstitial für ungeprüfte Links (`checked=0`), da dies die UX zerstören würde (Cry-Wolf-Effekt).

### Neue DB-Felder in `links` (planned Migration `sql/links_phase6_security.sql`)

| Spalte | Typ | Default | Bedeutung |
|--------|-----|---------|-----------|
| `checked` | INTEGER | 0 | 0 = noch nicht geprüft, 1 = geprüft |
| `spam_score` | REAL | 0.0 | Aggregierter Score 0.0–1.0 vom Wächter |
| `status` | TEXT | `'active'` | `CHECK (status IN ('active','warning','blocked'))` |
| `last_checked_at` | TEXT | NULL | ISO-8601, NULL = nie geprüft |
| `claimed_at` | TEXT | NULL | Wächter-Locking (ersetzt `SELECT FOR UPDATE`) |
| `manual_override` | INTEGER | 0 | 1 = Admin-Freigabe; Wächter überschreibt nicht |

> `status` und `is_active` sind **zwei unabhängige Felder**: `is_active` (User-Intent) hat Vorrang vor `status` (System-Bewertung) — siehe Hot-Path-Hierarchie im Abschnitt „Hot-Path mit KV-Cache".

### Neue Tabelle `security_scans` (planned Migration `sql/security_scans.sql`)

Audit-Trail je Provider-Scan. `link_id` ist `TEXT` (Foreign Key auf `links.id` = 32-char Hex).
`raw_response` wird vom Wächter nur für `raw_score >= 0.3` gesendet (Retention-Strategie).
Cleanup im `scheduled`-Handler: Score < 0.3 nach 7 Tagen, Score ≥ 0.3 nach 90 Tagen.

### Hot-Path mit KV-Cache (geplant)

```
KV.get(`link:${code}`)
  HIT  → { target_url, is_active, status } aus Cache (TTL 300s, ~5ms 99p)
  MISS → SELECT target_url, is_active, status FROM links WHERE short_code = ?
         → KV.put(`link:${code}`, {target_url, is_active, status}, {expirationTtl: 300})

Status-Hierarchie (User-Intent vor System-Intent):
  if (is_active === 0)         → 404   // Eigentümer hat Link deaktiviert
  elif (status === 'blocked')  → 404
  elif (status === 'warning')  → 302 → /warning?code=:code
  else                         → 302 → target_url
```

Cache-Invalidierung nach Wächter-Update: `LINKS_KV.delete(`link:${code}`)` (in `scan-result`-Handler).
Cache-Invalidierung nach User-Aktion: Toggle `is_active` und Inline-Edit `short_code` müssen `KV.delete` mitführen.
**Bekanntes Risiko:** Maximaler Drift zwischen D1-Status und KV-Cache: 5 Minuten (TTL). Für Spam-Schutz akzeptiert.

### Wächter-Loop-Charakteristik

- Adaptives Polling: 5 s (aktiv) bis 60 s (Leerlauf, exponentieller Backoff)
- Bounded Concurrency: `SCAN_CONCURRENCY=20` (env-konfigurierbar), verhindert Blockade durch langsame Provider
- `claimed_at`-Mechanismus: atomares `UPDATE … RETURNING` — race-condition-frei auch bei zwei parallelen Wächter-Instanzen
- Beim Boot: `POST /api/internal/links/release-stale` einmalig; danach alle 5 Minuten

### Score-Aggregation

Gewichtetes Maximum (nicht Durchschnitt), damit ein hochvertrauenswürdiger Treffer nicht durch viele unauffällige Provider verwässert wird.

### Status-Mapping (Default-Schwellenwerte, als Wächter-Env-Variablen konfigurierbar)

| Score | Status | Hot-Path-Wirkung |
|-------|--------|-----------------|
| `< 0.70` | `active` | 302 Redirect (inkl. Bereich 0.30–0.70: aktiv, aber im Audit-Trail) |
| `0.70 – 0.94` | `warning` | Interstitial-Page (`/warning?code=:code`) |
| `≥ 0.95` | `blocked` | 404 |

### Backpressure-Schichten

1. **Per-IP Rate-Limit** (existiert): 10/min anonym; 60/min authentifiziert (letzteres neu geplant)
2. **Globaler Insert-Cap** (KV Minute-Bucket): ~1000/min, 503 bei Überschreitung
3. **Queue-Depth-Throttle** (Worker-Memory-Cache, 30 s): `COUNT(*) WHERE checked=0` > Limit → 503
4. **Provider-Quota-Guard** (Wächter-seitig): `QuotaExhaustedError` lässt Aggregation mit restlichen Providern laufen

### Sicherheitskonventionen für `/api/internal/*`

- **Authentifizierung:** `Authorization: Bearer ${WAECHTER_TOKEN}` — 401 bei Mismatch, ohne Erklärung warum
- **Endpunkt-Präfix:** `/api/internal/*` (nicht `/api/admin/*`) — klare „Maschine-zu-Maschine"-Semantik
- **Rate-Limit:** 60 req/min pro Token
- **CSRF auf `/warning/proceed`:** `generateSignedToken("warning:" + shortCode, SESSION_SECRET, 5 * 60 * 1000)` — HMAC-SHA256 + Timestamp, TTL 5 min. `SESSION_SECRET` wird wiederverwendet; Subject-Trennung verhindert Cross-Replay mit Session-CSRF-Tokens. Keinen neuen Secret nötig.
- **HTML-Escape:** `target_url` auf `/warning`-Seite **immer** mit `escapeHtml()` — gespeicherte URLs sind User-Input, eine `javascript:`-URL als `href` wäre Stored-XSS
- **Bypass-Endpoint `/warning/proceed`** ist ein separater, token-geschützter Endpunkt — darf **nicht** `/r/:code` sein, sonst ist der Schutz wirkungslos
- **`manual_override=1`**: Wächter schreibt `status` nur, wenn `manual_override = 0` in der `WHERE`-Klausel — verhindert, dass Admin-Freigaben überschrieben werden

### Wächter-Projekt (separates Repo)

Der Wächter ist ein **separates Projekt** und wird **nicht** in dieses Repo eingecheckt. Kein `waechter/`-Subdirectory, kein `shared/`-Verzeichnis hier. Der API-Kontrakt (Endpunkte, Request/Response-Schemata, TypeScript-Interfaces) ist vollständig in `waechter.md` spezifiziert. Dieses Repo implementiert ausschließlich die Worker-Seite der Schnittstelle (`/api/internal/*`-Endpunkte, Interstitial-Page, KV-Cache, DB-Migrationen).

### Bewusst nicht im MVP

- Kein Default-Interstitial bei `checked=0` (Cry-Wolf-Effekt)
- Kein Push-Webhook vom Worker zum Wächter (Pull reicht für TTFS, Wächter kann hinter NAT bleiben)
- Keine ML-Heuristik
- Kein synchroner externer Provider-Aufruf im Worker (nur lokaler Static-Check, <5ms)
- Kein mTLS zwischen Worker und Wächter
- Kein Admin-Dashboard für Scans (`wrangler d1 execute` reicht für Operatoren)
- Kein `/api/internal/links/queue-size`-Endpoint (defer — nachrüstbar ohne Breaking Change)
- Kein Cloudflare Turnstile auf `POST /short` (defer — erst bei messbarer Bot-Last in Production)

### Heuristik-Owner-Grenze

Die Bewertungslogik (Provider-Gewichtung, Scores, Heuristik-Regeln) gehört **ausschließlich in den Wächter**. Der Worker hält die `spam_keywords`-Tabelle nur für den synchronen Static-Check beim INSERT (einfacher Keyword-Blocker, <5 ms, kein Netz-Call). Das ist keine Heuristik-Datenbank — die Trennung ist architektonisch gewollt: deshalb läuft die Bewertung extern.

### Bypass-Click-Tracking (geplant — Phase 5b)

```sql
CREATE TABLE bypass_clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  short_code TEXT NOT NULL,
  asn        TEXT,            -- z. B. "AS3320" — nicht personenbezogen
  hour_bucket TEXT NOT NULL   -- strftime('%Y-%m-%d %H', 'now'), z. B. "2026-05-01 13"
);
```

Zweck: False-Positive-Analyse (Bypass-Rate pro Link und Stunde). Kein sekundengenauer Timestamp. ASN ist nicht personenbezogen. Insert in `handleWarningProceed` via `ctx.waitUntil(...)` (nicht blockierend).
