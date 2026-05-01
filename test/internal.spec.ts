/**
 * Test suite for /api/internal/* endpoints (Wächter-Dienst)
 *
 * Covers:
 *   - GET  /api/internal/health
 *   - GET  /api/internal/links/pending
 *   - POST /api/internal/links/:id/scan-result
 *   - POST /api/internal/links/release-stale
 *   - GET  /api/internal/metrics
 *
 * Auth: Bearer token via WAECHTER_TOKEN (test value: "test-waechter-token")
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
	createLinksKvMock,
	seedSession,
	seedLink,
} from "./helpers";

const BASE = "https://example.com";
const VALID_TOKEN = "test-waechter-token";
const WRONG_TOKEN = "wrong-token";

// ── One-time schema setup ─────────────────────────────────────────────────────

let linksKvMock: ReturnType<typeof createLinksKvMock>;

beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
	await setupSecurityScansTable(env.hello_cf_spa_db);
	linksKvMock = createLinksKvMock();
	env.LINKS_KV = linksKvMock;
});

// ── Clean mutable tables before each test ────────────────────────────────────

beforeEach(async () => {
	await env.hello_cf_spa_db.prepare("DELETE FROM security_scans").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM sessions").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM users").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	linksKvMock.reset();
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function bearerRequest(path: string, method = "GET", token = VALID_TOKEN, body?: unknown): Request {
	return makeRequest(`${BASE}${path}`, method, {
		headers: {
			"authorization": `Bearer ${token}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
}

/** Generates a 32-char lowercase hex ID for use with /api/internal routes. */
function hexId(): string {
	return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

/** Directly inserts a link with a proper 32-char hex ID. Returns id and shortCode. */
async function seedHexLink(opts: {
	userId: string;
	shortCode: string;
	targetUrl?: string;
	checked?: number;
	status?: string;
	manualOverride?: number;
	claimedAt?: string | null;
}): Promise<{ id: string; shortCode: string }> {
	const id = hexId();
	const now = new Date().toISOString();
	await env.hello_cf_spa_db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active, checked, status, manual_override, claimed_at)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NULL, 1, ?, ?, ?, ?)`
		)
		.bind(
			id,
			opts.userId,
			opts.shortCode,
			opts.targetUrl ?? "https://example.com",
			now, now,
			opts.checked ?? 0,
			opts.status ?? "active",
			opts.manualOverride ?? 0,
			opts.claimedAt ?? null
		)
		.run();
	return { id, shortCode: opts.shortCode };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/internal/health
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/internal/health", () => {
	it("returns 200 { ok: true } with valid token", async () => {
		const res = await call(bearerRequest("/api/internal/health"));
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean }>();
		expect(data.ok).toBe(true);
	});

	it("returns 401 without Authorization header", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/health`));
		expect(res.status).toBe(401);
	});

	it("returns 401 with wrong token", async () => {
		const res = await call(bearerRequest("/api/internal/health", "GET", WRONG_TOKEN));
		expect(res.status).toBe(401);
	});

	it("returns 401 with malformed Authorization (no Bearer prefix)", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/health`, "GET", {
			headers: { "authorization": VALID_TOKEN },
		}));
		expect(res.status).toBe(401);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/internal/links/pending
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/internal/links/pending", () => {
	it("returns 401 without token", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/links/pending`));
		expect(res.status).toBe(401);
	});

	it("returns empty array when no links exist", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("returns unchecked links and claims them (sets claimed_at)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "pending1",
			checked: 0,
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string; short_code: string; target_url: string; created_at: string }[] }>();
		expect(data.links.length).toBe(1);
		expect(data.links[0].id).toBe(id);
		expect(data.links[0].short_code).toBe("pending1");
		expect(data.links[0].target_url).toBe("https://example.com");
		expect(typeof data.links[0].created_at).toBe("string");

		// Verify claimed_at was set in DB
		const row = await env.hello_cf_spa_db
			.prepare("SELECT claimed_at FROM links WHERE id = ?")
			.bind(id)
			.first<{ claimed_at: string | null }>();
		expect(row?.claimed_at).not.toBeNull();
	});

	it("does not return already-claimed links (within 10 minutes)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// Set claimed_at to now (within 10 minutes) — SQLite datetime() format
		const recentlyClaimed = new Date().toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({
			userId,
			shortCode: "claimed1",
			checked: 0,
			claimedAt: recentlyClaimed,
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("does not return links with manual_override=1", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "override1",
			checked: 0,
			manualOverride: 1,
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("does not return already-checked links (unless stale)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "checked1",
			checked: 1,
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("respects limit parameter (max 100)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// Create 3 unchecked links
		for (let i = 1; i <= 3; i++) {
			await seedHexLink({ userId, shortCode: `pend${i}`, checked: 0 });
		}

		const res = await call(bearerRequest("/api/internal/links/pending?limit=2"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links.length).toBe(2);
	});

	it("clamps limit to 100 maximum", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending?limit=999"));
		expect(res.status).toBe(200);
		// Should not crash — just returns up to 100
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/internal/links/:id/scan-result
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/internal/links/:id/scan-result", () => {
	const validId = "a".repeat(32); // 32-char hex

	it("returns 401 without token", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/links/${validId}/scan-result`, "POST", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ aggregate_score: 0.5, status: "active", scans: [{ provider: "heuristic", raw_score: 0.5, raw_response: null }] }),
		}));
		expect(res.status).toBe(401);
	});

	it("returns 404 for non-existent link", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "active",
			scans: [{ provider: "heuristic", raw_score: 0.5, raw_response: null }],
		}));
		expect(res.status).toBe(404);
	});

	it("returns 200 and updates link status + checked flag", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "scan1",
			checked: 0,
			status: "active",
		});

		const res = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.83,
			status: "warning",
			scans: [
				{ provider: "heuristic", raw_score: 0.83, raw_response: null },
			],
		}));
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean }>();
		expect(data.ok).toBe(true);

		// Check link was updated
		const row = await env.hello_cf_spa_db
			.prepare("SELECT checked, status, spam_score, last_checked_at, claimed_at FROM links WHERE id = ?")
			.bind(id)
			.first<{ checked: number; status: string; spam_score: number; last_checked_at: string | null; claimed_at: string | null }>();
		expect(row?.checked).toBe(1);
		expect(row?.status).toBe("warning");
		expect(row?.spam_score).toBeCloseTo(0.83);
		expect(row?.last_checked_at).not.toBeNull();
		expect(row?.claimed_at).toBeNull();
	});

	it("inserts security_scans rows for each provider", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({ userId, shortCode: "scan2", checked: 0 });

		await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.95,
			status: "blocked",
			scans: [
				{ provider: "google_safe_browsing", raw_score: 1.0, raw_response: '{"matches":[]}' },
				{ provider: "heuristic", raw_score: 0.9, raw_response: null },
			],
		}));

		const scans = await env.hello_cf_spa_db
			.prepare("SELECT provider, raw_score, raw_response FROM security_scans WHERE link_id = ?")
			.bind(id)
			.all<{ provider: string; raw_score: number; raw_response: string | null }>();
		expect(scans.results.length).toBe(2);
		const providers = scans.results.map(r => r.provider);
		expect(providers).toContain("google_safe_browsing");
		expect(providers).toContain("heuristic");
	});

	it("updates KV cache with new status after scan-result (put instead of delete)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({ userId, shortCode: "scan3", checked: 0 });
		// Pre-populate KV cache with old active status
		await env.LINKS_KV.put("link:scan3", JSON.stringify({ id, user_id: userId, target_url: "https://example.com", is_active: 1, status: "active" }));

		await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.97,
			status: "blocked",
			scans: [{ provider: "heuristic", raw_score: 0.97, raw_response: null }],
		}));

		// KV should now contain the updated status (put, not delete — avoids eventual-consistency drift)
		const raw = await env.LINKS_KV.get("link:scan3");
		expect(raw).not.toBeNull();
		const cached = JSON.parse(raw!);
		expect(cached.status).toBe("blocked");
	});

	it("returns 404 for manual_override=1 links (Wächter darf nicht überschreiben)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "override2",
			checked: 0,
			manualOverride: 1,
		});

		const res = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "active",
			scans: [{ provider: "heuristic", raw_score: 0.5, raw_response: null }],
		}));
		expect(res.status).toBe(404);
	});

	it("returns 400 for invalid aggregate_score > 1", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 1.5,
			status: "active",
			scans: [{ provider: "heuristic", raw_score: 0.5, raw_response: null }],
		}));
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid status value", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "suspicious",
			scans: [{ provider: "heuristic", raw_score: 0.5, raw_response: null }],
		}));
		expect(res.status).toBe(400);
	});

	it("returns 400 for empty scans array", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "active",
			scans: [],
		}));
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid raw_score in scan", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "active",
			scans: [{ provider: "heuristic", raw_score: -0.1, raw_response: null }],
		}));
		expect(res.status).toBe(400);
	});

	it("returns 400 for empty provider string", async () => {
		const res = await call(bearerRequest(`/api/internal/links/${validId}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.5,
			status: "active",
			scans: [{ provider: "", raw_score: 0.5, raw_response: null }],
		}));
		expect(res.status).toBe(400);
	});

	it("re-evaluation: blocked→warning causes /r/:code to redirect to /warning (not 404)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "reeval1",
			targetUrl: "https://example.com/target",
			checked: 1,
			status: "blocked",
		});

		// Simulate stale KV cache with old blocked status
		await env.LINKS_KV.put("link:reeval1", JSON.stringify({
			id,
			user_id: userId,
			target_url: "https://example.com/target",
			is_active: 1,
			status: "blocked",
		}));

		// Wächter re-evaluates: blocked → warning
		const scanRes = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.80,
			status: "warning",
			scans: [{ provider: "heuristic", raw_score: 0.80, raw_response: null }],
		}));
		expect(scanRes.status).toBe(200);

		// KV must now contain the updated warning status (not the old blocked)
		const raw = await env.LINKS_KV.get("link:reeval1");
		expect(raw).not.toBeNull();
		const cached = JSON.parse(raw!);
		expect(cached.status).toBe("warning");

		// Redirect must now go to /warning (not 404)
		const redirectReq = makeRequest(`${BASE}/r/reeval1`);
		const redirectRes = await call(redirectReq);
		expect(redirectRes.status).toBe(302);
		expect(redirectRes.headers.get("Location")).toBe("/warning?code=reeval1");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/internal/links/release-stale
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/internal/links/release-stale", () => {
	it("returns 401 without token", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/links/release-stale`, "POST"));
		expect(res.status).toBe(401);
	});

	it("returns 200 with released=0 when no stale claims exist", async () => {
		const res = await call(bearerRequest("/api/internal/links/release-stale", "POST"));
		expect(res.status).toBe(200);
		const data = await res.json<{ released: number }>();
		expect(data.released).toBe(0);
	});

	it("releases links with claimed_at older than 10 minutes", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// claimed_at 20 minutes ago (stale) — SQLite datetime() format (no T, no Z)
		const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const { id } = await seedHexLink({
			userId,
			shortCode: "stale1",
			checked: 0,
			claimedAt: staleTime,
		});

		const res = await call(bearerRequest("/api/internal/links/release-stale", "POST"));
		expect(res.status).toBe(200);
		const data = await res.json<{ released: number }>();
		expect(data.released).toBe(1);

		// Verify claimed_at is NULL now
		const row = await env.hello_cf_spa_db
			.prepare("SELECT claimed_at FROM links WHERE id = ?")
			.bind(id)
			.first<{ claimed_at: string | null }>();
		expect(row?.claimed_at).toBeNull();
	});

	it("does not release recently claimed links (within 10 minutes)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// SQLite datetime() format (no T, no Z)
		const recentTime = new Date().toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({
			userId,
			shortCode: "recent1",
			checked: 0,
			claimedAt: recentTime,
		});

		const res = await call(bearerRequest("/api/internal/links/release-stale", "POST"));
		expect(res.status).toBe(200);
		const data = await res.json<{ released: number }>();
		expect(data.released).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/internal/metrics
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/internal/metrics", () => {
	it("returns 401 without token", async () => {
		const res = await call(makeRequest(`${BASE}/api/internal/metrics`));
		expect(res.status).toBe(401);
	});

	it("returns 200 with correct structure when DB is empty", async () => {
		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{
			queue_depth: number;
			links_scanned_24h: number;
			status_distribution: Record<string, number>;
			provider_quota_status: Record<string, unknown>;
		}>();
		expect(typeof data.queue_depth).toBe("number");
		expect(typeof data.links_scanned_24h).toBe("number");
		expect(typeof data.status_distribution).toBe("object");
		expect(typeof data.provider_quota_status).toBe("object");
	});

	it("returns correct queue_depth (unchecked, unclaimed links)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// 2 unchecked, unclaimed
		await seedHexLink({ userId, shortCode: "q1", checked: 0 });
		await seedHexLink({ userId, shortCode: "q2", checked: 0 });
		// 1 already checked
		await seedHexLink({ userId, shortCode: "q3", checked: 1 });
		// 1 unchecked but claimed — SQLite datetime() format
		const claimedAt = new Date().toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({ userId, shortCode: "q4", checked: 0, claimedAt });

		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ queue_depth: number }>();
		expect(data.queue_depth).toBe(2);
	});

	it("returns correct status_distribution", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({ userId, shortCode: "sd1", status: "active" });
		await seedHexLink({ userId, shortCode: "sd2", status: "active" });
		await seedHexLink({ userId, shortCode: "sd3", status: "warning" });
		await seedHexLink({ userId, shortCode: "sd4", status: "blocked" });

		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ status_distribution: Record<string, number> }>();
		expect(data.status_distribution.active).toBe(2);
		expect(data.status_distribution.warning).toBe(1);
		expect(data.status_distribution.blocked).toBe(1);
	});
});
