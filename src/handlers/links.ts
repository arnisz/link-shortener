import type { Env } from "../types";
import { TARGET_URL_MAX_LEN, TITLE_MAX_LEN, SHORT_CODE_GENERATION_RETRIES } from "../config";
import { randomId, jsonResponse, errResponse, log } from "../utils";
import { isValidHttpUrl, validateAlias, isValidFutureIso, requireJson, generateShortCode } from "../validation";
import { getSessionUser } from "../auth/session";

/** POST /api/links – creates a new shortened link. Requires authentication. */
export async function handleCreateLink(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: { target_url?: unknown; title?: unknown; alias?: unknown; expires_at?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
	if (!targetUrl || !isValidHttpUrl(targetUrl)) {
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
			? body.alias
					.normalize("NFKC")
					.replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, "-")
					.trim()
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
		let generated = "";
		for (let i = 0; i < SHORT_CODE_GENERATION_RETRIES; i++) {
			const candidate = generateShortCode();
			const existing = await env.hello_cf_spa_db
				.prepare("SELECT id FROM links WHERE short_code = ?")
				.bind(candidate)
				.first();
			if (!existing) { generated = candidate; break; }
		}
		if (!generated) {
			return errResponse("Could not generate unique short code", 500);
		}
		shortCode = generated;
	}

	const id = await randomId(16);
	const now = new Date().toISOString();

	await env.hello_cf_spa_db
		.prepare(
			`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`
		)
		.bind(id, user.id, shortCode, targetUrl, title, now, now, expiresAt)
		.run();

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
		short_url: `${env.APP_BASE_URL}/r/${shortCode}`
	}, 201);
}

/** GET /api/links – lists all links for the authenticated user, newest first. */
export async function handleGetLinks(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	const { results } = await env.hello_cf_spa_db
		.prepare(
			`SELECT id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active
			 FROM links WHERE user_id = ? ORDER BY created_at DESC`
		)
		.bind(user.id)
		.all<{
			id: string;
			short_code: string;
			target_url: string;
			title: string | null;
			created_at: string;
			updated_at: string;
			click_count: number;
			expires_at: string | null;
			is_active: number;
		}>();

	return jsonResponse(results.map(l => ({ ...l, short_url: `${env.APP_BASE_URL}/r/${l.short_code}` })));
}

/** POST /api/links/:id/update – updates title, expires_at, and/or is_active. */
export async function handleUpdateLink(linkId: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	const owned = await env.hello_cf_spa_db
		.prepare("SELECT id FROM links WHERE id = ? AND user_id = ?")
		.bind(linkId, user.id)
		.first<{ id: string }>();
	if (!owned) {
		return errResponse("Link not found", 404);
	}

	let body: { title?: unknown; expires_at?: unknown; is_active?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

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

	if (body.expires_at !== undefined) {
		if (body.expires_at === null) {
			setClauses.push("expires_at = ?");
			values.push(null);
		} else if (typeof body.expires_at === "string" && isValidFutureIso(body.expires_at)) {
			setClauses.push("expires_at = ?");
			values.push(new Date(body.expires_at).toISOString());
		} else {
			return new Response(JSON.stringify({ error: "expires_at must be null or a valid future ISO date" }), {
				status: 400,
				headers: { "content-type": "application/json; charset=UTF-8" }
			});
		}
	}

	if (body.is_active !== undefined) {
		if (body.is_active !== true && body.is_active !== false && body.is_active !== 0 && body.is_active !== 1) {
			return new Response(JSON.stringify({ error: "is_active must be a boolean or 0/1" }), {
				status: 400,
				headers: { "content-type": "application/json; charset=UTF-8" }
			});
		}
		setClauses.push("is_active = ?");
		values.push(body.is_active ? 1 : 0);
	}

	if (setClauses.length === 0) {
		return errResponse("Nothing to update", 400);
	}

	setClauses.push("updated_at = ?");
	values.push(new Date().toISOString(), linkId, user.id);

	await env.hello_cf_spa_db
		.prepare(`UPDATE links SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`)
		.bind(...values)
		.run();

	const updated = await env.hello_cf_spa_db
		.prepare(
			`SELECT id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active
			 FROM links WHERE id = ?`
		)
		.bind(linkId)
		.first<{
			id: string; short_code: string; target_url: string; title: string | null;
			created_at: string; updated_at: string; click_count: number;
			expires_at: string | null; is_active: number;
		}>();

	return jsonResponse({ ...updated, short_url: `${env.APP_BASE_URL}/r/${updated!.short_code}` });
}

/** POST /api/links/:id/delete – permanently removes a link owned by the user. */
export async function handleDeleteLink(linkId: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	const owned = await env.hello_cf_spa_db
		.prepare("SELECT id FROM links WHERE id = ? AND user_id = ?")
		.bind(linkId, user.id)
		.first<{ id: string }>();
	if (!owned) {
		return errResponse("Link not found", 404);
	}

	await env.hello_cf_spa_db
		.prepare("DELETE FROM links WHERE id = ? AND user_id = ?")
		.bind(linkId, user.id)
		.run();

	return jsonResponse({ ok: true });
}

/** GET /r/:code – redirects to the target URL; increments click count asynchronously. */
export async function handleRedirect(code: string, env: Env, ctx: ExecutionContext): Promise<Response> {
	const link = await env.hello_cf_spa_db
		.prepare("SELECT id, target_url, is_active, expires_at FROM links WHERE short_code = ?")
		.bind(code)
		.first<{ id: string; target_url: string; is_active: number; expires_at: string | null }>();

	if (!link) {
		log("REDIRECT", `Not found: code="${code}"`);
		return new Response("Short link not found", { status: 404 });
	}

	if (link.is_active === 0) {
		log("REDIRECT", `Inactive: code="${code}"`);
		return new Response("Short link not found", { status: 404 });
	}

	if (link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now()) {
		log("REDIRECT", `Expired: code="${code}"`);
		return new Response("Link has expired", { status: 410 });
	}

	ctx.waitUntil(
		env.hello_cf_spa_db
			.prepare("UPDATE links SET click_count = click_count + 1, updated_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), link.id)
			.run()
	);

	return new Response(null, { status: 302, headers: { Location: link.target_url } });
}
