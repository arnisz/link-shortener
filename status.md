# Status Log

## 2026-05-14 — Implementierung: Security-Audit-Fixes S-3/S-1/S-2

**Status:** implementiert ✅ — 2026-05-14

### Umgesetzte Aenderungen

- `src/index.ts` — Admin-Link-Mutationsrouten auf 32-char `links.id` begrenzt; `handleAdminDeleteUser` bekommt `ExecutionContext` fuer KV-Tombstones.
- `src/handlers/admin.ts` — Admin-Link-PATCH/DELETE arbeiten ueber immutable `links.id`; KV-Invalidierung nutzt `put()` mit aktualisiertem Payload bzw. Tombstone; User-Delete schreibt Tombstones fuer alle User-Links; Admin-Auth-Rejects loggen `reason`.
- `public/user-administration.js` — Admin-UI verwendet `id` als API-/DOM-Identifier; `short_code` bleibt nur Anzeige- und Bestätigungstext.
- `test/helpers.ts` — `seedLink()` erzeugt nun realistische 32-char-Hex-`links.id`-Werte, damit Admin-Routen- und KV-Tests mit dem produktiven ID-Format laufen.
- `test/admin.spec.ts` — ID-Routen-, Alias-Race-, Unknown-ID-, KV-Drift- und Tombstone-Tests fuer Admin-Link- und User-Delete-Flows ergaenzt.
- `AGENTS.md` — CSRF-Sektion korrigiert, Admin-Routen auf `:id` aktualisiert, Admin-KV-`put()`/Tombstone dokumentiert und Burst-Revalidation ins Praesens gesetzt.

### Verifikation

- Gezielte Admin-Tests und Gesamtsuite wurden im Implementierungstask ausgefuehrt; Details siehe Task-Zusammenfassung.
- Manueller Wrangler-/Admin-UI-Smoke-Test am 2026-05-14 erfolgreich durchgefuehrt: Status-Toggle im Admin-UI geprueft; `GET /r/<code>` reagierte ohne beobachtbares Drift-Fenster mit dem erwarteten Ergebnis.
- Deploy-/Production-Smoke-Test am 2026-05-14 erfolgreich durchgefuehrt: Worker deployt; Test-Link-Statuswechsel und Admin-Aktion auf Wegwerf-User in Production ohne Auffaelligkeiten verifiziert.

---

## 2026-05-14 — Planung: Security-Audit-Fixes S-3 → S-1 → S-2

**Status:** implementiert ✅ — umgesetzt im Eintrag „2026-05-14 — Implementierung: Security-Audit-Fixes S-3/S-1/S-2".

### Anlass

Security-Audit vom 2026-05-14 hat drei kritische/hochsevere Befunde in den `/api/admin/*`-Endpunkten identifiziert. Volle Befundliste in `docs/security-audit-2026-05-14.md`, Umsetzungsdetails in `docs/security-fix-plan-2026-05-14.md`, ausfuehrbarer Coding-Agent-Prompt in `docs/s3s1s2.md`.

### Verbindliche Reihenfolge

Die drei Fixes haengen voneinander ab — S-3 etabliert die ID-basierten Admin-Routen, auf denen S-1 und S-2 aufsetzen. Dadurch wird jede KV-Invalidierungslogik nur einmal geschrieben.

1. **S-3 (HIGH) — Admin-Endpoints auf `links.id` statt mutierbaren `short_code` umstellen.**
   Betrifft: Router (`src/index.ts`), Handler (`src/handlers/admin.ts:212-307`), Frontend (`public/user-administration.js`). Tests in `test/admin.spec.ts`.

2. **S-1 (CRITICAL) — Admin-Mutationen invalidieren KV-Cache via `put()` mit aktualisiertem Payload statt `delete()`.**
   Pattern bereits in `handleInternalScanResult` (`src/handlers/internal.ts:278-294`) erprobt. `handleAdminDeleteLink` schreibt Tombstone (`is_active = 0`, TTL 60 s).

3. **S-2 (HIGH) — `handleAdminDeleteUser` invalidiert KV fuer alle Links des geloeschten Users.**
   Verwendet das Tombstone-Pattern aus S-1.

### Mit-Fixes im selben PR (empfohlen)

- **D-1 (HIGH)** — `AGENTS.md` CSRF-Sektion auf den Stand nach Bugfix 9.5.26-2 korrigieren.
- **D-3 (LOW)** — `AGENTS.md` Burst-Revalidation-Sektion ins Praesens.
- **S-6 (MEDIUM)** — `log("ADMIN_AUTH", "rejected reason=…")` in `checkAdminAuth` ergaenzen.

### Aus dem PR herausgehalten (eigene Tickets)

- **S-4** (timingSafeEqual fuer ADMIN/WAECHTER-Token)
- **S-5** (Hostname-Normalisierung in `/api/internal/kv/urlhaus`)
- **S-7** (`scans.length`-Bound in `handleInternalScanResult`)
- **D-2** (Timestamp-Format-Vereinheitlichung — braucht Abstimmung mit Stats-Worker-Owner)

### Definition of Done

Identisch zur Liste in `docs/security-fix-plan-2026-05-14.md` Abschnitt 5.

---

## 2026-05-14 — Implementierung: Burst-Revalidation fuer neue Links (40 Klicks in 6h)

**Status:** implementiert ✅ — 2026-05-14

### Umgesetzte Aenderungen

- `sql/links_phase6_burst_revalidation.sql` — neue Spalte `last_scanned_click_count INTEGER NOT NULL DEFAULT 0` in `links`; neuer Index `idx_links_burst_revalidation`
- `src/config.ts` — neue Konstanten `BURST_REVALIDATION_CLICK_THRESHOLD = 40` und `BURST_REVALIDATION_WINDOW_HOURS = 6`
- `src/handlers/internal.ts` — `handleInternalLinksPending`: neue Prioritaetsklasse 2 (Burst) direkt nach `checked = 0`; `handleInternalScanResult`: Writeback `last_scanned_click_count = click_count` nach jedem Scan (auch fuer `manual_override = 1`, um Re-Burst zu verhindern)
- `test/internal.spec.ts` + `test/helpers.ts` — 10 neue Tests; `seedHexLink` um `lastScannedClickCount` und `createdAt` erweitert; `setupLinksTable` um Migration erweitert
- `AGENTS.md` — Phase-6-Status auf `✅ done` gesetzt; Migration in lokaler DB-Setup-Liste ergaenzt

### Technische Anmerkung

SQLite vergleicht `created_at` (ISO-8601 mit `T` und `Z`) nicht korrekt mit `datetime('now', ...)` per String-Vergleich. Die Query verwendet deshalb `datetime(created_at) >= datetime('now', '-N hours')`, damit SQLite den ISO-8601-Timestamp korrekt parst.

---

## 2026-05-14 — Planung: Burst-Revalidation fuer neue Links (40 Klicks in 6h)

