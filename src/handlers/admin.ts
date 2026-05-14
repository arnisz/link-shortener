import type { Env } from "../types";
import { jsonResponse, errResponse, log } from "../utils";
import { getSessionUser } from "../auth/session";
import { validateMutationCsrf } from "../csrf";
import { requireJson } from "../validation";

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Dual-layer admin auth: valid Google-OAuth session + Authorization: Bearer ADMIN_TOKEN.
 * Returns the authenticated userId or null (always generic 401, no detail hint).
 */
async function checkAdminAuth(request: Request, env: Env): Promise<string | null> {
	// Factor 1: valid session cookie (getSessionUser reads __Host-sid internally)
	const user = await getSessionUser(request, env);
	if (!user) {
		log("ADMIN_AUTH", "rejected reason=no_session");
		return null;
	}

	// Factor 2: Authorization: Bearer ADMIN_TOKEN
	const authHeader = request.headers.get("Authorization") ?? "";
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
	if (!token) {
		log("ADMIN_AUTH", "rejected reason=no_token");
		return null;
	}
	if (token !== env.ADMIN_TOKEN) {
		log("ADMIN_AUTH", "rejected reason=token_mismatch");
		return null;
	}

	return user.id;
}

// ---------------------------------------------------------------------------
// GET /api/admin/links
// ---------------------------------------------------------------------------

/**
 * Returns all links across all users, cursor-paginated.
 * Cursor format: ISO|id  (created_at ISO string + link id)
 * Default limit: 100, max: 200.
 */
