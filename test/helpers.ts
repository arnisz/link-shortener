/**
 * Shared test utilities.
 * Keep this small – only what is actually used by the test suite.
 */

// ── Fake Google ID-Token ──────────────────────────────────────────────────────

/**
 * Builds a syntactically valid (but cryptographically unsigned) Google ID
 * token that parseGoogleIdToken() in src/index.ts can decode.
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
 * Applies the two SQL migration files (init.sql + auth.sql) to a test D1
 * database.  Each statement is executed individually to stay compatible with
 * every miniflare D1 version.
 */
export async function setupTestDb(db: D1Database): Promise<void> {
	// ── counters (init.sql) ──
	// Note: db.prepare().run() is used instead of db.exec() because miniflare's
	// exec() parser processes SQL line-by-line, which breaks multi-line statements.
	await db
		.prepare(`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`)
		.run();
	await db
		.prepare(`INSERT OR IGNORE INTO counters (name, value) VALUES ('hello', 0)`)
		.run();

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
			`user_id TEXT NOT NULL, ` +
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
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_links_user_id ON links(user_id)`)
		.run();
	await db
		.prepare(`CREATE INDEX IF NOT EXISTS idx_links_short_code ON links(short_code)`)
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
	}
): Promise<{ id: string; shortCode: string }> {
	const id = `link-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const shortCode = opts.shortCode ?? "abc123";
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
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
			opts.isActive ?? 1
		)
		.run();

	return { id, shortCode };
}

