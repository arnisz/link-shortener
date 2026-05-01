# Pflichtenheft: Wächter-Dienst

**Projekt:** aadd.li / YAQQ Link Shortener — Sicherheitskomponente
**Dokumentversion:** 1.0 (2026-05-01)
**Status:** Planungsphase — kein Code geschrieben
**Zugehöriges Worker-Repo:** `hello-cf-spa` (dieses Repo, enthält die API-Gegenseite)

---

## 1. Zweck und Abgrenzung

### 1.1 Was der Wächter ist

Der Wächter ist ein eigenständiger Hintergrundprozess (Node.js / Bun, Hetzner VPS), der per adaptivem Pull-Loop neu erstellte Kurz-Links aus der Worker-API holt, sie gegen externe und lokale Threat-Intelligence-Provider bewertet, einen aggregierten Sicherheits-Score berechnet und das Ergebnis via HTTPS-API an den Worker zurückmeldet. Der Worker reagiert darauf durch Status-Änderungen und KV-Cache-Invalidierung — ohne jegliche Kenntnis von Provider-Internals.

### 1.2 Was der Wächter ausdrücklich **nicht** ist

- **Kein Cloudflare Worker / keine Edge-Funktion.** Der Wächter läuft auf einem VPS und darf externe HTTP-Calls (Google Safe Browsing, VirusTotal etc.) absetzen — was im Worker aus Latenz- und Kostengründen verboten ist.
- **Kein Echtzeit-System.** Time-to-First-Scan (TTFS) von 5–60 Sekunden ist akzeptabel. Spam-Schutz in diesem Zeitfenster übernimmt der Static-Check im Worker beim INSERT.
- **Kein persistenter Store.** Der Wächter hält keinen eigenen Datenbankzustand. Einziger Zustand: in-memory Quota-Counter pro Provider (verlustfrei bei Neustart, da Provider-Quotas täglich zurückgesetzt werden).
- **Kein Entscheider über UX.** Der Worker entscheidet, was mit einem Link passiert (`warning`, `blocked`, 404). Der Wächter liefert nur Score und Status-Vorschlag.
- **Kein Hüter der `spam_keywords`-Tabelle.** Diese Tabelle gehört dem Worker und dient dem synchronen Static-Check beim INSERT. Der Wächter hat seine eigene Heuristik-Logik und bezieht `spam_keywords` nicht aus dem Worker.

### 1.3 Systemkontext

```
  aadd.li Worker (Cloudflare)
  ┌──────────────────────────────────────────────────────┐
  │  POST /short  → Static-Check (spam_keywords, URLhaus)│
  │  GET /r/:code → Hot-Path (KV-Cache → D1)             │
  │  GET /warning → Interstitial-Page                    │
  │                                                      │
  │  /api/internal/*  ←── NUR für Wächter (Bearer-Auth)  │
  └───────────────────────┬──────────────────────────────┘
                          │  HTTPS (Pull + Result-POST)
                          ▼
  Wächter (Hetzner VPS) ─────────────────────────────────┐
  │  Adaptiver Pull-Loop                                  │
  │  Provider-Plugin-Architektur                          │
  │  Score-Aggregation                                    │
  └──────────┬────────────────────────────────────────────┘
             │
    ┌────────┴───────────┬───────────────────┐
    ▼                    ▼                   ▼
  Google Safe         VirusTotal        Heuristik
  Browsing v4         (optional)        (lokal, kein API-Call)
```

---

## 2. Externes Interface — Worker-API

Der Worker stellt alle Endpunkte bereit. Der Wächter ist ausschließlich **Consumer**, nie Provider einer Schnittstelle (kein eingehender HTTP-Traffic nötig — Wächter kann hinter NAT laufen).

### 2.1 Authentifizierung

Alle `/api/internal/*`-Endpunkte erfordern:

```
Authorization: Bearer <WAECHTER_TOKEN>
```

