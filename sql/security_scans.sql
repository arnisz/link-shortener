-- Migration: Audit-Trail für Provider-Scans (Wächter)
CREATE TABLE security_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id      TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  raw_score    REAL NOT NULL,
  raw_response TEXT,
  scanned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scans_link ON security_scans(link_id, scanned_at DESC);

