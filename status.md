# Status Log

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
