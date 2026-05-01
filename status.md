# Status Log

## 2026-05-01

### Planung: Wächter-Dienst (Architekturkonzept v4)

**Status:** Planungsphase — kein Code geschrieben. Alle offenen Fragen aus v3 beantwortet (siehe unten). Alle Diskussionspunkte §14 v4 entschieden (2026-05-01). **Bereit für Phase 1.**

#### Zusammenfassung

Der Wächter-Dienst ist ein externer Sicherheitsdienst (Hetzner VPS), der per adaptivem Pull-Loop neue Links aus D1 holt, sie gegen externe Threat-Intelligence-Provider (Google Safe Browsing, Heuristik, optional VirusTotal) prüft, einen aggregierten Spam-Score berechnet und das Ergebnis via HTTPS-API an den Worker zurückmeldet. Der Worker steuert auf Basis des `status`-Feldes (`active` / `warning` / `blocked`) den Hot-Path-Redirect, eine neue Interstitial-Page oder eine 404-Antwort.

#### Rollout-Phasen (geplant) — Worker-Anteil dieses Repos

> Phasen, die den Wächter selbst betreffen (Loop, Provider, Scoring), sind im separaten Wächter-Projekt geplant (Pflichtenheft: `waechter.md`).

| Phase | Inhalt | Repo |
|-------|--------|------|
| **1** | DB-Migration (neue Spalten + `security_scans`), KV-Cache im Hot-Path, Static-Check-Erweiterung (URLhaus-Snapshot in KV), `/api/internal/*`-Endpunkte implementieren | **dieses Repo** |
| **2** | Wächter auf Hetzner deployen, nur `HeuristicProvider`, nur Beobachtung (Status-Schreiben noch deaktiviert) | **Wächter-Projekt** |
| **3** | Status-Übernahme aktivieren, KV-Invalidierung aktiv | **Wächter-Projekt** |
| **4** | Google Safe Browsing als zweiter Provider | **Wächter-Projekt** |
| **5** | Interstitial-Page (`/warning`, `/warning/proceed`) implementieren | **dieses Repo** |
| **5b** | `bypass_clicks`-Tabelle + Logging in `/warning/proceed` (ASN + short_code + hour_bucket) | **dieses Repo** |
| **6** | 30-Tage-Re-Scan (bereits durch Pending-Query abgedeckt) | **Wächter-Projekt** |
| **7** | Push-Trigger (optional, nur bei messbarem TTFS-Problem) | **beide** |

#### Neue Worker-Routen (geplant)

| Methode | Pfad | Authentifizierung |
|---------|------|-------------------|
| GET | `/api/internal/health` | Bearer `WAECHTER_TOKEN` |
| GET | `/api/internal/links/pending?limit=N` | Bearer `WAECHTER_TOKEN` |
| POST | `/api/internal/links/:id/scan-result` | Bearer `WAECHTER_TOKEN` (**`:id` = `links.id`, 32-char Hex**) |
| POST | `/api/internal/links/release-stale` | Bearer `WAECHTER_TOKEN` |
| GET | `/api/internal/metrics` | Bearer `WAECHTER_TOKEN` (optional, §9.5) |
| GET | `/warning?code=:code` | öffentlich |
| GET | `/warning/proceed?code=:code&t=:token` | öffentlich (CSRF-Token) |

#### Neue D1-Spalten in `links` (geplant, Migration `links_phase6_security.sql`)

```sql
ALTER TABLE links ADD COLUMN checked         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN spam_score      REAL    NOT NULL DEFAULT 0.0;
ALTER TABLE links ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'warning', 'blocked'));
ALTER TABLE links ADD COLUMN last_checked_at TEXT;   -- ISO-8601, NULL = nie geprüft
ALTER TABLE links ADD COLUMN claimed_at      TEXT;   -- Wächter-Locking
ALTER TABLE links ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_links_scan_queue ON links(checked, last_checked_at, claimed_at);
```

#### Neue Tabelle `security_scans` (Migration `security_scans.sql`)

