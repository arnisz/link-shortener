/**
 * Shared test utilities.
 * Keep this small – only what is actually used by the test suite.
 */

// ── Fake Google ID-Token ──────────────────────────────────────────────────────

/**
 * Builds a syntactically valid (but cryptographically unsigned) Google ID
 * token that parseGoogleIdToken() in src/auth/google.ts can decode.
 * The signature segment is a fixed placeholder – it is never verified in the
 * worker code, only the payload is used.
 */
export function buildFakeIdToken(payload: Record<string, unknown>, headerOverrides: Record<string, unknown> = {}): string {
	const encode = (obj: unknown) =>
		btoa(JSON.stringify(obj))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	const header = encode({ alg: "RS256", typ: "JWT", kid: "test-kid", ...headerOverrides });
	const body = encode(payload);
	return `${header}.${body}.fakesig`;
}

// ── Request builder ───────────────────────────────────────────────────────────

/**
 * Creates a Request with optional cookies / extra headers / body.
 */
export function makeRequest(
	url: string,
	method = "GET",
	opts: {
		cookies?: Record<string, string>;
		body?: BodyInit;
		headers?: Record<string, string>;
	} = {}
): Request {
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };

	if (opts.cookies && Object.keys(opts.cookies).length > 0) {
		headers["Cookie"] = Object.entries(opts.cookies)
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
	}

	return new Request(url, { method, headers, body: opts.body });
}

// ── D1 test database setup ────────────────────────────────────────────────────

/**
 * Applies the auth.sql migrations to a test D1 database.
 * Each statement is executed individually to stay compatible with
 * every miniflare D1 version.
 */
export async function setupTestDb(db: D1Database): Promise<void> {

	// ── users (auth.sql) ──
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (` +
			`id TEXT PRIMARY KEY, ` +
			`google_sub TEXT NOT NULL UNIQUE, ` +
			`email TEXT NOT NULL, ` +
			`name TEXT, ` +
			`avatar_url TEXT, ` +
			`created_at TEXT NOT NULL, ` +
			`last_login_at TEXT NOT NULL)`
		)
		.run();

	// ── sessions (auth.sql) ──
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS sessions (` +
			`id TEXT PRIMARY KEY, ` +
			`user_id TEXT NOT NULL, ` +
			`expires_at TEXT NOT NULL, ` +
			`created_at TEXT NOT NULL, ` +
			`FOREIGN KEY (user_id) REFERENCES users(id))`
		)
		.run();

	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`)
		.run();
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`)
		.run();
}

// ── Session seeder ────────────────────────────────────────────────────────────

/**
 * Inserts a user + a valid (non-expired) session into the test DB.
 * Returns the sessionId that can be used as a `sid` cookie value.
 */
export async function seedSession(
	db: D1Database,
	opts: { userId?: string; email?: string; googleSub?: string } = {}
): Promise<{ userId: string; sessionId: string }> {
	const userId = opts.userId ?? "test-user-001";
	const googleSub = opts.googleSub ?? "google-sub-001";
	const email = opts.email ?? "test@example.com";
	const now = new Date().toISOString();
	const sessionId = `test-session-${userId}`;
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

	await db
		.prepare(
			`INSERT OR REPLACE INTO users
			 (id, google_sub, email, name, avatar_url, created_at, last_login_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(userId, googleSub, email, "Test User", null, now, now)
		.run();

	await db
		.prepare(
			`INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at)
			 VALUES (?, ?, ?, ?)`
		)
		.bind(sessionId, userId, expiresAt, now)
		.run();

	return { userId, sessionId };
}

// ── Links table setup ─────────────────────────────────────────────────────────

/**
 * Creates the `links` table (and its indexes) in the test D1 database.
 * Call this once in beforeAll alongside setupTestDb().
 */
export async function setupLinksTable(db: D1Database): Promise<void> {
			 await db
			   .prepare(
				 `CREATE TABLE IF NOT EXISTS links (` +
				 `id TEXT PRIMARY KEY, ` +
				 `user_id TEXT, ` + // nullable: NULL for anonymous links
				 `short_code TEXT NOT NULL UNIQUE, ` +
				 `target_url TEXT NOT NULL, ` +
				 `title TEXT, ` +
				 `created_at TEXT NOT NULL, ` +
				 `updated_at TEXT NOT NULL, ` +
				 `click_count INTEGER NOT NULL DEFAULT 0, ` +
				 `expires_at TEXT, ` +
				 `is_active INTEGER NOT NULL DEFAULT 1, ` +
				 `FOREIGN KEY (user_id) REFERENCES users(id))`
			   )
			   .run();
			 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id)`).run();
			 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code)`).run();

			 // Migration: links_phase6_security.sql (Wächter-Spalten und Index)
			 await db.prepare(`ALTER TABLE links ADD COLUMN checked INTEGER NOT NULL DEFAULT 0`).run();
			 await db.prepare(`ALTER TABLE links ADD COLUMN spam_score REAL NOT NULL DEFAULT 0.0`).run();
			 await db.prepare(`ALTER TABLE links ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','warning','blocked'))`).run();
			 await db.prepare(`ALTER TABLE links ADD COLUMN last_checked_at TEXT`).run();
			 await db.prepare(`ALTER TABLE links ADD COLUMN claimed_at TEXT`).run();
			 await db.prepare(`ALTER TABLE links ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0`).run();
			 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_links_scan_queue ON links(checked, last_checked_at, claimed_at)`).run();
}

/**
 * Creates the tags and link_tags tables in the test D1 database.
 */
export async function setupTagsTables(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS tags (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ` +
			`name TEXT NOT NULL, ` +
			`created_at TEXT NOT NULL DEFAULT (datetime('now')), ` +
			`UNIQUE(user_id, name))`
		)
		.run();

	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id)`)
		.run();

	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS link_tags (` +
			`link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, ` +
			`tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, ` +
			`user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ` +
			`PRIMARY KEY (link_id, tag_id))`
		)
		.run();

	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_link_tags_user ON link_tags(user_id)`)
		.run();
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_link_tags_tag ON link_tags(tag_id)`)
		.run();
}

