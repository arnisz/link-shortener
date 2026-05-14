-- Admin-Dashboard: is_blocked flag for users
ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_users_is_blocked ON users(is_blocked) WHERE is_blocked = 1;