```sql
CREATE TABLE security_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id      TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  -- ⚠️ link_id muss TEXT sein (links.id ist 32-char Hex) — Konzept hatte irrtümlich INTEGER
  provider     TEXT NOT NULL,
  raw_score    REAL NOT NULL,
  raw_response TEXT,           -- NULL für raw_score < 0.3 (Retention-Strategie 2)
  scanned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scans_link ON security_scans(link_id, scanned_at DESC);
```

#### Neue Bindings und Secrets (geplant)

| Name | Typ | Zweck |
|------|-----|-------|
| `LINKS_KV` | KV Namespace | Hot-Path Read-Through-Cache (TTL 300s) + URLhaus-Snapshot + Global-Insert-Counter |
| `WAECHTER_TOKEN` | Secret | Bearer-Auth für `/api/internal/*` |

#### Retention-Strategie für `security_scans`

- Unauffällige Scans (`raw_score < 0.3`): Cleanup nach 7 Tagen (im `scheduled`-Handler)
- Auffällige Scans: Cleanup nach 90 Tagen
- `raw_response` wird vom Wächter nur für `raw_score >= 0.3` gesendet (spart ~1-2 KB/Eintrag)

#### Score-Schwellenwerte (Wächter-Env-Variablen)

| Aggregierter Score | Status | Wirkung im Hot-Path |
|-------------------|--------|----------------------|
| `< 0.70` | `active` | 302 Redirect |
| `0.70 – 0.94` | `warning` | 302 → `/warning?code=:code` |
| `≥ 0.95` | `blocked` | 404 |

#### Hot-Path Status-Hierarchie (handleRedirect)

```
if (is_active === 0)         → 404  // User-Intent hat Vorrang
elif (status === 'blocked')  → 404
elif (status === 'warning')  → 302 → /warning?code=:code
else                         → 302 → target_url
```

`is_active` (User-Intent) wird **vor** `status` (System-Bewertung) geprüft. Ein vom Eigentümer deaktivierter Link zeigt kein Wächter-Interstitial.

#### Backpressure-Schichten (geplant)

1. **Per-IP Rate-Limit** (existiert): 10/min anonym, 60/min authentifiziert (letzteres neu)
2. **Globaler Insert-Cap** via KV-Minute-Bucket: Default 1000/min, gibt 503 zurück
3. **Queue-Depth-Throttle**: Worker prüft `COUNT(*) WHERE checked=0 AND claimed_at IS NULL` beim Insert; Ergebnis 30s im Module-Scope gecacht; bei Überschreitung 503
4. **Wächter-seitig**: Quota-Tracking pro Provider (Provider wirft `QuotaExhaustedError`, Aggregation läuft mit restlichen Providern weiter)

#### CSRF-Schema für `/warning/proceed` (v4 §8.4)

`SESSION_SECRET` wird wiederverwendet. Neuer generischer Helper `generateSignedToken(subject, secret, ttlMs)`:

```
// Warning-Bypass-Token:
generateSignedToken(`warning:${shortCode}`, SESSION_SECRET)
// Verifikation:
verifySignedToken(token, `warning:${shortCode}`, SESSION_SECRET)
```

Subject-Trennung verhindert Cross-Replay zwischen Session-CSRF-Tokens und Warning-Bypass-Tokens. Falls Refactor zu invasiv: parallele Funktion `generateWarningToken(shortCode, secret)` mit identischem Format.

#### Wächter-Projekt

Der Wächter wird als **separates Projekt** auf einem Hetzner VPS entwickelt und betrieben. Das Pflichtenheft ist in `waechter.md` in diesem Repo dokumentiert (API-Kontrakt, TypeScript-Interfaces, Loop-Verhalten, Provider-Architektur, Deployment). Kein Wächter-Code in diesem Repo.

#### Offene Fragen (v3) — Status nach v4