Bei Token-Mismatch: generischer `401 Unauthorized`, kein Detail über den Fehlergrund. Rate-Limit: 60 req/min pro Token.

`WAECHTER_TOKEN` ist ein Cloudflare-Secret (`wrangler secret put WAECHTER_TOKEN`). Rotation: neuen Token setzen, Wächter-Env aktualisieren, deploy.

### 2.2 `GET /api/internal/health`

Trivialer Health-Check beim Wächter-Boot.

**Response `200 OK`:**
```json
{ "ok": true }
```

**Verwendung:** Wächter ruft diesen Endpoint beim Start auf. Bei Fehler: Wächter startet nicht, systemd führt Retry durch.

### 2.3 `GET /api/internal/links/pending?limit=N`

Holt bis zu `N` Links zur Prüfung und **claimt sie atomisch** (setzt `claimed_at = now()`). Bereits geclaimte Links (jünger als 10 Minuten) werden übersprungen.

**Query-Parameter:**

| Parameter | Typ | Default | Max |
|-----------|-----|---------|-----|
| `limit` | integer | 50 | 100 |

**Response `200 OK`:**
```json
{
  "links": [
    {
      "id": "a3f8c1e9b2d4f6e8a1c3b5d7e9f2a4c6",
      "short_code": "aB3xY9",
      "target_url": "https://example.com/some/path",
      "created_at": "2026-05-01T13:42:00.123Z"
    }
  ]
}
```

**Feldkonventionen:**

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `id` | string, 32-char Hex | `links.id` — **immutable**, Primärschlüssel für alle API-Calls |
| `short_code` | string | `links.short_code` — mutable (User kann Alias ändern); nur für Logging |
| `target_url` | string | Zu prüfende URL |
| `created_at` | ISO-8601 + ms + Z | Erstellungszeitpunkt |

> ⚠️ **Immer `id` als URL-Parameter verwenden**, nie `short_code`. Ein Inline-Edit des Aliases durch den User zwischen Claim und Result-POST würde sonst einen falschen Link aktualisieren.

**SQL im Worker (atomares Claiming):**
```sql
UPDATE links
SET claimed_at = datetime('now')
WHERE id IN (
  SELECT id FROM links
  WHERE manual_override = 0
    AND (checked = 0 OR last_checked_at < datetime('now', '-30 days'))
    AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes'))
  ORDER BY created_at ASC
  LIMIT ?
)
RETURNING id, short_code, target_url, created_at;
```

### 2.4 `POST /api/internal/links/:id/scan-result`

Schreibt das aggregierte Scan-Ergebnis für einen Link. `:id` ist die immutable `links.id` (32-char Hex).

**Request-Body `application/json`:**
```json
{
  "aggregate_score": 0.83,
  "status": "warning",
  "scans": [
    {
      "provider": "google_safe_browsing",
      "raw_score": 0.95,
      "raw_response": "{\"matches\":[...]}"
    },
    {
      "provider": "heuristic",
      "raw_score": 0.71,
      "raw_response": null
    }
  ]
}
```

**Feldkonventionen:**

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `aggregate_score` | float 0.0–1.0 | ✅ | Aggregierter Score (gewichtetes Maximum) |
| `status` | `"active"` \| `"warning"` \| `"blocked"` | ✅ | Aus Score abgeleiteter Status |
| `scans` | array | ✅ | Min. 1 Eintrag (nur erfolgreiche Provider) |
| `scans[].provider` | string | ✅ | Provider-Name (s. Abschnitt 5.2) |
| `scans[].raw_score` | float 0.0–1.0 | ✅ | Provider-eigener Score |
| `scans[].raw_response` | string \| null | ✅ | JSON-String oder `null` wenn `raw_score < 0.3` |

**Wichtig — `raw_response` Retention-Strategie:**
Wächter sendet `raw_response: null` für alle Scans mit `raw_score < 0.3`. Spart ~1–2 KB/Eintrag in D1. Die Worker-Seite erzwingt das nicht, aber die Konvention muss eingehalten werden.

