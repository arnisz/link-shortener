/**
 * Test suite for POST /api/links/anonymous
 *
 * Covers:
 *   - Valid URL → 201, returns short_url + expires_at (~48 h)
 *   - Spam URL → 422
 *   - Invalid URL → 400
 *   - Rate limit: 11th request from same IP → 429
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import worker from "../src/index";
import { makeRequest, setupTestDb, setupLinksTable, setupSpamTable, setupRateLimitTable, setupTagsTables, createLinksKvMock, type LinksKvMock } from "./helpers";

const BASE = "https://example.com";
const CLIENT_IP = "1.2.3.4";

let linksKvMock: LinksKvMock;

// ── One-time schema setup ─────────────────────────────────────────────────────

beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupSpamTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
	// KV-Mock für alle Tests bereitstellen
	linksKvMock = createLinksKvMock();
	env.LINKS_KV = linksKvMock;
});

// ── Clean mutable tables before each test ────────────────────────────────────

beforeEach(async () => {
	await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
	// Do NOT delete spam_keywords: module-scope cache is already warm after first query.
	// KV-Store zurücksetzen für Test-Isolation (insert_count + link-Cache)
	linksKvMock.reset();
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function postAnonymous(targetUrl: string, ip = CLIENT_IP): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		makeRequest(`${BASE}/api/links/anonymous`, "POST", {
			headers: {
				"content-type": "application/json",
				"CF-Connecting-IP": ip,
			},
			body: JSON.stringify({ target_url: targetUrl }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/links/anonymous
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/links/anonymous", () => {
	it("returns 201 and a short_url for a valid URL", async () => {
		const res = await postAnonymous("https://example.com/some/long/path");
		expect(res.status).toBe(201);
		const data = await res.json<{ short_url: string; expires_at: string }>();
		expect(data.short_url).toMatch(/^https?:\/\/.+\/r\/[a-zA-Z0-9]+$/);
	});

	it("expires_at is approximately 48 hours in the future (±5 minutes)", async () => {
		const before = Date.now();
		const res = await postAnonymous("https://example.com/expiry-test");
		expect(res.status).toBe(201);
		const { expires_at } = await res.json<{ short_url: string; expires_at: string }>();

		const expiryMs = new Date(expires_at).getTime();
		const expected = before + 48 * 60 * 60 * 1000;
		const tolerance = 5 * 60 * 1000; // 5 minutes

		expect(expiryMs).toBeGreaterThanOrEqual(expected - tolerance);
		expect(expiryMs).toBeLessThanOrEqual(expected + tolerance);
	});

	it("returns 422 for a URL containing a spam keyword (viagra)", async () => {
		const res = await postAnonymous("https://buy-viagra-now.example.com/deals");
		expect(res.status).toBe(422);
		const data = await res.json<{ error: string }>();
		expect(data.error).toBe("URL nicht zulässig");
	});

	it("returns 422 for a URL containing the spam keyword 'casino' (case-insensitive)", async () => {
		const res = await postAnonymous("https://BEST-CASINO.example.com");
		expect(res.status).toBe(422);
	});

	it("returns 400 for an invalid URL", async () => {
		const res = await postAnonymous("not-a-url-at-all");
		expect(res.status).toBe(400);
	});

	it("returns 400 for a non-http protocol", async () => {
		const res = await postAnonymous("ftp://example.com/file");
		expect(res.status).toBe(400);
	});

	it("returns 400 for a localhost URL (SSRF protection)", async () => {
		const res = await postAnonymous("http://localhost:8080/admin");
		expect(res.status).toBe(400);
	});

	it("returns 400 for a private IP URL (SSRF protection)", async () => {
		const res = await postAnonymous("http://192.168.1.1/router");
		expect(res.status).toBe(400);
	});

	it("returns 400 for 127.0.0.1 (SSRF protection)", async () => {
		const res = await postAnonymous("http://127.0.0.1/secret");
		expect(res.status).toBe(400);
	});

	it("returns 400 for a 10.x.x.x private IP (SSRF protection)", async () => {
		const res = await postAnonymous("http://10.0.0.1/internal");
		expect(res.status).toBe(400);
	});

	it("returns 400 for AWS metadata endpoint (SSRF protection)", async () => {
		const res = await postAnonymous("http://169.254.169.254/latest/meta-data/");
		expect(res.status).toBe(400);
	});

	it("returns 400 when target_url is missing", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			makeRequest(`${BASE}/api/links/anonymous`, "POST", {
				headers: {
					"content-type": "application/json",
					"CF-Connecting-IP": CLIENT_IP,
				},
				body: JSON.stringify({}),
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(400);
	});

	it("returns 415 when Content-Type is not application/json", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(
			makeRequest(`${BASE}/api/links/anonymous`, "POST", {
				headers: { "CF-Connecting-IP": CLIENT_IP },
				body: "target_url=https://example.com",
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(415);
	});

	it("link is stored in DB with user_id = NULL and expires_at set", async () => {
		const res = await postAnonymous("https://example.com/db-check");
		expect(res.status).toBe(201);
		const { short_url } = await res.json<{ short_url: string; expires_at: string }>();

		// Extract short code from the URL
		const code = short_url.split("/r/")[1];
		expect(code).toBeTruthy();

		const row = await env.hello_cf_spa_db
			.prepare("SELECT user_id, expires_at FROM links WHERE short_code = ?")
			.bind(code)
			.first<{ user_id: string | null; expires_at: string | null }>();

		expect(row).not.toBeNull();
		expect(row!.user_id).toBeNull();
		expect(row!.expires_at).not.toBeNull();
	});

	it("short_url resolves via redirect (GET /r/:code)", async () => {
		const res = await postAnonymous("https://target.example.com/page");
		const { short_url } = await res.json<{ short_url: string }>();
		const code = short_url.split("/r/")[1];

		const ctx = createExecutionContext();
		const redirectRes = await worker.fetch(
			makeRequest(`${BASE}/r/${code}`),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(redirectRes.status).toBe(302);
		expect(redirectRes.headers.get("location")).toBe("https://target.example.com/page");
	});

	it("rate limit: 11th request from same IP within one minute returns 429", async () => {
		const url = "https://example.com/rate-limit-test";

		// Requests 1–10 must succeed
		for (let i = 1; i <= 10; i++) {
			const res = await postAnonymous(url, "5.6.7.8");
			expect(res.status, `Request ${i} should be 201`).toBe(201);
		}

		// 11th request must be rate-limited
		const limited = await postAnonymous(url, "5.6.7.8");
		expect(limited.status).toBe(429);
		const data = await limited.json<{ error: string }>();
		expect(data.error).toBe("Zu viele Anfragen. Bitte warte eine Minute.");
	});

	it("rate limit is per-IP: different IPs are tracked independently", async () => {
		const url = "https://example.com/per-ip-test";

		// Exhaust limit for IP A
		for (let i = 0; i < 10; i++) {
			await postAnonymous(url, "10.0.0.1");
		}
		const limitedA = await postAnonymous(url, "10.0.0.1");
		expect(limitedA.status).toBe(429);

		// IP B should still be allowed
		const resB = await postAnonymous(url, "10.0.0.2");
		expect(resB.status).toBe(201);
	});

	it("response does not expose user_id", async () => {
		const res = await postAnonymous("https://example.com/privacy-check");
		expect(res.status).toBe(201);
		const data = await res.json<Record<string, unknown>>();
		expect("user_id" in data).toBe(false);
		expect("id" in data).toBe(false);
	});
});
