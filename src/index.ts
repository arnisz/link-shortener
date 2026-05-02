import type { Env } from "./types";
import { handleGetMe, handleLogout, handleLogin, handleGoogleCallback } from "./handlers/auth";
import { handleCreateLink, handleGetLinks, handleUpdateLink, handleDeleteLink, handleRedirect, handleCreateAnonymousLink } from "./handlers/links";
import { handleInternalHealth, handleInternalLinksPending, handleInternalScanResult, handleInternalReleaseStale, handleInternalMetrics, handleInternalUpdateUrlhaus } from "./handlers/internal";
import { handleWarning, handleWarningProceed } from "./handlers/warning";
import { applySecurityHeaders, errResponse, log } from "./utils";
import { validateCsrf } from "./csrf";

async function router(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const { pathname, method } = { pathname: url.pathname, method: request.method };

	// ── CSRF protection: reject cross-origin POST requests ────────────────────
	if (!validateCsrf(request, env)) {
		return errResponse("CSRF validation failed", 403);
	}

	if (pathname === "/login" && method === "GET")
	{
		return handleLogin(request, env);
	}
	if (pathname === "/api/auth/google/callback" && method === "GET")
	{
		return handleGoogleCallback(request, env);
	}
	if (pathname === "/api/me" && method === "GET")                        return handleGetMe(request, env);
	if (pathname === "/logout" && method === "POST")                       return handleLogout(request, env);
	if (pathname === "/api/links/anonymous" && method === "POST") return handleCreateAnonymousLink(request, env);
	if (pathname === "/api/links" && method === "POST") return handleCreateLink(request, env);
	if (pathname === "/api/links" && method === "GET")  return handleGetLinks(request, env);

	// --- Interne Wächter-API ---
	if (pathname === "/api/internal/health" && method === "GET") {
		return handleInternalHealth(request, env);
	}
	if (pathname === "/api/internal/links/pending" && method === "GET") {
		return handleInternalLinksPending(request, env);
	}
	const scanResultMatch = pathname.match(/^\/api\/internal\/links\/([0-9a-f]{32})\/scan-result$/);
	if (scanResultMatch && method === "POST") {
		return handleInternalScanResult(scanResultMatch[1], request, env);
	}
	if (pathname === "/api/internal/links/release-stale" && method === "POST") {
		return handleInternalReleaseStale(request, env);
	}
	if (pathname === "/api/internal/metrics" && method === "GET") {
		return handleInternalMetrics(request, env);
	}
	if (pathname === "/api/internal/kv/urlhaus" && method === "POST") {
		return handleInternalUpdateUrlhaus(request, env);
	}

	const updateMatch = pathname.match(/^\/api\/links\/([^/]+)\/update$/);
	if (updateMatch && method === "POST") return handleUpdateLink(updateMatch[1], request, env, ctx);

	const deleteMatch = pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
	if (deleteMatch && method === "POST") return handleDeleteLink(deleteMatch[1], request, env, ctx);

	const redirectMatch = pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
	if (redirectMatch && (method === "GET" || method === "HEAD"))
	{
		return handleRedirect(redirectMatch[1], env, ctx, request);
	}

	if (pathname === "/warning" && method === "GET") return handleWarning(request, env);
	if (pathname === "/warning/proceed" && method === "GET") return handleWarningProceed(request, env, ctx);

	return new Response("Not found", { status: 404 });
}

export default {
 	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
 		return applySecurityHeaders(await router(request, env, ctx));
 	},

	/** Scheduled cleanup: deletes expired anonymous links so their click logs are removed via ON DELETE CASCADE.
	 * Runs as a Cron Trigger. To configure, add a cron entry to wrangler.jsonc (example: daily).
	 */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const now = new Date().toISOString();
		const BATCH = 1000; // delete in chunks to avoid long-running transactions

		// ── 1. Expired anonymous links ────────────────────────────────────────
		let deleted = 0;
		let total = 0;
		try {
			do {
				const res = await env.hello_cf_spa_db
					.prepare(
						"DELETE FROM links WHERE id IN (SELECT id FROM links WHERE user_id IS NULL AND expires_at IS NOT NULL AND expires_at < ? LIMIT ? )"
					)
					.bind(now, BATCH)
					.run();
				deleted = res.meta?.changes ?? 0;
				total += deleted;
				if (deleted > 0) log("CLEANUP", `Deleted ${deleted} expired anonymous links`);
			} while (deleted === BATCH);
			if (total === 0) log("CLEANUP", "No expired anonymous links found");
			else log("CLEANUP", `Cleanup finished, total deleted=${total}`);
		} catch (e) {
			log("CLEANUP_ERR", `Scheduled cleanup failed: ${String(e)}`);
		}

		// ── 2. security_scans retention ───────────────────────────────────────
		// Low-risk scans (raw_score < 0.3): keep 7 days
		// High-risk scans (raw_score >= 0.3): keep 90 days
		try {
			let scanDeleted = 0;
			let scanTotal = 0;
			do {
				const res = await env.hello_cf_spa_db
					.prepare(
						"DELETE FROM security_scans WHERE id IN (SELECT id FROM security_scans WHERE raw_score < 0.3 AND scanned_at < datetime('now', '-7 days') LIMIT ?)"
					)
					.bind(BATCH)
					.run();
				scanDeleted = res.meta?.changes ?? 0;
				scanTotal += scanDeleted;
				if (scanDeleted > 0) log("CLEANUP", `Deleted ${scanDeleted} low-risk security_scans (>7d)`);
			} while (scanDeleted === BATCH);

			scanDeleted = 0;
			do {
				const res = await env.hello_cf_spa_db
					.prepare(
						"DELETE FROM security_scans WHERE id IN (SELECT id FROM security_scans WHERE raw_score >= 0.3 AND scanned_at < datetime('now', '-90 days') LIMIT ?)"
					)
					.bind(BATCH)
					.run();
				scanDeleted = res.meta?.changes ?? 0;
				scanTotal += scanDeleted;
				if (scanDeleted > 0) log("CLEANUP", `Deleted ${scanDeleted} high-risk security_scans (>90d)`);
			} while (scanDeleted === BATCH);

			if (scanTotal === 0) log("CLEANUP", "No stale security_scans found");
			else log("CLEANUP", `security_scans cleanup finished, total deleted=${scanTotal}`);
		} catch (e) {
			log("CLEANUP_ERR", `security_scans cleanup failed: ${String(e)}`);
		}
	}
};
