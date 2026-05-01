-- Migration: Erweiterung der links-Tabelle für Wächter-Integration
ALTER TABLE links ADD COLUMN checked         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN spam_score      REAL    NOT NULL DEFAULT 0.0;
ALTER TABLE links ADD COLUMN status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','warning','blocked'));
ALTER TABLE links ADD COLUMN last_checked_at TEXT;
ALTER TABLE links ADD COLUMN claimed_at      TEXT;
ALTER TABLE links ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_links_scan_queue ON links(checked, last_checked_at, claimed_at);