**Status:** implementiert ✅ (siehe Eintrag oben)

### Anlass

Phishing-Kampagnen erzeugen haeufig einen Klick-Burst in den ersten 3 bis 6 Stunden nach dem Anlegen eines Links. Die bestehende Revalidation priorisiert bislang nur `checked = 0` sowie spaetere statusbasierte Wiederpruefungen (`warning` 24h, `active` 14d, `blocked` 90d). Dadurch kann ein Link, der kurz nach dem ersten Scan ploetzlich stark angeklickt wird, zu lange im Status des ersten Checks verbleiben.

### Zielbild / Pflichtenheft-Nachschärfung

- **Neu** ist ein Link fuer die ersten **6 Stunden** ab `created_at`.
- Wenn ein bereits mindestens einmal gescannter Link in diesem Fenster **40 oder mehr Klicks** erreicht, soll er fuer den Waechter sofort erneut faellig werden.
- Diese Regel ist eine **beschleunigte Zweitbewertung**, kein Ersatz fuer den Initial-Scan von `checked = 0`.
- Die Nachpruefung soll **genau einmal pro Link innerhalb des 6h-Fensters** ausgeloest werden — nicht bei jedem weiteren Poll, solange `click_count` ueber 40 bleibt.
- Diese Revalidierung ist **bewusst priorisiert**: sie soll vor jeder zeitbasierten Revalidierung laufen, damit frueh eskalierende Kampagnen nicht hinter 24h-/14d-/90d-Schwellwerten warten muessen.

### Geplante fachliche Regeln

1. **Prioritaet:** `checked = 0` bleibt weiterhin vor allem anderen. Die neue Burst-Klasse kommt direkt danach und ist damit **hoeher priorisiert als jede zeitbasierte Revalidation**.
2. **Eligibility:** Burst-Revalidation greift nur fuer `checked = 1`, damit wirklich eine erneute Bewertung stattfindet.
3. **Fenster:** `created_at >= now - 6h`.
4. **Schwelle:** `click_count >= 40`.
5. **Einmaligkeit:** Der Worker braucht eine persistierte Wasserstandsmarke, damit die 40-Klick-Schwelle nur einmal als Trigger wirkt. Das ist kein Optimierungsdetail, sondern notwendiger Teil des Features.
6. **Admin-Entscheidungen bleiben bindend:** `manual_override = 1` schliesst auch diese automatische Burst-Revalidation aus.

### Verbindliche Priorisierungsreihenfolge fuer die spaetere Pending-Query

1. `checked = 0`
2. `checked = 1 AND created_at >= now - 6h AND click_count >= 40 AND last_scanned_click_count < 40`
3. stale `warning`
4. stale `active`
5. stale `blocked`

Innerhalb derselben Prioritaetsklasse bleibt die bestehende Sortierlogik erhalten: zuerst `click_count DESC`, danach `last_checked_at ASC NULLS FIRST`.

### Geplante technische Anpassungen (noch nicht implementiert)

- **Neue Persistenz in `links`:** ein Feld wie `last_scanned_click_count INTEGER NOT NULL DEFAULT 0` ist fuer diese Feature-Stufe fachlich erforderlich.
  - Zweck: sauber erkennen, ob ein Link **seit dem letzten Scan** erstmals ueber die 40-Klick-Schwelle gestiegen ist.
  - Zielbedingung fuer die Pending-Query: `click_count >= 40 AND last_scanned_click_count < 40`.
- **`handleInternalScanResult`:** soll nach jedem erfolgreichen Scan den aktuellen `click_count` in diese Wasserstandsmarke uebernehmen, damit dieselbe Burst-Schwelle nicht mehrfach getriggert wird.
- **`handleInternalLinksPending`:** bekommt eine zusaetzliche Prioritaetsklasse zwischen `checked = 0` und der 24h-`warning`-Revalidation; diese Klasse ist ausdruecklich als priorisierte Revalidierung fuer frische Hochreichweiten-Links zu behandeln.
- **Konstanten statt Magic Numbers:** `40 Klicks` und `6 Stunden` sollen spaeter in `src/config.ts` als benannte Limits dokumentiert werden.
- **Keine Aenderung an oeffentlichen Endpunkten:** Das Feature betrifft nur die interne Auswahl- und Revalidierungslogik zwischen Worker und Waechter.
- **Verantwortungstrennung:** Der Worker entscheidet ueber Faelligkeit und Prioritaet; der Waechter behaelt die Verantwortung fuer die eigentliche Sicherheitsbewertung und das resultierende Scoring.

### Vorgesehene Tests fuer die spaetere Implementierung

- Link ist juenger als 6h, bereits gescannt, steigt von `< 40` auf `>= 40` Klicks -> wird von `/api/internal/links/pending` sofort zurueckgegeben.
- Link ist juenger als 6h, hat bereits `>= 40` Klicks, wurde aber danach schon erneut gescannt -> wird **nicht** erneut wegen derselben Schwelle geclaimed.
- Link ist aelter als 6h, auch bei `>= 40` Klicks -> keine Burst-Prioritaet mehr.
- Link mit `manual_override = 1` -> nie Burst-Revalidation.
- Sortierung: `checked = 0` bleibt vor Burst-Revalidation; Burst-Revalidation bleibt vor zeitbasierter `warning`/`active`/`blocked`-Revalidation.
- Gleichstand innerhalb der Burst-Klasse: hoeherer `click_count` zuerst, dann aelterer `last_checked_at` zuerst.

### Kompakte Implementierungsnotiz fuer den spaeteren Coding-Task

1. **Migration anlegen:** neue Spalte in `links` fuer die Wasserstandsmarke einfuehren, voraussichtlich `last_scanned_click_count INTEGER NOT NULL DEFAULT 0`.
2. **Konstanten definieren:** in `src/config.ts` benannte Konstanten fuer Burst-Schwelle und Frischefenster ergaenzen (`40` Klicks, `6` Stunden), damit keine Magic Numbers in SQL oder Handlern landen.
3. **Pending-Query erweitern:** in `src/handlers/internal.ts` die Claim-Logik um eine eigene Burst-Prioritaetsklasse direkt nach `checked = 0` ergaenzen.
4. **Einmal-Trigger absichern:** die Pending-Query muss explizit auf der Wasserstandsmarke basieren, damit dieselbe 40-Klick-Schwelle innerhalb des 6h-Fensters nicht mehrfach claimt.
5. **Scan-Result-Writeback erweitern:** `handleInternalScanResult` soll nach erfolgreichem Scan den aktuellen `click_count` in `last_scanned_click_count` uebernehmen.
6. **Index-/Query-Plan pruefen:** falls noetig zusaetzlichen Index fuer die neue Prioritaetsklasse vorsehen, damit Burst-Revalidation nicht zu einem Full Table Scan degeneriert.
7. **Tests erweitern:** `test/internal.spec.ts` um Prioritaetsreihenfolge, Einmal-Trigger, 6h-Fenster, `manual_override` und Gleichstand-Sortierung ergaenzen.
8. **Doku nachziehen:** nach Implementierung `AGENTS.md` und `status.md` von „geplant“ auf „implementiert“ aktualisieren.

