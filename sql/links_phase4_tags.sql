-- tags: pro User unique
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id);

-- Junction: link ↔ tag, immer im Userkontext
CREATE TABLE IF NOT EXISTS link_tags (
  link_id TEXT    NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  user_id TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_link_tags_user ON link_tags(user_id);
CREATE INDEX IF NOT EXISTS idx_link_tags_tag  ON link_tags(tag_id);
