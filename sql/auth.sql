CREATE TABLE IF NOT EXISTS users (
									 id TEXT PRIMARY KEY,
	                                 google_sub TEXT NOT NULL UNIQUE,
	                                 email TEXT NOT NULL,
	                                 name TEXT,
	                                 avatar_url TEXT,
	                                 created_at TEXT NOT NULL,
	                                 last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
										id TEXT PRIMARY KEY,
	                                    user_id TEXT NOT NULL,
	                                    expires_at TEXT NOT NULL,
	                                    created_at TEXT NOT NULL,
	                                    FOREIGN KEY (user_id) REFERENCES users(id)
	);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