| # | Frage | Status |
|---|-------|--------|
| 1 | `target_url` vs `original_url` | ✅ **RESOLVED** — `target_url` ist kanonisch |
| 2 | `short_code` vs `slug` | ✅ **RESOLVED** — `short_code` / `:code` sind kanonisch |
| 3 | `link_id`-Typ in `security_scans` | ✅ **RESOLVED** — `TEXT` (32-char Hex) |
| 4 | `is_active` vs `status` Vorrang | ✅ **RESOLVED** — `is_active` zuerst (User-Intent), dann `status` |
| 5 | `warning` in `ALIAS_RESERVED` | ✅ **RESOLVED** — Ja, muss hinzugefügt werden (§8.1) |
| 6 | CSRF-Schema für `/warning/proceed` | ✅ **RESOLVED** — `generateSignedToken(subject, SESSION_SECRET)` (§8.4) |
| 7 | Wächter-Repository | ✅ **RESOLVED** — Separates Projekt (eigenes Repo). Pflichtenheft: `waechter.md` |
| 8 | `:id` in interner API | ✅ **RESOLVED** — `links.id` (32-char Hex, immutable) |

#### Bekannte Inkonsistenz in v4 (nicht MVP-kritisch)

v4 §3.4 Strategie 3 (Reserve-Option) hat `link_id INTEGER` — muss `TEXT` sein, da `links.id` ein 32-char Hex-String ist (wie korrekt in §3.2). Fehler liegt im alternativen Schema, nicht im MVP-Schema. Bei Verwendung von Strategie 3 korrigieren.

#### Diskussionspunkte (v4 §14) — Entscheidungen 2026-05-01

| # | Thema | Entscheidung |
|---|-------|--------------|
| 1 | **Bypass-Tracking** | ✅ **JA** — `bypass_clicks`-Tabelle mit `ASN + short_code + hour_bucket` (`strftime('%Y-%m-%d %H', 'now')`). Kein sekundengenauer Timestamp. DSGVO-neutral (ASN nicht personenbezogen). Migration `sql/bypass_clicks.sql` als eigene Phase (Phase 5b). |
| 2 | **Re-Scan-Intervall** | ✅ **Fix 30 Tage** — Simpel halten. Dynamisches Intervall nach Click-Frequenz erst wenn 30-Tage-Fix nachweislich unzureichend ist. |
| 3 | **Heuristik-Listen-Owner** | ✅ **Wächter-Owner** — Bewertungslogik (Heuristiken, Scores, Provider-Gewichtung) gehört ausschließlich in den Wächter. Der Worker hält `spam_keywords` nur für den synchronen Static-Check beim INSERT; diese Liste ist kein Heuristik-Regelwerk, sondern ein einfacher Keyword-Blocker. Die Trennung ist bewusst: deshalb läuft der Wächter extern. |
| 4 | **`/api/internal/links/queue-size`** | ⏸️ **Defer** — Kein MVP-Blocker. Kann als schemafreier GET-Endpoint nachgerüstet werden ohne Breaking Change. Entscheidung nach Phase 3 (wenn Backpressure-Verhalten in Production beobachtbar ist). |
| 5 | **Cloudflare Turnstile (Phase 8)** | ⏸️ **Defer** — Kein MVP-Blocker. Frontend- und Worker-Änderungen nötig; erst evaluieren wenn Bot-Last in Production messbar wird. |

---

## 2026-05-01 — Phase 1 Wächter-Integration abgeschlossen

- Migrationen `links_phase6_security.sql` und `security_scans.sql` angelegt (neue Felder in `links`, neue Tabelle `security_scans`)
- Hot-Path-Redirect (`handleRedirect`) liest jetzt Status/URL aus KV-Cache (TTL 300s), DB-Fallback und Write-Through bei MISS
- Status-Hierarchie im Redirect nach Konzept: `is_active` → `status` → `/warning` → 404/302
- Platzhalter für alle `/api/internal/*`-Endpoints im Router implementiert (501 Not Implemented, Auth-Check vorbereitet)
- `LINKS_KV: KVNamespace` zum `Env`-Interface (`src/types.ts`) hinzugefügt
- Noch offen: URLhaus-Snapshot-Check im Static-Check, Wächter-Logik, Interstitial-Page, Bypass-Tracking

### Bugfixes Phase 1 (Tests)

