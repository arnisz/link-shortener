-- Phase 5b: bypass_clicks table
-- Tracks warning-page bypass clicks for false-positive analysis.
-- No second-granular timestamps; ASN is not personally identifiable.
-- Populated by handleWarningProceed via ctx.waitUntil (non-blocking).

CREATE TABLE IF NOT EXISTS bypass_clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  short_code  TEXT    NOT NULL,
  asn         TEXT,            -- e.g. "AS3320" — not personally identifiable
  hour_bucket TEXT    NOT NULL -- strftime('%Y-%m-%d %H', 'now'), e.g. "2026-05-01 13"
);

CREATE INDEX IF NOT EXISTS idx_bypass_clicks_code_hour
  ON bypass_clicks(short_code, hour_bucket);
