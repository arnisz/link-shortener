import type { Env } from "../types";
import { TARGET_URL_MAX_LEN, TITLE_MAX_LEN, SHORT_CODE_GENERATION_RETRIES, TAG_MAX_PER_LINK } from "../config";
import { randomId, jsonResponse, errResponse, log } from "../utils";
import { generateShortCode, validateAlias, normalizeAlias, isValidFutureIso, requireJson, checkSpamFilter, validateTargetUrl, validateTag } from "../validation";
import { checkRateLimit } from "../rateLimit";
import { getSessionUser } from "../auth/session";
import { validateCsrfToken, validateMutationCsrf } from "../csrf";
import { getCookie, sanitizeReferrer } from "../utils";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Tries to generate a unique short code by retrying up to SHORT_CODE_GENERATION_RETRIES times.
 * Returns the code on success, or `null` when every candidate already exists in the DB.
 */
async function generateUniqueShortCode(db: D1Database): Promise<string | null> {
	for (let i = 0; i < SHORT_CODE_GENERATION_RETRIES; i++) {
		const candidate = generateShortCode();
		const existing = await db.prepare("SELECT id FROM links WHERE short_code = ?").bind(candidate).first();
		if (!existing) return candidate;
	}
	return null;
}

/**
 * Parses and validates a `tags` field from a request body.
 * Returns the deduplicated, normalised tag array on success,
 * or a ready-to-return error `Response` on failure.
 */
function parseTags(tags: unknown): { ok: true; tags: string[] } | { ok: false; response: Response } {
	if (!Array.isArray(tags)) {
		return { ok: false, response: errResponse("tags must be an array of strings", 400) };
	}
	if (tags.length > TAG_MAX_PER_LINK) {
		return { ok: false, response: errResponse(`Maximum ${TAG_MAX_PER_LINK} tags allowed per link`, 400) };
	}
	const tagSet = new Set<string>();
	for (const rawTag of tags) {
		const validation = validateTag(String(rawTag));
		if (!validation.ok) {
			return { ok: false, response: errResponse(validation.error, 400) };
		}
		tagSet.add(validation.name);
	}
	return { ok: true, tags: Array.from(tagSet) };
}

