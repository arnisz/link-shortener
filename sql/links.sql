CREATE TABLE IF NOT EXISTS links (
	id          TEXT    PRIMARY KEY,
	user_id     TEXT    NOT NULL,
	short_code  TEXT    NOT NULL UNIQUE,
	target_url  TEXT    NOT NULL,
	title       TEXT,
	created_at  TEXT    NOT NULL,
	updated_at  TEXT    NOT NULL,
	click_count INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_links_user_id    ON links(user_id);
CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code);