### Dokumentarische Migrationsskizze (noch nicht implementieren)

Die folgende Skizze ist als Arbeitsgrundlage fuer das spaetere Feature-Update gedacht. Sie ist **kein** Umsetzungsauftrag fuer diesen Task, sondern dokumentiert nur die beabsichtigte Struktur.

```sql
-- Beispiel fuer eine zusaetzliche Migration im links-Kontext:
ALTER TABLE links
  ADD COLUMN last_scanned_click_count INTEGER NOT NULL DEFAULT 0;

-- Optional/zu pruefen: zusaetzlicher Index, falls D1 fuer die neue
-- Burst-Prioritaetsklasse sonst zu viele Zeilen scannen muss.
-- Der exakte Index sollte erst nach Query-Plan-Pruefung festgelegt werden.
-- Beispielrichtung:
-- CREATE INDEX idx_links_burst_revalidation
--   ON links(checked, manual_override, created_at, click_count, last_scanned_click_count, claimed_at);
```

**Absicht der Migration:**

- `last_scanned_click_count` speichert den beim letzten erfolgreichen Scan bekannten Klickstand.
- Damit wird aus einer fluechtigen Reichweitenbeobachtung ein persistierbarer, eindeutig pruefbarer Trigger.
- Ohne dieses Feld waere die Einmaligkeit des Burst-Triggers innerhalb des 6h-Fensters nicht robust herstellbar.

### Dokumentarische Pending-Query-/SQL-Skizze (noch nicht implementieren)

Auch die folgende Query ist bewusst als **Skizze** formuliert. Sie soll die Zielrichtung der spaeteren Implementierung festhalten, nicht bereits finalen produktiven SQL-Code liefern.

```sql
UPDATE links
SET claimed_at = datetime('now')
WHERE id IN (
  SELECT id
  FROM links
  WHERE claimed_at IS NULL
	AND manual_override = 0
	AND (
	  checked = 0
	  OR (
		checked = 1
		AND created_at >= datetime('now', '-6 hours')
		AND click_count >= 40
		AND last_scanned_click_count < 40
	  )
	  OR (
		status = 'warning'
		AND last_checked_at < datetime('now', '-24 hours')
	  )
	  OR (
		status = 'active'
		AND last_checked_at < datetime('now', '-14 days')
	  )
	  OR (
		status = 'blocked'
		AND last_checked_at < datetime('now', '-90 days')
	  )
	)
  ORDER BY
	CASE
	  WHEN checked = 0 THEN 1
	  WHEN checked = 1
		AND created_at >= datetime('now', '-6 hours')
		AND click_count >= 40
		AND last_scanned_click_count < 40 THEN 2
	  WHEN status = 'warning'
		AND last_checked_at < datetime('now', '-24 hours') THEN 3
	  WHEN status = 'active'
		AND last_checked_at < datetime('now', '-14 days') THEN 4
	  WHEN status = 'blocked'
		AND last_checked_at < datetime('now', '-90 days') THEN 5
	  ELSE 99
	END,
	click_count DESC,
	last_checked_at ASC NULLS FIRST
  LIMIT ?
)
RETURNING id, short_code, target_url, click_count, created_at, last_checked_at, status;
```

**Wichtige Hinweise zu dieser Skizze:**

- Die Burst-Klasse ist absichtlich **zwischen** `checked = 0` und der `warning`-Revalidation eingeordnet.
- `last_scanned_click_count < 40` repraesentiert den Einmal-Trigger. Dadurch wird nicht jeder weitere Poll nach Ueberschreiten der Schwelle erneut faellig.
- Die konkrete Verwendung von `datetime(...)` vs. ISO-Vergleich muss bei der spaeteren Umsetzung gegen das reale Datumsformat in `links.created_at` und `links.last_checked_at` geprueft werden, da dieses Projekt vertraglich ISO-8601 mit Millisekunden und `Z`-Suffix verwendet.
- Es ist moeglich, dass der finale Worker-Code statt eines einzelnen SQL-Statements eine leicht angepasste D1-kompatible Form braucht. Diese Sektion beschreibt daher **Logik und Priorisierung**, nicht die endgueltige Syntax.

### Dokumentarische Scan-Result-Skizze (noch nicht implementieren)

Fachliche Zielrichtung fuer den spaeteren Update-Pfad in `handleInternalScanResult`:

```sql
UPDATE links
SET
  checked = 1,
  spam_score = ?,
  status = ?,
  last_checked_at = ?,
  claimed_at = NULL,
  last_scanned_click_count = click_count
WHERE id = ?
  AND manual_override = 0;
```

**Absicht dieser Skizze:**

- Nach einem erfolgreichen Scan wird der aktuelle Klickstand als neue Wasserstandsmarke gespeichert.
- Dadurch kann derselbe Link erst dann erneut durch den Burst-Mechanismus faellig werden, wenn eine spaetere Produktstufe bewusst eine neue Schwellwertlogik einfuehrt.
- Fuer die jetzt geplante Feature-Stufe gilt damit klar: **eine** Burst-Nachpruefung pro Link innerhalb des 6h-Fensters.

---

## 2026-05-14 — Erweiterung: Admin-Dashboard – Link-Verwaltung (Status, Spam-Score, Löschen)

**Status:** implementiert ✅

### Anlass

Das Admin-Dashboard war bisher auf User-Management (sperren/entsperren/löschen) beschränkt. Links konnten nur gelesen, nicht bearbeitet oder gelöscht werden. Nach dem ersten Phishing-Vorfall (Mai 2026) wurde der Bedarf erkannt, Links direkt aus dem Dashboard zu verwalten.

### Neue Features

**Status-Änderung per Dropdown:**
- Jede Link-Zeile hat ein `<select>` mit den Optionen `active`, `warning`, `blocked`
- Änderung sendet `PATCH /api/admin/links/:id` mit `{ status }` im Body (immutable 32-char `links.id`)
- Setzt `manual_override=1` → der Wächter überschreibt den Status nicht mehr automatisch
- Überschreibt den KV-Cache via `put()` sofort mit dem aktualisierten Payload (kein Drift-Fenster durch eventual-consistent `delete()`)

**Spam-Score-Bearbeitung:**
- Jede Link-Zeile zeigt den aktuellen `spam_score` (0.00–1.00) in einem Number-Input
- Speichern-Button (✓) sendet `PATCH /api/admin/links/:id` mit `{ spam_score }`
- Validierung: Wert muss im Bereich [0, 1] liegen