/** POST /api/links – creates a new shortened link. Requires authentication. */
export async function handleCreateLink(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	// 🔴 SICHERHEIT: Konsolidierte CSRF-Prüfung (P5-Fix)
	const csrfError = validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: { target_url?: unknown; title?: unknown; alias?: unknown; expires_at?: unknown; tags?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
	// P1-Fix: validateTargetUrl statt isValidHttpUrl für vollständigen SSRF-Schutz
	const targetValidation = targetUrl ? validateTargetUrl(targetUrl) : { ok: false as const, error: "empty" };
	if (!targetValidation.ok) {
		return errResponse("Invalid or missing target_url", 400);
	}
	if (targetUrl.length > TARGET_URL_MAX_LEN) {
		return errResponse(`target_url must not exceed ${TARGET_URL_MAX_LEN} characters`, 400);
	}

	const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
	if (rawTitle.length > TITLE_MAX_LEN) {
		return errResponse(`title must not exceed ${TITLE_MAX_LEN} characters`, 400);
	}
	const title: string | null = rawTitle || null;

	let expiresAt: string | null = null;
	if (body.expires_at != null) {
		if (typeof body.expires_at !== "string" || !isValidFutureIso(body.expires_at)) {
			return errResponse("expires_at must be a valid future ISO date", 400);
		}
		expiresAt = new Date(body.expires_at).toISOString();
	}

	if (body.alias !== undefined && body.alias !== null && typeof body.alias !== "string") {
		return errResponse("alias must be a string", 400);
	}

	const normalizedAlias =
		typeof body.alias === "string"
			? normalizeAlias(body.alias)
			: "";

	let shortCode: string;

	if (normalizedAlias) {
		const aliasError = validateAlias(normalizedAlias);
		if (aliasError) {
			return errResponse(aliasError, 400);
		}

		const conflict = await env.hello_cf_spa_db
			.prepare("SELECT id FROM links WHERE short_code = ?")
			.bind(normalizedAlias)
			.first();

		if (conflict) {
			return errResponse("Alias already in use", 409);
		}

		shortCode = normalizedAlias;
	} else {
		// Auto-generate – retry up to SHORT_CODE_GENERATION_RETRIES times on collision
		const generated = await generateUniqueShortCode(env.hello_cf_spa_db);
		if (!generated) {
			return errResponse("Could not generate unique short code", 500);
		}
		shortCode = generated;
	}

	const id = await randomId(16);
	const now = new Date().toISOString();

	// Process tags if provided
	let normalizedTags: string[] = [];
	if (body.tags !== undefined) {
		const result = parseTags(body.tags);
		if (!result.ok) return result.response;
		normalizedTags = result.tags;
	}

	const batch: D1PreparedStatement[] = [];

	// 1. Insert link
	batch.push(
		env.hello_cf_spa_db
			.prepare(
				`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`
			)
			.bind(id, user.id, shortCode, targetUrl, title, now, now, expiresAt)
	);

	// 2. Insert tags and link_tags if present
	if (normalizedTags.length > 0) {
		for (const tagName of normalizedTags) {
			batch.push(
				env.hello_cf_spa_db
					.prepare("INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)")
					.bind(user.id, tagName)
			);
		}
	}

	await env.hello_cf_spa_db.batch(batch);

	if (normalizedTags.length > 0) {
		const junctionBatch: D1PreparedStatement[] = [];
		for (const tagName of normalizedTags) {
			junctionBatch.push(
				env.hello_cf_spa_db
					.prepare(`
						INSERT INTO link_tags (link_id, tag_id, user_id)
						SELECT ?, id, ? FROM tags WHERE user_id = ? AND name = ?
					`)
					.bind(id, user.id, user.id, tagName)
			);
		}
		await env.hello_cf_spa_db.batch(junctionBatch);
	}

	return jsonResponse({
		id,
		user_id: user.id,
		short_code: shortCode,
		target_url: targetUrl,
		title,
		created_at: now,
		updated_at: now,
		click_count: 0,
		expires_at: expiresAt,
		is_active: 1,
		tags: normalizedTags,
		short_url: `${env.APP_BASE_URL}/r/${shortCode}`
	}, 201);
}

/** GET /api/links – lists links for the authenticated user, newest first, with cursor-based pagination.
 *  Query params:
 *    cursor – "ISO|id" cursor string from a previous response's nextCursor field
 *    limit  – number of items to return (default 50, capped at 100)
 *  Response: { links: [...], nextCursor: string | null }
 */
export async function handleGetLinks(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	const url = new URL(request.url);
	const cursorParam = url.searchParams.get("cursor");
	const limitParam = url.searchParams.get("limit");
	const q = url.searchParams.get("q")?.trim().slice(0, 100) || null;
	const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

	const pipe = cursorParam ? cursorParam.indexOf("|") : -1;
	const cursorTs = pipe > 0 ? cursorParam!.slice(0, pipe) : null;
	const cursorId = pipe > 0 ? cursorParam!.slice(pipe + 1) : null;

	type LinkRow = {
		id: string;
		short_code: string;
		target_url: string;
		title: string | null;
		created_at: string;
		updated_at: string;
		click_count: number;
		expires_at: string | null;
		is_active: number;
	};

	let query = `SELECT id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active
				 FROM links WHERE user_id = ?`;
	const params: (string | number)[] = [user.id];

	if (q) {
		const term = `%${q.toLowerCase()}%`;
		query += ` AND (
			LOWER(short_code) LIKE ?
			OR LOWER(title) LIKE ?
			OR id IN (
				SELECT lt.link_id FROM link_tags lt
				JOIN tags t ON t.id = lt.tag_id
				WHERE lt.user_id = ? AND LOWER(t.name) LIKE ?
			)
		)`;
		params.push(term, term, user.id, term);
	}

	if (cursorTs && cursorId) {
		query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
		params.push(cursorTs, cursorTs, cursorId);
	}

	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
	params.push(limit + 1);

	const { results } = await env.hello_cf_spa_db.prepare(query).bind(...params).all<LinkRow>();

	const hasMore = results.length > limit;
	const links = hasMore ? results.slice(0, limit) : results;
	const last = links[links.length - 1];
	const nextCursor = hasMore && last ? `${last.created_at}|${last.id}` : null;

	// Fetch tags for all links in one batch
	const tagsMap: Record<string, string[]> = {};
	if (links.length > 0) {
		const linkIds = links.map(l => l.id);
		const placeholders = linkIds.map(() => "?").join(",");
		const tagsResult = await env.hello_cf_spa_db
			.prepare(`
				SELECT lt.link_id, t.name
				FROM link_tags lt
				JOIN tags t ON t.id = lt.tag_id
				WHERE lt.user_id = ? AND lt.link_id IN (${placeholders})
				ORDER BY t.name
			`)
			.bind(user.id, ...linkIds)
			.all<{ link_id: string; name: string }>();

		for (const row of tagsResult.results) {
			if (!tagsMap[row.link_id]) tagsMap[row.link_id] = [];
			tagsMap[row.link_id].push(row.name);
		}
	}

	return jsonResponse({
		links: links.map(l => ({
			...l,
			tags: tagsMap[l.id] || [],
			short_url: `${env.APP_BASE_URL}/r/${l.short_code}`
		})),
		nextCursor,
	});
}

/** POST /api/links/:code/update – updates title, alias, expires_at, and/or is_active. */
export async function handleUpdateLink(code: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	// 🔴 SICHERHEIT: Konsolidierte CSRF-Prüfung (P5-Fix)
	const csrfError = validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: { title?: unknown; alias?: unknown; expires_at?: unknown; is_active?: unknown; tags?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	// First, check if link exists and belongs to user to get the internal ID
	const existing = await env.hello_cf_spa_db
		.prepare("SELECT id FROM links WHERE short_code = ? AND user_id = ?")
		.bind(code, user.id)
		.first<{ id: string }>();

	if (!existing) {
		return errResponse("Link not found or access denied", 404);
	}
	const linkId = existing.id;

	const setClauses: string[] = [];
	const values: (string | number | null)[] = [];

	if (body.title !== undefined) {
		const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
		if (rawTitle.length > TITLE_MAX_LEN) {
			return errResponse(`title must not exceed ${TITLE_MAX_LEN} characters`, 400);
		}
		setClauses.push("title = ?");
		values.push(rawTitle || null);
	}

	if (body.alias !== undefined) {
		if (typeof body.alias !== "string") {
			return errResponse("alias must be a string", 400);
		}

		const normalizedAlias = normalizeAlias(body.alias);

		const aliasError = validateAlias(normalizedAlias);
		if (aliasError) {
			return errResponse(aliasError, 400);
		}

		const conflict = await env.hello_cf_spa_db
			.prepare("SELECT id FROM links WHERE short_code = ? AND short_code != ?")
			.bind(normalizedAlias, code)
			.first<{ id: string }>();
		if (conflict) {
			return errResponse("Alias already in use", 409);
		}

		setClauses.push("short_code = ?");
		values.push(normalizedAlias);
	}

	if (body.expires_at !== undefined) {
		if (body.expires_at === null) {
			setClauses.push("expires_at = ?");
			values.push(null);
		} else if (typeof body.expires_at === "string" && isValidFutureIso(body.expires_at)) {
			setClauses.push("expires_at = ?");
			values.push(new Date(body.expires_at).toISOString());
		} else {
			return errResponse("expires_at must be null or a valid future ISO date", 400);
		}
	}

	if (body.is_active !== undefined) {
		if (body.is_active !== true && body.is_active !== false && body.is_active !== 0 && body.is_active !== 1) {
			return errResponse("is_active must be a boolean or 0/1", 400);
		}
		setClauses.push("is_active = ?");
		values.push(body.is_active ? 1 : 0);
	}

	let normalizedTags: string[] | null = null;
	if (body.tags !== undefined) {
		const result = parseTags(body.tags);
		if (!result.ok) return result.response;
		normalizedTags = result.tags;
	}

	if (setClauses.length === 0 && normalizedTags === null) {
		return errResponse("Nothing to update", 400);
	}

	const batch: D1PreparedStatement[] = [];

	if (setClauses.length > 0) {
		setClauses.push("updated_at = ?");
		values.push(new Date().toISOString(), code, user.id);
		batch.push(
			env.hello_cf_spa_db
				.prepare(`UPDATE links SET ${setClauses.join(", ")} WHERE short_code = ? AND user_id = ?`)
				.bind(...values)
		);
	} else if (normalizedTags !== null) {
		// If only tags changed, still update updated_at
		batch.push(
			env.hello_cf_spa_db
				.prepare(`UPDATE links SET updated_at = ? WHERE id = ? AND user_id = ?`)
				.bind(new Date().toISOString(), linkId, user.id)
		);
	}

	if (normalizedTags !== null) {
		// 1. Clear existing link_tags
		batch.push(
			env.hello_cf_spa_db
				.prepare("DELETE FROM link_tags WHERE link_id = ? AND user_id = ?")
				.bind(linkId, user.id)
		);

		// 2. Insert new tags (OR IGNORE)
		for (const tagName of normalizedTags) {
			batch.push(
				env.hello_cf_spa_db
					.prepare("INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)")
					.bind(user.id, tagName)
			);
		}

		// 3. Link them
		for (const tagName of normalizedTags) {
			batch.push(
				env.hello_cf_spa_db
					.prepare(`
						INSERT INTO link_tags (link_id, tag_id, user_id)
						SELECT ?, id, ? FROM tags WHERE user_id = ? AND name = ?
					`)
					.bind(linkId, user.id, user.id, tagName)
			);
		}

		// 4. Cleanup orphaned tags
		batch.push(
			env.hello_cf_spa_db
				.prepare(`
					DELETE FROM tags
					WHERE user_id = ?
					  AND id NOT IN (SELECT tag_id FROM link_tags WHERE user_id = ?)
				`)
				.bind(user.id, user.id)
		);
	}

	await env.hello_cf_spa_db.batch(batch);

	// P0-Fix: Wenn alias geändert wurde, hat sich der short_code geändert → neuen Code für Re-Fetch verwenden
	const fetchCode = (body.alias !== undefined && typeof body.alias === "string")
		? normalizeAlias(body.alias)
		: code;

	const updated = await env.hello_cf_spa_db
		.prepare(
			`SELECT id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active
			 FROM links WHERE short_code = ? AND user_id = ?`
		)
		.bind(fetchCode, user.id)
		.first<{
			id: string; short_code: string; target_url: string; title: string | null;
			created_at: string; updated_at: string; click_count: number;
			expires_at: string | null; is_active: number;
		}>();

	if (!updated) {
		return errResponse("Link not found after update", 404);
	}

	// Fetch tags for the response
	const tagRows = await env.hello_cf_spa_db
		.prepare(`
			SELECT t.name FROM tags t
			JOIN link_tags lt ON t.id = lt.tag_id
			WHERE lt.link_id = ? AND lt.user_id = ?
			ORDER BY t.name
		`)
		.bind(updated.id, user.id)
		.all<{ name: string }>();

	return jsonResponse({
		...updated,
		tags: tagRows.results.map(r => r.name),
		short_url: `${env.APP_BASE_URL}/r/${updated.short_code}`
	});
}

/** POST /api/links/:code/delete – permanently removes a link owned by the user. */
export async function handleDeleteLink(code: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	// 🔴 SICHERHEIT: Konsolidierte CSRF-Prüfung (P5-Fix)
	const csrfError = validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	// 🔴 SICHERHEIT: user_id DIREKT in WHERE-Clause
	// Atomic operation verhindert TOCTOU Race Conditions
	const result = await env.hello_cf_spa_db
		.prepare(
			`DELETE FROM links WHERE short_code = ? AND user_id = ?`
		)
		.bind(code, user.id)
		.run();

	// Bewusst KEINE Unterscheidung zwischen "Not found" und "Forbidden" (404)
	// Verhindert User Enumeration Attacken via Statuscode
	if (result.meta.changes === 0) {
		return errResponse("Link not found or access denied", 404);
	}

	// Cleanup orphaned tags for this user
	await env.hello_cf_spa_db
		.prepare(`
			DELETE FROM tags
			WHERE user_id = ?
			  AND id NOT IN (SELECT tag_id FROM link_tags WHERE user_id = ?)
		`)
		.bind(user.id, user.id)
		.run();

	return jsonResponse({ ok: true });
}

/** POST /api/links/anonymous – creates a short link without authentication.
 *  - Uses only target_url and always applies a hard 48 h expiry.
 *  - Subject to spam filter and IP-based rate limiting (10 req/min).
 *  - user_id is stored as NULL.
 */
export async function handleCreateAnonymousLink(request: Request, env: Env): Promise<Response> {
	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: { target_url?: unknown; tags?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	if (body.tags !== undefined) {
		return errResponse("Anonymous links cannot have tags", 400);
	}

	const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
	// 🔴 SICHERHEIT: validateTargetUrl statt isValidHttpUrl für vollständigen SSRF-Schutz
	const targetValidation = targetUrl ? validateTargetUrl(targetUrl) : { ok: false as const, error: "empty" };
	if (!targetValidation.ok) {
		return errResponse("Invalid or missing target_url", 400);
	}
	if (targetUrl.length > TARGET_URL_MAX_LEN) {
		return errResponse(`target_url must not exceed ${TARGET_URL_MAX_LEN} characters`, 400);
	}

	const isSpam = await checkSpamFilter(targetUrl, env.hello_cf_spa_db);
	if (isSpam) {
		return errResponse("URL nicht zulässig", 422);
	}

	const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
	const { allowed } = await checkRateLimit(ip, env.hello_cf_spa_db);
	if (!allowed) {
		return errResponse("Zu viele Anfragen. Bitte warte eine Minute.", 429, { "Retry-After": "60" });
	}

	// Auto-generate short code with collision retry
	const shortCode = await generateUniqueShortCode(env.hello_cf_spa_db);
	if (!shortCode) {
		return errResponse("Could not generate unique short code", 500);
	}

	const id = await randomId(16);
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

	await env.hello_cf_spa_db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active)
			 VALUES (?, NULL, ?, ?, NULL, ?, ?, 0, ?, 1)`
		)
		.bind(id, shortCode, targetUrl, now, now, expiresAt)
		.run();

	return jsonResponse({
		short_url: `${env.APP_BASE_URL}/r/${shortCode}`,
		expires_at: expiresAt,
	}, 201);
}

/** GET /r/:code – redirects to the target URL; increments click count asynchronously. */
export async function handleRedirect(code: string, env: Env, ctx: ExecutionContext, request: Request): Promise<Response> {
				// Rate-limit redirect lookups to prevent short-code enumeration (60/min per IP).
				const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
				const { allowed } = await checkRateLimit(`redirect:${ip}`, env.hello_cf_spa_db, 60);
				if (!allowed) {
					return errResponse("Too many requests", 429, { "Retry-After": "60" });
				}

				// --- Hot-Path mit KV-Cache (TTL 300s) ---
				let cache: { id: string; user_id: string | null; target_url: string; is_active: number; status?: string; expires_at?: string } | null = null;
				try {
					const raw = await env.LINKS_KV.get(`link:${code}`);
					if (raw) {
						cache = JSON.parse(raw);
					}
				} catch {}

				let link: { id: string; user_id: string | null; target_url: string; is_active: number; status?: string; expires_at?: string } | null = null;
				if (cache) {
					link = cache;
				} else {
					// Fallback: DB-Query
					link = await env.hello_cf_spa_db
						.prepare("SELECT id, user_id, target_url, is_active, status, expires_at FROM links WHERE short_code = ?")
						.bind(code)
						.first();
					if (link) {
						// Write to KV for next time (inkl. id + user_id für async click-count)
						ctx.waitUntil(env.LINKS_KV.put(`link:${code}`,
							JSON.stringify({ id: link.id, user_id: link.user_id, target_url: link.target_url, is_active: link.is_active, status: link.status, expires_at: link.expires_at }),
							{ expirationTtl: 300 }
						));
					}
				}

				if (!link) {
					log("REDIRECT", `Not found: code=\"${code}\"`);
					return errResponse("Short link not found", 404);
				}

				// Hot-Path Status-Hierarchie (User-Intent vor System-Intent)
				if (link.is_active === 0) {
					log("REDIRECT", `Inactive: code=\"${code}\"`);
					return errResponse("Short link not found", 404);
				}
				if (link.status === "blocked") {
					log("REDIRECT", `Blocked: code=\"${code}\"`);
					return errResponse("Short link not found", 404);
				}
				if (link.status === "warning") {
					log("REDIRECT", `Warning: code=\"${code}\"`);
					// Interstitial-Page (noch nicht implementiert)
					return new Response(null, { status: 302, headers: { Location: `/warning?code=${code}` } });
				}
				if (link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now()) {
					log("REDIRECT", `Expired: code=\"${code}\"`);
					return errResponse("Short link not found", 404);
				}

				// 🔴 SICHERHEIT: Strikte URL-Validierung auch bei Redirect
				const validation = validateTargetUrl(link.target_url);
				if (!validation.ok) {
					log('redirect', `Blocked invalid stored URL for code ${code}`);
					return errResponse('Invalid redirect target', 500);
				}
				const destination = validation.url.href;

				const ts = Math.floor(Date.now() / 1000);
				const country = (request.cf?.country as string) || null;
				const asn = (request.cf?.asn as number) || null;
				const asnOrg = (request.cf?.asOrganization as string) || null;
				const referrerHost = sanitizeReferrer(request.headers.get("Referer"));

				ctx.waitUntil((async () => {
					try {
						await env.hello_cf_spa_db
							.prepare("UPDATE links SET click_count = click_count + 1, updated_at = ? WHERE id = ?")
							.bind(new Date().toISOString(), link.id)
							.run();
					} catch (e) {
						log("REDIRECT_ERR", `Failed to update click count `);
					}
				})());

				ctx.waitUntil((async () => {
					try {
						await env.hello_cf_spa_db
							.prepare(`INSERT INTO clicks (ts, link_id, user_id, country, asn, asn_org, referrer_host) VALUES (?, ?, ?, ?, ?, ?, ?)`)
							.bind(ts, link.id, link.user_id, country, asn, asnOrg, referrerHost)
							.run();
					} catch (e) {
						log("REDIRECT_ERR", `Failed to insert click log for link ${link.id}: ${e}`);
					}
				})());

				return new Response(null, { status: 302, headers: { Location: destination } });
}
