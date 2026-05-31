ALTER TABLE links ADD COLUMN abuse_flag_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE abuse_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  asn TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  UNIQUE(link_id, asn)
);

CREATE INDEX idx_abuse_reports_link ON abuse_reports(link_id);