**Link löschen:**
- Button 🗑 am Zeilenanfang
- Sendet `DELETE /api/admin/links/:id`
- Löscht den Link cross-user über die immutable 32-char `links.id` (kein `user_id`-Filter)
- Schreibt einen kurzlebigen KV-Tombstone (`is_active = 0`, TTL 60 s)

### API-Endpunkte

| Method | Path | Handler |
|--------|------|---------|
| `PATCH` | `/api/admin/links/:id` | `handleAdminUpdateLink` — setzt `status` und/oder `spam_score`, `manual_override=1`, KV-Update via `put()` |
| `DELETE` | `/api/admin/links/:id` | `handleAdminDeleteLink` — löscht Link per immutable `links.id`, schreibt KV-Tombstone |

### Geänderte Dateien

- `src/handlers/admin.ts`: 2 neue Handler (`handleAdminUpdateLink`, `handleAdminDeleteLink`)
- `src/index.ts`: 2 neue Router-Einträge
- `public/user-administration.html`: Neue Tabellenspalten "Aktionen" + "Spam-Score", Status-Dropdown
- `public/user-administration.js`: Event-Handler für change (Status-Dropdown) und click (Delete, Save-Score)
- `test/admin.spec.ts`: 10 neue Tests (PATCH + DELETE Links, spam_score in GET)

### Tests

- 448 Tests, alle bestanden
- Neue Tests: Status-Update, Spam-Score-Update, invalid status (400), score out of range (400), nicht existenter Link (404), unauthorized (401)

---

## 2026-05-14 — Implementierung: Admin-Dashboard (`/user-administration`)

**Status:** implementiert ✅ — `ADMIN_TOKEN` bereits in Cloudflare als Secret angelegt

### Anlass

Erster bestätigter Phishing-Missbrauch von aadd.li (Mai 2026): Ein User nutzte den Dienst zur Verbreitung eines Phishing-Links. Der Angriff wurde manuell gestoppt (Direktzugriff auf D1 / Cloudflare Dashboard). Als strukturelle Lücke wurde das Fehlen eines Admin-Interfaces identifiziert, das Link-Übersicht, User-Sperrung und -Löschung ohne direkten DB-Zugriff ermöglicht.

### Designentscheidungen

**Sperren vs. Löschen:**
- **Sperren** (`is_blocked=1`): Sessions werden invalidiert (erzwungene Neu-Anmeldung). Login-Callback lehnt gesperrte User mit 403 ab. User-Datensatz und Links bleiben erhalten — der Admin kennt den Angreifer weiterhin (E-Mail, erstellte Links, Zeitstempel). Bevorzugte Aktion bei Missbrauch.
- **Löschen**: Unwiderruflich. Für DSGVO-Löschanträge oder nach abgeschlossener Klärung.

**Auth-Modell (Dual-Layer):**
- Faktor 1: Gültige Google-OAuth-Session (`__Host-sid`)
- Faktor 2: `Authorization: Bearer ${ADMIN_TOKEN}` (Cloudflare Secret, bereits angelegt)
- Beide Faktoren gleichzeitig erforderlich — fehlt einer: generischer `401`

**Endpunkt:** `https://aadd.li/user-administration` (Admin-SPA, statisch in `public/`)

### Geplante Änderungen

#### DB-Migration (`sql/admin.sql`)

```sql
ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_users_is_blocked ON users(is_blocked) WHERE is_blocked = 1;
```

#### Neuer Handler `src/handlers/admin.ts`

| Funktion | Route |
|----------|-------|
| `handleAdminGetLinks` | `GET /api/admin/links` |
| `handleAdminGetUsers` | `GET /api/admin/users` |
| `handleAdminBlockUser` | `POST /api/admin/users/:id/block` |
| `handleAdminUnblockUser` | `POST /api/admin/users/:id/unblock` |
| `handleAdminDeleteUser` | `DELETE /api/admin/users/:id` |

#### Weitere Änderungen

- `src/types.ts`: `ADMIN_TOKEN: string` in `Env`
- `src/index.ts`: Router-Einträge für `/user-administration` und `/api/admin/*`
- `src/handlers/auth.ts` (`handleGoogleCallback`): `is_blocked`-Check nach User-Upsert — wenn `1`, Login mit 403 ablehnen, kein Session-Cookie setzen
- `src/validation.ts`: `ALIAS_RESERVED` um `"user-administration"` und `"admin"` erweitern
- `public/user-administration.html`: Admin-SPA mit Token-Eingabe, User-Tabelle (sperren/entsperren/löschen), Link-Tabelle
- `test/admin.spec.ts`: neue Testsuite

### Implementierungs-Reihenfolge

1. Migration `sql/admin.sql` anlegen und anwenden (lokal + remote)
2. `Env`-Interface erweitern
3. `handleGoogleCallback` härten (`is_blocked`-Check)
4. `src/handlers/admin.ts` implementieren
5. Router-Einträge in `src/index.ts`
6. `public/user-administration.html`
7. Tests

---

## 2026-05-09 — Implementierung: CSRF-Härtung Bugfix 9.5.26-1 + 9.5.26-2

**Status:** implementiert ✅

### Bugfix 9.5.26-1 — `fix(auth): require mutation CSRF validation for logout`

#### Änderungen

- **`src/handlers/auth.ts`**: `validateMutationCsrf` importiert; `handleLogout` ruft `validateMutationCsrf(request, env)` vor dem Session-Delete auf. Bei CSRF-Fehler wird die Fehler-Response sofort zurückgegeben, die Session bleibt erhalten.
- **`test/index.spec.ts`**: `generateCsrfToken` importiert. Bestehende Logout-Tests angepasst (Beschreibungen präzisiert, "deletes session"-Test sendet jetzt gültigen CSRF-Token + Origin). 3 neue Tests:
	- `POST /logout` mit Origin aber ohne X-CSRF-Token → 403, Session bleibt
	- `POST /logout` mit Origin + nur X-Requested-With → 403
	- `POST /logout` mit fremdem Origin → 403

### Bugfix 9.5.26-2 — `fix(csrf): do not accept X-Requested-With as substitute for X-CSRF-Token`

#### Änderungen

- **`src/csrf.ts`**: `validateMutationCsrf` akzeptiert `X-Requested-With` nicht mehr als Ersatz für `X-CSRF-Token`. Same-Origin-Requests mit `Origin`-Header müssen zwingend einen gültigen, session-gebundenen CSRF-Token liefern.
- **`test/index.spec.ts`**: CSRF-Test "allows POST when Origin matches APP_BASE_URL and X-Requested-With is set" auf gültigen CSRF-Token umgestellt. Neuer Test: "returns 403 when Origin matches APP_BASE_URL but only X-Requested-With is sent".
- **`test/backpressure.spec.ts`**: `postAuthLink`-Helper auf CSRF-Token umgestellt (`generateCsrfToken` importiert, `X-Requested-With` durch `X-CSRF-Token` ersetzt).