/**
 * Inserts a link row for testing. Returns its id and shortCode.
 */
export async function seedLink(
	db: D1Database,
	opts: {
		userId: string;
		shortCode?: string;
		targetUrl?: string;
		title?: string | null;
		isActive?: number;
		expiresAt?: string | null;
		// Phase 6 (Wächter)
		checked?: number;
		status?: string;
		manualOverride?: number;
		claimedAt?: string | null;
	}
): Promise<{ id: string; shortCode: string }> {
	const id = `link-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const shortCode = opts.shortCode ?? "abc123";
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active, checked, status, manual_override, claimed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			opts.userId,
			shortCode,
			opts.targetUrl ?? "https://example.com",
			opts.title ?? null,
			now,
			now,
			opts.expiresAt ?? null,
			opts.isActive ?? 1,
			opts.checked ?? 0,
			opts.status ?? "active",
			opts.manualOverride ?? 0,
			opts.claimedAt ?? null
		)
		.run();

	return { id, shortCode };
}

// ── Spam filter table setup ───────────────────────────────────────────────────

/**
 * Creates the spam_keywords table and seeds it with test keywords.
 */
export async function setupSpamTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS spam_keywords (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`keyword TEXT NOT NULL UNIQUE COLLATE NOCASE, ` +
			`created_at TEXT NOT NULL DEFAULT (datetime('now')))`
		)
		.run();

	const keywords = ["sex", "porn", "viagra", "casino", "crypto", "free-money", "OnlyFans", "nude", "xxx"];
	for (const kw of keywords) {
		await db
			.prepare("INSERT OR IGNORE INTO spam_keywords (keyword) VALUES (?)")
			.bind(kw)
			.run();
	}
}

// ── Rate limit table setup ────────────────────────────────────────────────────

/**
 * Creates the rate_limits table used by the anonymous link endpoint.
 */
export async function setupRateLimitTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS rate_limits (` +
			`ip TEXT NOT NULL, ` +
			`window_start TEXT NOT NULL, ` +
			`count INTEGER NOT NULL DEFAULT 0, ` +
			`PRIMARY KEY (ip, window_start))`
		)
		.run();
}

/**
 * Creates the clicks table (Phase 5).
 */
export async function setupClicksTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS clicks (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`ts INTEGER NOT NULL, ` +
			`link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, ` +
			`user_id TEXT, ` +
			`country TEXT, ` +
			`asn INTEGER, ` +
			`asn_org TEXT, ` +
			`referrer_host TEXT, ` +
			`FOREIGN KEY (user_id) REFERENCES users(id))`
		)
		.run();
	await db.prepare(`CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id)`).run();
}

/**
 * Creates the security_scans table in the test D1 database.
 */
export async function setupSecurityScansTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS security_scans (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE, ` +
			`provider TEXT NOT NULL, ` +
			`raw_score REAL NOT NULL, ` +
			`raw_response TEXT, ` +
			`scanned_at TEXT NOT NULL DEFAULT (datetime('now')))`
		)
		.run();
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_scans_link ON security_scans(link_id, scanned_at DESC)`)
		.run();
}

/**
 * Creates the bypass_clicks table in the test D1 database (Phase 5b).
 */
export async function setupBypassClicksTable(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS bypass_clicks (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`short_code TEXT NOT NULL, ` +
			`asn TEXT, ` +
			`hour_bucket TEXT NOT NULL)`
		)
		.run();
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_bypass_clicks_code_hour ON bypass_clicks(short_code, hour_bucket)`)
		.run();
}

/**
 * Typ des In-Memory-KV-Mocks (für Test-Isolation via reset()).
 */
export type LinksKvMock = ReturnType<typeof createLinksKvMock>;

/**
 * Erstellt einen einfachen In-Memory-Mock für den Cloudflare KV-Namespace.
 * Wird in den Tests als env.LINKS_KV verwendet.
 */
export function createLinksKvMock() {
	const store = new Map<string, string>();
	return {
		async get(key: string) {
			return store.has(key) ? store.get(key)! : null;
		},
		async put(key: string, value: string, opts?: { expirationTtl?: number }) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list() {
			return { keys: Array.from(store.keys()).map(k => ({ name: k })), list_complete: true, cursor: "" };
		},
		async getWithMetadata(key: string) {
			const val = store.get(key);
			return { value: val === undefined ? null : val, metadata: null };
		},
		reset() {
			store.clear();
		},
	};
}