**Worker-Verhalten nach erfolgreichem POST:**
1. `UPDATE links SET checked=1, spam_score=?, status=?, last_checked_at=now(), claimed_at=NULL WHERE id=? AND manual_override=0`
2. `INSERT INTO security_scans` (eine Zeile pro Provider)
3. `LINKS_KV.delete("link:" + short_code)` — Cache-Invalidierung

**Response `200 OK`:** `{ "ok": true }`
**Response `404`:** Link nicht gefunden oder `manual_override=1` (Wächter ignoriert `manual_override=1`-Links)

### 2.5 `POST /api/internal/links/release-stale`

Gibt alle Claims frei, deren `claimed_at` älter als 10 Minuten ist. Dient der Wiederherstellung nach Wächter-Crashes.

**Kein Request-Body erforderlich.**

**Response `200 OK`:** `{ "released": 42 }` (Anzahl freigegebener Einträge)

**Wann aufrufen:**
- Einmalig beim Wächter-Boot (vor der ersten `pending`-Anfrage)
- Danach alle 5 Minuten (als `setInterval` oder separates Cron-Interval)

### 2.6 `GET /api/internal/metrics` *(optional, Phase 6+)*

Liefert Betriebs-Metriken für Monitoring und Threshold-Tuning. Nicht MVP.

**Response `200 OK`:**
```json
{
  "queue_depth": 142,
  "links_scanned_24h": 1847,
  "status_distribution": { "active": 1801, "warning": 39, "blocked": 7 },
  "provider_quota_status": {}
}
```

---

## 3. TypeScript-Interfaces (Wächter-intern)

Diese Interfaces definieren die Datenstrukturen im Wächter-Code. Sie sind **nicht** mit dem Worker geteilt — kein `shared/`-Verzeichnis in `hello-cf-spa`. Der Wächter pflegt diese Types eigenständig und muss sie bei API-Änderungen synchron halten (Abschnitt 10).

```typescript
// Antwort von GET /api/internal/links/pending
export interface PendingLink {
  id: string;           // 32-char Hex, immutable — für API-Calls verwenden
  short_code: string;   // mutable — nur für Logging
  target_url: string;
  created_at: string;   // ISO-8601
}

export interface PendingResponse {
  links: PendingLink[];
}

// Einzelner Provider-Scan
export interface ProviderScanPayload {
  provider: string;
  raw_score: number;
  raw_response: string | null;  // null wenn raw_score < 0.3
}

// Request an POST /api/internal/links/:id/scan-result
export interface ScanResultPayload {
  aggregate_score: number;
  status: 'active' | 'warning' | 'blocked';
  scans: ProviderScanPayload[];
}

// Internes Scan-Ergebnis eines Providers
export interface ScanResult {
  raw_score: number;
  raw_response?: unknown;  // wird bei Persist als JSON.stringify serialisiert
}
```

---

## 4. Provider-Plugin-Architektur

### 4.1 Interface

```typescript
export interface ScanProvider {
  readonly name: string;    // kanonischer Name für DB-Insert, z. B. 'google_safe_browsing'
  readonly weight: number;  // Gewichtung in der Aggregation, 0.0–1.0
  enabled: boolean;
  scan(url: string): Promise<ScanResult>;
}
```

### 4.2 Kanonische Provider-Namen

| Name | Beschreibung | MVP |
|------|-------------|-----|
| `heuristic` | Lokale Heuristik (kein API-Call) | ✅ Phase 2 |
| `google_safe_browsing` | Google Safe Browsing v4 API | ✅ Phase 4 |
| `virustotal` | VirusTotal Public API | optional |

Neue Provider: neuer Klassen-Name, neuer kanonischer Name, neuer `weight`-Wert. Kein Eingriff in bestehenden Code nötig.

### 4.3 Heuristik-Provider (Phase 2, lokal)

