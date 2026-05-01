import type { Env } from "../types";
import { errResponse, escapeHtml, log } from "../utils";
import { generateSignedToken, verifySignedToken } from "../csrf";
import { validateTargetUrl } from "../validation";

/**
 * GET /warning?code=:code
 *
 * Interstitial-Page for links with status='warning'.
 * Generates a short-lived bypass token and renders an HTML warning page.
 * The user must actively click "Proceed anyway" to follow the link.
 *
 * Security notes:
 * - `target_url` is always HTML-escaped (stored URLs are user-input).
 * - Token subject is `"warning:<code>"` — prevents cross-replay with session CSRF tokens.
 */
export async function handleWarning(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	if (!code || !/^[a-zA-Z0-9_-]{1,50}$/.test(code)) {
		return errResponse("Invalid or missing code", 400);
	}

	const link = await env.hello_cf_spa_db
		.prepare("SELECT target_url, status, is_active, expires_at FROM links WHERE short_code = ?")
		.bind(code)
		.first<{ target_url: string; status: string; is_active: number; expires_at: string | null }>();

	// Anti-enumeration: same 404 for not-found, inactive, expired, and non-warning links
	if (
		!link ||
		link.is_active === 0 ||
		link.status === "blocked" ||
		(link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now())
	) {
		return errResponse("Short link not found", 404);
	}

	// Only show the warning page for warning-status links
	if (link.status !== "warning") {
		// Redirect directly to /r/:code for active links
		return new Response(null, { status: 302, headers: { Location: `/r/${code}` } });
	}

	const token = generateSignedToken(`warning:${code}`, env.SESSION_SECRET);
	const safeTarget = escapeHtml(link.target_url);
	const safeCode = escapeHtml(code);
	// HTML-attribute context: use &amp; between query params to avoid invalid HTML
	const proceedUrl = `/warning/proceed?code=${encodeURIComponent(code)}&amp;t=${encodeURIComponent(token)}`;

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Security Warning — aadd.li</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 1rem; color: #222; }
  .warning-box { border: 2px solid #e65100; border-radius: 8px; padding: 1.5rem; background: #fff3e0; }
  h1 { color: #e65100; margin-top: 0; }
  .url { word-break: break-all; font-family: monospace; background: #f5f5f5; padding: .4rem .6rem; border-radius: 4px; font-size: .9rem; }
  .actions { margin-top: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
  .btn { padding: .6rem 1.2rem; border-radius: 6px; text-decoration: none; font-weight: 600; cursor: pointer; border: none; font-size: 1rem; }
  .btn-back { background: #1976d2; color: #fff; }
  .btn-proceed { background: #e65100; color: #fff; }
</style>
</head>
<body>
<div class="warning-box">
  <h1>⚠️ Security Warning</h1>
  <p>Our security scanner flagged this link as potentially harmful.</p>
  <p><strong>Destination:</strong></p>
  <p class="url">${safeTarget}</p>
  <p>Proceed only if you trust this destination.</p>
  <div class="actions">
    <a href="/" class="btn btn-back">← Go back safely</a>
    <a href="${proceedUrl}" class="btn btn-proceed">Proceed anyway</a>
  </div>
</div>
<p style="margin-top:2rem;font-size:.8rem;color:#666;">
  Short link: <code>aadd.li/r/${safeCode}</code>
</p>
</body>
</html>`;

	log("WARNING", `Showing interstitial for code="${code}"`);
	return new Response(html, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=UTF-8" },
	});
}

/**
 * GET /warning/proceed?code=:code&t=:token
 *
 * CSRF-token-protected bypass redirect for the warning interstitial page.
 * Verifies the signed token before issuing the 302 redirect.
 * Separate endpoint from /r/:code so the bypass protection cannot be circumvented.
 *
 * Phase 5b: logs bypass click (ASN + short_code + hour_bucket) via ctx.waitUntil.
 */
export async function handleWarningProceed(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const token = url.searchParams.get("t");

	if (!code || !/^[a-zA-Z0-9_-]{1,50}$/.test(code) || !token) {
		return errResponse("Invalid or missing parameters", 400);
	}

	if (!verifySignedToken(token, `warning:${code}`, env.SESSION_SECRET)) {
		log("WARNING", `Invalid or expired bypass token for code="${code}" reason=token_invalid`);
		return errResponse("Invalid or expired token", 403);
	}

	const link = await env.hello_cf_spa_db
		.prepare("SELECT target_url, status, is_active, expires_at FROM links WHERE short_code = ?")
		.bind(code)
		.first<{ target_url: string; status: string; is_active: number; expires_at: string | null }>();

	if (
		!link ||
		link.is_active === 0 ||
		link.status === "blocked" ||
		(link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now())
	) {
		return errResponse("Short link not found", 404);
	}

	// Only allow bypass for warning-status links
	if (link.status !== "warning") {
		return new Response(null, { status: 302, headers: { Location: `/r/${code}` } });
	}

	// Re-validate stored URL before redirect (SSRF guard)
	const validation = validateTargetUrl(link.target_url);
	if (!validation.ok) {
		log("WARNING", `Blocked invalid stored URL for code="${code}"`);
		return errResponse("Invalid redirect target", 500);
	}

	// Phase 5b: log bypass click (non-blocking)
	const asn = (request.cf?.asn as number | undefined) ?? null;
	const asnStr = asn !== null ? `AS${asn}` : null;
	const hourBucket = new Date().toISOString().slice(0, 13).replace("T", " "); // "YYYY-MM-DD HH"

	ctx.waitUntil((async () => {
		try {
			await env.hello_cf_spa_db
				.prepare("INSERT INTO bypass_clicks (short_code, asn, hour_bucket) VALUES (?, ?, ?)")
				.bind(code, asnStr, hourBucket)
				.run();
		} catch {
			// bypass_clicks table may not exist yet (Phase 5b migration not applied)
		}
	})());

	log("WARNING", `Bypass proceed for code="${code}"`);
	return new Response(null, { status: 302, headers: { Location: validation.url.href } });
}
