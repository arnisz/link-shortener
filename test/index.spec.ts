/**
 * Safety-net test suite for the current worker behaviour.
 *
 * Covers:
 *   /api/me                        – unauthenticated + authenticated
 *   POST /logout                   – redirect, cleared cookie, DB session deleted
 *   unknown route                  – 404
 *   GET /api/auth/google/callback  – bad state variants → 400
 *                                    valid mocked exchange → session + redirect
 */
import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import {
	describe,
	it,
	expect,
	beforeAll,
	beforeEach,
	afterEach,
	vi,
} from "vitest";
import worker from "../src/index";
import { makeRequest, buildFakeIdToken, setupTestDb, seedSession, setupLinksTable, seedLink, setupRateLimitTable, setupTagsTables } from "./helpers";

const BASE = "https://example.com";

// ── One-time schema migration ─────────────────────────────────────────────────

beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
});

// ── Clean DB state before every test ─────────────────────────────────────────

beforeEach(async () => {
	await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM sessions").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM users").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
});

// ── Tiny helper: call the worker and wait for ctx ─────────────────────────────

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}


// ─────────────────────────────────────────────────────────────────────────────
// /api/me
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/me", () => {
	it("returns authenticated:false when no session cookie is present", async () => {
		const res = await call(makeRequest(`${BASE}/api/me`));
		expect(res.status).toBe(200);
		const data = await res.json<{ authenticated: boolean }>();
		expect(data.authenticated).toBe(false);
	});

	it("returns authenticated:true with a valid session cookie", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/me`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<{
			authenticated: boolean;
			user: { email: string };
		}>();
		expect(data.authenticated).toBe(true);
		expect(data.user.email).toBe("test@example.com");
	});

	it("returns authenticated:false when the session cookie is unknown", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/me`, "GET", { cookies: { "__Host-sid": "not-a-real-session" } })
		);
		const data = await res.json<{ authenticated: boolean }>();
		expect(data.authenticated).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /logout
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /logout", () => {
	it("redirects to / with status 302", async () => {
		const res = await call(makeRequest(`${BASE}/logout`, "POST"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
	});

	it("clears the session cookie (Max-Age=0)", async () => {
		const res = await call(makeRequest(`${BASE}/logout`, "POST"));
		const cookie = res.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/(__Host-sid=|sid=)/);
		expect(cookie).toContain("Max-Age=0");
	});

	it("deletes the session row from the DB", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);

		await call(
			makeRequest(`${BASE}/logout`, "POST", { cookies: { "__Host-sid": sessionId } })
		);

		const row = await env.hello_cf_spa_db
			.prepare("SELECT id FROM sessions WHERE id = ?")
			.bind(sessionId)
			.first();

		expect(row).toBeNull();
	});

	it("redirects even when no session cookie is sent", async () => {
		const res = await call(makeRequest(`${BASE}/logout`, "POST"));
		expect(res.status).toBe(302);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Unknown routes
// ─────────────────────────────────────────────────────────────────────────────

describe("unknown route", () => {
	it("returns 404 for an unregistered path", async () => {
		const res = await call(makeRequest(`${BASE}/does-not-exist`));
		expect(res.status).toBe(404);
	});
});

describe("method enforcement for GET endpoints", () => {

	it("returns 404 for POST /api/me", async () => {
		const res = await call(makeRequest(`${BASE}/api/me`, "POST"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for POST /login", async () => {
		const res = await call(makeRequest(`${BASE}/login`, "POST"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for POST /api/auth/google/callback", async () => {
		const res = await call(makeRequest(`${BASE}/api/auth/google/callback`, "POST"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for POST /r/:code", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "redir-post", targetUrl: "https://example.com" });
		const res = await call(makeRequest(`${BASE}/r/redir-post`, "POST"));
		expect(res.status).toBe(404);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/google/callback
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/auth/google/callback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── Invalid-state variants ──────────────────────────────────────────────

	it("returns 400 when the state query param is missing", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/auth/google/callback?code=abc`, "GET", {
				cookies: { oauth_state: "s", oauth_nonce: "n" },
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when state param does not match the cookie", async () => {
		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=WRONG`,
				"GET",
				{ cookies: { oauth_state: "correct", oauth_nonce: "n" } }
			)
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when the oauth_state cookie is missing", async () => {
		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=mystate`,
				"GET",
				{ cookies: { oauth_nonce: "n" } } // oauth_state cookie intentionally absent
			)
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when the oauth_nonce cookie is missing", async () => {
		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=s`,
				"GET",
				{ cookies: { oauth_state: "s" } } // oauth_nonce cookie intentionally absent
			)
		);
		expect(res.status).toBe(400);
	});

	// ── Happy path: mocked Google token exchange ────────────────────────────

	it("creates a session and redirects to /app.html on a valid exchange", async () => {
		// Build an id_token whose aud and nonce match the test bindings / cookie
		const idToken = buildFakeIdToken({
			iss: "https://accounts.google.com",
			aud: env.GOOGLE_CLIENT_ID, // "test-google-client-id" from vitest.config.mts
			sub: "google-sub-callback-001",
			email: "callback-user@example.com",
			email_verified: true,
			name: "Callback User",
			nonce: "validnonce", // must match the oauth_nonce cookie below
			exp: Math.floor(Date.now() / 1000) + 3600,
			iat: Math.floor(Date.now() / 1000),
		});

		// Mock the outbound fetch to Google's token endpoint
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(
					JSON.stringify({ id_token: idToken, access_token: "fake-access-token" }),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			if (url === "https://www.googleapis.com/oauth2/v3/certs") {
				return new Response(
					JSON.stringify({
						keys: [{
							kid: "test-kid",
							n: "unused",
							e: "unused",
							kty: "RSA",
							alg: "RS256",
							use: "sig"
						}]
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			return new Response("Not found", { status: 404 });
		});

		// Also mock crypto.subtle.importKey and crypto.subtle.verify to bypass real signature check
		vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as any);
		vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true);

		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=auth-code-123&state=validstate`,
				"GET",
				{ cookies: { oauth_state: "validstate", oauth_nonce: "validnonce" } }
			)
		);

		// Should redirect to the app
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/app.html");

		// Should set a non-empty sid cookie with a positive Max-Age
		const setCookies = res.headers.getAll("set-cookie");
		// 🔴 SICHERHEIT: Suche nach __Host-sid (neuer Cookie-Name mit __Host--Präfix)
		const sidCookie = setCookies.find((c) => c.startsWith("__Host-sid=")) ?? setCookies.find((c) => c.startsWith("sid="));
		expect(sidCookie).toBeDefined();
		expect(sidCookie).toContain("Max-Age=");

		// The sid value itself must not be empty
		const sidValue = sidCookie!.split(";")[0].split("=")[1];
		expect(sidValue.length).toBeGreaterThan(0);

		// The session must have been persisted to D1
		const session = await env.hello_cf_spa_db
			.prepare("SELECT id FROM sessions WHERE id = ?")
			.bind(sidValue)
			.first<{ id: string }>();
		expect(session).not.toBeNull();
	});

	it("returns 400 when the nonce in the id_token does not match the cookie", async () => {
		const idToken = buildFakeIdToken({
			iss: "https://accounts.google.com",
			aud: env.GOOGLE_CLIENT_ID,
			sub: "google-sub-nonce-mismatch",
			email: "nonce-mismatch@example.com",
			email_verified: true,
			nonce: "WRONG-NONCE", // deliberately different from the cookie below
			exp: Math.floor(Date.now() / 1000) + 3600,
			iat: Math.floor(Date.now() / 1000),
		});

		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(
					JSON.stringify({ id_token: idToken, access_token: "fake-access-token" }),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			if (url === "https://www.googleapis.com/oauth2/v3/certs") {
				return new Response(
					JSON.stringify({
						keys: [{
							kid: "test-kid",
							n: "unused",
							e: "unused",
							kty: "RSA",
							alg: "RS256",
							use: "sig"
						}]
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			return new Response("Not found", { status: 404 });
		});

		vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as any);
		vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true);

		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=auth-code-nonce&state=validstate`,
				"GET",
				{ cookies: { oauth_state: "validstate", oauth_nonce: "validnonce" } }
			)
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when the JWT signature is invalid", async () => {
		const idToken = buildFakeIdToken({
			iss: "https://accounts.google.com",
			aud: env.GOOGLE_CLIENT_ID,
			sub: "google-sub-bad-sig",
			email: "bad-sig@example.com",
			email_verified: true,
			nonce: "validnonce",
			exp: Math.floor(Date.now() / 1000) + 3600,
			iat: Math.floor(Date.now() / 1000),
		});

		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			if (url === "https://oauth2.googleapis.com/token") {
				return new Response(
					JSON.stringify({ id_token: idToken, access_token: "fake-access-token" }),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			if (url === "https://www.googleapis.com/oauth2/v3/certs") {
				return new Response(
					JSON.stringify({
						keys: [{
							kid: "test-kid",
							n: "unused",
							e: "unused",
							kty: "RSA",
							alg: "RS256",
							use: "sig"
						}]
					}),
					{ status: 200, headers: { "content-type": "application/json" } }
				);
			}
			return new Response("Not found", { status: 404 });
		});

		vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as any);
		vi.spyOn(crypto.subtle, "verify").mockResolvedValue(false); // Invalid signature

		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=s`,
				"GET",
				{ cookies: { oauth_state: "s", oauth_nonce: "validnonce" } }
			)
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when the issuer is invalid", async () => {
		const idToken = buildFakeIdToken({
			iss: "https://evil.com",
			aud: env.GOOGLE_CLIENT_ID,
			sub: "google-sub-bad-iss",
			email: "bad-iss@example.com",
			email_verified: true,
			nonce: "validnonce",
			exp: Math.floor(Date.now() / 1000) + 3600,
			iat: Math.floor(Date.now() / 1000),
		});

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id_token: idToken }), { status: 200 })
		);

		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=s`,
				"GET",
				{ cookies: { oauth_state: "s", oauth_nonce: "validnonce" } }
			)
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when email_verified is false", async () => {
		const idToken = buildFakeIdToken({
			iss: "https://accounts.google.com",
			aud: env.GOOGLE_CLIENT_ID,
			sub: "google-sub-unverified",
			email: "unverified@example.com",
			email_verified: false,
			nonce: "validnonce",
			exp: Math.floor(Date.now() / 1000) + 3600,
			iat: Math.floor(Date.now() / 1000),
		});

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ id_token: idToken }), { status: 200 })
		);

		const res = await call(
			makeRequest(
				`${BASE}/api/auth/google/callback?code=abc&state=s`,
				"GET",
				{ cookies: { oauth_state: "s", oauth_nonce: "validnonce" } }
			)
		);
		expect(res.status).toBe(400);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links", () => {
	it("returns 401 when unauthenticated", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com" }),
			})
		);
		expect(res.status).toBe(401);
	});

	it("returns 201 and the created link on a valid authenticated request", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com/page", title: "Test-Link" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{
			short_code: string;
			short_url: string;
			target_url: string;
			title: string;
			click_count: number;
		}>();
		expect(data.short_code).toBeTruthy();
		expect(data.short_url).toContain("/r/");
		expect(data.target_url).toBe("https://example.com/page");
		expect(data.title).toBe("Test-Link");
		expect(data.click_count).toBe(0);
	});

	it("returns 400 when target_url is not a valid HTTP URL", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "not-a-url" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when target_url is missing", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "No URL here" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("persists the link to D1", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://persisted.example.com" }),
			})
		);
		const row = await env.hello_cf_spa_db
			.prepare("SELECT user_id, target_url FROM links WHERE user_id = ?")
			.bind(userId)
			.first<{ user_id: string; target_url: string }>();
		expect(row).not.toBeNull();
		expect(row!.target_url).toBe("https://persisted.example.com");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/links", () => {
	it("returns 401 when unauthenticated", async () => {
		const res = await call(makeRequest(`${BASE}/api/links`));
		expect(res.status).toBe(401);
	});

	it("returns an empty links array when the user has no links", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[]; nextCursor: string | null }>();
		expect(data.links).toEqual([]);
		expect(data.nextCursor).toBeNull();
	});

	it("returns only links belonging to the current user", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const other = await seedSession(env.hello_cf_spa_db, {
			userId: "other-user-002",
			email: "other@example.com",
			googleSub: "google-sub-002",
		});

		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "mine001" });
		await seedLink(env.hello_cf_spa_db, { userId: other.userId, shortCode: "theirs01" });

		const res = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { short_code: string }[]; nextCursor: string | null }>();
		expect(data.links).toHaveLength(1);
		expect(data.links[0].short_code).toBe("mine001");
	});

	it("includes short_url in each result", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "urltest1" });

		const res = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		const data = await res.json<{ links: { short_url: string }[] }>();
		expect(data.links[0].short_url).toContain("/r/urltest1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /r/:code
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /r/:code", () => {
	it("redirects to target_url when the short code exists", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "redir01",
			targetUrl: "https://destination.example.com/path",
		});

		const res = await call(makeRequest(`${BASE}/r/redir01`));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://destination.example.com/path");
	});

	it("returns 404 for an unknown short code", async () => {
		const res = await call(makeRequest(`${BASE}/r/unknown99`));
		expect(res.status).toBe(404);
	});

	it("increments click_count after a redirect", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "clickme1",
		});

		await call(makeRequest(`${BASE}/r/clickme1`));

		const row = await env.hello_cf_spa_db
			.prepare("SELECT click_count FROM links WHERE id = ?")
			.bind(id)
			.first<{ click_count: number }>();
		expect(row?.click_count).toBe(1);
	});

	it("click_count accumulates across multiple redirects", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "clickme2",
		});

		await call(makeRequest(`${BASE}/r/clickme2`));
		await call(makeRequest(`${BASE}/r/clickme2`));
		await call(makeRequest(`${BASE}/r/clickme2`));

		const row = await env.hello_cf_spa_db
			.prepare("SELECT click_count FROM links WHERE id = ?")
			.bind(id)
			.first<{ click_count: number }>();
		expect(row?.click_count).toBe(3);
	});

	// ── Phase 2: is_active + expires_at ────────────────────────────────────

	it("returns 404 for an inactive link", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "inactive1", isActive: 0 });
		const res = await call(makeRequest(`${BASE}/r/inactive1`));
		expect(res.status).toBe(404);
	});

	// MED-2: Einheitlich 404 statt 410 — verhindert Code-Enumeration via Statuscode
	it("returns 404 for an expired link (anti-enumeration)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const pastDate = new Date(Date.now() - 1000 * 60).toISOString();
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "expired1", expiresAt: pastDate });
		const res = await call(makeRequest(`${BASE}/r/expired1`));
		expect(res.status).toBe(404);
	});

	it("does not increment click_count for an inactive link", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "inact-cnt", isActive: 0 });
		await call(makeRequest(`${BASE}/r/inact-cnt`));
		const row = await env.hello_cf_spa_db
			.prepare("SELECT click_count FROM links WHERE id = ?")
			.bind(id)
			.first<{ click_count: number }>();
		expect(row?.click_count).toBe(0);
	});

	it("redirects with a hyphenated alias", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "my-alias",
			targetUrl: "https://aliased.example.com",
		});
		const res = await call(makeRequest(`${BASE}/r/my-alias`));
		expect(res.status).toBe(302);
		// 🔴 SICHERHEIT: validateTargetUrl normalisiert URLs (new URL().href)
		// "https://aliased.example.com" wird zu "https://aliased.example.com/"
		expect(res.headers.get("location")).toBe("https://aliased.example.com/");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links – Phase 2 (alias + expires_at)
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links – Phase 2", () => {
	it("creates a link with a valid alias", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "my-alias" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string; is_active: number; expires_at: null }>();
		expect(data.short_code).toBe("my-alias");
		expect(data.is_active).toBe(1);
		expect(data.expires_at).toBeNull();
	});

	it("returns 409 when the alias is already taken", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "taken-alias" });
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "taken-alias" }),
			})
		);
		expect(res.status).toBe(409);
	});

	it("returns 201 when alias contains uppercase letters", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "BadAlias" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("BadAlias");
	});

	it("returns 400 for a reserved alias", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "api" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when alias is too short (< 3 chars)", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "ab" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a past expires_at", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const past = new Date(Date.now() - 1000).toISOString();
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", expires_at: past }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for an invalid expires_at string", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", expires_at: "not-a-date" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("stores and returns expires_at and is_active on creation", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", expires_at: future }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ expires_at: string; is_active: number }>();
		expect(data.expires_at).toBeTruthy();
		expect(data.is_active).toBe(1);
	});

	// ── Alias normalisation ─────────────────────────────────────────────────

	it("accepts an ASCII-hyphen alias", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "valid-alias" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("valid-alias");
	});

	it("normalises a Unicode dash alias and accepts it", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		// U+2013 EN DASH should be converted to ASCII hyphen → "my-link"
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "my\u2013link" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("my-link");
	});

	it("falls back to auto-generated short code when alias is an empty string", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		// auto-generated codes are not equal to the empty string
		expect(data.short_code.length).toBeGreaterThan(0);
	});

	it("returns 400 when alias is not a string (e.g. a number)", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: 42 }),
			})
		);
		expect(res.status).toBe(400);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links – Phase 2 (new fields in response)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/links – Phase 2", () => {
	it("includes expires_at and is_active in each result", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "fields-test" });

		const res = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		const data = await res.json<{ links: { expires_at: unknown; is_active: unknown }[] }>();
		expect("expires_at" in data.links[0]).toBe(true);
		expect("is_active"  in data.links[0]).toBe(true);
		expect(data.links[0].is_active).toBe(1);
		expect(data.links[0].expires_at).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links/:id/update
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links/:id/update", () => {
	it("returns 401 when unauthenticated", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/links/some-id/update`, "POST", {
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "x" }),
			})
		);
		expect(res.status).toBe(401);
	});

	it("returns 404 when trying to update another user's link", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { sessionId: otherSession } = await seedSession(env.hello_cf_spa_db, {
			userId: "other-user-u01",
			email: "other-u01@example.com",
			googleSub: "google-sub-u01",
		});
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-owner" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": otherSession },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Stolen" }),
			})
		);
		expect(res.status).toBe(404);
	});

	it("returns 400 when the body has nothing to update", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-empty" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			})
		);
		expect(res.status).toBe(400);
	});

	it("updates the title", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-title" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "New Title" }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ title: string }>();
		expect(data.title).toBe("New Title");
	});

	it("deactivates a link (is_active: false)", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-deact" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ is_active: false }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ is_active: number }>();
		expect(data.is_active).toBe(0);
	});

	it("re-activates a previously inactive link", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-react", isActive: 0 });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ is_active: true }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ is_active: number }>();
		expect(data.is_active).toBe(1);
	});

	it("sets expires_at to a future date", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-exp" });
		const future = new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString();

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expires_at: future }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ expires_at: string }>();
		expect(data.expires_at).toBeTruthy();
	});

	it("clears expires_at when set to null", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const past = new Date(Date.now() + 1000 * 60 * 60).toISOString();
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-clrexp", expiresAt: past });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expires_at: null }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ expires_at: null }>();
		expect(data.expires_at).toBeNull();
	});

	it("returns 400 for an invalid expires_at in update", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-badexp" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expires_at: "gestern" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("deactivated link is unreachable via redirect", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-unreach" });

		await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ is_active: false }),
			})
		);
		const redirRes = await call(makeRequest(`${BASE}/r/${shortCode}`));
		expect(redirRes.status).toBe(404);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Content-Type enforcement on write endpoints
// ─────────────────────────────────────────────────────────────────────────────

describe("Content-Type enforcement", () => {
	it("returns 415 for POST /api/links without application/json content-type", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				// deliberately no content-type header
				body: JSON.stringify({ target_url: "https://example.com" }),
			})
		);
		expect(res.status).toBe(415);
	});

	it("returns 415 for POST /api/links/:id/update without application/json content-type", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "ct-upd-test" });
		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				// deliberately no content-type header
				body: JSON.stringify({ title: "test" }),
			})
		);
		expect(res.status).toBe(415);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Input length limits
// ─────────────────────────────────────────────────────────────────────────────

describe("Input length limits on POST /api/links", () => {
	it("returns 400 when target_url exceeds 2000 characters", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		// 20-char prefix + 1990 chars = 2010 > 2000
		const longUrl = "https://example.com/" + "a".repeat(1990);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: longUrl }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when title exceeds 200 characters", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					target_url: "https://example.com",
					title: "t".repeat(201),
				}),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when title exceeds 200 characters in update", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "title-len-upd" });
		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "x".repeat(201) }),
			})
		);
		expect(res.status).toBe(400);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Alias validation regression – specific accepted / rejected values
// Prevents regressions where valid aliases were incorrectly rejected,
// or invalid aliases (e.g. spaces) were silently accepted.
// ─────────────────────────────────────────────────────────────────────────────

describe("Alias validation regression – POST /api/links", () => {

	// ── Valid aliases ─────────────────────────────────────────────────────────

	it('accepts "google3" (lowercase letters + digit)', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "google3" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("google3");
	});

	it('accepts "mein-link" (hyphen)', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "mein-link" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("mein-link");
	});

	it('accepts "mein_link" (underscore)', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "mein_link" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("mein_link");
	});

	// ── Additional accepted aliases (case handling) ───────────────────────────

	it('accepts "Google3" (uppercase letter) with 201', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "Google3" }),
			})
		);
		expect(res.status).toBe(201);
		const data = await res.json<{ short_code: string }>();
		expect(data.short_code).toBe("Google3");
	});

	it('rejects "ab" (too short, < 3 chars) with 400', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "ab" }),
			})
		);
		expect(res.status).toBe(400);
		const data = await res.json<{ error: string }>();
		expect(data.error).toBeTruthy();
	});

	it('rejects "test link" (contains a space) with 400', async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "https://example.com", alias: "test link" }),
			})
		);
		expect(res.status).toBe(400);
		const data = await res.json<{ error: string }>();
		expect(data.error).toBeTruthy();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontend pattern regression (public/app.html)
// Reads the HTML file statically and asserts the pattern attribute value.
// Prevents silent regressions back to the broken pattern variants.
// ─────────────────────────────────────────────────────────────────────────────

describe("Frontend alias pattern regression (app.html)", () => {
	// public/app.html is read at config time (Node.js, no Windows path issues)
	// and injected into the test environment as env.APP_HTML_CONTENT.

	it('uses the correct pattern pattern="[a-zA-Z0-9_-]{3,50}"', () => {
		// Hyphen at the end of a character class is unambiguous and does not
		// need escaping. This matches the backend ALIAS_REGEX validation rule
		// and works correctly in all modern browsers.
		expect(env.APP_HTML_CONTENT).toContain('pattern="[a-zA-Z0-9_-]{3,50}"');
	});

	it('does NOT use the broken escaped-hyphen variant pattern="[a-z0-9_\\-]{3,50}"', () => {
		// This variant caused browser validation errors in Chrome 146+.
		// It has been fixed and should not appear in the HTML.
		expect(env.APP_HTML_CONTENT).not.toContain('pattern="[a-z0-9_\\-]{3,50}"');
	});

	it('does NOT use the hyphen-at-start variant pattern="[-a-z0-9_]{3,50}"', () => {
		// Incorrect ordering; the correct form places hyphen at the end.
		expect(env.APP_HTML_CONTENT).not.toContain('pattern="[-a-z0-9_]{3,50}"');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links/:id/delete
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links/:id/delete", () => {
	it("returns 401 when unauthenticated", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/links/some-id/delete`, "POST")
		);
		expect(res.status).toBe(401);
	});

	it("returns 404 when trying to delete another user's link", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { sessionId: otherSession } = await seedSession(env.hello_cf_spa_db, {
			userId: "other-user-del01",
			email: "other-del01@example.com",
			googleSub: "google-sub-del01",
		});
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "del-owner" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", {
				cookies: { "__Host-sid": otherSession },
			})
		);
		expect(res.status).toBe(404);
	});

	it("deletes the link and returns { ok: true }", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "del-ok" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", {
				cookies: { "__Host-sid": sessionId },
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean }>();
		expect(data.ok).toBe(true);
	});

	it("deleted link is removed from the database", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "del-db" });

		await call(
			makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", {
				cookies: { "__Host-sid": sessionId },
			})
		);

		const row = await env.hello_cf_spa_db
			.prepare("SELECT id FROM links WHERE id = ?")
			.bind(id)
			.first();
		expect(row).toBeNull();
	});

	it("deleted link no longer appears in GET /api/links", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "del-list" });

		await call(
			makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", {
				cookies: { "__Host-sid": sessionId },
			})
		);

		const listRes = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		const data = await listRes.json<{ links: { id: string }[] }>();
		expect(data.links.find(l => l.id === id)).toBeUndefined();
	});

	it("returns 404 when trying to delete an already-deleted link", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "del-twice" });

		await call(makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", { cookies: { "__Host-sid": sessionId } }));
		const second = await call(makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", { cookies: { "__Host-sid": sessionId } }));
		expect(second.status).toBe(404);
	});

	it("deleted link is no longer reachable via redirect", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "del-redir",
			targetUrl: "https://will-be-gone.example.com",
		});

		await call(makeRequest(`${BASE}/api/links/${shortCode}/delete`, "POST", { cookies: { "__Host-sid": sessionId } }));
		const res = await call(makeRequest(`${BASE}/r/${shortCode}`));
		expect(res.status).toBe(404);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links – additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links – additional edge cases", () => {
	it("returns 400 for an ftp:// URL (only http/https accepted)", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target_url: "ftp://files.example.com/file.txt" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for a malformed (non-parseable) JSON body", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: "{not valid json",
			})
		);
		expect(res.status).toBe(400);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links/:id/update – additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links/:id/update – additional edge cases", () => {
	it("returns 400 for a syntactically valid but past ISO date as expires_at", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-pastiso" });
		const past = new Date(Date.now() - 1000 * 60).toISOString(); // 1 minute ago

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expires_at: past }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for an invalid is_active value (non-boolean string)", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-badact" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ is_active: "yes" }),
			})
		);
		expect(res.status).toBe(400);
	});

	it("can update title and is_active together in one request", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const { id, shortCode } = await seedLink(env.hello_cf_spa_db, { userId, shortCode: "upd-multi" });

		const res = await call(
			makeRequest(`${BASE}/api/links/${shortCode}/update`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title: "Multi-Update", is_active: false }),
			})
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ title: string; is_active: number }>();
		expect(data.title).toBe("Multi-Update");
		expect(data.is_active).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /r/:code – additional edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /r/:code – additional edge cases", () => {
	it("redirects a link that has a future expires_at (not yet expired)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const future = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // 24h from now
		await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "notexpired1",
			targetUrl: "https://still-valid.example.com",
			expiresAt: future,
		});

	const res = await call(makeRequest(`${BASE}/r/notexpired1`));
	expect(res.status).toBe(302);
	// 🔴 SICHERHEIT: URL-Normalisierung durch validateTargetUrl
	expect(res.headers.get("location")).toBe("https://still-valid.example.com/");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links – result ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/links – result ordering", () => {
	it("returns links newest-first (by created_at DESC)", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

		// Insert with an explicit 1 ms gap so created_at values differ
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "order-old" });
		await new Promise(r => setTimeout(r, 5));
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "order-new" });

		const res = await call(
			makeRequest(`${BASE}/api/links`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { short_code: string }[] }>();
		expect(data.links).toHaveLength(2);
		expect(data.links[0].short_code).toBe("order-new");
		expect(data.links[1].short_code).toBe("order-old");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/links – cursor-based pagination
// ─────────────────────────────────────────────────────────────────────────────

type LinkPage = { links: { id: string; short_code: string; created_at: string }[]; nextCursor: string | null };

describe("GET /api/links – cursor-based pagination", () => {
	it("nextCursor is null when all results fit in one page", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, { userId, shortCode: "pag-single" });

		const res = await call(
			makeRequest(`${BASE}/api/links?limit=10`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<LinkPage>();
		expect(data.links).toHaveLength(1);
		expect(data.nextCursor).toBeNull();
	});

	it("nextCursor is set when results exceed the limit", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

		// Insert 3 links with distinct created_at values
		for (let i = 0; i < 3; i++) {
			await seedLink(env.hello_cf_spa_db, { userId, shortCode: `pag-over-${i}` });
			await new Promise(r => setTimeout(r, 5));
		}

		const res = await call(
			makeRequest(`${BASE}/api/links?limit=2`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		expect(res.status).toBe(200);
		const data = await res.json<LinkPage>();
		expect(data.links).toHaveLength(2);
		expect(data.nextCursor).not.toBeNull();
	});

	it("cursor fetches the next page without duplicates", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

		// Insert 4 links with distinct created_at values (newest last in loop)
		for (let i = 0; i < 4; i++) {
			await seedLink(env.hello_cf_spa_db, { userId, shortCode: `pag-dup-${i}` });
			await new Promise(r => setTimeout(r, 5));
		}

		// Page 1: 2 links
		const res1 = await call(
			makeRequest(`${BASE}/api/links?limit=2`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		const page1 = await res1.json<LinkPage>();
		expect(page1.links).toHaveLength(2);
		expect(page1.nextCursor).not.toBeNull();

		// Page 2: remaining links using cursor
		const res2 = await call(
			makeRequest(`${BASE}/api/links?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, "GET", {
				cookies: { "__Host-sid": sessionId },
			})
		);
		const page2 = await res2.json<LinkPage>();
		expect(page2.links).toHaveLength(2);
		expect(page2.nextCursor).toBeNull();

		// No overlap between pages
		const ids1 = new Set(page1.links.map(l => l.id));
		for (const l of page2.links) {
			expect(ids1.has(l.id)).toBe(false);
		}

		// Combined ordering: newest first across both pages
		const allCodes = [...page1.links, ...page2.links].map(l => l.short_code);
		expect(allCodes).toEqual(["pag-dup-3", "pag-dup-2", "pag-dup-1", "pag-dup-0"]);
	});

	it("cursor page returns nextCursor=null when it is the final page", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);

		for (let i = 0; i < 3; i++) {
			await seedLink(env.hello_cf_spa_db, { userId, shortCode: `pag-end-${i}` });
			await new Promise(r => setTimeout(r, 5));
		}

		const res1 = await call(
			makeRequest(`${BASE}/api/links?limit=2`, "GET", { cookies: { "__Host-sid": sessionId } })
		);
		const page1 = await res1.json<LinkPage>();
		expect(page1.nextCursor).not.toBeNull();

		const res2 = await call(
			makeRequest(`${BASE}/api/links?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`, "GET", {
				cookies: { "__Host-sid": sessionId },
			})
		);
		const page2 = await res2.json<LinkPage>();
		expect(page2.links).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
	});

	it("cursor isolates results to the authenticated user", async () => {
		const { sessionId, userId } = await seedSession(env.hello_cf_spa_db);
		const other = await seedSession(env.hello_cf_spa_db, {
			userId: "pag-other-user",
			email: "pag-other@example.com",
			googleSub: "pag-other-sub",
		});

		for (let i = 0; i < 3; i++) {
			await seedLink(env.hello_cf_spa_db, { userId, shortCode: `pag-mine-${i}` });
			await seedLink(env.hello_cf_spa_db, { userId: other.userId, shortCode: `pag-theirs-${i}` });
			await new Promise(r => setTimeout(r, 5));
		}

		// Fetch all pages for the current user
		let cursor: string | null = null;
		const allLinks: { short_code: string }[] = [];
		do {
			const url = cursor
				? `${BASE}/api/links?limit=2&cursor=${encodeURIComponent(cursor)}`
				: `${BASE}/api/links?limit=2`;
			const res = await call(makeRequest(url, "GET", { cookies: { "__Host-sid": sessionId } }));
			const page = await res.json<{ links: { short_code: string }[]; nextCursor: string | null }>();
			allLinks.push(...page.links);
			cursor = page.nextCursor;
		} while (cursor);

		// Only own links returned
		expect(allLinks).toHaveLength(3);
		for (const l of allLinks) {
			expect(l.short_code.startsWith("pag-mine-")).toBe(true);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CSRF protection (P0)
// ─────────────────────────────────────────────────────────────────────────────

describe("CSRF protection on POST routes", () => {
	it("returns 403 when Origin header is a foreign site", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: {
					"content-type": "application/json",
					"Origin": "https://evil.com",
					"X-Requested-With": "XMLHttpRequest",
				},
				body: JSON.stringify({ target_url: "https://example.com" }),
			})
		);
		expect(res.status).toBe(403);
	});

	it("returns 403 when Origin matches APP_BASE_URL but X-Requested-With is missing", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: {
					"content-type": "application/json",
					"Origin": env.APP_BASE_URL, // use actual env value (may come from .dev.vars)
					// X-Requested-With intentionally absent
				},
				body: JSON.stringify({ target_url: "https://example.com" }),
			})
		);
		expect(res.status).toBe(403);
	});

	it("allows POST when Origin matches APP_BASE_URL and X-Requested-With is set", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: {
					"content-type": "application/json",
					"Origin": env.APP_BASE_URL, // use actual env value (may come from .dev.vars)
					"X-Requested-With": "XMLHttpRequest",
				},
				body: JSON.stringify({ target_url: "https://csrf-allowed.example.com" }),
			})
		);
		expect(res.status).toBe(201);
	});

	it("allows POST without Origin header (non-browser client / curl / tests)", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const res = await call(
			makeRequest(`${BASE}/api/links`, "POST", {
				cookies: { "__Host-sid": sessionId },
				headers: {
					"content-type": "application/json",
					// No Origin header — existing tests and curl behave this way
				},
				body: JSON.stringify({ target_url: "https://no-origin.example.com" }),
			})
		);
		expect(res.status).toBe(201);
	});

	it("returns 403 on anonymous link creation with foreign Origin", async () => {
		const res = await call(
			makeRequest(`${BASE}/api/links/anonymous`, "POST", {
				headers: {
					"content-type": "application/json",
					"Origin": "https://attacker.example.com",
					"X-Requested-With": "XMLHttpRequest",
					"CF-Connecting-IP": "1.1.1.1",
				},
				body: JSON.stringify({ target_url: "https://example.com" }),
			})
		);
		expect(res.status).toBe(403);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting – GET /login  (P0)
// ─────────────────────────────────────────────────────────────────────────────

describe("Rate limit on GET /login", () => {
	it("returns 429 when the login rate limit is exceeded", async () => {
		const ip = "55.66.77.88";
		const window = new Date().toISOString().slice(0, 16);
		// Pre-seed 5 counts (limit is 5) so the next call is the 6th and gets blocked.
		await env.hello_cf_spa_db
			.prepare("INSERT OR REPLACE INTO rate_limits (ip, window_start, count) VALUES (?, ?, 5)")
			.bind(`login:${ip}`, window)
			.run();

		const res = await call(
			makeRequest(`${BASE}/login`, "GET", {
				headers: { "CF-Connecting-IP": ip },
			})
		);
		expect(res.status).toBe(429);
	});

	it("allows login when rate limit not yet exceeded", async () => {
		// Fresh IP → should get 302 redirect to Google
		const res = await call(
			makeRequest(`${BASE}/login`, "GET", {
				headers: { "CF-Connecting-IP": "99.88.77.66" },
			})
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("accounts.google.com");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting – GET /r/:code  (P0)
// ─────────────────────────────────────────────────────────────────────────────

describe("Rate limit on GET /r/:code", () => {
	it("returns 429 when the redirect rate limit is exceeded", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "rl-redir-test",
			targetUrl: "https://destination.example.com",
		});
		const ip = "11.22.33.44";
		const window = new Date().toISOString().slice(0, 16);
		// Pre-seed 60 counts (limit is 60) so the next call is the 61st and gets blocked.
		await env.hello_cf_spa_db
			.prepare("INSERT OR REPLACE INTO rate_limits (ip, window_start, count) VALUES (?, ?, 60)")
			.bind(`redirect:${ip}`, window)
			.run();

		const res = await call(
			makeRequest(`${BASE}/r/rl-redir-test`, "GET", {
				headers: { "CF-Connecting-IP": ip },
			})
		);
		expect(res.status).toBe(429);
	});

	it("redirect rate limit is independent of anonymous link rate limit", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedLink(env.hello_cf_spa_db, {
			userId,
			shortCode: "rl-indep-test",
			targetUrl: "https://independent.example.com",
		});
		const ip = "22.33.44.55";
		const window = new Date().toISOString().slice(0, 16);
		// Exhaust anonymous limit (10) — redirect limit (60) must remain unaffected.
		await env.hello_cf_spa_db
			.prepare("INSERT OR REPLACE INTO rate_limits (ip, window_start, count) VALUES (?, ?, 10)")
			.bind(ip, window)
			.run();

		// Redirect should still work (uses "redirect:ip" key, not plain "ip")
		const res = await call(
			makeRequest(`${BASE}/r/rl-indep-test`, "GET", {
				headers: { "CF-Connecting-IP": ip },
			})
		);
		expect(res.status).toBe(302);
	});
});