Bewertet ohne externen API-Call. Mögliche Heuristiken:
- IP-Adresse statt Domain in URL (`raw_score = 0.6`)
- Bekannte Spam-TLDs (`.tk`, `.ml`, `.ga`, `.cf`)
- Ungewöhnlich lange URLs (> 500 Zeichen)
- Query-Parameter mit Base64-kodierten URLs (Redirect-Chain-Indikator)
- Sonderzeichen in Subdomain (Homoglyph-Indikator)

Eigene Heuristik-Regeln und Gewichtungen sind vollständig im Wächter und werden **nicht** mit dem Worker synchronisiert. Die `spam_keywords`-Tabelle im Worker ist ein anderes Artefakt (synchroner Static-Check, kein Wächter-Input).

### 4.4 Google Safe Browsing Provider (Phase 4)

- API: `https://safebrowsing.googleapis.com/v4/threatMatches:find`
- API-Key: kostenlos über Google Cloud Console, 10.000 Anfragen/Tag (Free Tier)
- `raw_score`: `1.0` bei Match, `0.0` bei keinem Match
- `weight`: `1.0` (höchstes Vertrauen)
- `raw_response`: vollständige API-Antwort als JSON-String (wird gesendet wenn `raw_score >= 0.3`)

### 4.5 VirusTotal Provider (optional)

- API v3: `https://www.virustotal.com/api/v3/urls`
- Rate-Limit Free Tier: 500 Anfragen/Tag, 4/min
- `raw_score`: `positives / total` aus dem Scan-Report
- `weight`: `0.8`

---

## 5. Score-Aggregation

### 5.1 Algorithmus: gewichtetes Maximum

```typescript
function aggregateScore(
  scans: Array<{ raw_score: number; weight: number }>
): number {
  // Gewichtetes Maximum — nicht Durchschnitt.
  // Begründung: ein hochvertrauenswürdiger Treffer darf nicht durch
  // viele unkritische Provider auf einen harmlosen Wert abgesenkt werden.
  return Math.max(...scans.map(s => s.raw_score * s.weight));
}
```

### 5.2 Status-Mapping

Schwellenwerte sind als **Env-Variablen konfigurierbar** — OSS-Operatoren stellen ihre eigene Risikobereitschaft ein.

| Umgebungsvariable | Default | Bedeutung |
|-------------------|---------|-----------|
| `THRESHOLD_WARNING` | `0.70` | `aggregate_score >= dieser Wert` → `status = 'warning'` |
| `THRESHOLD_BLOCK` | `0.95` | `aggregate_score >= dieser Wert` → `status = 'blocked'` |

```typescript
function mapStatus(score: number): 'active' | 'warning' | 'blocked' {
  if (score >= THRESHOLD_BLOCK)   return 'blocked';
  if (score >= THRESHOLD_WARNING) return 'warning';
  return 'active';
}
```

**Initiale Empfehlung (Phase 3):** Konservative Schwellenwerte `THRESHOLD_BLOCK=0.95`, `THRESHOLD_WARNING=0.85`. In Phase 5 nach Beobachtung der False-Positive-Rate auf `THRESHOLD_WARNING=0.70` absenken.

---

## 6. Pull-Loop

### 6.1 Adaptiver Backoff

Statisches Polling ist verschwenderisch in Ruhephasen und zu langsam bei Last-Spikes.

```typescript
const MIN_WAIT_MS  = 5_000;   // 5 s bei aktiver Last
const MAX_WAIT_MS  = 60_000;  // 60 s bei Leerlauf

let waitMs = MIN_WAIT_MS;

while (true) {
  const { links } = await fetchPending(BATCH_SIZE);

  if (links.length === 0) {
    waitMs = Math.min(waitMs * 2, MAX_WAIT_MS);  // exponentieller Backoff
    await sleep(waitMs);
    continue;
  }

  waitMs = MIN_WAIT_MS;  // bei Arbeit: sofort zurücksetzen
  await processWithConcurrency(links, SCAN_CONCURRENCY, scanLink);
}
```

