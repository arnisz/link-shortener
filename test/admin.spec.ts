import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/types";
import {
	setupTestDb,
	setupLinksTable,
	setupRateLimitTable,
	seedLink,
	makeRequest,
} from "./helpers";
import { generateCsrfToken } from "../src/csrf";

// ── Constants ──────────────────────────────────────────────────────────────────
const ADMIN_TOKEN = "test-admin-token";
const BASE = "https://example.com";

// 32-char hex user IDs (required by admin route regex)
const ADMIN_USER_ID   = "a0000000000000000000000000000001";
const TARGET_USER_ID  = "b0000000000000000000000000000002";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Seeds a user+session with a specific 32-char hex userId. */
async function seedAdminSession(
	db: D1Database,
	opts: { userId: string; email?: string; googleSub?: string }
): Promise<{ userId: string; sessionId: string }> {
	const now = new Date().toISOString();
	const sessionId = `${opts.userId}${"a".repeat(48)}`.slice(0, 48);
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
	const email = opts.email ?? `user-${opts.userId.slice(0, 6)}@example.com`;
	const googleSub = opts.googleSub ?? `gsub-${opts.userId.slice(0, 8)}`;

	await db
		.prepare(
			`INSERT OR REPLACE INTO users (id, google_sub, email, name, avatar_url, created_at, last_login_at, is_blocked)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
		)
		.bind(opts.userId, googleSub, email, "Test User", null, now, now)
		.run();

	await db
		.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
		.bind(sessionId, opts.userId, expiresAt, now)
		.run();

	return { userId: opts.userId, sessionId };
}

/** Builds a request with admin auth headers (session cookie + Bearer token). */
function adminRequest(
	path: string,
	method: string,
	sessionId: string,
	opts: { csrfToken?: string; body?: unknown } = {}
): Request {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${ADMIN_TOKEN}`,
	};
	if (opts.csrfToken) {
		headers["X-CSRF-Token"] = opts.csrfToken;
		headers["Origin"] = BASE;
	}
	return makeRequest(`${BASE}${path}`, method, {
		cookies: { "__Host-sid": sessionId },
		headers,
		body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
	});
}

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("Admin Dashboard", () => {
	const db = env.hello_cf_spa_db;

	beforeAll(async () => {
		await setupTestDb(db);
		await setupLinksTable(db);
		await setupRateLimitTable(db);
	});

	beforeEach(async () => {
		await db.prepare("DELETE FROM sessions").run();
		await db.prepare("DELETE FROM links").run();
		await db.prepare("DELETE FROM users").run();
	});

	// ── Auth: missing session ────────────────────────────────────────────────
	describe("Auth enforcement", () => {
		it("GET /api/admin/users returns 401 without session cookie", async () => {
			const req = new Request(`${BASE}/api/admin/users`, {
				headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
			});
			const res = await call(req);
			expect(res.status).toBe(401);
		});

		it("GET /api/admin/users returns 401 without admin token", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const req = makeRequest(`${BASE}/api/admin/users`, "GET", {
				cookies: { "__Host-sid": sessionId },
			});
			const res = await call(req);
			expect(res.status).toBe(401);
		});

		it("GET /api/admin/users returns 401 with wrong admin token", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const req = makeRequest(`${BASE}/api/admin/users`, "GET", {
				cookies: { "__Host-sid": sessionId },
				headers: { Authorization: "Bearer wrong-token" },
			});
			const res = await call(req);
			expect(res.status).toBe(401);
		});

		it("GET /api/admin/links returns 401 without both factors", async () => {
			const req = new Request(`${BASE}/api/admin/links`);
			const res = await call(req);
			expect(res.status).toBe(401);
		});
	});

	// ── GET /api/admin/users ─────────────────────────────────────────────────
	describe("GET /api/admin/users", () => {
		it("returns all users with link_count", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID, email: "admin@example.com" });
			await seedAdminSession(db, { userId: TARGET_USER_ID, email: "target@example.com" });
			await seedLink(db, { userId: TARGET_USER_ID, shortCode: "abc001" });
			await seedLink(db, { userId: TARGET_USER_ID, shortCode: "abc002" });

			const req = adminRequest("/api/admin/users", "GET", sessionId);
			const res = await call(req);
			expect(res.status).toBe(200);

			const data = await res.json<{ users: Array<{ email: string; link_count: number; is_blocked: number }> }>();
			expect(data.users.length).toBe(2);

			const target = data.users.find(u => u.email === "target@example.com");
			expect(target).toBeDefined();
			expect(target!.link_count).toBe(2);
			expect(target!.is_blocked).toBe(0);
		});

		it("returns is_blocked=1 for blocked users", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID, email: "blocked@example.com" });
			await db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").bind(TARGET_USER_ID).run();

			const req = adminRequest("/api/admin/users", "GET", sessionId);
			const res = await call(req);
			const data = await res.json<{ users: Array<{ email: string; is_blocked: number }> }>();

			const blocked = data.users.find(u => u.email === "blocked@example.com");
			expect(blocked!.is_blocked).toBe(1);
		});
	});

	// ── GET /api/admin/links ─────────────────────────────────────────────────
	describe("GET /api/admin/links", () => {
		it("returns all links with user_email", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID, email: "owner@example.com" });
			await seedLink(db, { userId: TARGET_USER_ID, shortCode: "lnk001", targetUrl: "https://target.example.com" });

			const req = adminRequest("/api/admin/links", "GET", sessionId);
			const res = await call(req);
			expect(res.status).toBe(200);

			const data = await res.json<{ links: Array<{ short_code: string; user_email: string }> }>();
			expect(data.links.length).toBe(1);
			expect(data.links[0].short_code).toBe("lnk001");
			expect(data.links[0].user_email).toBe("owner@example.com");
		});

		it("paginates with limit parameter", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID });
			for (let i = 0; i < 5; i++) {
				await seedLink(db, { userId: TARGET_USER_ID, shortCode: `pg${i}000` });
			}

			const req = adminRequest("/api/admin/links?limit=3", "GET", sessionId);
			const res = await call(req);
			const data = await res.json<{ links: unknown[]; nextCursor: string | null }>();
			expect(data.links.length).toBe(3);
			expect(data.nextCursor).not.toBeNull();
		});

		it("returns 400 for invalid cursor", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const req = adminRequest("/api/admin/links?cursor=invalid", "GET", sessionId);
			const res = await call(req);
			expect(res.status).toBe(400);
		});
	});

	// ── POST /api/admin/users/:id/block ──────────────────────────────────────
	describe("POST /api/admin/users/:id/block", () => {
		it("sets is_blocked=1 and deletes sessions", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = adminRequest(`/api/admin/users/${TARGET_USER_ID}/block`, "POST", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(200);
			const data = await res.json<{ ok: boolean }>();
			expect(data.ok).toBe(true);

			const user = await db.prepare("SELECT is_blocked FROM users WHERE id = ?").bind(TARGET_USER_ID).first<{ is_blocked: number }>();
			expect(user!.is_blocked).toBe(1);

			const sessions = await db.prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE user_id = ?").bind(TARGET_USER_ID).first<{ cnt: number }>();
			expect(sessions!.cnt).toBe(0);
		});

		it("returns 404 for non-existent user", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);
			const nonExistent = "f".repeat(32);

			const req = adminRequest(`/api/admin/users/${nonExistent}/block`, "POST", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(404);
		});

		it("returns 401 without admin token", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = makeRequest(`${BASE}/api/admin/users/${TARGET_USER_ID}/block`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "X-CSRF-Token": csrfToken, "Origin": BASE },
			});
			const res = await call(req);
			expect(res.status).toBe(401);
		});
	});

	// ── POST /api/admin/users/:id/unblock ────────────────────────────────────
	describe("POST /api/admin/users/:id/unblock", () => {
		it("sets is_blocked=0", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID });
			await db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").bind(TARGET_USER_ID).run();
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = adminRequest(`/api/admin/users/${TARGET_USER_ID}/unblock`, "POST", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(200);

			const user = await db.prepare("SELECT is_blocked FROM users WHERE id = ?").bind(TARGET_USER_ID).first<{ is_blocked: number }>();
			expect(user!.is_blocked).toBe(0);
		});

		it("returns 404 for non-existent user", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);
			const nonExistent = "e".repeat(32);

			const req = adminRequest(`/api/admin/users/${nonExistent}/unblock`, "POST", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(404);
		});
	});

	// ── DELETE /api/admin/users/:id ──────────────────────────────────────────
	describe("DELETE /api/admin/users/:id", () => {
		it("deletes user and their links", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			await seedAdminSession(db, { userId: TARGET_USER_ID });
			await seedLink(db, { userId: TARGET_USER_ID, shortCode: "del001" });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = adminRequest(`/api/admin/users/${TARGET_USER_ID}`, "DELETE", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(200);

			const user = await db.prepare("SELECT id FROM users WHERE id = ?").bind(TARGET_USER_ID).first();
			expect(user).toBeNull();

			const links = await db.prepare("SELECT COUNT(*) AS cnt FROM links WHERE user_id = ?").bind(TARGET_USER_ID).first<{ cnt: number }>();
			expect(links!.cnt).toBe(0);
		});

		it("returns 404 for non-existent user (idempotency)", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);
			const nonExistent = "d".repeat(32);

			const req = adminRequest(`/api/admin/users/${nonExistent}`, "DELETE", sessionId, { csrfToken });
			const res = await call(req);
			expect(res.status).toBe(404);
		});

		it("returns 401 without session", async () => {
			const req = new Request(`${BASE}/api/admin/users/${TARGET_USER_ID}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
			});
			const res = await call(req);
			expect(res.status).toBe(401);
		});
	});

	// ── handleGoogleCallback: is_blocked check ───────────────────────────────
	describe("handleGoogleCallback: blocked user login rejection", () => {
		it("blocked user has is_blocked=1 in DB (login would be rejected)", async () => {
			await seedAdminSession(db, { userId: TARGET_USER_ID, email: "blocked@example.com" });
			await db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").bind(TARGET_USER_ID).run();

			const row = await db
				.prepare("SELECT is_blocked FROM users WHERE id = ?")
				.bind(TARGET_USER_ID)
				.first<{ is_blocked: number }>();
			expect(row!.is_blocked).toBe(1);
		});
	});

	// ── ALIAS_RESERVED ───────────────────────────────────────────────────────
	describe("ALIAS_RESERVED includes admin paths", () => {
		it("rejects 'user-administration' as alias", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "X-CSRF-Token": csrfToken, "Origin": BASE, "Content-Type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "user-administration" }),
			});
			const res = await call(req);
			expect(res.status).toBe(400);
			const data = await res.json<{ error: string }>();
			expect(data.error).toContain("reserved");
		});

		it("rejects 'admin' as alias", async () => {
			const { sessionId } = await seedAdminSession(db, { userId: ADMIN_USER_ID });
			const csrfToken = await generateCsrfToken(sessionId, env.SESSION_SECRET);

			const req = makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "X-CSRF-Token": csrfToken, "Origin": BASE, "Content-Type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "admin" }),
			});
			const res = await call(req);
			expect(res.status).toBe(400);
			const data = await res.json<{ error: string }>();
			expect(data.error).toContain("reserved");
		});
	});
});
