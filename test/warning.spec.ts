/**
 * Test suite for /warning and /warning/proceed endpoints (Phase 5)
 *
 * Covers:
 *   - GET /warning?code=:code — interstitial page
 *   - GET /warning/proceed?code=:code&t=:token — bypass redirect
 *
 * Also covers:
 *   - generateSignedToken / verifySignedToken from src/csrf.ts
 *   - "warning" in ALIAS_RESERVED
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import worker from "../src/index";
import {
	makeRequest,
	setupTestDb,
	setupLinksTable,
	setupRateLimitTable,
	setupTagsTables,
	setupSecurityScansTable,
	setupBypassClicksTable,
	createLinksKvMock,
	seedSession,
	seedLink,
} from "./helpers";
import { generateSignedToken, verifySignedToken } from "../src/csrf";
import { ALIAS_RESERVED } from "../src/validation";

const BASE = "https://example.com";
const SESSION_SECRET = "test-session-secret";

// ── One-time schema setup ─────────────────────────────────────────────────────

let linksKvMock: ReturnType<typeof createLinksKvMock>;
let testUserId: string;

beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
	await setupSecurityScansTable(env.hello_cf_spa_db);
	await setupBypassClicksTable(env.hello_cf_spa_db);
	linksKvMock = createLinksKvMock();
	env.LINKS_KV = linksKvMock;
});

beforeEach(async () => {
	await env.hello_cf_spa_db.prepare("DELETE FROM bypass_clicks").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM security_scans").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM sessions").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM users").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	linksKvMock.reset();

	// Seed a user for all tests
	const session = await seedSession(env.hello_cf_spa_db);
	testUserId = session.userId;
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function getReq(path: string): Request {
	return makeRequest(`${BASE}${path}`);
}

// ── generateSignedToken / verifySignedToken unit tests ────────────────────────

describe("generateSignedToken / verifySignedToken", () => {
	it("valid token verifies correctly", () => {
		const token = generateSignedToken("warning:abc123", SESSION_SECRET);
		expect(verifySignedToken(token, "warning:abc123", SESSION_SECRET)).toBe(true);
	});

	it("wrong subject fails", () => {
		const token = generateSignedToken("warning:abc123", SESSION_SECRET);
		expect(verifySignedToken(token, "warning:other", SESSION_SECRET)).toBe(false);
	});

	it("wrong secret fails", () => {
		const token = generateSignedToken("warning:abc123", SESSION_SECRET);
		expect(verifySignedToken(token, "warning:abc123", "wrong-secret")).toBe(false);
	});

	it("tampered MAC fails", () => {
		const token = generateSignedToken("warning:abc123", SESSION_SECRET);
		const tampered = token.slice(0, -4) + "0000";
		expect(verifySignedToken(token.split(".")[0] + "." + "0".repeat(64), "warning:abc123", SESSION_SECRET)).toBe(false);
	});

	it("expired token fails", () => {
		// TTL = -1000 ensures the timestamp is strictly in the past
		const token = generateSignedToken("warning:abc123", SESSION_SECRET, -1000);
		expect(verifySignedToken(token, "warning:abc123", SESSION_SECRET)).toBe(false);
	});

	it("malformed token fails", () => {
		expect(verifySignedToken("nodot", "warning:abc123", SESSION_SECRET)).toBe(false);
		expect(verifySignedToken("", "warning:abc123", SESSION_SECRET)).toBe(false);
		expect(verifySignedToken("abc.def", "warning:abc123", SESSION_SECRET)).toBe(false);
	});

	it("prevents cross-replay: session CSRF token does not pass as warning token", () => {
		// Session CSRF token uses a different subject format
		const sessionToken = generateSignedToken("session:abc123", SESSION_SECRET);
		expect(verifySignedToken(sessionToken, "warning:abc123", SESSION_SECRET)).toBe(false);
	});
});

// ── ALIAS_RESERVED ────────────────────────────────────────────────────────────

describe("ALIAS_RESERVED", () => {
	it("contains 'warning'", () => {
		expect(ALIAS_RESERVED.has("warning")).toBe(true);
	});
});

// ── GET /warning ──────────────────────────────────────────────────────────────

describe("GET /warning", () => {
	it("returns 400 for missing code", async () => {
		const res = await call(getReq("/warning"));
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid code (SQL injection attempt)", async () => {
		const res = await call(getReq("/warning?code=' OR 1=1--"));
		expect(res.status).toBe(400);
	});

	it("returns 404 for non-existent link", async () => {
		const res = await call(getReq("/warning?code=notexist"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for inactive link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "inact1",
			status: "warning",
			isActive: 0,
		});
		const res = await call(getReq("/warning?code=inact1"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for blocked link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "blkd01",
			status: "blocked",
		});
		const res = await call(getReq("/warning?code=blkd01"));
		expect(res.status).toBe(404);
	});

	it("returns 404 for expired link", async () => {
		const past = new Date(Date.now() - 1000).toISOString();
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "exprd1",
			status: "warning",
			expiresAt: past,
		});
		const res = await call(getReq("/warning?code=exprd1"));
		expect(res.status).toBe(404);
	});

	it("redirects to /r/:code for active (non-warning) link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "activ1",
			status: "active",
		});
		const res = await call(getReq("/warning?code=activ1"));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/r/activ1");
	});

	it("returns 200 HTML interstitial for warning link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn01",
			targetUrl: "https://suspicious.example.com/path",
			status: "warning",
		});
		const res = await call(getReq("/warning?code=warn01"));
		expect(res.status).toBe(200);
		const ct = res.headers.get("content-type") ?? "";
		expect(ct).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("Security Warning");
		expect(html).toContain("suspicious.example.com");
		expect(html).toContain("/warning/proceed?code=warn01");
	});

	it("HTML-escapes target_url in interstitial", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "xss001",
			targetUrl: "https://example.com/<script>alert(1)</script>",
			status: "warning",
		});
		const res = await call(getReq("/warning?code=xss001"));
		expect(res.status).toBe(200);
		const html = await res.text();
		// Raw script tag must not appear
		expect(html).not.toContain("<script>alert(1)</script>");
		// Escaped version should appear
		expect(html).toContain("&lt;script&gt;");
	});

	it("interstitial HTML contains proceed URL with token parameter", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn02",
			status: "warning",
		});
		const res = await call(getReq("/warning?code=warn02"));
		expect(res.status).toBe(200);
		const html = await res.text();
		// The proceed URL should contain both code and t params
		expect(html).toMatch(/\/warning\/proceed\?code=warn02&amp;t=/);
	});
});

// ── GET /warning/proceed ──────────────────────────────────────────────────────

describe("GET /warning/proceed", () => {
	it("returns 400 for missing parameters", async () => {
		const res = await call(getReq("/warning/proceed"));
		expect(res.status).toBe(400);
	});

	it("returns 400 for missing token", async () => {
		const res = await call(getReq("/warning/proceed?code=warn01"));
		expect(res.status).toBe(400);
	});

	it("returns 403 for invalid/tampered token", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn03",
			status: "warning",
		});
		const res = await call(getReq("/warning/proceed?code=warn03&t=invalid.token"));
		expect(res.status).toBe(403);
	});

	it("returns 403 for expired token", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn04",
			status: "warning",
		});
		// TTL=-1000: timestamp is strictly in the past
		const expiredToken = generateSignedToken("warning:warn04", SESSION_SECRET, -1000);
		const res = await call(getReq(`/warning/proceed?code=warn04&t=${encodeURIComponent(expiredToken)}`));
		expect(res.status).toBe(403);
	});

	it("returns 403 for token with wrong subject (cross-replay protection)", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn05",
			status: "warning",
		});
		// Token is for a different code
		const wrongToken = generateSignedToken("warning:other", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=warn05&t=${encodeURIComponent(wrongToken)}`));
		expect(res.status).toBe(403);
	});

	it("returns 404 for valid token but non-existent link", async () => {
		const token = generateSignedToken("warning:ghost1", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=ghost1&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(404);
	});

	it("returns 404 for valid token but blocked link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "blkd02",
			status: "blocked",
		});
		const token = generateSignedToken("warning:blkd02", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=blkd02&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(404);
	});

	it("returns 404 for valid token but inactive link", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "inact2",
			status: "warning",
			isActive: 0,
		});
		const token = generateSignedToken("warning:inact2", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=inact2&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(404);
	});

	it("redirects to /r/:code for active link with valid token", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "activ2",
			status: "active",
		});
		const token = generateSignedToken("warning:activ2", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=activ2&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/r/activ2");
	});

	it("302 redirect to target_url for warning link with valid token", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn06",
			targetUrl: "https://destination.example.com/page",
			status: "warning",
		});
		const token = generateSignedToken("warning:warn06", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=warn06&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("https://destination.example.com/page");
	});

	it("logs bypass click in bypass_clicks table", async () => {
		await seedLink(env.hello_cf_spa_db, {
			userId: testUserId,
			shortCode: "warn07",
			targetUrl: "https://destination.example.com/",
			status: "warning",
		});
		const token = generateSignedToken("warning:warn07", SESSION_SECRET);
		const res = await call(getReq(`/warning/proceed?code=warn07&t=${encodeURIComponent(token)}`));
		expect(res.status).toBe(302);
		const row = await env.hello_cf_spa_db
			.prepare("SELECT short_code, hour_bucket FROM bypass_clicks WHERE short_code = ?")
			.bind("warn07")
			.first<{ short_code: string; hour_bucket: string }>();
		expect(row).not.toBeNull();
		expect(row?.short_code).toBe("warn07");
		// hour_bucket format: "YYYY-MM-DD HH"
		expect(row?.hour_bucket).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}$/);
	});
});
