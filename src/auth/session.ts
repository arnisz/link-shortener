import type { Env, GoogleIdTokenPayload } from "../types";
import { SESSION_DURATION_MS } from "../config";
import { randomId, getCookie } from "../utils";

export async function upsertUserFromGoogle(payload: GoogleIdTokenPayload, env: Env): Promise<string> {
	const now = new Date().toISOString();

	const existing = await env.hello_cf_spa_db
		.prepare("SELECT id FROM users WHERE google_sub = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	if (existing?.id) {
		await env.hello_cf_spa_db
			.prepare(`
        UPDATE users
        SET email = ?, name = ?, avatar_url = ?, last_login_at = ?
        WHERE id = ?
      `)
			.bind(
				payload.email ?? "",
				payload.name ?? null,
				payload.picture ?? null,
				now,
				existing.id
			)
			.run();

		return existing.id;
	}

	const userId = await randomId(16);

	await env.hello_cf_spa_db
		.prepare(`
      INSERT INTO users (id, google_sub, email, name, avatar_url, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
		.bind(
			userId,
			payload.sub,
			payload.email ?? "",
			payload.name ?? null,
			payload.picture ?? null,
			now,
			now
		)
		.run();

	return userId;
}

export async function createSession(
	userId: string,
	env: Env
): Promise<{ sessionId: string; expiresAt: string }> {
	const sessionId = await randomId(24);
	const expires = new Date(Date.now() + SESSION_DURATION_MS);
	const expiresAt = expires.toISOString();
	const createdAt = new Date().toISOString();

	await env.hello_cf_spa_db
		.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `)
		.bind(sessionId, userId, expiresAt, createdAt)
		.run();

	return { sessionId, expiresAt };
}

export async function getSessionUser(request: Request, env: Env) {
	const sid = getCookie(request, "sid");
	if (!sid) return null;

	const now = new Date().toISOString();

	const row = await env.hello_cf_spa_db
		.prepare(`
      SELECT u.id, u.email, u.name, u.avatar_url, s.expires_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?
    `)
		.bind(sid, now)
		.first<{
			id: string;
			email: string;
			name: string | null;
			avatar_url: string | null;
			expires_at: string;
		}>();

	return row ?? null;
}
