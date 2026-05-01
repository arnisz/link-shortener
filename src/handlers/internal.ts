/**
 * Internal API handlers for the Wächter security scanner.
 * All endpoints require Bearer token authentication via WAECHTER_TOKEN.
 * Rate limit: 60 req/min per token.
 */
import type { Env } from "../types";
import { jsonResponse, errResponse, log } from "../utils";
import { checkRateLimit } from "../rateLimit";

/**
 * Validates the Bearer token from the Authorization header.
 * Returns true if valid, false otherwise.
 * Always returns generic 401 on mismatch — no detail about why.
 */
function validateBearerToken(request: Request, env: Env): boolean {
	const auth = request.headers.get("authorization") ?? "";
	if (!auth.startsWith("Bearer ")) return false;
	const token = auth.slice(7);
	return token === env.WAECHTER_TOKEN;
}

/**
 * Applies bearer auth + rate limit check (60 req/min per token).
 * Returns a Response on failure, null on success.
 */
async function authAndRateLimit(request: Request, env: Env): Promise<Response | null> {
	if (!validateBearerToken(request, env)) {
		log("INTERNAL_AUTH", "Unauthorized request to internal API");
		return errResponse("Unauthorized", 401);
	}
	const { allowed } = await checkRateLimit("internal:token", env.hello_cf_spa_db, 60);
	if (!allowed) {
		return errResponse("Too many requests", 429, { "Retry-After": "60" });
	}
	return null;
}

/** GET /api/internal/health — trivial boot check */
export async function handleInternalHealth(request: Request, env: Env): Promise<Response> {
	const authError = await authAndRateLimit(request, env);
	if (authError) return authError;
	return jsonResponse({ ok: true });
}

/** GET /api/internal/links/pending?limit=N — atomically claims unchecked/stale links */
export async function handleInternalLinksPending(request: Request, env: Env): Promise<Response> {
	const authError = await authAndRateLimit(request, env);
	if (authError) return authError;

	const url = new URL(request.url);
	const limitParam = parseInt(url.searchParams.get("limit") ?? "50", 10);
	const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 100);

	// Atomic claim: UPDATE … WHERE … RETURNING
	// Selects unchecked (checked=0) or stale (last_checked_at < 30 days ago),
	// not already claimed in the last 10 minutes, manual_override=0.
	let links: { id: string; short_code: string; target_url: string; created_at: string }[] = [];
	try {
		const result = await env.hello_cf_spa_db
			.prepare(
				`UPDATE links
				 SET claimed_at = datetime('now')
				 WHERE id IN (
				   SELECT id FROM links
				   WHERE manual_override = 0
				     AND (checked = 0 OR last_checked_at < datetime('now', '-30 days'))
				     AND (claimed_at IS NULL OR claimed_at < datetime('now', '-10 minutes'))
				   ORDER BY created_at ASC
				   LIMIT ?
				 )
				 RETURNING id, short_code, target_url, created_at`
			)
			.bind(limit)
			.all<{ id: string; short_code: string; target_url: string; created_at: string }>();
		links = result.results ?? [];
	} catch (e) {
		log("INTERNAL_ERR", `Failed to fetch pending links: ${String(e)}`);
		return errResponse("Internal server error", 500);
	}

	return jsonResponse({ links });
}

