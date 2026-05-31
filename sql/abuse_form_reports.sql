CREATE TABLE abuse_form_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip          TEXT NOT NULL,          -- volle IP des Melders (Missbrauchsabwehr, max. ~4 Tage)
  reported_at TEXT NOT NULL,          -- ISO-8601 mit ms + Z (Worker-geschrieben)
  short_code  TEXT,                   -- aufgelöster Code bei Treffer, NULL bei keinem Match
  raw_input   TEXT NOT NULL           -- roher Melder-Input (gecappt), für Review
);
CREATE INDEX idx_abuse_form_reports_reported_at ON abuse_form_reports(reported_at);