- **`test/anonymous.spec.ts`**: `require("./helpers").createLinksKvMock()` durch korrekten ES-Import ersetzt — `require()` ist im Miniflare/Vitest-Worker-Pool (ESM-Kontext) nicht verfügbar
- **`src/handlers/links.ts`**: KV-Payload korrigiert — `id` und `user_id` werden jetzt explizit mitgespeichert. Beim Cache-Hit wurde zuvor `id: code` (short_code statt `links.id`) gesetzt, was dazu führte, dass `UPDATE … WHERE id = ?` keine Zeile fand und `click_count` nicht inkrementiert wurde
- **`test/helpers.ts`**: `createLinksKvMock()` um `reset()`-Methode erweitert, damit der In-Memory-Store zwischen Tests isoliert geleert werden kann
- **`test/index.spec.ts`**: `linksKvMock`-Referenz außerhalb von `beforeAll` gehoben; `linksKvMock.reset()` in `beforeEach` für saubere Test-Isolation
- Alle **316 Tests** grün (5 Suites)

---

## 2026-05-01 — Phase 1 Wächter-Integration: `/api/internal/*`-Endpunkte implementiert

- Neuer Handler `src/handlers/internal.ts` mit allen 5 Endpunkten vollständig implementiert:
  - `GET /api/internal/health` — 200 OK `{ ok: true }`, Bearer-Auth
  - `GET /api/internal/links/pending?limit=N` — atomisches UPDATE … RETURNING (claimed_at = now()), limit 1–100
  - `POST /api/internal/links/:id/scan-result` — schreibt `checked`, `spam_score`, `status`, `last_checked_at`, löscht `claimed_at`, `INSERT INTO security_scans`, invalidiert KV-Cache
  - `POST /api/internal/links/release-stale` — gibt `claimed_at > 10 min` zurück, liefert `{ released: N }`
  - `GET /api/internal/metrics` — Queue-Tiefe, Scans 24h, Status-Verteilung per DB-Batch-Query
- Authentifizierung via `WAECHTER_TOKEN` (Bearer), Rate-Limit 60 req/min per Token (`checkRateLimit("internal:token", ...)`)
- Router in `src/index.ts` aktualisiert (Platzhalter durch echte Handler ersetzt)
- `WAECHTER_TOKEN: string` zu `src/types.ts` und `vitest.config.mts` (Test-Binding `"test-waechter-token"`) hinzugefügt
- `test/helpers.ts` erweitert: `setupSecurityScansTable()`, `seedLink()` um Phase-6-Felder (`checked`, `status`, `manualOverride`, `claimedAt`)
- Neue Test-Suite `test/internal.spec.ts` mit 30 Tests für alle 5 Endpunkte (Auth, Happy Path, Edge Cases, Validierung)
- Alle **347 Tests** grün (6 Suites)

---

## 2026-05-01 — Phase 5 + 5b Wächter-Integration: Interstitial-Page implementiert

### Änderungen

- **`src/validation.ts`**: `"warning"` zu `ALIAS_RESERVED` hinzugefügt (§8.1 des Konzepts v4)
- **`src/csrf.ts`**: `generateSignedToken(subject, secret, ttlMs)` und `verifySignedToken(token, subject, secret)` neu — HMAC-SHA256 + Timestamp, TTL 5 min Default; Subject-Trennung verhindert Cross-Replay mit Session-CSRF-Tokens
- **`src/handlers/warning.ts`** (neu): `handleWarning` (GET `/warning`) — rendert HTML-Interstitial-Page, HTML-escaped `target_url`, generiert Bypass-Token; `handleWarningProceed` (GET `/warning/proceed`) — verifiziert Token, 302 Redirect auf `target_url`, Phase-5b-Bypass-Logging via `ctx.waitUntil`
- **`src/index.ts`**: Router um `GET /warning` und `GET /warning/proceed` erweitert
- **`sql/bypass_clicks.sql`** (neu, Phase 5b): Migration für `bypass_clicks`-Tabelle (`short_code`, `asn`, `hour_bucket`) — kein sekundengenauer Timestamp, ASN nicht personenbezogen
- **`test/helpers.ts`**: `setupBypassClicksTable()` neu hinzugefügt
- **`test/warning.spec.ts`** (neu): 29 Tests — `generateSignedToken`/`verifySignedToken` Unit-Tests, `ALIAS_RESERVED`-Check, alle Edge Cases für `/warning` und `/warning/proceed`

