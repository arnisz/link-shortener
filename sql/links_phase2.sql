-- Phase 2: add link expiration and active/inactive state
ALTER TABLE links ADD COLUMN expires_at TEXT;
ALTER TABLE links ADD COLUMN is_active  INTEGER NOT NULL DEFAULT 1;

