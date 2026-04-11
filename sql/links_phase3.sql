-- Make user_id nullable in links table to support anonymous link creation.
-- SQLite does not support ALTER COLUMN, so the table must be recreated.
PRAGMA foreign_keys = OFF;

CREATE TABLE links_v3 (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  short_code TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  click_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO links_v3 SELECT * FROM links;

DROP TABLE links;

ALTER TABLE links_v3 RENAME TO links;

CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code);

PRAGMA foreign_keys = ON;
