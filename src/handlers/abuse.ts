import type { Env } from "../types";
import { ABUSE_HARD_LIMIT, ABUSE_REPORT_RATE_LIMIT, ABUSE_WARN_THRESHOLD, REPORT_FLOOD_WINDOW_S } from "../config";
import { checkRateLimit, extractClientIp } from "../rateLimit";
import { errResponse, jsonResponse, log } from "../utils";

type ReportableLink = {
	id: string;
	short_code: string;
	target_url: string;
	is_active: number;
	status: "active" | "warning" | "blocked";
	expires_at: string | null;
	user_id: string | null;
};

export function normalizeAsn(request: Request): string {
	const asn = (request as Request & { cf?: { asn?: number } }).cf?.asn;
	if (typeof asn === "number" && Number.isFinite(asn) && asn > 0) {
		return `AS${Math.trunc(asn)}`;
	}
	return "AS0";
}

/**
 * Prüft, ob der Flood-Key für eine ASN bereits gesetzt ist.
 * Fails open bei KV-Fehlern.
 */
export async function checkFlood(asn: string, env: Env): Promise<boolean> {
	if (!env.LINKS_KV) return false;
	try {
		const key = `report_flood:${asn}`;
		const existing = await env.LINKS_KV.get(key);
		return existing !== null;
	} catch {
		return false;
	}
}

/**
 * Setzt den Flood-Key für eine ASN (10-Minuten-Fenster).
 * Fails open bei KV-Fehlern.
 */
export async function setFlood(asn: string, env: Env): Promise<void> {
	if (!env.LINKS_KV) return;
	try {
		const key = `report_flood:${asn}`;
		await env.LINKS_KV.put(key, "1", { expirationTtl: REPORT_FLOOD_WINDOW_S });
	} catch {
		// fails open
	}
}

export async function hasExistingAbuseReport(linkId: string, asn: string, env: Env): Promise<boolean> {
	const row = await env.hello_cf_spa_db
		.prepare("SELECT 1 AS exists_flag FROM abuse_reports WHERE link_id = ? AND asn = ? LIMIT 1")
		.bind(linkId, asn)
		.first<{ exists_flag: number }>();
	return row != null;
}

/**
 * Kern der Abuse-Eskalationskaskade: INSERT OR IGNORE (ASN-Dedup), UPDATE RETURNING
 * (Increment + Status-Mirror + Hard-Cap), KV-put bei Eskalation, Mail via waitUntil.
 * Flood-Handling erfolgt in den Handlern (checkFlood/setFlood), nicht hier.
 * Wiederverwendbar für API- und Formular-Handler.
 */
export async function escalateReport(
	link: { id: string; short_code: string; target_url: string; is_active: number; status: string; expires_at: string | null; user_id: string | null },
	asn: string,
	env: Env,
	ctx: ExecutionContext
): Promise<{ inserted: boolean }> {
	const now = new Date().toISOString();

	const insert = await env.hello_cf_spa_db
		.prepare(
			`INSERT OR IGNORE INTO abuse_reports (link_id, asn, reported_at)
			 VALUES (?, ?, ?)`
		)
		.bind(link.id, asn, now)
		.run();

	if ((insert.meta?.changes ?? 0) === 0) {
		// ASN bereits bekannt für diesen Link — idempotent
		return { inserted: false };
	}

	const updated = await env.hello_cf_spa_db
		.prepare(
			`UPDATE links
			 SET abuse_flag_count = MIN(abuse_flag_count + 1, ?),
			     status = CASE
			               WHEN status = 'active' AND abuse_flag_count + 1 >= ? THEN 'warning'
			               ELSE status
			             END,
			     updated_at = ?
			 WHERE id = ?
			 RETURNING id, short_code, target_url, is_active, status, expires_at, user_id, abuse_flag_count, manual_override`
		)
		.bind(ABUSE_HARD_LIMIT, ABUSE_WARN_THRESHOLD, now, link.id)
		.first<{
			id: string;
			short_code: string;
			target_url: string;
			is_active: number;
			status: "active" | "warning" | "blocked";
			expires_at: string | null;
			user_id: string | null;
			abuse_flag_count: number;
			manual_override: number;
		}>();

	if (!updated) return { inserted: true };

	const newCount = updated.abuse_flag_count;
	const reachedWarnThreshold = newCount === ABUSE_WARN_THRESHOLD;

	if (reachedWarnThreshold && env.LINKS_KV) {
		try {
			await env.LINKS_KV.put(
				`link:${updated.short_code}`,
				JSON.stringify({
					id: updated.id,
					user_id: updated.user_id,
					target_url: updated.target_url,
					is_active: updated.is_active,
					status: updated.status,
					expires_at: updated.expires_at,
					abuse_flag_count: newCount,
					manual_override: updated.manual_override,
				}),
				{ expirationTtl: 300 }
			);
		} catch (e) {
			log("ABUSE", `kv_put_failed code=${updated.short_code} reason=${String(e)}`);
		}
	}

	if ((newCount === 1 || reachedWarnThreshold) && newCount <= ABUSE_HARD_LIMIT) {
		const event = newCount === 1 ? "abuse_report" : "abuse_escalation";
		ctx.waitUntil((async () => {
			if (!env.MAIL_NOTIFY_URL) {
				return;
			}
			try {
				const res = await fetch(env.MAIL_NOTIFY_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${env.MAIL_NOTIFY_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						event,
						short_code: updated.short_code,
						link_id: updated.id,
						target_url: updated.target_url,
						asn,
						abuse_flag_count: newCount,
						reported_at: now,
					}),
				});
				if (!res.ok) {
					log("ABUSE", `mail_failed code=${updated.short_code} status=${res.status}`);
				}
			} catch (e) {
				log("ABUSE", `mail_failed code=${updated.short_code} reason=${String(e)}`);
			}
		})());
	}

	if (newCount === ABUSE_HARD_LIMIT) {
		log("ABUSE", `hard_limit_reached code=${updated.short_code}`);
	}
	if (reachedWarnThreshold) {
		log("ABUSE", `abuse_escalation code=${updated.short_code} count=${newCount}`);
	} else {
		log("ABUSE", `abuse_report code=${updated.short_code} count=${newCount}`);
	}

	return { inserted: true };
}

export async function handleReportAbuse(
	code: string,
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const ip = extractClientIp(request);
	const { allowed } = await checkRateLimit(`report:${ip}`, env.hello_cf_spa_db, ABUSE_REPORT_RATE_LIMIT);
	if (!allowed) {
		return errResponse("Too many requests", 429, { "Retry-After": "60" });
	}

	const asn = normalizeAsn(request);

	const link = await env.hello_cf_spa_db
		.prepare(
			`SELECT id, short_code, target_url, is_active, status, expires_at, user_id
			 FROM links
			 WHERE short_code = ?`
		)
		.bind(code)
		.first<ReportableLink>();

	if (
		!link ||
		link.is_active === 0 ||
		link.status === "blocked" ||
		(link.expires_at != null && new Date(link.expires_at).getTime() < Date.now())
	) {
		return errResponse("Not found", 404);
	}

	if (await hasExistingAbuseReport(link.id, asn, env)) {
		return jsonResponse({ ok: true });
	}

	if (await checkFlood(asn, env)) {
		return errResponse("Too many requests", 429, { "Retry-After": String(REPORT_FLOOD_WINDOW_S) });
	}

	const { inserted } = await escalateReport(link, asn, env, ctx);
	if (inserted) {
		await setFlood(asn, env);
	}

	return jsonResponse({ ok: true });
}