**Kosten-Abschätzung:** Aktiv ~720 Polls/h, Leerlauf ~60 Polls/h. Workers Free Tier: 100k Requests/Tag — Polling konsumiert max. ~17k davon.

### 6.2 Bounded Concurrency

`Promise.all` würde auf das langsamste Element warten. Stattdessen Worker-Pool, der pro freiem Slot den nächsten Link nachzieht:

```typescript
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function next(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try   { await worker(items[i]); }
      catch (e) { logError('worker_failed', { item: items[i], error: String(e) }); }
    }
  }
  const slots = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: slots }, () => next()));
}
```

Konfigurationsvariable: `SCAN_CONCURRENCY` (Default: `20`).

### 6.3 Release-Stale-Schedule

```typescript
// Bei Boot:
await releaseStale();

// Danach alle 5 Minuten:
setInterval(releaseStale, 5 * 60 * 1000);
```

---

## 7. Fehlerbehandlung

### 7.1 Provider-Fehler

Wenn ein Provider `scan()` mit einem Fehler wirft:
- Aus der `valid`-Liste ausschließen
- Anderen Providern wird dadurch **kein** höheres Gewicht zugeordnet (das wäre eine versteckte Manipulation)
- Fehler loggen (strukturiert, s. Abschnitt 9)

Wenn **alle** Provider fehlschlagen:
- `releaseClaim(link.id)` aufrufen: `POST /api/internal/links/release-stale` ist zu grobgranular für einen einzelnen Link → Wächter hält eine Liste aktiv geclaimter IDs und ruft `release-stale` wie üblich auf; der Link kommt beim nächsten Loop automatisch wieder
- **Keinen** fehlerhaften Score schreiben

### 7.2 Quota-Exhaustion

```typescript
class QuotaExhaustedError extends Error {}

// Im Provider:
if (this.dailyUsed >= this.dailyLimit) {
  throw new QuotaExhaustedError(this.name);
}
```

Bei `QuotaExhaustedError`: Warning loggen, Provider aus dem aktuellen Scan-Batch ausschließen. Aggregation läuft mit verbleibenden Providern weiter. Wenn alle externen Quotas erschöpft sind: Aggregation fällt auf lokale Provider (Heuristik) zurück.

Quota-Tracking in-memory (zurückgesetzt bei Prozess-Neustart, was täglich zum Quota-Reset der Provider zeitlich passt).

### 7.3 Netzwerk-Fehler zum Worker

Bei `fetch`-Fehler auf Worker-Endpoints:
- Retry mit exponential backoff (max. 3 Versuche, dann Log + weiter mit nächstem Link)
- Claim läuft nach 10 min ab → Link kommt automatisch wieder in Pending-Queue

### 7.4 Worker antwortet mit 4xx / 5xx

| Status | Interpretation | Verhalten |
|--------|---------------|-----------|
| `401` | Token ungültig oder nicht gesetzt | Process beenden (systemd restart), Alert |
| `404` auf scan-result | `manual_override=1` oder Link gelöscht | Claim verwerfen, weitermachen |
| `429` | Rate-Limit überschritten | Backoff + Retry |
| `5xx` | Worker-seitiger Fehler | Retry, dann Claim freigeben |

---

## 8. Quota-Management

Jeder externe Provider benötigt eine `QuotaAwareProvider`-Basisklasse:

```typescript
abstract class QuotaAwareProvider implements ScanProvider {
  protected dailyUsed = 0;
  protected dailyResetAt = nextMidnight();
  protected abstract readonly dailyLimit: number;

  protected resetIfNeeded(): void {
    if (new Date() >= this.dailyResetAt) {
      this.dailyUsed = 0;
      this.dailyResetAt = nextMidnight();
    }
  }

  async scan(url: string): Promise<ScanResult> {
    this.resetIfNeeded();
    if (this.dailyUsed >= this.dailyLimit) throw new QuotaExhaustedError(this.name);
    this.dailyUsed++;
    return this.actualScan(url);
  }

  abstract actualScan(url: string): Promise<ScanResult>;
}
```

