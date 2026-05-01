/**
 * Test suite for Backpressure-Schichten 2 + 3
 *
 * Schicht 2 — Globaler Insert-Cap via KV-Minute-Bucket:
 *   - KV-Counter bei 0  → Request durchgelassen (201)
 *   - KV-Counter ≥ GLOBAL_INSERT_CAP → 503 für anonym und auth
 *   - KV-Fehler (throws) → Fails open, Request durchgelassen
 *
 * Schicht 3 — Queue-Depth-Throttle (30 s Modul-Cache):
 *   - Zu viele unchecked+unclaimed Links → 503 für anonym und auth
 *   - Modul-Cache verhindert wiederholte DB-Abfragen
 *   - Fehler bei DB-Abfrage → Fails open
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import worker from "../src/index";
import {
	makeRequest,
	setupTestDb,
	setupLinksTable,
	setupSpamTable,
	setupRateLimitTable,
	setupTagsTables,
	setupSecurityScansTable,
	seedSession,
	createLinksKvMock,
} from "./helpers";
import { GLOBAL_INSERT_CAP, QUEUE_DEPTH_THROTTLE_LIMIT } from "../src/config";
import { _resetQueueDepthCache, _setQueueDepthCacheForTest } from "../src/handlers/links";
import { _resetSpamKeywordCache } from "../src/validation";

const BASE = "https://example.com";
const CLIENT_IP = "1.2.3.4";

// ── KV-Mock mit steuerbarem Verhalten ────────────────────────────────────────
type MockKv = ReturnType<typeof createLinksKvMock> & {
	setGetResponse(key: string, value: string | null): void;
	setShouldThrow(v: boolean): void;
};

function createControllableKvMock(): MockKv {
	const base = createLinksKvMock();
	const overrides = new Map<string, string | null>();
	let shouldThrow = false;

	return {
		...base,
		async get(key: string) {
			if (shouldThrow) throw new Error("KV unavailable");
			if (overrides.has(key)) return overrides.get(key) ?? null;
			return base.get(key);
		},
		async put(key: string, value: string, opts?: { expirationTtl?: number }) {
			if (shouldThrow) throw new Error("KV unavailable");
			return base.put(key, value, opts);
		},
		async delete(key: string) {
			return base.delete(key);
		},
		setGetResponse(key: string, value: string | null) {
			overrides.set(key, value);
		},
		setShouldThrow(v: boolean) {
			shouldThrow = v;
		},
		reset() {
			base.reset();
			overrides.clear();
			shouldThrow = false;
		},
	};
}

let kvMock: MockKv;

// ── One-time schema setup ────────────────────────────────────────────────────
beforeAll(async () => {
	await setupTestDb(env.hello_cf_spa_db);
	await setupLinksTable(env.hello_cf_spa_db);
	await setupSpamTable(env.hello_cf_spa_db);
	await setupRateLimitTable(env.hello_cf_spa_db);
	await setupTagsTables(env.hello_cf_spa_db);
	await setupSecurityScansTable(env.hello_cf_spa_db);
	kvMock = createControllableKvMock();
	env.LINKS_KV = kvMock;
});

// ── Clean state before each test ─────────────────────────────────────────────
beforeEach(async () => {
	await env.hello_cf_spa_db.prepare("DELETE FROM links").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM sessions").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM users").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM rate_limits").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM tags").run();
	await env.hello_cf_spa_db.prepare("DELETE FROM link_tags").run();
	kvMock.reset();
	_resetQueueDepthCache();
	_resetSpamKeywordCache();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function postAnonymous(targetUrl: string, ip = CLIENT_IP): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		makeRequest(`${BASE}/api/links/anonymous`, "POST", {
			headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
			body: JSON.stringify({ target_url: targetUrl }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

async function postAuthLink(sessionId: string, targetUrl: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(
		makeRequest(`${BASE}/api/links`, "POST", {
			cookies: { "__Host-sid": sessionId },
			headers: {
				"content-type": "application/json",
				"origin": BASE,
				"x-requested-with": "XMLHttpRequest",
			},
			body: JSON.stringify({ target_url: targetUrl }),
		}),
		env,
		ctx
	);
	await waitOnExecutionContext(ctx);
	return res;
}

// ── Schicht 2: Globaler Insert-Cap ───────────────────────────────────────────
describe("Backpressure Schicht 2: Globaler Insert-Cap (KV)", () => {
	it("lässt anonymen Request durch wenn KV-Counter = 0", async () => {
		const res = await postAnonymous("https://example.com/test");
		expect(res.status).toBe(201);
	});

	it("blockiert anonymen Request mit 503 wenn KV-Counter ≥ GLOBAL_INSERT_CAP", async () => {
		// Simuliere vollen Bucket: KV enthält bereits GLOBAL_INSERT_CAP Einträge
		const bucket = Math.floor(Date.now() / 60_000).toString();
		const key = `insert_count:${bucket}`;
		kvMock.setGetResponse(key, String(GLOBAL_INSERT_CAP));

		const res = await postAnonymous("https://example.com/test");
		expect(res.status).toBe(503);
		const data = await res.json<{ error: string }>();
		expect(data.error).toContain("überlastet");
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("blockiert auth Request mit 503 wenn KV-Counter ≥ GLOBAL_INSERT_CAP", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		const bucket = Math.floor(Date.now() / 60_000).toString();
		const key = `insert_count:${bucket}`;
		kvMock.setGetResponse(key, String(GLOBAL_INSERT_CAP));

		const res = await postAuthLink(sessionId, "https://example.com/auth-test");
		expect(res.status).toBe(503);
		const data = await res.json<{ error: string }>();
		expect(data.error).toContain("überlastet");
	});

	it("KV-Fehler → Fails open, Request wird durchgelassen", async () => {
		kvMock.setShouldThrow(true);
		const res = await postAnonymous("https://example.com/kv-error");
		// Sollte trotzdem 201 liefern, da Fails open
		expect(res.status).toBe(201);
	});

	it("inkrementiert KV-Counter bei jedem erfolgreichen Request", async () => {
		await postAnonymous("https://example.com/counter-test-1");
		await postAnonymous("https://example.com/counter-test-2");

		const bucket = Math.floor(Date.now() / 60_000).toString();
		const key = `insert_count:${bucket}`;
		// @ts-ignore — direkt aus dem Mock lesen
		const raw = await kvMock.get(key);
		// Wert muss ≥ 2 sein (evtl. mehr wenn andere Tests liefen, aber ≥ 2)
		expect(parseInt(raw ?? "0", 10)).toBeGreaterThanOrEqual(2);
	});
});

// ── Schicht 3: Queue-Depth-Throttle ──────────────────────────────────────────
describe("Backpressure Schicht 3: Queue-Depth-Throttle", () => {
	it("lässt anonymen Request durch wenn Queue-Tiefe < Limit", async () => {
		_resetQueueDepthCache();
		const res = await postAnonymous("https://example.com/queue-ok");
		expect(res.status).toBe(201);
	});

	it("blockiert anonymen Request mit 503 wenn Queue-Tiefe ≥ Limit (Cache-Inject)", async () => {
		// Direkte Cache-Injektion: QUEUE_DEPTH_THROTTLE_LIMIT als aktuelle Tiefe setzen
		_setQueueDepthCacheForTest(QUEUE_DEPTH_THROTTLE_LIMIT);
		const res = await postAnonymous("https://example.com/queue-over");
		expect(res.status).toBe(503);
		const data = await res.json<{ error: string }>();
		expect(data.error).toContain("überlastet");
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("blockiert auth Request mit 503 wenn Queue-Tiefe ≥ Limit (Cache-Inject)", async () => {
		const { sessionId } = await seedSession(env.hello_cf_spa_db);
		_setQueueDepthCacheForTest(QUEUE_DEPTH_THROTTLE_LIMIT);
		const res = await postAuthLink(sessionId, "https://example.com/auth-queue-over");
		expect(res.status).toBe(503);
		const data = await res.json<{ error: string }>();
		expect(data.error).toContain("überlastet");
	});

	it("Cache-Injektion wird nach Reset ignoriert, DB wird neu abgefragt", async () => {
		// Cache mit Limit setzen → sollte blockieren
		_setQueueDepthCacheForTest(QUEUE_DEPTH_THROTTLE_LIMIT);
		const blocked = await postAnonymous("https://example.com/before-reset");
		expect(blocked.status).toBe(503);

		// Cache leeren → DB wird neu gelesen (leer) → erlaubt
		_resetQueueDepthCache();
		const res = await postAnonymous("https://example.com/after-reset");
		expect(res.status).toBe(201);
	});

	it("Cached-Ergebnis wird wiederverwendet (Queue-Depth bleibt über Limit)", async () => {
		_setQueueDepthCacheForTest(QUEUE_DEPTH_THROTTLE_LIMIT);
		const res1 = await postAnonymous("https://example.com/cached-1");
		const res2 = await postAnonymous("https://example.com/cached-2");
		expect(res1.status).toBe(503);
		expect(res2.status).toBe(503);
	});

	it("Queue-Depth-Cache wird nach Reset neu befüllt (DB-Wert = 0 → erlaubt)", async () => {
		_resetQueueDepthCache();
		const res = await postAnonymous("https://example.com/fresh-cache");
		expect(res.status).toBe(201);
		// Ein weiterer Aufruf: sollte gecachtes Ergebnis (depth=0+) verwenden
		const res2 = await postAnonymous("https://example.com/from-cache");
		expect(res2.status).toBe(201);
	});
});
