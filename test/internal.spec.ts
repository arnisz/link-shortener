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
import type { Env } from "../src/types";
import {
	makeRequest,
	setupTestDb,
	setupLinksTable,
	setupRateLimitTable,
	setupTagsTables,
	setupSecurityScansTable,
	createLinksKvMock,
	seedSession,
} from "./helpers";

const BASE = "https://example.com";
const VALID_TOKEN = "test-waechter-token";
const WRONG_TOKEN = "wrong-token";

// ── One-time schema setup ─────────────────────────────────────────────────────

let linksKvMock: ReturnType<typeof createLinksKvMock>;
let linksKv: ReturnType<typeof createLinksKvMock>;

beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
	await setupSecurityScansTable(env.hello_cf_spa_db);
	linksKvMock = createLinksKvMock();
	linksKv = linksKvMock;
	env.LINKS_KV = linksKvMock as unknown as Env["LINKS_KV"];
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
	linksKv.reset();
});

// ── Helper ────────────────────────────────────────────────────────────────────

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env as unknown as Env, ctx);
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
	lastCheckedAt?: string | null;
	clickCount?: number;
	lastScannedClickCount?: number;
	/** Override created_at (ISO-8601). Defaults to now. */
	createdAt?: string;
}): Promise<{ id: string; shortCode: string }> {
	const id = hexId();
	const now = new Date().toISOString();
	const createdAt = opts.createdAt ?? now;
	await env.hello_cf_spa_db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active, checked, status, manual_override, claimed_at, last_checked_at, last_scanned_click_count)
			 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			id,
			opts.userId,
			opts.shortCode,
			opts.targetUrl ?? "https://example.com",
			createdAt, now,
			opts.clickCount ?? 0,
			opts.checked ?? 0,
			opts.status ?? "active",
			opts.manualOverride ?? 0,
			opts.claimedAt ?? null,
			opts.lastCheckedAt ?? null,
			opts.lastScannedClickCount ?? 0
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
			clickCount: 7,
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string; short_code: string; target_url: string; created_at: string; click_count: number }[] }>();
		expect(data.links.length).toBe(1);
		expect(data.links[0].id).toBe(id);
		expect(data.links[0].short_code).toBe("pending1");
		expect(data.links[0].target_url).toBe("https://example.com");
		expect(typeof data.links[0].created_at).toBe("string");
		expect(data.links[0].click_count).toBe(7);

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
		// Use a recent last_checked_at so the link is not considered stale by any tier
		const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({
			userId,
			shortCode: "checked1",
			checked: 1,
			lastCheckedAt: recentTime,
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

	it("returns 400 for max_age_warning_h = 0 (out of range)", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending?max_age_warning_h=0"));
		expect(res.status).toBe(400);
	});

	it("returns 400 for max_age_active_d = 9999 (out of range)", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending?max_age_active_d=9999"));
		expect(res.status).toBe(400);
	});

	it("returns 400 for max_age_blocked_d = -1 (out of range)", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending?max_age_blocked_d=-1"));
		expect(res.status).toBe(400);
	});

	it("returns 400 for non-integer max_age_warning_h", async () => {
		const res = await call(bearerRequest("/api/internal/links/pending?max_age_warning_h=abc"));
		expect(res.status).toBe(400);
	});

	it("prioritises checked=0 (Prio 1) over warning/active/blocked (Prio 2-4)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// A warning link that is overdue (last_checked_at 48h ago)
		const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const { id: warningId } = await seedHexLink({
			userId, shortCode: "prio-warning", checked: 1, status: "warning", lastCheckedAt: oldTime, clickCount: 100,
		});
		// An unchecked link with lower click_count
		const { id: newId } = await seedHexLink({
			userId, shortCode: "prio-new", checked: 0, status: "active", clickCount: 1,
		});

		const res = await call(bearerRequest("/api/internal/links/pending?limit=1&max_age_warning_h=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		// Prio 1 (checked=0) must come before Prio 2 (warning overdue)
		expect(data.links[0].id).toBe(newId);
		// warningId must not be in this batch (limit=1)
		expect(data.links.map(l => l.id)).not.toContain(warningId);
	});

	it("returns warning links due for re-scan (Prio 2) when checked=0 queue is empty", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const { id } = await seedHexLink({
			userId, shortCode: "warn-recheck", checked: 1, status: "warning", lastCheckedAt: oldTime,
		});

		const res = await call(bearerRequest("/api/internal/links/pending?max_age_warning_h=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links.map(l => l.id)).toContain(id);
	});

	it("does not return warning links that were checked recently (within threshold)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const recentTime = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({
			userId, shortCode: "warn-fresh", checked: 1, status: "warning", lastCheckedAt: recentTime,
		});

		// threshold = 24h, link only 30min old → should NOT be returned
		const res = await call(bearerRequest("/api/internal/links/pending?max_age_warning_h=24"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("sorts within same priority by click_count DESC", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id: lowId }  = await seedHexLink({ userId, shortCode: "click-low",  checked: 0, clickCount: 5  });
		const { id: highId } = await seedHexLink({ userId, shortCode: "click-high", checked: 0, clickCount: 99 });

		const res = await call(bearerRequest("/api/internal/links/pending?limit=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		// Higher click_count must come first
		expect(data.links[0].id).toBe(highId);
		expect(data.links.map(l => l.id)).not.toContain(lowId);
	});

	it("keeps active links with delta < 50 on the existing 14-day reclaim interval", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const thirteenDaysAgo = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");

		const { id: freshId } = await seedHexLink({
			userId,
			shortCode: "active-fresh-delta-low",
			checked: 1,
			status: "active",
			clickCount: 49,
			lastScannedClickCount: 0,
			lastCheckedAt: thirteenDaysAgo,
			createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const { id: dueId } = await seedHexLink({
			userId,
			shortCode: "active-overdue-delta-low",
			checked: 1,
			status: "active",
			clickCount: 49,
			lastScannedClickCount: 0,
			lastCheckedAt: fifteenDaysAgo,
			createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links.map(l => l.id)).toContain(dueId);
		expect(data.links.map(l => l.id)).not.toContain(freshId);
	});

	it("reclaims active links with delta 50-99 after 1 hour since last_checked_at", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");

		const { id: freshId } = await seedHexLink({
			userId,
			shortCode: "active-mid-fresh",
			checked: 1,
			status: "active",
			clickCount: 75,
			lastScannedClickCount: 0,
			lastCheckedAt: thirtyMinutesAgo,
			createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const { id: dueId } = await seedHexLink({
			userId,
			shortCode: "active-mid-due",
			checked: 1,
			status: "active",
			clickCount: 75,
			lastScannedClickCount: 0,
			lastCheckedAt: twoHoursAgo,
			createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links.map(l => l.id)).toContain(dueId);
		expect(data.links.map(l => l.id)).not.toContain(freshId);
	});

	it("reclaims active links with delta >= 100 after 30 minutes since last_checked_at", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");

		const { id: freshId } = await seedHexLink({
			userId,
			shortCode: "active-high-fresh",
			checked: 1,
			status: "active",
			clickCount: 150,
			lastScannedClickCount: 0,
			lastCheckedAt: twentyMinutesAgo,
			createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		});
		const { id: dueId } = await seedHexLink({
			userId,
			shortCode: "active-high-due",
			checked: 1,
			status: "active",
			clickCount: 150,
			lastScannedClickCount: 0,
			lastCheckedAt: fortyMinutesAgo,
			createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links.map(l => l.id)).toContain(dueId);
		expect(data.links.map(l => l.id)).not.toContain(freshId);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/internal/links/pending — Burst-Revalidation (Prio 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/internal/links/pending — Burst-Revalidation", () => {
	/**
	 * Returns an ISO-8601 timestamp offset from now.
	 * hoursAgo > 0 → in the past, hoursAgo < 0 → in the future.
	 */
	function hoursAgoIso(hoursAgo: number): string {
		return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
	}

	it("returns a fresh link (< 6h) with click_count >= 40 and last_scanned_click_count < 40", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "burst1",
			checked: 1,
			status: "active",
			clickCount: 45,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(3), // 3 hours ago — within 6h window
			lastCheckedAt: hoursAgoIso(3),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links.map(l => l.id)).toContain(id);
	});

	it("does NOT return a link where last_scanned_click_count >= 40 (burst already triggered)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "burst2",
			checked: 1,
			status: "active",
			clickCount: 50,
			lastScannedClickCount: 45, // already scanned after crossing threshold
			createdAt: hoursAgoIso(3),
			lastCheckedAt: hoursAgoIso(2),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("does NOT return a fresh link with click_count < 40", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "burst3",
			checked: 1,
			status: "active",
			clickCount: 39,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(2),
			lastCheckedAt: hoursAgoIso(2),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("does NOT return a link older than 6h even with click_count >= 40", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "burst4",
			checked: 1,
			status: "active",
			clickCount: 100,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(8), // 8 hours ago — outside 6h window
			lastCheckedAt: hoursAgoIso(8),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("does NOT return a burst-eligible link with manual_override=1", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		await seedHexLink({
			userId,
			shortCode: "burst5",
			checked: 1,
			status: "active",
			clickCount: 50,
			lastScannedClickCount: 0,
			manualOverride: 1,
			createdAt: hoursAgoIso(2),
			lastCheckedAt: hoursAgoIso(2),
		});

		const res = await call(bearerRequest("/api/internal/links/pending"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: unknown[] }>();
		expect(data.links).toEqual([]);
	});

	it("Burst-Revalidation (Prio 2) comes before stale warning (Prio 3) when limit=1", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// Stale warning link — would be Prio 3
		const { id: warningId } = await seedHexLink({
			userId,
			shortCode: "burst-vs-warn",
			checked: 1,
			status: "warning",
			clickCount: 200,
			lastScannedClickCount: 200,
			createdAt: hoursAgoIso(48),
			lastCheckedAt: hoursAgoIso(48), // overdue by 24h threshold
		});
		// Burst-eligible link — should be Prio 2
		const { id: burstId } = await seedHexLink({
			userId,
			shortCode: "burst-prio",
			checked: 1,
			status: "active",
			clickCount: 50,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(3),
			lastCheckedAt: hoursAgoIso(3),
		});

		const res = await call(bearerRequest("/api/internal/links/pending?limit=1&max_age_warning_h=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		// Burst (Prio 2) must come before stale warning (Prio 3)
		expect(data.links[0].id).toBe(burstId);
		expect(data.links.map(l => l.id)).not.toContain(warningId);
	});

	it("checked=0 (Prio 1) comes before Burst-Revalidation (Prio 2) when limit=1", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// Burst-eligible link — Prio 2
		const { id: burstId } = await seedHexLink({
			userId,
			shortCode: "burst-vs-new",
			checked: 1,
			status: "active",
			clickCount: 50,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(3),
			lastCheckedAt: hoursAgoIso(3),
		});
		// Never-scanned link — Prio 1
		const { id: newId } = await seedHexLink({
			userId,
			shortCode: "never-scanned",
			checked: 0,
			status: "active",
			clickCount: 1,
		});

		const res = await call(bearerRequest("/api/internal/links/pending?limit=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		// checked=0 (Prio 1) must come first
		expect(data.links[0].id).toBe(newId);
		expect(data.links.map(l => l.id)).not.toContain(burstId);
	});

	it("sorts burst-eligible links by click_count DESC within Prio 2", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id: highId } = await seedHexLink({
			userId, shortCode: "burst-hi",
			checked: 1, status: "active",
			clickCount: 80, lastScannedClickCount: 0,
			createdAt: hoursAgoIso(3), lastCheckedAt: hoursAgoIso(3),
		});
		const { id: lowId } = await seedHexLink({
			userId, shortCode: "burst-lo",
			checked: 1, status: "active",
			clickCount: 42, lastScannedClickCount: 0,
			createdAt: hoursAgoIso(4), lastCheckedAt: hoursAgoIso(4),
		});

		const res = await call(bearerRequest("/api/internal/links/pending?limit=1"));
		expect(res.status).toBe(200);
		const data = await res.json<{ links: { id: string }[] }>();
		expect(data.links[0].id).toBe(highId);
		expect(data.links.map(l => l.id)).not.toContain(lowId);
	});

	it("scan-result writeback updates last_scanned_click_count to current click_count", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "burst-wb",
			checked: 1,
			status: "active",
			clickCount: 50,
			lastScannedClickCount: 0,
			createdAt: hoursAgoIso(3),
			lastCheckedAt: hoursAgoIso(3),
		});

		const res = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.1,
			status: "active",
			scans: [{ provider: "heuristic", raw_score: 0.1, raw_response: null }],
		}));
		expect(res.status).toBe(200);

		const row = await env.hello_cf_spa_db
			.prepare("SELECT last_scanned_click_count FROM links WHERE id = ?")
			.bind(id)
			.first<{ last_scanned_click_count: number }>();
		// last_scanned_click_count must be updated to the current click_count (50)
		expect(row?.last_scanned_click_count).toBe(50);
	});

	it("scan-result for manual_override=1 also updates last_scanned_click_count (audit writeback)", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "burst-mo-wb",
			checked: 1,
			status: "active",
			clickCount: 60,
			lastScannedClickCount: 0,
			manualOverride: 1,
			createdAt: hoursAgoIso(3),
			lastCheckedAt: hoursAgoIso(3),
		});

		const res = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.99,
			status: "blocked",
			scans: [{ provider: "heuristic", raw_score: 0.99, raw_response: null }],
		}));
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean; applied: boolean; reason: string }>();
		expect(data.applied).toBe(false);
		expect(data.reason).toBe("manual_override");

		const row = await env.hello_cf_spa_db
			.prepare("SELECT last_scanned_click_count, status FROM links WHERE id = ?")
			.bind(id)
			.first<{ last_scanned_click_count: number; status: string }>();
		// status must be unchanged
		expect(row?.status).toBe("active");
		// last_scanned_click_count must be updated to current click_count (60) to prevent re-burst
		expect(row?.last_scanned_click_count).toBe(60);
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
		await linksKv.put("link:scan3", JSON.stringify({ id, user_id: userId, target_url: "https://example.com", is_active: 1, status: "active" }));

		await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.97,
			status: "blocked",
			scans: [{ provider: "heuristic", raw_score: 0.97, raw_response: null }],
		}));

		// KV should now contain the updated status (put, not delete — avoids eventual-consistency drift)
		const raw = await linksKv.get("link:scan3");
		expect(raw).not.toBeNull();
		const cached = JSON.parse(raw!);
		expect(cached.status).toBe("blocked");
	});

	it("returns { ok, applied: false, reason: manual_override } for manual_override=1 links", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		const { id } = await seedHexLink({
			userId,
			shortCode: "override2",
			checked: 0,
			status: "active",
			manualOverride: 1,
		});

		const res = await call(bearerRequest(`/api/internal/links/${id}/scan-result`, "POST", VALID_TOKEN, {
			aggregate_score: 0.97,
			status: "blocked",
			scans: [{ provider: "heuristic", raw_score: 0.97, raw_response: null }],
		}));
		expect(res.status).toBe(200);
		const data = await res.json<{ ok: boolean; applied: boolean; reason: string }>();
		expect(data.ok).toBe(true);
		expect(data.applied).toBe(false);
		expect(data.reason).toBe("manual_override");

		// links.status must be unchanged (still "active")
		const row = await env.hello_cf_spa_db
			.prepare("SELECT status FROM links WHERE id = ?")
			.bind(id)
			.first<{ status: string }>();
		expect(row?.status).toBe("active");

		// security_scans must still be inserted (audit-trail)
		const scans = await env.hello_cf_spa_db
			.prepare("SELECT COUNT(*) as count FROM security_scans WHERE link_id = ?")
			.bind(id)
			.first<{ count: number }>();
		expect(scans?.count).toBe(1);
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
		await linksKv.put("link:reeval1", JSON.stringify({
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
		const raw = await linksKv.get("link:reeval1");
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
		}>();
		expect(typeof data.queue_depth).toBe("number");
		expect(typeof data.links_scanned_24h).toBe("number");
		expect(typeof data.status_distribution).toBe("object");
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

	it("returns revalidation_aging in response structure", async () => {
		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ revalidation_aging: unknown }>();
		expect(typeof data.revalidation_aging).toBe("object");
	});

	it("revalidation_aging.active counts never_scanned correctly", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// Two active links with no last_checked_at → never_scanned
		await seedHexLink({ userId, shortCode: "ag1", checked: 1, status: "active", lastCheckedAt: null });
		await seedHexLink({ userId, shortCode: "ag2", checked: 1, status: "active", lastCheckedAt: null });
		// One active link with a recent last_checked_at → fresh
		const recentTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({ userId, shortCode: "ag3", checked: 1, status: "active", lastCheckedAt: recentTime });

		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ revalidation_aging: { active: { never_scanned: number; fresh_lt_7d: number } } }>();
		expect(data.revalidation_aging.active.never_scanned).toBe(2);
		expect(data.revalidation_aging.active.fresh_lt_7d).toBeGreaterThanOrEqual(1);
	});

	it("revalidation_aging.warning counts overdue_gt_24h correctly", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// One fresh warning link (< 24h)
		const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({ userId, shortCode: "wag1", checked: 1, status: "warning", lastCheckedAt: recentTime });
		// One overdue warning link (> 24h)
		const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", "");
		await seedHexLink({ userId, shortCode: "wag2", checked: 1, status: "warning", lastCheckedAt: oldTime });

		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ revalidation_aging: { warning: { fresh_lt_24h: number; overdue_gt_24h: number } } }>();
		expect(data.revalidation_aging.warning.fresh_lt_24h).toBe(1);
		expect(data.revalidation_aging.warning.overdue_gt_24h).toBe(1);
	});

	it("revalidation_aging excludes manual_override=1 links", async () => {
		const { userId } = await seedSession(env.hello_cf_spa_db);
		// manual_override=1 link — must NOT appear in aging histograms
		await seedHexLink({ userId, shortCode: "mo1", checked: 1, status: "active", manualOverride: 1, lastCheckedAt: null });
		// Regular active link
		await seedHexLink({ userId, shortCode: "reg1", checked: 1, status: "active", lastCheckedAt: null });

		const res = await call(bearerRequest("/api/internal/metrics"));
		expect(res.status).toBe(200);
		const data = await res.json<{ revalidation_aging: { active?: { never_scanned: number } } }>();
		// Only the regular link should count — manual_override=1 is excluded
		expect(data.revalidation_aging.active?.never_scanned).toBe(1);
	});
});