Bei mehreren Wächter-Instanzen (nur bei sehr hoher Last relevant) muss Quota in einem zentralen Store (Redis o.ä.) gehalten werden. Das ist **kein MVP-Szenario**.

---

## 9. Konfiguration (Umgebungsvariablen)

Alle Konfiguration via Umgebungsvariablen (`.env`-Datei oder systemd `EnvironmentFile`).

| Variable | Typ | Default | Beschreibung |
|----------|-----|---------|--------------|
| `WORKER_BASE_URL` | string | — | **Pflicht.** z.B. `https://aadd.li` |
| `WAECHTER_TOKEN` | string | — | **Pflicht.** Bearer-Token für Worker-API |
| `GOOGLE_SAFE_BROWSING_API_KEY` | string | `""` | Leer = Provider deaktiviert |
| `VIRUSTOTAL_API_KEY` | string | `""` | Leer = Provider deaktiviert |
| `SCAN_CONCURRENCY` | integer | `20` | Parallele Scans pro Batch |
| `BATCH_SIZE` | integer | `50` | Links pro `pending`-Request (max. 100) |
| `MIN_WAIT_MS` | integer | `5000` | Minimales Poll-Interval (ms) |
| `MAX_WAIT_MS` | integer | `60000` | Maximales Poll-Interval bei Leerlauf (ms) |
| `THRESHOLD_WARNING` | float | `0.70` | Score-Schwellenwert für Status `warning` |
| `THRESHOLD_BLOCK` | float | `0.95` | Score-Schwellenwert für Status `blocked` |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error` | `info` | Log-Verbosity |

Beim Start: alle Pflichtfelder prüfen, bei fehlendem Wert sofort abbrechen (fail-fast).

---

## 10. Logging

Strukturiertes JSON-Logging zu `stdout`. `journald` oder ein Log-Aggregator sammelt automatisch.

```json
{ "ts": "2026-05-01T13:42:01.234Z", "level": "info",  "msg": "scan_complete", "link_id": "a3f8...", "score": 0.83, "status": "warning", "providers": 2 }
{ "ts": "2026-05-01T13:42:05.001Z", "level": "warn",  "msg": "quota_exhausted", "provider": "virustotal" }
{ "ts": "2026-05-01T13:42:10.005Z", "level": "error", "msg": "provider_error", "provider": "google_safe_browsing", "error": "network timeout" }
```

**Sicherheitsregeln:**
- `target_url` darf mitgeloggt werden (ist öffentlich einsehbar via Redirect)
- `WAECHTER_TOKEN` darf **niemals** geloggt werden
- `raw_response` darf auf `debug`-Level geloggt werden, nicht auf `info`+

---

## 11. Deployment

### 11.1 Anforderungen

- **Laufzeitumgebung:** Node.js ≥ 20 LTS oder Bun ≥ 1.0
- **Betriebssystem:** Linux (Ubuntu 22.04 LTS oder Debian 12 empfohlen)
- **Hardware:** 1 vCPU, 512 MB RAM reichen für Single-Instance-Betrieb
- **Ausgehender HTTPS-Traffic:** zu `aadd.li` (Worker), `safebrowsing.googleapis.com`, `www.virustotal.com`
- **Kein eingehender Traffic notwendig** — Wächter kann hinter NAT betrieben werden

### 11.2 systemd-Service

```ini
[Unit]
Description=Wächter Link Security Scanner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=waechter
Group=waechter
WorkingDirectory=/opt/waechter
EnvironmentFile=/opt/waechter/.env
ExecStart=/usr/bin/node /opt/waechter/dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=waechter

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/opt/waechter/logs
PrivateTmp=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

### 11.3 VPS-Hardening

