import type { Env } from "../types";
import { TARGET_URL_MAX_LEN, REPORT_FORM_NOTE_MAX_LEN } from "../config";
import { extractClientIp } from "../rateLimit";
import { errResponse, jsonResponse, log } from "../utils";
import { requireJson } from "../validation";
import { normalizeAsn, checkFlood, escalateReport, hasExistingAbuseReport, setFlood } from "./abuse";

type ReportableLink = {
	id: string;
	short_code: string;
	target_url: string;
	is_active: number;
	status: "active" | "warning" | "blocked";
	expires_at: string | null;
	user_id: string | null;
};

/**
 * Verifiziert ein Cloudflare Turnstile-Token serverseitig.
 * Nicht fails-open: Netzfehler → false (400 im Handler).
 */
async function verifyTurnstile(token: string, ip: string, env: Env): Promise<boolean> {
	try {
		const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				secret: env.TURNSTILE_SECRET_KEY,
				response: token,
				remoteip: ip,
			}),
		});
		if (!res.ok) return false;
		const data = await res.json() as { success: boolean };
		return data.success === true;
	} catch (e) {
		log("REPORT_FORM", `turnstile_verify_failed reason=${String(e)}`);
		return false;
	}
}

export async function handleReportForm(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON", 400);
	}

	if (typeof body !== "object" || body === null) {
		return errResponse("Invalid request body", 400);
	}

	const { url, note, turnstileToken } = body as { url?: unknown; note?: unknown; turnstileToken?: unknown };

	if (typeof url !== "string" || url.trim().length === 0) {
		return errResponse("url is required", 400);
	}
	if (url.trim().length > TARGET_URL_MAX_LEN) {
		return errResponse("url too long", 400);
	}
	if (note !== undefined && note !== null && typeof note !== "string") {
		return errResponse("note must be a string", 400);
	}
	if (typeof note === "string" && note.length > REPORT_FORM_NOTE_MAX_LEN) {
		return errResponse("note too long", 400);
	}
	if (typeof turnstileToken !== "string" || turnstileToken.trim().length === 0) {
		return errResponse("Turnstile token required", 400);
	}

	const rawInput = url.trim().slice(0, TARGET_URL_MAX_LEN);
	const ip = extractClientIp(request);

	// Turnstile verifizieren — nicht fails-open
	const turnstileOk = await verifyTurnstile(turnstileToken, ip, env);
	if (!turnstileOk) {
		return errResponse("Bot verification failed", 400);
	}

	const asn = normalizeAsn(request);

	// Input auflösen: aadd.li-Kurz-URL oder Ziel-URL
	const links: ReportableLink[] = [];
	let firstShortCode: string | null = null;

	try {
		const parsed = new URL(rawInput);
		const appBase = new URL(env.APP_BASE_URL);

		if (parsed.hostname === appBase.hostname && parsed.pathname.startsWith("/r/")) {
			// Kurz-URL: letztes Pfadsegment als short_code
			const code = parsed.pathname.split("/").pop() ?? "";
			if (code.length > 0) {
				const row = await env.hello_cf_spa_db
					.prepare(
						`SELECT id, short_code, target_url, is_active, status, expires_at, user_id
						 FROM links WHERE short_code = ?`
					)
					.bind(code)
					.first<ReportableLink>();
				if (
					row &&
					row.is_active !== 0 &&
					row.status !== "blocked" &&
					!(row.expires_at != null && new Date(row.expires_at).getTime() < Date.now())
				) {
					links.push(row);
				}
			}
		} else {
			// Ziel-URL: alle Treffer
			const rows = await env.hello_cf_spa_db
				.prepare(
					`SELECT id, short_code, target_url, is_active, status, expires_at, user_id
					 FROM links WHERE target_url = ?`
				)
				.bind(rawInput)
				.all<ReportableLink>();
			for (const row of rows.results ?? []) {
				if (
					row.is_active !== 0 &&
					row.status !== "blocked" &&
					!(row.expires_at != null && new Date(row.expires_at).getTime() < Date.now())
				) {
					links.push(row);
				}
			}
		}
	} catch {
		// Kein gültiges URL-Format — kein Treffer, trotzdem Audit + 200
	}

	if (links.length > 0) {
		firstShortCode = links[0].short_code;
	}

	if (links.length > 0 && await checkFlood(asn, env)) {
		return errResponse("Too many requests", 429, { "Retry-After": "600" });
	}

	const linksToEscalate: ReportableLink[] = [];
	for (const link of links) {
		if (!(await hasExistingAbuseReport(link.id, asn, env))) {
			linksToEscalate.push(link);
		}
	}

	let anyInserted = false;

	// Für jeden Treffer eskalieren
	for (const link of linksToEscalate) {
		const { inserted } = await escalateReport(link, asn, env, ctx);
		if (inserted) {
			anyInserted = true;
		}
	}

	if (anyInserted) {
		await setFlood(asn, env);
	}

	// Audit-Eintrag (eine Zeile pro Submission)
	const now = new Date().toISOString();
	ctx.waitUntil(
		env.hello_cf_spa_db
			.prepare(
				`INSERT INTO abuse_form_reports (ip, reported_at, short_code, raw_input)
				 VALUES (?, ?, ?, ?)`
			)
			.bind(ip, now, firstShortCode, rawInput)
			.run()
			.catch((e) => log("REPORT_FORM", `audit_insert_failed reason=${String(e)}`))
	);

	// Immer 200, neutrale Bestätigung (Anti-Enumeration)
	return jsonResponse({
		ok: true,
		message: `Danke, deine Meldung zu „${rawInput}" wurde entgegengenommen und wird geprüft.`,
	});
}