### Kompatibilität

- Non-Browser-Requests ohne `Origin`-Header: weiterhin erlaubt (curl, Tests, mobile Apps)
- Browser-Clients, die `GET /api/me` aufrufen und den `csrfToken` mitsenden: weiterhin funktionsfähig
- `tags_search.spec.ts`: nicht betroffen (kein expliziter `Origin`-Header → Non-Browser-Pfad)

### Tests

- Alle bestehenden Tests angepasst; 3 neue Logout-Tests + 1 neuer CSRF-Test hinzugefügt
- Test-Ausführung in dieser Umgebung nicht möglich (Windows: "access violation in the runtime" / veraltete Visual C++ Redistributable — pre-existing Problem)

---

## 2026-05-09 — Planung: CSRF-Härtung Bugfix 9.5.26-1 + 9.5.26-2

**Status:** implementiert ✅ (siehe Eintrag oben)

### Hintergrund

Im Security Review wurden zwei bestätigte CSRF-bezogene Härtungspunkte identifiziert. Beide betreffen die Trennung zwischen dem globalen Router-Precheck (`validateCsrf`) und der stärkeren, sessiongebundenen Per-Handler-Validierung (`validateMutationCsrf`). Dieser Eintrag dokumentiert ausschließlich die offenen Bugfix-Aufgaben, damit ein späterer Implementierungs-Task die Änderungen ohne erneute Ursachenanalyse umsetzen kann.

### Bugfix 9.5.26-1

**Title:** `fix(auth): require mutation CSRF validation for logout`

**Problem:** `POST /logout` ist browser-authentifiziert über das Cookie `__Host-sid` und führt eine serverseitige Zustandsänderung aus (`DELETE FROM sessions WHERE id = ?`), ruft aber im Gegensatz zu den anderen authentifizierten Mutation-Handlern `validateMutationCsrf(...)` nicht auf.

**Risk:** Logout-CSRF / erzwungene Session-Invalidierung. Das ermöglicht keine Link-Erstellung, kein Update und kein Delete fremder Daten, verletzt aber die Projektregel, dass browser-authentifizierte Mutationen zusätzlich zur globalen Router-Prüfung eine Per-Handler-CSRF-Validierung verwenden sollen.

**Expected fix:** `handleLogout(...)` muss vor dem Löschen der Session `validateMutationCsrf(request, env)` aufrufen. Wenn die CSRF-Prüfung fehlschlägt, muss die zurückgegebene CSRF-Fehler-Response sofort zurückgegeben werden und die Session darf nicht gelöscht werden.

**Compatibility notes:** Bestehender Browser-Logout-Code muss künftig einen gültigen `X-CSRF-Token` mitsenden. Tests, die Logout nur mit `X-Requested-With` absichern, müssen bei der späteren Implementierung angepasst werden.

**Suggested tests to add later:**

- `POST /logout` mit gültiger Session und gültigem CSRF-Token erfolgreich; Session-Zeile wird gelöscht.
- `POST /logout` mit gültigem `Origin`, aber ohne `X-CSRF-Token` → `403`.
- `POST /logout` nur mit `X-Requested-With` → nach CSRF-Härtung `403`.
- `POST /logout` ohne Session bleibt sicher und leakt keine zusätzlichen Informationen.

### Bugfix 9.5.26-2

**Title:** `fix(csrf): do not accept X-Requested-With as substitute for X-CSRF-Token`

**Problem:** `validateMutationCsrf(...)` akzeptiert aktuell entweder einen gültigen CSRF-Token oder bloß die Existenz von `X-Requested-With`. Das schwächt die beabsichtigte, an die aktuelle Session gebundene CSRF-Schutzschicht.

**Risk:** Der globale Router-CSRF-Precheck blockiert klassische Cross-Origin-Form-CSRF bereits, daher ist dies kein unmittelbarer Account-Takeover-Bug. Die Per-Handler-CSRF-Schicht soll jedoch einen stärkeren, kryptografisch an die aktuelle Session gebundenen Nachweis liefern. `X-Requested-With` als gleichwertigen Ersatz für einen echten Token zu behandeln, unterläuft dieses Design.

**Expected fix:** Für browser-originierte Mutation-Requests mit `Origin`-Header muss `validateMutationCsrf(...)` künftig zwingend verlangen:

- erlaubter `Origin`
- vorhandenes `__Host-sid`-Cookie
- gültiger `X-CSRF-Token`, der für genau diese Session erzeugt wurde

`X-Requested-With` kann optional Teil des globalen Router-Level-Prechecks bleiben, darf aber `validateCsrfToken(...)` in `validateMutationCsrf(...)` nicht ersetzen.

**Compatibility notes:** Browser-Clients, die bereits `GET /api/me` aufrufen und den gelieferten `X-CSRF-Token` mitsenden, sollten weiter funktionieren. Clients oder Tests, die sich bei authentifizierten Mutationen ausschließlich auf `X-Requested-With` verlassen, müssen während der späteren Implementierung angepasst werden.

**Suggested tests to add later:**

- Authentifizierte Mutation mit gültigem `Origin` und gültigem `X-CSRF-Token` erfolgreich.
- Authentifizierte Mutation mit gültigem `Origin` und nur `X-Requested-With` → `403`.
- Authentifizierte Mutation mit ungültigem `Origin` → Fehler.
- Origin-lose Non-Browser-Requests verhalten sich weiterhin gemäß dokumentierter Projektpolicy.

---

## 2026-05-02 — scheduled-Handler: security_scans Retention-Cleanup

### Änderungen

**Problem:** Der `scheduled`-Handler in `src/index.ts` bereinigt abgelaufene anonyme Links, hatte aber keinen Cleanup für `security_scans`. Laut Architektur sollen low-risk Scans (Score < 0.3) nach 7 Tagen und high-risk Scans (Score ≥ 0.3) nach 90 Tagen gelöscht werden.

#### Implementierung

- **`src/index.ts`** — `scheduled`-Handler um zweiten Cleanup-Block erweitert:
	- Loop 1: `DELETE FROM security_scans WHERE raw_score < 0.3 AND scanned_at < datetime('now', '-7 days')` in 1000er-Batches
	- Loop 2: `DELETE FROM security_scans WHERE raw_score >= 0.3 AND scanned_at < datetime('now', '-90 days')` in 1000er-Batches
	- Fehler im security_scans-Cleanup werfen keinen Fehler im anonymous-links-Cleanup und umgekehrt (zwei unabhängige try/catch-Blöcke)

#### Tests

- **`test/index.spec.ts`** — 6 neue Tests im `describe("scheduled – security_scans retention")`:
	- Low-risk (< 0.3) älter als 7d → gelöscht
	- Low-risk jünger als 7d → bleibt
	- High-risk (≥ 0.3) älter als 90d → gelöscht
	- High-risk jünger als 90d → bleibt
	- Grenzfall score = 0.3 → high-risk → bleibt (< 90d)
	- Frische Einträge beider Klassen → beide bleiben