/** POST /api/internal/links/:id/scan-result — writes aggregated score + status + per-provider audit rows */
export async function handleInternalScanResult(id: string, request: Request, env: Env): Promise<Response> {
	const authError = await authAndRateLimit(request, env);
	if (authError) return authError;

	let body: {
		aggregate_score: number;
		status: "active" | "warning" | "blocked";
		scans: { provider: string; raw_score: number; raw_response: string | null }[];
	};
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	// Validate required fields
	if (
		typeof body.aggregate_score !== "number" ||
		body.aggregate_score < 0 || body.aggregate_score > 1
	) {
		return errResponse("aggregate_score must be a number between 0.0 and 1.0", 400);
	}
	if (!["active", "warning", "blocked"].includes(body.status)) {
		return errResponse("status must be one of: active, warning, blocked", 400);
	}
	if (!Array.isArray(body.scans) || body.scans.length === 0) {
		return errResponse("scans must be a non-empty array", 400);
	}
	for (const scan of body.scans) {
		if (typeof scan.provider !== "string" || scan.provider.length === 0) {
			return errResponse("Each scan must have a non-empty provider string", 400);
		}
		if (typeof scan.raw_score !== "number" || scan.raw_score < 0 || scan.raw_score > 1) {
			return errResponse("Each scan.raw_score must be a number between 0.0 and 1.0", 400);
		}
	}

	// 1. Update links row — only if manual_override = 0
	let short_code: string | null = null;
	let updatedLink: { short_code: string; target_url: string; is_active: number; expires_at: string | null; user_id: string | null } | null = null;
	try {
		updatedLink = await env.hello_cf_spa_db
			.prepare(
				`UPDATE links
				 SET checked = 1,
				     spam_score = ?,
				     status = ?,
				     last_checked_at = datetime('now'),
				     claimed_at = NULL
				 WHERE id = ? AND manual_override = 0
				 RETURNING short_code, target_url, is_active, expires_at, user_id`
			)
			.bind(body.aggregate_score, body.status, id)
			.first<{ short_code: string; target_url: string; is_active: number; expires_at: string | null; user_id: string | null }>();

		if (!updatedLink) {
			// Link not found or manual_override = 1
			log("INTERNAL", `scan-result: link id=${id} not found or manual_override=1`);
			return errResponse("Not found", 404);
		}
		short_code = updatedLink.short_code;
	} catch (e) {
		log("INTERNAL_ERR", `Failed to update link ${id}: ${String(e)}`);
		return errResponse("Internal server error", 500);
	}

	// 2. Insert security_scans rows (one per provider)
	try {
		const now = new Date().toISOString();
		const insertStmts = body.scans.map(scan =>
			env.hello_cf_spa_db
				.prepare(
					`INSERT INTO security_scans (link_id, provider, raw_score, raw_response, scanned_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(id, scan.provider, scan.raw_score, scan.raw_response ?? null, now)
		);
		if (insertStmts.length > 0) {
			await env.hello_cf_spa_db.batch(insertStmts);
		}
	} catch (e) {
		// Non-fatal: log and continue — link status was already written
		log("INTERNAL_ERR", `Failed to insert security_scans for link ${id}: ${String(e)}`);
	}

	// 3. KV cache update — write new status directly instead of deleting.
	// KV delete() is eventually consistent and may leave stale blocked/warning entries
	// at other edge nodes for up to ~60s. A put() with the updated payload propagates
	// the new status immediately and avoids the re-evaluation race condition.
	if (short_code && updatedLink && env.LINKS_KV) {
		try {
			await env.LINKS_KV.put(
				`link:${short_code}`,
				JSON.stringify({
					id,
					user_id: updatedLink.user_id,
					target_url: updatedLink.target_url,
					is_active: updatedLink.is_active,
					status: body.status,
					expires_at: updatedLink.expires_at,
				}),
				{ expirationTtl: 300 }
			);
		} catch (e) {
			log("INTERNAL_ERR", `Failed to update KV cache for ${short_code}: ${String(e)}`);
		}
	}

	log("INTERNAL", `scan-result written: id=${id} status=${body.status} score=${body.aggregate_score}`);
	return jsonResponse({ ok: true });
}

/** POST /api/internal/links/release-stale — releases claimed_at > 10 min */
export async function handleInternalReleaseStale(request: Request, env: Env): Promise<Response> {
	const authError = await authAndRateLimit(request, env);
	if (authError) return authError;

	let released = 0;
	try {
		const result = await env.hello_cf_spa_db
			.prepare(
				`UPDATE links
				 SET claimed_at = NULL
				 WHERE claimed_at IS NOT NULL
				   AND claimed_at < datetime('now', '-10 minutes')`
			)
			.run();
		released = result.meta?.changes ?? 0;
	} catch (e) {
		log("INTERNAL_ERR", `Failed to release stale claims: ${String(e)}`);
		return errResponse("Internal server error", 500);
	}

	log("INTERNAL", `release-stale: released=${released}`);
	return jsonResponse({ released });
}

/** GET /api/internal/metrics — queue depth, scans last 24h, status distribution */
export async function handleInternalMetrics(request: Request, env: Env): Promise<Response> {
	const authError = await authAndRateLimit(request, env);
	if (authError) return authError;

	try {
		const [queueRow, scansRow, distRows] = await env.hello_cf_spa_db.batch([
			env.hello_cf_spa_db.prepare(
				`SELECT COUNT(*) as count FROM links WHERE checked = 0 AND claimed_at IS NULL`
			),
			env.hello_cf_spa_db.prepare(
				`SELECT COUNT(*) as count FROM security_scans WHERE scanned_at > datetime('now', '-24 hours')`
			),
			env.hello_cf_spa_db.prepare(
				`SELECT status, COUNT(*) as count FROM links GROUP BY status`
			),
		]);

		const queue_depth = (queueRow.results?.[0] as { count: number } | undefined)?.count ?? 0;
		const links_scanned_24h = (scansRow.results?.[0] as { count: number } | undefined)?.count ?? 0;

		const status_distribution: Record<string, number> = { active: 0, warning: 0, blocked: 0 };
		for (const row of (distRows.results ?? []) as { status: string; count: number }[]) {
			status_distribution[row.status] = row.count;
		}

		return jsonResponse({
			queue_depth,
			links_scanned_24h,
			status_distribution,
			provider_quota_status: {},
		});
	} catch (e) {
		log("INTERNAL_ERR", `Failed to fetch metrics: ${String(e)}`);
		return errResponse("Internal server error", 500);
	}
}
