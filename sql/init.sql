CREATE TABLE IF NOT EXISTS counters (
										name TEXT PRIMARY KEY,
	                                    value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value)
VALUES ('hello', 0);