### Tests

- Alle **412 Tests** grün (8 Suites), vorher 406

---

## 2026-05-02 — KV-Cache-Invalidierung nach User-Mutationen

### Änderungen

**Problem:** `handleUpdateLink` und `handleDeleteLink` invalidierten den KV-Cache (`LINKS_KV`) nach erfolgreichen Mutationen nicht. Dadurch blieb ein gelöschter oder deaktivierter Link bis zu 5 Minuten lang über den Redirect erreichbar.

**Ursache:** Beide Handler hatten keinen `ctx: ExecutionContext`-Parameter und riefen `LINKS_KV.delete()` nicht auf.

#### Implementierung

- **`src/handlers/links.ts`** — `handleDeleteLink`: ctx-Parameter ergänzt, `LINKS_KV.delete(`link:${code}`)` via `ctx.waitUntil(...)` nach erfolgreichem DELETE
- **`src/handlers/links.ts`** — `handleUpdateLink`: ctx-Parameter ergänzt, `LINKS_KV.delete()` nach erfolgreichem UPDATE — invalidiert immer den alten Code; bei Alias-Änderung zusätzlich den neuen Code (falls dort ein veralteter Eintrag lag)
- **`src/index.ts`** — Router übergibt `ctx` an beide Handler

#### Verhalten

| Mutation | KV-Aktion |
|----------|-----------|
| DELETE link | `delete(link:<code>)` |
| UPDATE is_active, title, expires_at | `delete(link:<oldCode>)` |
| UPDATE alias (short_code) | `delete(link:<oldCode>)` + `delete(link:<newCode>)` |

#### Tests

- **`test/index.spec.ts`** — 6 neue Tests in zwei `describe`-Blöcken:
	- `KV-Cache-Invalidierung – DELETE`: KV-Eintrag nach delete entfernt; andere Codes unangetastet
	- `KV-Cache-Invalidierung – UPDATE`: KV-Eintrag nach is_active-Toggle, Alias-Änderung (alter + neuer Code), title-Update jeweils entfernt

### Tests

- Alle **406 Tests** grün (8 Suites), vorher 400

---

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

## 2026-05-01 — Produktionsbugfix: LINKS_KV Binding fehlte in Produktion

### Ursache

`TypeError: Cannot read properties of undefined (reading 'put')` bei `GET /r/:code` in Produktion (FC 1101). Das `LINKS_KV` KV-Namespace-Binding war in `wrangler.jsonc` nicht eingetragen — `env.LINKS_KV` war in der Produktionsumgebung `undefined`.

### Änderungen

- **`wrangler.jsonc`**: `kv_namespaces`-Block mit Binding `LINKS_KV` hinzugefügt (ID: `9e7b1f4897164f5a996c74a16d2d562a`, Preview-ID: `4d89aab81e384008a2091f35327d3604`)
- **`src/handlers/links.ts`**: Defensive Absicherung aller drei `LINKS_KV`-Zugriffe — `checkGlobalInsertCap` gibt jetzt `false` (Fails open) zurück wenn `!env.LINKS_KV`; `handleRedirect` prüft `if (env.LINKS_KV)` vor `get()` und `put()` — KV-Cache überspringen statt crashen wenn Binding nicht konfiguriert
- **`worker-configuration.d.ts`**: `wrangler types` nach Binding-Update ausgeführt
- **`test/anonymous.spec.ts`**: `linksKvMock`-Referenz aus `beforeAll` nach außen gehoben + `linksKvMock.reset()` in `beforeEach` hinzugefügt — behebt Cross-Test-Isolation-Problem: KV-Insert-Counter aus Backpressure-Tests schlug den Rate-Limit-Test (429 wurde nicht ausgelöst wenn Counter bereits voll war)
- **`test/helpers.ts`**: `export type LinksKvMock` exportiert für typgerechten Import in `anonymous.spec.ts`

### Test-Ergebnis

Alle **387 Tests** grün (8 Suites). Deployed: Version `5fa2b72f-ad97-415e-bfc1-083725f59c9d`.

---

## 2026-05-01 — Backpressure-Schichten 2 + 3 implementiert

### Änderungen

- **`src/config.ts`**: Drei neue Konstanten: `GLOBAL_INSERT_CAP = 1000`, `QUEUE_DEPTH_THROTTLE_LIMIT = 5000`, `QUEUE_DEPTH_CACHE_TTL_MS = 30_000`
- **`src/handlers/links.ts`**: Zwei neue private Backpressure-Helper + zwei Test-Hilfsfunktionen:
	- `checkGlobalInsertCap(env)` — Schicht 2: KV-Minute-Bucket (`insert_count:<bucket>`, TTL 120 s), 503 bei Überschreitung; **Fails open** bei KV-Fehler
	- `checkQueueDepthThrottle(db)` — Schicht 3: `COUNT(*) WHERE checked=0 AND claimed_at IS NULL`, 30 s Modul-Scope-Cache, 503 bei Überschreitung; **Fails open** bei DB-Fehler
	- `_resetQueueDepthCache()` + `_setQueueDepthCacheForTest(depth)` — Testhelper für Cache-Isolation und Cache-Injektion
	- Beide Checks in `handleCreateAnonymousLink` und `handleCreateLink` eingebaut (Schicht 3 vor Schicht 2, damit der Throttle zuerst greift)
- **`test/backpressure.spec.ts`** (neu, 11 Tests):
	- Schicht 2: Normal (201), KV voll → 503, KV-Fehler → Fails open, Counter-Increment-Verifizierung
	- Schicht 3: Normal (201), Cache-Inject → 503 (anonym + auth), Cache-Reset → neu abfragen, Cached-Ergebnis persistiert

### Test-Ergebnis

Alle **387 Tests** grün (8 Suites)

---

## 2026-05-02 — Bugfix: KV eventual-consistency Race beim Re-Evaluation blocked→warning

### Problem

Wenn der Wächter einen Link von `blocked` auf `warning` hochstuft, erschien für Nutzer weiterhin HTTP 404 statt der Interstitial-Page. Ursache: `handleInternalScanResult` rief `LINKS_KV.delete()` auf — Cloudflare KV `delete()` ist **eventual consistent** und propagiert das Löschen nicht sofort an alle Edge-Nodes. Andere Edge-Nodes konnten den alten `blocked`-Eintrag noch bis zu ~60 Sekunden liefern, was `handleRedirect` zu einem 404 veranlasste.

### Fix

