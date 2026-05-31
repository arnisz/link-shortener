import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/types";
import {
	makeRequest,
	seedLink,
	seedSession,
	setupAbuseReportsTable,
	setupClicksTable,
	setupLinksTable,
	setupRateLimitTable,
	setupSecurityScansTable,
	setupTestDb,
} from "./helpers";
import { ABUSE_HARD_LIMIT } from "../src/config";
import { generateCsrfToken } from "../src/csrf";

const BASE = "https://example.com";
const ADMIN_TOKEN = "test-admin-token";
const WAECHTER_TOKEN = "test-waechter-token";

async function call(req: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env as unknown as Env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

function reportRequest(
	code: string,
	opts: { asn?: number; ip?: string; origin?: string } = {}
): Request {
	const headers: Record<string, string> = {
		"CF-Connecting-IP": opts.ip ?? "1.1.1.1",
	};
	if (opts.origin) headers.Origin = opts.origin;
	return makeRequest(`${BASE}/api/report/${code}`, "POST", {
		headers,
		cf: opts.asn !== undefined ? { asn: opts.asn } : undefined,
	});
}

function internalScanRequest(id: string, status: "active" | "warning" | "blocked"): Request {
	return makeRequest(`${BASE}/api/internal/links/${id}/scan-result`, "POST", {
		headers: {
			Authorization: `Bearer ${WAECHTER_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			aggregate_score: 0.9,
			status,
			scans: [{ provider: "heuristic", raw_score: 0.9, raw_response: "{}" }],
		}),
	});
}

function adminPatchLinkRequest(id: string, sessionId: string, csrfToken: string, body: unknown): Request {
	return makeRequest(`${BASE}/api/admin/links/${id}`, "PATCH", {
		cookies: { "__Host-sid": sessionId },
		headers: {
			Authorization: `Bearer ${ADMIN_TOKEN}`,
			"X-CSRF-Token": csrfToken,
			Origin: BASE,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

async function clearKv(): Promise<void> {
	const kv = env.LINKS_KV!;
	const listed = await kv.list();
	await Promise.all(listed.keys.map((key) => kv.delete(key.name)));
}

describe("abuse reporting", () => {
	const db = env.hello_cf_spa_db;
	const kv = env.LINKS_KV!;

	beforeAll(async () => {
		await setupTestDb(db);
		await setupLinksTable(db);
		await setupRateLimitTable(db);
		await setupSecurityScansTable(db);
		await setupClicksTable(db);
		await setupAbuseReportsTable(db);
	});

	beforeEach(async () => {
		await db.prepare("DELETE FROM abuse_reports").run();
		await db.prepare("DELETE FROM security_scans").run();
		await db.prepare("DELETE FROM clicks").run();
		await db.prepare("DELETE FROM rate_limits").run();
		await db.prepare("DELETE FROM links").run();
		await db.prepare("DELETE FROM sessions").run();
		await db.prepare("DELETE FROM users").run();
		await clearKv();
		vi.restoreAllMocks();
	});

	it("records first report, keeps link active, and is CSRF-exempt", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abuse001", targetUrl: "https://target.example/one" });

		const res = await call(reportRequest("abuse001", { asn: 3320, origin: "https://evil.example" }));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count, status FROM links WHERE short_code = ?").bind("abuse001").first<{ abuse_flag_count: number; status: string }>();
		expect(row).toMatchObject({ abuse_flag_count: 1, status: "active" });

		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE asn = ?").bind("AS3320").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);

		const redirect = await call(makeRequest(`${BASE}/r/abuse001`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("https://target.example/one");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0]?.[0]).toBe(env.MAIL_NOTIFY_URL);
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			Authorization: `Bearer ${env.MAIL_NOTIFY_TOKEN}`,
			"Content-Type": "application/json",
		});
		const payload = JSON.parse(String(init?.body)) as {
			event: string;
			short_code: string;
			link_id: string;
			target_url: string;
			asn: string;
			abuse_flag_count: number;
			reported_at: string;
		};
		expect(payload).toMatchObject({
			event: "abuse_report",
			short_code: "abuse001",
			link_id: seeded.id,
			target_url: "https://target.example/one",
			asn: "AS3320",
			abuse_flag_count: 1,
		});
		expect(Number.isNaN(Date.parse(payload.reported_at))).toBe(false);
	});

	it("escalates on second distinct ASN, mirrors warning status, updates KV and warning redirect", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abuse002", targetUrl: "https://target.example/two" });

		await call(reportRequest("abuse002", { asn: 3320 }));
		await kv.put(
			"link:abuse002",
			JSON.stringify({
				id: seeded.id,
				user_id: userId,
				target_url: "https://target.example/two",
				is_active: 1,
				status: "active",
				expires_at: null,
				abuse_flag_count: 1,
				manual_override: 0,
			}),
			{ expirationTtl: 300 }
		);

		const res = await call(reportRequest("abuse002", { asn: 680 }));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count, status FROM links WHERE short_code = ?").bind("abuse002").first<{ abuse_flag_count: number; status: string }>();
		expect(row).toMatchObject({ abuse_flag_count: 2, status: "warning" });

		const cached = await kv.get("link:abuse002", "json") as { status: string; abuse_flag_count: number; manual_override: number } | null;
		expect(cached).toMatchObject({ status: "warning", abuse_flag_count: 2, manual_override: 0 });

		const redirect = await call(makeRequest(`${BASE}/r/abuse002`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("/warning?code=abuse002");

		const events = fetchSpy.mock.calls.map((callArgs) => JSON.parse(String(callArgs[1]?.body)).event);
		expect(events).toEqual(["abuse_report", "abuse_escalation"]);
	});

	it("deduplicates same ASN idempotently (no increment, no extra mail)", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abuse003" });

		await call(reportRequest("abuse003", { asn: 3320 }));
		fetchSpy.mockClear();

		const res = await call(reportRequest("abuse003", { asn: 3320 }));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abuse003").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("abuse003").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns uniform 404 for non-reportable links", async () => {
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abuse404a", isActive: 0 });
		await seedLink(db, { userId, shortCode: "abuse404b", status: "blocked" });
		await seedLink(db, { userId, shortCode: "abuse404c", expiresAt: new Date(Date.now() - 60_000).toISOString() });

		const cases = [
			reportRequest("does-not-exist"),
			reportRequest("abuse404a"),
			reportRequest("abuse404b"),
			reportRequest("abuse404c"),
		];
		for (const req of cases) {
			const res = await call(req);
			expect(res.status).toBe(404);
		}
	});

	it("caps abuse_flag_count at hard limit and does not spam mail above threshold/limit", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abusecap1" });

		for (let i = 1; i <= ABUSE_HARD_LIMIT + 2; i++) {
			const res = await call(reportRequest("abusecap1", { asn: 1000 + i, ip: `10.0.0.${i}` }));
			expect(res.status).toBe(200);
		}

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abusecap1").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(ABUSE_HARD_LIMIT);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("uses AS0 fallback when ASN is missing and deduplicates ASN-less reports", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abuseas0" });

		const first = await call(reportRequest("abuseas0", { ip: "20.0.0.1" }));
		const second = await call(reportRequest("abuseas0", { ip: "20.0.0.2" }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abuseas0").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("abuseas0").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);
	});

	it("mail 500 response does not affect report response or persistence", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("mail-down", { status: 500 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abusem500" });

		const res = await call(reportRequest("abusem500", { asn: 3320 }));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abusem500").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("abusem500").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("mail fetch rejection does not affect report response or persistence", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abusemrej" });

		const res = await call(reportRequest("abusemrej", { asn: 3320 }));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abusemrej").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("abusemrej").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("skips mail call when MAIL_NOTIFY_URL is empty", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abusemoff" });
		const originalUrl = env.MAIL_NOTIFY_URL;
		(env as unknown as { MAIL_NOTIFY_URL: string }).MAIL_NOTIFY_URL = "";

		try {
			const res = await call(reportRequest("abusemoff", { asn: 3320 }));
			expect(res.status).toBe(200);
		} finally {
			(env as unknown as { MAIL_NOTIFY_URL: string }).MAIL_NOTIFY_URL = originalUrl;
		}

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abusemoff").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("abusemoff").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(1);
		expect(fetchSpy).not.toHaveBeenCalled();

		const logLines = logSpy.mock.calls.map((args) => args.map((arg) => String(arg)).join(" "));
		expect(logLines.some((line) => line.includes("mail_failed"))).toBe(false);
	});

	it("mail failures do not affect abuse reporting response or persistence", async () => {
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abusemail" });
		const originalUrl = env.MAIL_NOTIFY_URL;
		(env as unknown as { MAIL_NOTIFY_URL: string }).MAIL_NOTIFY_URL = "://bad-url";

		try {
			const res = await call(reportRequest("abusemail", { asn: 3320 }));
			expect(res.status).toBe(200);
		} finally {
			(env as unknown as { MAIL_NOTIFY_URL: string }).MAIL_NOTIFY_URL = originalUrl;
		}

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("abusemail").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
	});

	it("escalates to warning and updates KV even when mail fetch rejects", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("mail endpoint unreachable"));
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abusemesc", targetUrl: "https://target.example/escalation" });

		const first = await call(reportRequest("abusemesc", { asn: 3320 }));
		const second = await call(reportRequest("abusemesc", { asn: 680 }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count, status FROM links WHERE short_code = ?").bind("abusemesc").first<{ abuse_flag_count: number; status: string }>();
		expect(row).toMatchObject({ abuse_flag_count: 2, status: "warning" });

		const cached = await kv.get("link:abusemesc", "json") as {
			id: string;
			status: string;
			abuse_flag_count: number;
		} | null;
		expect(cached).toMatchObject({ id: seeded.id, status: "warning", abuse_flag_count: 2 });

		const redirect = await call(makeRequest(`${BASE}/r/abusemesc`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("/warning?code=abusemesc");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("rate limits /api/report and fails open when rate_limits table is unavailable", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "abuserl1" });

		for (let i = 0; i < 20; i++) {
			const res = await call(reportRequest("abuserl1", { asn: 3320, ip: "99.99.99.99" }));
			expect([200, 404]).toContain(res.status);
		}
		const limited = await call(reportRequest("abuserl1", { asn: 3320, ip: "99.99.99.99" }));
		expect(limited.status).toBe(429);

		await db.prepare("DROP TABLE rate_limits").run();
		const failOpenRes = await call(reportRequest("abuserl1", { asn: 1337, ip: "1.2.3.4" }));
		expect(failOpenRes.status).toBe(200);
		await setupRateLimitTable(db);
	});

	it("applies abuse floor in internal scan-result: active verdict stays warning when abuse is high", async () => {
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abuseflr", status: "active", checked: 1, abuseFlagCount: 2 });

		const res = await call(internalScanRequest(seeded.id, "active"));
		expect(res.status).toBe(200);

		const row = await db.prepare("SELECT status FROM links WHERE id = ?").bind(seeded.id).first<{ status: string }>();
		expect(row?.status).toBe("warning");
		const scan = await db.prepare("SELECT provider FROM security_scans WHERE link_id = ?").bind(seeded.id).first<{ provider: string }>();
		expect(scan?.provider).toBe("heuristic");
	});

	it("internal scan-result still allows blocked to override abuse floor", async () => {
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abuseblk", status: "warning", checked: 1, abuseFlagCount: 2 });

		const res = await call(internalScanRequest(seeded.id, "blocked"));
		expect(res.status).toBe(200);
		const row = await db.prepare("SELECT status FROM links WHERE id = ?").bind(seeded.id).first<{ status: string }>();
		expect(row?.status).toBe("blocked");
	});

	it("without abuse floor, internal active verdict remains active", async () => {
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, { userId, shortCode: "abusenof", status: "warning", checked: 1, abuseFlagCount: 0 });

		const res = await call(internalScanRequest(seeded.id, "active"));
		expect(res.status).toBe(200);
		const row = await db.prepare("SELECT status FROM links WHERE id = ?").bind(seeded.id).first<{ status: string }>();
		expect(row?.status).toBe("active");
	});

	it("admin status override to active bypasses abuse warning branch", async () => {
		const { userId, sessionId } = await seedSession(db, { userId: "a0000000000000000000000000000002" });
		const seeded = await seedLink(db, {
			userId,
			shortCode: "abovr01",
			targetUrl: "https://target.example/override",
			status: "warning",
			checked: 1,
			abuseFlagCount: 2,
		});
		const csrfToken = generateCsrfToken(sessionId, env.SESSION_SECRET);

		const patchRes = await call(adminPatchLinkRequest(seeded.id, sessionId, csrfToken, { status: "active" }));
		expect(patchRes.status).toBe(200);

		const row = await db
			.prepare("SELECT status, manual_override, abuse_flag_count FROM links WHERE id = ?")
			.bind(seeded.id)
			.first<{ status: string; manual_override: number; abuse_flag_count: number }>();
		expect(row).toMatchObject({ status: "active", manual_override: 1, abuse_flag_count: 2 });

		const cached = await kv.get("link:abovr01", "json") as {
			status: string;
			abuse_flag_count: number;
			manual_override: number;
		} | null;
		expect(cached).toMatchObject({ status: "active", abuse_flag_count: 2, manual_override: 1 });

		const redirect = await call(makeRequest(`${BASE}/r/abovr01`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("https://target.example/override");
	});

	it("keeps abuse warning branch active when manual_override is 0", async () => {
		const { userId } = await seedSession(db);
		await seedLink(db, {
			userId,
			shortCode: "abusemo0",
			targetUrl: "https://target.example/manual0",
			status: "active",
			manualOverride: 0,
			abuseFlagCount: 2,
		});

		const redirect = await call(makeRequest(`${BASE}/r/abusemo0`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("/warning?code=abusemo0");
	});

	it("treats legacy KV payload without manual_override as manual_override=0", async () => {
		const { userId } = await seedSession(db);
		const seeded = await seedLink(db, {
			userId,
			shortCode: "abuseleg",
			targetUrl: "https://target.example/legacy",
			status: "active",
			abuseFlagCount: 2,
		});
		await kv.put(
			"link:abuseleg",
			JSON.stringify({
				id: seeded.id,
				user_id: userId,
				target_url: "https://target.example/legacy",
				is_active: 1,
				status: "active",
				expires_at: null,
				abuse_flag_count: 2,
			}),
			{ expirationTtl: 300 }
		);

		const redirect = await call(makeRequest(`${BASE}/r/abuseleg`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("/warning?code=abuseleg");
	});

	it("admin abuse reset to zero restores direct redirect when status is active", async () => {
		const { userId, sessionId } = await seedSession(db, { userId: "a0000000000000000000000000000003" });
		const seeded = await seedLink(db, {
			userId,
			shortCode: "abusera0",
			targetUrl: "https://target.example/reset-active",
			status: "active",
			checked: 1,
			abuseFlagCount: 2,
		});
		await db.prepare("INSERT INTO abuse_reports (link_id, asn, reported_at) VALUES (?, ?, ?)").bind(seeded.id, "AS3320", new Date().toISOString()).run();
		await db.prepare("INSERT INTO abuse_reports (link_id, asn, reported_at) VALUES (?, ?, ?)").bind(seeded.id, "AS680", new Date().toISOString()).run();
		await kv.put(
			"link:abusera0",
			JSON.stringify({
				id: seeded.id,
				user_id: userId,
				target_url: "https://target.example/reset-active",
				is_active: 1,
				status: "active",
				expires_at: null,
				abuse_flag_count: 2,
				manual_override: 0,
			}),
			{ expirationTtl: 300 }
		);
		const csrfToken = generateCsrfToken(sessionId, env.SESSION_SECRET);

		const patchRes = await call(adminPatchLinkRequest(seeded.id, sessionId, csrfToken, { abuse_flag_count: 0 }));
		expect(patchRes.status).toBe(200);

		const row = await db
			.prepare("SELECT abuse_flag_count, status, manual_override FROM links WHERE id = ?")
			.bind(seeded.id)
			.first<{ abuse_flag_count: number; status: string; manual_override: number }>();
		expect(row).toMatchObject({ abuse_flag_count: 0, status: "active", manual_override: 0 });
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = ?").bind(seeded.id).first<{ cnt: number }>();
		expect(reports?.cnt).toBe(0);

		const cached = await kv.get("link:abusera0", "json") as {
			status: string;
			abuse_flag_count: number;
			manual_override: number;
		} | null;
		expect(cached).toMatchObject({ status: "active", abuse_flag_count: 0, manual_override: 0 });

		const redirect = await call(makeRequest(`${BASE}/r/abusera0`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("https://target.example/reset-active");
	});

	// ─── Flood-Schutz (per ASN, geteilt mit Formular-Handler) ───
	// Diese Tests sichern die Architektur ab: checkFlood (Lesen) vor escalateReport,
	// setFlood (Schreiben) nur bei echtem neuen INSERT. escalateReport selbst kennt den
	// Flood-Key nicht (sonst würde sich Formular-Mehrfach-Kaskade selbst aussperren).

	it("FLOOD: API returns 429 on second report from same ASN on a different link", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "flood01a", targetUrl: "https://target.example/a" });
		await seedLink(db, { userId, shortCode: "flood01b", targetUrl: "https://target.example/b" });

		const first = await call(reportRequest("flood01a", { asn: 3320, ip: "5.5.5.1" }));
		expect(first.status).toBe(200);

		const second = await call(reportRequest("flood01b", { asn: 3320, ip: "5.5.5.2" }));
		expect(second.status).toBe(429);
		expect(second.headers.get("Retry-After")).toBe("600");

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("flood01b").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(0);

		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = (SELECT id FROM links WHERE short_code = ?)").bind("flood01b").first<{ cnt: number }>();
		expect(reports?.cnt).toBe(0);
	});

	it("FLOOD: API does NOT flood-429 a different ASN in the same window", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "flood02a" });
		await seedLink(db, { userId, shortCode: "flood02b" });

		const first = await call(reportRequest("flood02a", { asn: 3320, ip: "5.5.5.10" }));
		expect(first.status).toBe(200);

		const second = await call(reportRequest("flood02b", { asn: 680, ip: "5.5.5.11" }));
		expect(second.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("flood02b").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
	});

	it("FLOOD: idempotent re-report (same ASN, same link) does NOT consume the flood window", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "flood03a" });
		await seedLink(db, { userId, shortCode: "flood03b" });

		// erste Meldung setzt Flood-Key — danach Key löschen, um „nur Dedup verbraucht das Fenster nicht"
		// isoliert zu prüfen
		const first = await call(reportRequest("flood03a", { asn: 3320, ip: "5.5.5.20" }));
		expect(first.status).toBe(200);
		await env.LINKS_KV!.delete("report_flood:AS3320");

		// Re-Report → Dedup-Treffer, kein Increment, KEIN Flood-Key gesetzt
		const reReport = await call(reportRequest("flood03a", { asn: 3320, ip: "5.5.5.21" }));
		expect(reReport.status).toBe(200);
		expect(await env.LINKS_KV!.get("report_flood:AS3320")).toBeNull();

		// Folge-Report auf anderen Link aus derselben ASN → 200 (Re-Report hat das Fenster nicht verbraucht)
		const followUp = await call(reportRequest("flood03b", { asn: 3320, ip: "5.5.5.22" }));
		expect(followUp.status).toBe(200);
		const row = await db.prepare("SELECT abuse_flag_count FROM links WHERE short_code = ?").bind("flood03b").first<{ abuse_flag_count: number }>();
		expect(row?.abuse_flag_count).toBe(1);
	});

	it("FLOOD: uniform 404 — flood-state must not leak via status code on non-reportable links", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "flood04a" });
		await seedLink(db, { userId, shortCode: "flood04b", isActive: 0 });

		// Erste Meldung setzt den Flood-Key.
		const first = await call(reportRequest("flood04a", { asn: 3320, ip: "5.5.5.30" }));
		expect(first.status).toBe(200);

		// Geflooderter Request auf nicht-reportbaren Link → 404, NICHT 429 (Anti-Enumeration)
		const blocked = await call(reportRequest("flood04b", { asn: 3320, ip: "5.5.5.31" }));
		expect(blocked.status).toBe(404);

		// Genauso für nicht-existierenden Code
		const missing = await call(reportRequest("does-not-exist-xyz", { asn: 3320, ip: "5.5.5.32" }));
		expect(missing.status).toBe(404);
	});

	it("FLOOD: KV unavailable → checkFlood/setFlood fail open (no 429, reports persist)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 204 }));
		const { userId } = await seedSession(db);
		await seedLink(db, { userId, shortCode: "flood05a" });
		await seedLink(db, { userId, shortCode: "flood05b" });

		const originalKv = env.LINKS_KV;
		(env as unknown as { LINKS_KV: unknown }).LINKS_KV = undefined;
		try {
			const first = await call(reportRequest("flood05a", { asn: 3320, ip: "5.5.5.40" }));
			const second = await call(reportRequest("flood05b", { asn: 3320, ip: "5.5.5.41" }));
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
		} finally {
			(env as unknown as { LINKS_KV: unknown }).LINKS_KV = originalKv;
		}
	});

	it("admin abuse reset clears counter/reports but keeps warning status intact", async () => {
		const { userId, sessionId } = await seedSession(db, { userId: "a0000000000000000000000000000001" });
		const seeded = await seedLink(db, { userId, shortCode: "abuserst", status: "warning", checked: 1, abuseFlagCount: 2 });
		await db.prepare("INSERT INTO abuse_reports (link_id, asn, reported_at) VALUES (?, ?, ?)").bind(seeded.id, "AS3320", new Date().toISOString()).run();
		await db.prepare("INSERT INTO abuse_reports (link_id, asn, reported_at) VALUES (?, ?, ?)").bind(seeded.id, "AS680", new Date().toISOString()).run();
		await kv.put(
			"link:abuserst",
			JSON.stringify({
				id: seeded.id,
				user_id: userId,
				target_url: "https://example.com",
				is_active: 1,
				status: "warning",
				expires_at: null,
				abuse_flag_count: 2,
				manual_override: 0,
			}),
			{ expirationTtl: 300 }
		);
		const csrfToken = generateCsrfToken(sessionId, env.SESSION_SECRET);

		const patchRes = await call(adminPatchLinkRequest(seeded.id, sessionId, csrfToken, { abuse_flag_count: 0 }));
		expect(patchRes.status).toBe(200);

		const row = await db.prepare("SELECT abuse_flag_count, status FROM links WHERE id = ?").bind(seeded.id).first<{ abuse_flag_count: number; status: string }>();
		expect(row).toMatchObject({ abuse_flag_count: 0, status: "warning" });
		const reports = await db.prepare("SELECT COUNT(*) AS cnt FROM abuse_reports WHERE link_id = ?").bind(seeded.id).first<{ cnt: number }>();
		expect(reports?.cnt).toBe(0);

		const cached = await kv.get("link:abuserst", "json") as {
			abuse_flag_count: number;
			status: string;
			manual_override: number;
		} | null;
		expect(cached).toMatchObject({ abuse_flag_count: 0, status: "warning", manual_override: 0 });

		const redirect = await call(makeRequest(`${BASE}/r/abuserst`));
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("Location")).toBe("/warning?code=abuserst");
	});
});
