-- Analytics table für datenschutzkonforme Klick-Erfassung (DSGVO)
-- Speichert aggregierte Klick-Metriken, KEINE persönlichen Daten (IP, UA, full URL)
CREATE TABLE IF NOT EXISTS clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  link_id    TEXT NOT NULL,
  user_id    TEXT,
  country    TEXT,
  asn        INTEGER,
  asn_org    TEXT,
  referrer_host TEXT,
  FOREIGN KEY(link_id) REFERENCES links(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_user_id ON clicks(user_id);