- Dedicated non-root User `waechter` (kein Login-Shell, kein Passwort)
- UFW: nur ausgehende HTTPS-Verbindungen, kein eingehender Traffic nötig
- fail2ban für SSH
- Automatische Security-Updates (`unattended-upgrades`)
- Kein öffentlich erreichbarer Port für den Wächter-Prozess

### 11.4 Build und Start

```bash
npm install
npm run build      # tsc → dist/
npm run start      # node dist/index.js

# Oder mit systemd:
sudo systemctl enable waechter
sudo systemctl start waechter
sudo journalctl -u waechter -f   # Live-Logs
```

---

## 12. Nicht im Scope des Wächters

| Feature | Begründung |
|---------|-----------|
| Direkter D1-Zugriff | D1 ist nicht von außen erreichbar; API-Schicht ist der einzige Zugang |
| Push-Webhooks empfangen | Erfordert öffentliche IP/DNS; bricht NAT-Kompatibilität (Phase 7 optional) |
| ML-basierte Heuristik | Maintenance-Aufwand zu hoch für MVP; URLhaus + Google Safe Browsing decken 95 % ab |
| Admin-UI | Nicht nötig; `wrangler d1 execute` + Wächter-Logs reichen für Operator-Einblick |
| Eigene Datenbank | Wächter ist zustandslos; D1 ist Single Source of Truth |
| HMAC-Signatur des POST-Body | Overkill für diesen Threat-Scope; Bearer-Token reicht |
| mTLS | Nicht trivial auf Cloudflare Worker-Seite; Bearer-Token reicht |
| Cloudflare D1 REST-API | Zu viele Privilegien, hohe Latenz; eigene API ist sicherer und schneller |

---

## 13. Schnittstellen-Versionierung und Koordination

Der Worker und der Wächter sind lose gekoppelt — der Worker ändert sich unabhängig. Folgende Änderungen sind **Breaking Changes** und erfordern explizite Koordination:

| Änderung | Auswirkung |
|----------|-----------|
| Neues Pflichtfeld in `POST /api/internal/links/:id/scan-result` | Wächter muss aktualisiert werden, bevor der Worker deployed wird |
| Umbenennung eines Feldes in `GET /api/internal/links/pending` | Beide müssen gleichzeitig deployed werden (kurzes Downtime-Fenster akzeptabel) |
| Neuer `status`-Wert (z.B. `'suspicious'`) | Worker-CHECK-Constraint und Wächter-Status-Mapping müssen synchron geändert werden |
| Token-Rotation (`WAECHTER_TOKEN`) | Wächter-Env aktualisieren, bevor Worker-Secret rotiert wird (kurzes 401-Fenster sonst) |

Nicht-Breaking Changes (Wächter-Update nicht nötig):
- Neues optionales Feld in einem Worker-Response
- Neue Worker-Routen, die der Wächter nicht aufruft
- Schema-Änderungen an `links`-Tabelle, die nicht auf die Pending-Response wirken

---

## 14. Bekannte Grenzen

| Sachverhalt | Konsequenz |
|-------------|-----------|
| KV-Cache TTL 5 min | Nach Worker-Update ist der neue Status erst nach max. 5 min im Hot-Path sichtbar. Kein "instant blocking". |
| Single-Instance Quota-Tracking | Bei zwei Wächter-Instanzen können Quotas doppelt verbraucht werden. Für Single-Instance-Betrieb nicht relevant. |
| `claimed_at` läuft nach 10 min ab | Sehr langsame Provider-Calls (>10 min) können dazu führen, dass ein Link doppelt gescannt wird. Praktisch irrelevant. |
| ASN in `bypass_clicks` | Kein sekundengenauer Timestamp; stündliche Bucket-Granularität. DSGVO-neutral, aber kein präzises Audit. |
| Wächter erfährt keine Löschungen | Wenn ein Link zwischen Claim und Result-POST gelöscht wird, antwortet der Worker mit 404; Wächter verwirft das Ergebnis. |

