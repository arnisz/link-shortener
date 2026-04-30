# Status Log

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