- **`src/handlers/internal.ts`**: `LINKS_KV.delete()` durch `LINKS_KV.put()` mit dem vollständigen aktualisierten Payload ersetzt. `put()` propagiert den neuen Status (`warning`, `active` etc.) sofort an alle Edges — kein Drift-Fenster. Das `RETURNING`-Clause im UPDATE wurde um `target_url, is_active, expires_at, user_id` erweitert, damit alle KV-Pflichtfelder befüllt werden können.
- **`src/handlers/internal.ts`**: Defensiver `env.LINKS_KV`-Null-Check hinzugefügt (Fails open wenn Binding nicht konfiguriert).

### Tests

- **`test/internal.spec.ts`**: Bestehenden KV-Test umbenannt und auf `put`-Semantik angepasst — prüft jetzt `cached.status === "blocked"` statt `toBeNull()`.
- **`test/internal.spec.ts`**: Neuer End-to-End-Test `re-evaluation: blocked→warning causes /r/:code to redirect to /warning (not 404)` — simuliert stalen KV-Eintrag mit `blocked`, sendet `scan-result` mit `warning`, prüft KV enthält `warning` und Redirect geht zu `/warning` (302).
- Alle **388 Tests** grün (8 Suites)

---

## 2026-05-02 — Phase 1 Wächter-Integration: URLhaus Static-Check implementiert

### Änderungen

- **`src/handlers/links.ts`**: URLhaus Static-Check in `handleCreateLink` und `handleCreateAnonymousLink` integriert.
- **Datensparsamkeit**: Der Check erfolgt rein lokal im Worker gegen einen Snapshot bösartiger Hostnames im Cloudflare KV-Store (`urlhaus:blocked_hosts`). Es findet kein externer Netzwerk-Call an URLhaus/abuse.ch während der Link-Erstellung statt.
- **Speicher-Effizienz**: Alle bösartigen Hostnames werden als JSON-Set in einem einzigen KV-Key gespeichert, um im Cloudflare Free Tier (max. 100.000 Reads/Tag, aber nur 1.000 Writes/Monat) zu bleiben.
- **Sicherheit**: Erkennt Malware-Links bereits synchron beim Erstellen (Static-Check), noch bevor der asynchrone Wächter-Scan läuft.

## 2026-05-02 — API-Endpunkt für automatische URLhaus-Updates

### Änderungen
- **`src/handlers/internal.ts`**: Neuer Endpunkt `handleInternalUpdateUrlhaus` (`POST /api/internal/kv/urlhaus`).
- **`src/index.ts`**: Route für den neuen API-Endpunkt im Router registriert.
- **Zweck**: Erlaubt dem externen Wächter-Script (z.B. Python auf einem Raspberry Pi), die Liste der geblockten URLhaus-Hostnames automatisiert via HTTPS-API zu aktualisieren, ohne das Wrangler CLI nutzen zu müssen.
- **Datenformat**: Erwartet Authentifizierung via `Authorization: Bearer <WAECHTER_TOKEN>` und einen rohen JSON-Array-Body als Payload (z.B. `["bad-domain.com", "evil.net"]`). Speichert diesen extrem effizient als einen einzigen JSON-Blob im KV-Schlüssel `urlhaus:blocked_hosts`.

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
---

## 2026-05-02 — Phase 6 Wächter-Integration: Tiered Revalidation, Manual Override Audit, revalidation_aging Metrics

### Änderungen

#### 6.1 — Tiered Revalidation in `handleInternalLinksPending`

- **`src/handlers/internal.ts`** (`handleInternalLinksPending`): Pending-Query von einfachem `checked=0 OR last_checked_at < 30d` auf 4 Prioritätsklassen erweitert:
	- Prio 1: `checked = 0` (neue Links, sofort scannen)
	- Prio 2: `status = 'warning'`, `last_checked_at` älter als `max_age_warning_h` Stunden (Default 24h)
	- Prio 3: `status = 'active'`, `last_checked_at` älter als `max_age_active_d` Tagen (Default 14d)
	- Prio 4: `status = 'blocked'`, `last_checked_at` älter als `max_age_blocked_d` Tagen (Default 90d)
- Schwellwerte kommen als Query-Parameter vom Wächter; Validierung im Worker (Grenzen: `1 ≤ h ≤ 8760`, `1 ≤ d ≤ 3650`), 400 bei ungültigen Werten
- Sortierung innerhalb gleicher Prio-Klasse: `click_count DESC`, dann `last_checked_at ASC NULLS FIRST`
- Response um `click_count` erweitert (war bereits `created_at` vorhanden)
- Neue Migration `sql/links_phase6_revalidation_index.sql`: Index `idx_links_revalidation` auf `(status, last_checked_at, click_count)`

#### 6.2 — Manual Override Audit-Response in `handleInternalScanResult`

- **`src/handlers/internal.ts`** (`handleInternalScanResult`): Wenn `UPDATE … WHERE manual_override = 0` keine Zeile ändert, wird nun zwischen "Link nicht gefunden" und `manual_override = 1` unterschieden (SELECT auf `manual_override`)
- Bei `manual_override = 1`: Response `{ ok: true, applied: false, reason: "manual_override" }` (200) statt bisheriger 404
- `INSERT INTO security_scans` läuft auch für override'd Links durch — Audit-Trail vollständig erhalten

#### 6.3 — `revalidation_aging` Histogramm in `handleInternalMetrics`

- **`src/handlers/internal.ts`** (`handleInternalMetrics`): Neues SQL-Statement im D1-Batch, gruppiert nach `status`, zählt `never_scanned`, `fresh_lt_24h`, `fresh_lt_7d`, `stale_7d_to_14d`, `overdue_gt_14d`, `overdue_gt_90d` — `manual_override = 0`-Filter
- Response enthält neues `revalidation_aging`-Objekt mit `active`, `warning`, `blocked` Unterobjekten
- Operations-Signal: wenn `overdue_*` über mehrere Tage wächst, fällt der Wächter strukturell zurück

### Tests

- **`test/internal.spec.ts`**: 15 neue Tests (vorher 30, jetzt 44 in dieser Suite):
	- `seedHexLink` um `lastCheckedAt` und `clickCount` erweitert
	- `click_count` im bestehenden Pending-Test geprüft
	- `does not return already-checked links (unless stale)`: `lastCheckedAt` auf "jetzt" gesetzt (sonst gilt `NULL` als stale in Prio 3-4)
	- 4 Tests für Query-Parameter-Validierung (400 bei out-of-range)
	- 4 Tests für Tiered Revalidation (Prio-Reihenfolge, warning-Schwellwert, frische Links, click_count-Sortierung)
	- Manual Override: Response `{ ok, applied: false, reason }` + `links.status` unverändert + `security_scans` vorhanden
	- 4 Tests für `revalidation_aging` (Struktur, `never_scanned`, `overdue_gt_24h`, `manual_override`-Ausschluss)
- Alle **400 Tests** grün (8 Suites)

---

## 2026-05-02 — Architekturkonzept v5: Tiered Revalidation & Manual Override Audit

### Konzeptionelle Weiterentwicklung (v4 → v5)