export async function handleAdminGetLinks(request: Request, env: Env): Promise<Response> {
	const userId = await checkAdminAuth(request, env);
	if (!userId) return errResponse("Unauthorized", 401);

	const url = new URL(request.url);
	const limitParam = parseInt(url.searchParams.get("limit") ?? "100", 10);
	const limit = isNaN(limitParam) || limitParam < 1 ? 100 : Math.min(limitParam, 200);
	const cursor = url.searchParams.get("cursor") ?? null;

	let rows: unknown[];
	if (cursor) {
		const parts = cursor.split("|");
		if (parts.length !== 2) return errResponse("Invalid cursor", 400);
		const [cursorTs, cursorId] = parts;
		const result = await env.hello_cf_spa_db
			.prepare(
				`SELECT l.id, l.short_code, l.target_url, l.status, l.spam_score, l.is_active, l.click_count,
				        l.created_at, l.user_id, u.email AS user_email
				 FROM links l
				 LEFT JOIN users u ON u.id = l.user_id
				 WHERE (l.created_at < ? OR (l.created_at = ? AND l.id < ?))
				 ORDER BY l.created_at DESC, l.id DESC
				 LIMIT ?`
			)
			.bind(cursorTs, cursorTs, cursorId, limit + 1)
			.all();
		rows = result.results;
	} else {
		const result = await env.hello_cf_spa_db
			.prepare(
				`SELECT l.id, l.short_code, l.target_url, l.status, l.spam_score, l.is_active, l.click_count,
				        l.created_at, l.user_id, u.email AS user_email
				 FROM links l
				 LEFT JOIN users u ON u.id = l.user_id
				 ORDER BY l.created_at DESC, l.id DESC
				 LIMIT ?`
			)
			.bind(limit + 1)
			.all();
		rows = result.results;
	}

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	let nextCursor: string | null = null;
	if (hasMore && items.length > 0) {
		const last = items[items.length - 1] as { created_at: string; id: string };
		nextCursor = `${last.created_at}|${last.id}`;
	}

	return jsonResponse({ links: items, nextCursor });
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

/** Returns all users with link_count, is_blocked, created_at, email. */
export async function handleAdminGetUsers(request: Request, env: Env): Promise<Response> {
	const userId = await checkAdminAuth(request, env);
	if (!userId) return errResponse("Unauthorized", 401);

	const result = await env.hello_cf_spa_db
		.prepare(
			`SELECT u.id, u.email, u.is_blocked, u.created_at,
			        COUNT(l.id) AS link_count
			 FROM users u
			 LEFT JOIN links l ON l.user_id = u.id
			 GROUP BY u.id
			 ORDER BY u.created_at DESC`
		)
		.all();

	return jsonResponse({ users: result.results });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/block
// ---------------------------------------------------------------------------

/** Blocks a user: sets is_blocked=1, deletes all their sessions. */
export async function handleAdminBlockUser(
	id: string,
	request: Request,
	env: Env
): Promise<Response> {
	const adminId = await checkAdminAuth(request, env);
	if (!adminId) return errResponse("Unauthorized", 401);

	const csrfError = await validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	const user = await env.hello_cf_spa_db
		.prepare("SELECT id FROM users WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	if (!user) return errResponse("User not found", 404);

	await env.hello_cf_spa_db.batch([
		env.hello_cf_spa_db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").bind(id),
		env.hello_cf_spa_db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
	]);

	log("ADMIN", `User blocked: uid=${id.slice(0, 8)}… by admin=${adminId.slice(0, 8)}…`);
	return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/unblock
// ---------------------------------------------------------------------------

/** Unblocks a user: sets is_blocked=0. */
export async function handleAdminUnblockUser(
	id: string,
	request: Request,
	env: Env
): Promise<Response> {
	const adminId = await checkAdminAuth(request, env);
	if (!adminId) return errResponse("Unauthorized", 401);

	const csrfError = await validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	const result = await env.hello_cf_spa_db
		.prepare("UPDATE users SET is_blocked = 0 WHERE id = ?")
		.bind(id)
		.run();

	if (result.meta.changes === 0) return errResponse("User not found", 404);

	log("ADMIN", `User unblocked: uid=${id.slice(0, 8)}… by admin=${adminId.slice(0, 8)}…`);
	return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id
// ---------------------------------------------------------------------------

/** Deletes a user, all their sessions and all their links (CASCADE). Irreversible. */
export async function handleAdminDeleteUser(
	id: string,
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const adminId = await checkAdminAuth(request, env);
	if (!adminId) return errResponse("Unauthorized", 401);

	const csrfError = await validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	const user = await env.hello_cf_spa_db
		.prepare("SELECT id FROM users WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	if (!user) return errResponse("User not found", 404);

	const links = await env.hello_cf_spa_db
		.prepare("SELECT id, short_code FROM links WHERE user_id = ?")
		.bind(id)
		.all<{ id: string; short_code: string }>();
	const codes = links.results;

	await env.hello_cf_spa_db.batch([
		env.hello_cf_spa_db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
		env.hello_cf_spa_db.prepare("DELETE FROM links WHERE user_id = ?").bind(id),
		env.hello_cf_spa_db.prepare("DELETE FROM users WHERE id = ?").bind(id),
	]);

	if (env.LINKS_KV && codes.length > 0) {
		ctx.waitUntil(Promise.all(
			codes.map(({ id: linkId, short_code }) =>
				env.LINKS_KV.put(
					`link:${short_code}`,
					JSON.stringify({
						id: linkId,
						user_id: null,
						target_url: "",
						is_active: 0,
						status: "blocked",
						expires_at: null,
					}),
					{ expirationTtl: 60 }
				)
			)
		));
	}

	log("ADMIN", `User deleted: uid=${id.slice(0, 8)}… by admin=${adminId.slice(0, 8)}…`);
	return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/links/:id
// ---------------------------------------------------------------------------

/**
 * Updates a link across all users by immutable link id.
 * Allowed fields: status and/or spam_score.
 * Always sets manual_override=1 so the Wächter no longer overwrites status.
 */
export async function handleAdminUpdateLink(
	id: string,
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const adminId = await checkAdminAuth(request, env);
	if (!adminId) return errResponse("Unauthorized", 401);

	const csrfError = await validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	if (!requireJson(request)) {
		return errResponse("Content-Type must be application/json", 415);
	}

	let body: { status?: unknown; spam_score?: unknown };
	try {
		body = await request.json();
	} catch {
		return errResponse("Invalid JSON body", 400);
	}

	const setClauses: string[] = ["updated_at = ?", "manual_override = 1"];
	const binds: unknown[] = [new Date().toISOString()];

	if (body.status !== undefined) {
		if (typeof body.status !== "string" || !["active", "warning", "blocked"].includes(body.status)) {
			return errResponse("Invalid status", 400);
		}
		setClauses.push("status = ?");
		binds.push(body.status);
	}

	if (body.spam_score !== undefined) {
		if (typeof body.spam_score !== "number" || !Number.isFinite(body.spam_score) || body.spam_score < 0 || body.spam_score > 1) {
			return errResponse("Invalid spam_score", 400);
		}
		setClauses.push("spam_score = ?");
		binds.push(body.spam_score);
	}

	if (body.status === undefined && body.spam_score === undefined) {
		return errResponse("No valid fields to update", 400);
	}

	const result = await env.hello_cf_spa_db
		.prepare(
			`UPDATE links SET ${setClauses.join(", ")} WHERE id = ?
			 RETURNING short_code, id, target_url, is_active, status, expires_at, user_id`
		)
		.bind(...binds, id)
		.first<{
			short_code: string;
			id: string;
			target_url: string;
			is_active: number;
			status: string;
			expires_at: string | null;
			user_id: string | null;
		}>();

	if (!result) {
		return errResponse("Link not found", 404);
	}

	if (env.LINKS_KV) {
		// KV delete() is eventually consistent and may leave stale redirect entries
		// at other edge nodes for up to ~60s. A put() with the updated payload
		// propagates the new status immediately and avoids drift during incidents.
		ctx.waitUntil(env.LINKS_KV.put(
			`link:${result.short_code}`,
			JSON.stringify({
				id: result.id,
				user_id: result.user_id,
				target_url: result.target_url,
				is_active: result.is_active,
				status: result.status,
				expires_at: result.expires_at,
			}),
			{ expirationTtl: 300 }
		));
	}

	log("ADMIN", `Link updated: id=${id} by admin=${adminId.slice(0, 8)}…`);
	return jsonResponse({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/links/:id
// ---------------------------------------------------------------------------

/** Deletes a link across all users by immutable link id. */
export async function handleAdminDeleteLink(
	id: string,
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const adminId = await checkAdminAuth(request, env);
	if (!adminId) return errResponse("Unauthorized", 401);

	const csrfError = await validateMutationCsrf(request, env);
	if (csrfError) return csrfError;

	const result = await env.hello_cf_spa_db
		.prepare("DELETE FROM links WHERE id = ? RETURNING short_code, id, target_url, is_active, expires_at, user_id")
		.bind(id)
		.first<{
			short_code: string;
			id: string;
			target_url: string;
			is_active: number;
			expires_at: string | null;
			user_id: string | null;
		}>();

	if (!result) {
		return errResponse("Link not found", 404);
	}

	if (env.LINKS_KV) {
		// KV delete() is eventually consistent; write a short-lived tombstone so
		// every edge immediately applies the hot-path 404 hierarchy after deletion.
		ctx.waitUntil(env.LINKS_KV.put(
			`link:${result.short_code}`,
			JSON.stringify({
				id: result.id,
				user_id: null,
				target_url: "",
				is_active: 0,
				status: "blocked",
				expires_at: null,
			}),
			{ expirationTtl: 60 }
		));
	}

	log("ADMIN", `Link deleted: id=${id} by admin=${adminId.slice(0, 8)}…`);
	return jsonResponse({ ok: true });
}

