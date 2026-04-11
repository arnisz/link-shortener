CREATE TABLE IF NOT EXISTS spam_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO spam_keywords (keyword) VALUES
  ('sex'), ('porn'), ('viagra'), ('casino'), ('crypto'),
  ('free-money'), ('OnlyFans'), ('nude'), ('xxx');