Das Wächter-Konzept wurde auf v5 weiterentwickelt. Alle Änderungen betreffen ausschließlich Worker-seitige Logik und sind rückwärtskompatibel mit der bestehenden Wächter-API-Schnittstelle. Keine Breaking Changes am Kontrakt.

#### Änderungen v4 → v5

**§4.1 Pending-Query — Tiered Revalidation**

Die bisherige Pending-Query fragt nur `checked = 0` ab (neue Links). Phase 6 erweitert auf vier Prioritätsklassen mit konfigurierbaren Schwellwerten:

| Prio | Klasse | Default-Intervall |
|------|--------|-------------------|
| 0 | `manual_override = 1` | nie (per WHERE ausgeschlossen) |
| 1 | `checked = 0` | sofort |
| 2 | `status = 'warning'` | 24h |
| 3 | `status = 'active'` | 14d |
| 4 | `status = 'blocked'` | 90d |

Schwellwerte sind nicht im Worker hartcodiert, sondern kommen als Query-Parameter (`max_age_warning_h`, `max_age_active_d`, `max_age_blocked_d`) vom Wächter. Validierung im Worker: positive Integer in sinnvollen Grenzen, sonst 400.

Sortierung innerhalb gleicher Prio-Klasse: `click_count DESC` (Reichweite = Risiko-Multiplikator), dann `last_checked_at ASC NULLS FIRST`. Response enthält zusätzlich `click_count` und `created_at`.

**§4.5 Re-Validation Policy**

Formale Verteilung der Verantwortlichkeiten: Worker liefert Schwellwert-Defaults, Status-Sortierung, atomisches Claiming. Wächter überschreibt Schwellwerte via Query-Params, implementiert Jitter (±15% auf `max_age_*`), verwaltet Provider-Quotas.

**§4.6 Verhalten bei `manual_override = 1`**

Bisher: `UPDATE ... WHERE manual_override = 0` schlägt still fehl. Phase 6 ergänzt eine explizite Response:

```json
{ "ok": true, "applied": false, "reason": "manual_override" }
```

`INSERT INTO security_scans` läuft weiterhin durch — Audit-Trail bleibt für override'd Links vollständig erhalten. Ermöglicht späteres Admin-UI: "Manuell freigegeben, aber Provider würde als blocked einstufen."

**§9.5 Metrics-Endpoint — revalidation_aging Histogramm**

Bestehender Metrics-Endpoint wird um `revalidation_aging` erweitert: pro Status-Klasse eine Aufschlüsselung nach `never_scanned`, `fresh_*`, `stale_*`, `overdue_*`. Operations-Signal: wenn `overdue_*` über mehrere Tage wächst, fällt der Wächter strukturell zurück.

---

### Nächste Schritte — Phase 6 (Worker-Anteil)

#### 6.1 — Pending-Query auf Tiered Revalidation erweitern

**Datei:** `src/handlers/internal.ts` (`handleInternalLinksPending`)

- Query-Parameter `limit`, `max_age_warning_h`, `max_age_active_d`, `max_age_blocked_d` aus URL lesen und validieren (positive Integer, Grenzen: `1 ≤ h ≤ 8760`, `1 ≤ d ≤ 3650`). Ungültige Werte → 400.
- `UPDATE links SET claimed_at = datetime('now') WHERE id IN (SELECT ... ORDER BY ... LIMIT ?) RETURNING ...` auf 4-Prio-Klassen-Logik umstellen (alle vier `OR`-Zweige, `ORDER BY CASE ... END, click_count DESC, last_checked_at ASC NULLS FIRST`).
- Response um `click_count` und `created_at` erweitern.
- Migration `sql/links_phase6_revalidation_index.sql` anlegen: zusätzlichen Index auf `(status, last_checked_at, click_count)` prüfen ob D1 ihn nutzt; bestehender `idx_links_scan_queue (checked, last_checked_at, claimed_at)` bleibt erhalten.

**Tests:** `test/internal.spec.ts` — bestehende Pending-Tests auf neuen Response-Shape anpassen + neue Tests für alle vier Prio-Klassen, Schwellwert-Validierung (400 bei out-of-range), Default-Werte, click_count-Sortierung.

#### 6.2 — manual_override Audit-Response in scan-result

**Datei:** `src/handlers/internal.ts` (`handleInternalScanResult`)

- Nach dem D1-Batch prüfen: wenn `result.meta.changes === 0` auf dem `UPDATE links SET ...` → prüfen ob Link `manual_override = 1` hat (SELECT oder RETURNING erweitern).
- Wenn ja: Response `{ ok: true, applied: false, reason: "manual_override" }` statt der bisherigen impliziten 0-rows-affected-Ignoranz.
- `INSERT INTO security_scans` läuft in beiden Fällen durch — nicht in das `IF`-Gate einbeziehen.

**Tests:** `test/internal.spec.ts` — neuer Test: Link mit `manual_override = 1`, POST scan-result → 200, `applied: false`, `reason: "manual_override"`, security_scans-Eintrag vorhanden, `links.status` unverändert.

#### 6.3 — revalidation_aging Histogramm in Metrics

**Datei:** `src/handlers/internal.ts` (`handleInternalMetrics`)

SQL (als separates Statement im D1-Batch):

```sql
SELECT
  status,
  COUNT(*) FILTER (WHERE last_checked_at IS NULL)                      AS never_scanned,
  COUNT(*) FILTER (WHERE last_checked_at > datetime('now', '-1 day'))  AS fresh_lt_24h,
  COUNT(*) FILTER (WHERE last_checked_at > datetime('now', '-7 days')) AS fresh_lt_7d,
  COUNT(*) FILTER (WHERE last_checked_at BETWEEN datetime('now', '-14 days')
                                             AND datetime('now', '-7 days'))  AS stale_7d_to_14d,
  COUNT(*) FILTER (WHERE last_checked_at < datetime('now', '-14 days'))       AS overdue_gt_14d,
  COUNT(*) FILTER (WHERE last_checked_at < datetime('now', '-90 days'))       AS overdue_gt_90d
FROM links
WHERE manual_override = 0
GROUP BY status;
```

Ergebnis in Response-Objekt `revalidation_aging` strukturiert nach Status-Klasse (active/warning/blocked).

**Tests:** `test/internal.spec.ts` — Seed-Links mit unterschiedlichen `status` und `last_checked_at`, prüfen ob Histogramm-Buckets korrekt befüllt.

#### 6.4 — Gesamtstatus Phase 6 nach Abschluss

Wenn 6.1–6.3 implementiert und grün:
- `status.md` Eintrag anlegen
- `AGENTS.md` Phase-6-Markierung von `🔜 next` auf `✅ done` aktualisieren
- Konzept `waechter-konzept.md` bleibt v5 (keine neuen Breaking Changes)
- Wächter-Projekt kann mit dem aktualisierten Pending-Endpoint beginnen (Phase 2)