### Sicherheit

- `target_url` wird immer mit `escapeHtml()` gerendert (Stored-XSS-Schutz)
- `/warning/proceed` ist ein separater Endpunkt (nicht `/r/:code`) — Bypass-Schutz nicht umgehbar
- Token-Subject `"warning:<code>"` verhindert Cross-Replay mit Session-CSRF-Tokens
- Anti-Enumeration: `/warning` und `/warning/proceed` geben identisches 404 für nicht-existente, inaktive, abgelaufene und geblockte Links

### Test-Ergebnis

Alle **376 Tests** grün (7 Suites)

---

## 2026-04-30

### Security: OAuth Open Redirect & Cookie Prefix Fixes

**Fix 1 — Open Redirect via Protocol-Relative `next` (HIGH)**
- `src/handlers/auth.ts`: `handleLogin` und `extractNextFromState` — `next`-Validierung von `startsWith("/")` auf `startsWith("/") && !startsWith("//")` verschärft. Verhindert Redirect auf `//evil.com`.

**Fix 2 — OAuth Cookies mit `__Host-` Präfix (HIGH)**
- `src/handlers/auth.ts`: `oauth_state` → `__Host-oauth_state`, `oauth_nonce` → `__Host-oauth_nonce` beim Setzen (Z. 79–80), Lesen (Z. 199–200) und Löschen (Z. 216–217). `__Host-`-Präfix erzwingt `Secure; Path=/; kein Domain`-Attribut und verhindert Subdomain-Overwrite-Angriffe.

**Tests**
- `test/index.spec.ts`: Alle Vorkommen der Cookie-Keys auf `__Host-oauth_state`/`__Host-oauth_nonce` aktualisiert. Neuer Test `falls back to next=/ for protocol-relative URL //evil.com` im `GET /login – dynamic redirect`-Block hinzugefügt.
- Alle **316 Tests** grün.

## 2026-04-29

### Dynamic OAuth Redirect (`?next=`)
- **Datei**: `src/handlers/auth.ts`
- **Änderung**: `handleLogin` liest optionalen `?next=`-Parameter, validiert ihn (nur relative Pfade), kodiert `{ nonce, next }` als Base64-JSON in den OAuth-`state`-Parameter und den `oauth_state`-Cookie. `handleGoogleCallback` extrahiert und validiert `next` aus dem State; leitet nach erfolgreicher Session-Erstellung auf den dekodiertem Pfad weiter statt fest auf `/app.html`.
- **Datei**: `test/index.spec.ts`
- **Änderung**: 6 neue Tests für den dynamischen Redirect und Open-Redirect-Schutz.

### Format-Verträge & Doku-Erweiterungen
- **Datei**: `src/validation.ts`
- **Änderung**: `stats` zu `ALIAS_RESERVED` hinzugefügt, um Kollision mit dem externen Stats-Worker-Routing zu verhindern.
- **Datei**: `test/index.spec.ts`
- **Änderung**: Neuer Test, der `stats` als reservierten Alias ablehnt (erwartet HTTP 400).
- **Datei**: `AGENTS.md`
- **Änderung**: Vier neue/erweiterte Abschnitte:
  1. **Data Format Contracts** — Tabelle mit exakten Formaten (Regex, Generator-Funktion, Beispiel) für alle D1-Felder, die von externen Konsumenten gelesen werden können (`users.id`, `sessions.id`, `sessions.expires_at` etc.).
  2. **Alias reserved words** — `stats` ergänzt, Begründung dokumentiert.
  3. **Shared Database Consumers** — Expliziter Hinweis, dass diese D1 auch von einem externen Stats-/Paywall-Worker gelesen wird; Schema-Änderungen sind Breaking Changes.
  4. **Logging conventions** — Sicherheitsregeln: keine vollständigen Cookie-/Session-Werte loggen; bei Auth-Rejects `reason`-String mit-loggen.
