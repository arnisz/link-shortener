interface Env {
	hello_cf_spa_db: D1Database;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	SESSION_SECRET: string;
	APP_BASE_URL: string;
}

type GoogleTokenResponse = {
	access_token?: string;
	expires_in?: number;
	id_token?: string;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
};

type GoogleIdTokenPayload = {
	iss: string;
	aud: string;
	sub: string;
	nonce?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
	exp: number;
	iat: number;
};

function base64UrlDecode(input: string): string {
	input = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = input.length % 4;
	if (pad) input += "=".repeat(4 - pad);
	return atob(input);
}

async function randomId(bytes = 24): Promise<string> {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;
	const parts = cookieHeader.split(";").map((p) => p.trim());
	for (const part of parts) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx);
		const value = part.slice(idx + 1);
		if (key === name) return value;
	}
	return null;
}

function makeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
	return [
		`sid=${sessionId}`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		`Max-Age=${maxAgeSeconds}`
	].join("; ");
}

function clearSessionCookie(): string {
	return [
		"sid=",
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		"Max-Age=0"
	].join("; ");
}

async function parseGoogleIdToken(idToken: string): Promise<GoogleIdTokenPayload> {
	const parts = idToken.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid ID token format");
	}

	const [headerB64, payloadB64, signatureB64] = parts;

	let header: { kid?: string; alg?: string };
	try {
		header = JSON.parse(base64UrlDecode(headerB64));
	} catch {
		throw new Error("Invalid JWT header");
	}

	if (header.alg !== "RS256") {
		throw new Error("Unsupported signature algorithm");
	}

	if (!header.kid) {
		throw new Error("Missing kid in JWT header");
	}

	const payloadJson = base64UrlDecode(payloadB64);
	const payload = JSON.parse(payloadJson) as GoogleIdTokenPayload;

	// 1. Verify issuer
	if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
		throw new Error("Invalid issuer");
	}

	// 2. Verify email_verified
	if (payload.email_verified !== true) {
		throw new Error("Email not verified");
	}

	// 3. Verify signature
	const keys = await fetchGooglePublicKeys();
	const key = keys.find(k => k.kid === header.kid);
	if (!key) {
		throw new Error("Public key not found for kid");
	}

	const isValid = await verifyRS256Signature(`${headerB64}.${payloadB64}`, signatureB64, key);
	if (!isValid) {
		throw new Error("Invalid JWT signature");
	}

	return payload;
}

interface GoogleJWK {
	kid: string;
	n: string;
	e: string;
	kty: "RSA";
	alg: "RS256";
	use: "sig";
}

let googleKeysCache: GoogleJWK[] | null = null;
let googleKeysExpiry = 0;

async function fetchGooglePublicKeys(): Promise<GoogleJWK[]> {
	if (googleKeysCache && Date.now() < googleKeysExpiry) {
		return googleKeysCache;
	}

	const resp = await fetch("https://www.googleapis.com/oauth2/v3/certs");
	if (!resp.ok) {
		throw new Error("Failed to fetch Google public keys");
	}

	const { keys } = await resp.json<{ keys: GoogleJWK[] }>();
	googleKeysCache = keys;
	// Cache for 1 hour
	googleKeysExpiry = Date.now() + 3600 * 1000;
	return keys;
}

async function verifyRS256Signature(data: string, signatureB64Url: string, jwk: GoogleJWK): Promise<boolean> {
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"]
	);

	const signature = Uint8Array.from(base64UrlDecode(signatureB64Url), c => c.charCodeAt(0));
	const dataUint8 = new TextEncoder().encode(data);

	return await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		signature,
		dataUint8
	);
}

async function upsertUserFromGoogle(payload: GoogleIdTokenPayload, env: Env): Promise<string> {
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

async function createSession(userId: string, env: Env): Promise<{ sessionId: string; expiresAt: string }> {
	const sessionId = await randomId(24);
	const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 Tage
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

async function getSessionUser(request: Request, env: Env) {
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

// ── Link-shortener helpers ────────────────────────────────────────────────────

const SHORT_CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Hard limits for user-supplied strings. */
const TARGET_URL_MAX_LEN = 2000;
const TITLE_MAX_LEN = 200;

function generateShortCode(length = 6): string {
	const arr = new Uint8Array(length);
	crypto.getRandomValues(arr);
	return Array.from(arr).map(b => SHORT_CODE_CHARS[b % SHORT_CODE_CHARS.length]).join("");
}

function isValidHttpUrl(input: string): boolean {
	try {
		const u = new URL(input);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

// Aliases: 3-50 chars, lowercase letters / digits / hyphen / underscore.
const ALIAS_REGEX = /^[a-z0-9_-]{3,50}$/;
const ALIAS_RESERVED = new Set(["api", "login", "logout", "app", "r"]);

/** Returns an error message string, or null when the alias is acceptable. */
function validateAlias(alias: string): string | null {
	if (!ALIAS_REGEX.test(alias)) {
		return "Alias must be 3–50 chars: lowercase letters, digits, hyphen or underscore";
	}
	if (ALIAS_RESERVED.has(alias)) {
		return `"${alias}" is a reserved word`;
	}
	return null;
}

/** True when the input parses to a Date that is strictly in the future. */
function isValidFutureIso(input: string): boolean {
	const d = new Date(input);
	return !isNaN(d.getTime()) && d.getTime() > Date.now();
}

/** Returns true when the request declares a JSON content-type. */
function requireJson(request: Request): boolean {
	const ct = request.headers.get("content-type") ?? "";
	return ct.includes("application/json");
}

/** Shorthand for a 400/415 JSON error response. */
function errResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" }
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/login") {
			const state = await randomId(16);
			const nonce = await randomId(16);

			const stateCookie = [
				`oauth_state=${state}`,
				"Path=/",
				"HttpOnly",
				"Secure",
				"SameSite=Lax",
				"Max-Age=600"
			].join("; ");

			const nonceCookie = [
				`oauth_nonce=${nonce}`,
				"Path=/",
				"HttpOnly",
				"Secure",
				"SameSite=Lax",
				"Max-Age=600"
			].join("; ");

			const redirectUri = `${env.APP_BASE_URL}/api/auth/google/callback`;

			const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
			googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
			googleUrl.searchParams.set("redirect_uri", redirectUri);
			googleUrl.searchParams.set("response_type", "code");
			googleUrl.searchParams.set("scope", "openid email profile");
			googleUrl.searchParams.set("state", state);
			googleUrl.searchParams.set("nonce", nonce);
			googleUrl.searchParams.set("prompt", "select_account");

			const headers = new Headers();
			headers.set("Location", googleUrl.toString());
			headers.append("Set-Cookie", stateCookie);
			headers.append("Set-Cookie", nonceCookie);

			return new Response(null, { status: 302, headers });
		}

		if (url.pathname === "/api/auth/google/callback") {
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const cookieState = getCookie(request, "oauth_state");
			const cookieNonce = getCookie(request, "oauth_nonce");

			if (!code || !state || !cookieState || state !== cookieState || !cookieNonce) {
				return new Response("Invalid login state", { status: 400 });
			}

			const redirectUri = `${env.APP_BASE_URL}/api/auth/google/callback`;

			const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded"
				},
				body: new URLSearchParams({
					code,
					client_id: env.GOOGLE_CLIENT_ID,
					client_secret: env.GOOGLE_CLIENT_SECRET,
					redirect_uri: redirectUri,
					grant_type: "authorization_code"
				})
			});

			if (!tokenResp.ok) {
				return new Response(`Google token exchange failed: ${await tokenResp.text()}`, { status: 502 });
			}

		const tokenJson = await tokenResp.json<GoogleTokenResponse>();
		if (!tokenJson.id_token) {
			return new Response("Missing id_token", { status: 502 });
		}

		let payload: GoogleIdTokenPayload;
		try {
			payload = await parseGoogleIdToken(tokenJson.id_token);
		} catch (e: any) {
			return new Response(`ID token verification failed: ${e.message}`, { status: 400 });
		}

		// Verify nonce to guard against token replay / CSRF
			if (payload.nonce !== cookieNonce) {
				return new Response("Invalid nonce", { status: 400 });
			}

			if (payload.aud !== env.GOOGLE_CLIENT_ID) {
				return new Response("Invalid token audience", { status: 400 });
			}

			if (payload.exp * 1000 < Date.now()) {
				return new Response("Expired token", { status: 400 });
			}

			const userId = await upsertUserFromGoogle(payload, env);
			const { sessionId } = await createSession(userId, env);

			const headers = new Headers();
			headers.set("Location", "/app.html");
			headers.append("Set-Cookie", makeSessionCookie(sessionId, 60 * 60 * 24 * 30));
			headers.append("Set-Cookie", "oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
			headers.append("Set-Cookie", "oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");

			return new Response(null, { status: 302, headers });
		}

		if (url.pathname === "/api/me") {
			const user = await getSessionUser(request, env);
			if (!user) {
				return new Response(JSON.stringify({ authenticated: false }), {
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}

			return new Response(JSON.stringify({ authenticated: true, user }), {
				headers: { "content-type": "application/json; charset=UTF-8" }
			});
		}

		if (url.pathname === "/logout" && request.method === "POST") {
			const sid = getCookie(request, "sid");
			if (sid) {
				await env.hello_cf_spa_db
					.prepare("DELETE FROM sessions WHERE id = ?")
					.bind(sid)
					.run();
			}

			return new Response(null, {
				status: 302,
				headers: {
					"Location": "/",
					"Set-Cookie": clearSessionCookie()
				}
			});
		}

		if (url.pathname === "/api/hello") {
			await env.hello_cf_spa_db
				.prepare("UPDATE counters SET value = value + 1 WHERE name = ?")
				.bind("hello")
				.run();

			const row = await env.hello_cf_spa_db
				.prepare("SELECT value FROM counters WHERE name = ?")
				.bind("hello")
				.first<{ value: number }>();

			return new Response(
				JSON.stringify({
					message: "Hallo vom Cloudflare Worker mit D1!",
					visits: row?.value ?? 0,
					time: new Date().toISOString()
				}),
				{
					headers: {
						"content-type": "application/json; charset=UTF-8",
						"cache-control": "no-store"
					}
				}
			);
		}

		// ── POST /api/links – create a new short link ────────────────────────

		if (url.pathname === "/api/links" && request.method === "POST") {
			const user = await getSessionUser(request, env);
			if (!user) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}

			if (!requireJson(request)) {
				return errResponse("Content-Type must be application/json", 415);
			}

			let body: { target_url?: unknown; title?: unknown; alias?: unknown; expires_at?: unknown };
			try {
				body = await request.json();
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
					status: 400,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}

			const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
			if (!targetUrl || !isValidHttpUrl(targetUrl)) {
				return new Response(JSON.stringify({ error: "Invalid or missing target_url" }), {
					status: 400,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}
			if (targetUrl.length > TARGET_URL_MAX_LEN) {
				return errResponse(`target_url must not exceed ${TARGET_URL_MAX_LEN} characters`, 400);
			}

			const rawTitle = typeof body.title === "string" ? body.title.trim() : "";
			if (rawTitle.length > TITLE_MAX_LEN) {
				return errResponse(`title must not exceed ${TITLE_MAX_LEN} characters`, 400);
			}
			const title: string | null = rawTitle || null;

			// Validate optional expires_at
			let expiresAt: string | null = null;
			if (body.expires_at != null) {
				if (typeof body.expires_at !== "string" || !isValidFutureIso(body.expires_at)) {
					return new Response(JSON.stringify({ error: "expires_at must be a valid future ISO date" }), {
						status: 400,
						headers: { "content-type": "application/json; charset=UTF-8" }
					});
				}
				expiresAt = new Date(body.expires_at).toISOString();
			}

			const id = await randomId(16);
			const now = new Date().toISOString();
			let shortCode: string;

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

		if (normalizedAlias) {
			// Custom alias path
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
			// Auto-generate short code – retry up to 5 times on collision
			let generated = "";
			for (let i = 0; i < 5; i++) {
				const candidate = generateShortCode();
				const existing = await env.hello_cf_spa_db
					.prepare("SELECT id FROM links WHERE short_code = ?")
					.bind(candidate)
					.first();
				if (!existing) { generated = candidate; break; }
			}
			if (!generated) {
				return new Response(JSON.stringify({ error: "Could not generate unique short code" }), {
					status: 500,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}
			shortCode = generated;
		}

			await env.hello_cf_spa_db
				.prepare(
					`INSERT INTO links (id, user_id, short_code, target_url, title, created_at, updated_at, click_count, expires_at, is_active)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`
				)
				.bind(id, user.id, shortCode, targetUrl, title, now, now, expiresAt)
				.run();

			return new Response(
				JSON.stringify({
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
				}),
				{ status: 201, headers: { "content-type": "application/json; charset=UTF-8" } }
			);
		}

		// ── GET /api/links – list current user's links ────────────────────────

		if (url.pathname === "/api/links" && request.method === "GET") {
			const user = await getSessionUser(request, env);
			if (!user) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
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

			return new Response(
				JSON.stringify(results.map(l => ({ ...l, short_url: `${env.APP_BASE_URL}/r/${l.short_code}` }))),
				{ headers: { "content-type": "application/json; charset=UTF-8" } }
			);
		}

		// ── POST /api/links/:id/update – update title / expiry / active state ──

		const updateLinkMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/update$/);
		if (updateLinkMatch && request.method === "POST") {
			const linkId = updateLinkMatch[1];
			const user = await getSessionUser(request, env);
			if (!user) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}

			if (!requireJson(request)) {
				return errResponse("Content-Type must be application/json", 415);
			}

			// Verify ownership before touching anything else
			const owned = await env.hello_cf_spa_db
				.prepare("SELECT id FROM links WHERE id = ? AND user_id = ?")
				.bind(linkId, user.id)
				.first<{ id: string }>();
			if (!owned) {
				return new Response(JSON.stringify({ error: "Link not found" }), {
					status: 404,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
			}

			let body: { title?: unknown; expires_at?: unknown; is_active?: unknown };
			try {
				body = await request.json();
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
					status: 400,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
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
				return new Response(JSON.stringify({ error: "Nothing to update" }), {
					status: 400,
					headers: { "content-type": "application/json; charset=UTF-8" }
				});
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

			return new Response(
				JSON.stringify({ ...updated, short_url: `${env.APP_BASE_URL}/r/${updated!.short_code}` }),
				{ headers: { "content-type": "application/json; charset=UTF-8" } }
			);
		}

		// ── GET /r/:code – redirect short link ───────────────────────────────
		// Pattern includes hyphen + underscore to support custom aliases.

		const redirectMatch = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
		if (redirectMatch) {
			const code = redirectMatch[1];
			const link = await env.hello_cf_spa_db
				.prepare("SELECT id, target_url, is_active, expires_at FROM links WHERE short_code = ?")
				.bind(code)
				.first<{ id: string; target_url: string; is_active: number; expires_at: string | null }>();

			if (!link) {
				return new Response("Short link not found", { status: 404 });
			}

		if (link.is_active === 0) {
				return new Response("Short link not found", { status: 404 });
			}

			if (link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now()) {
				return new Response("Link has expired", { status: 410 });
			}

			// Increment click count asynchronously – redirect is not delayed.
			// TODO Phase 3: insert a click_event row here (geo, referrer, user-agent).
			ctx.waitUntil(
				env.hello_cf_spa_db
					.prepare("UPDATE links SET click_count = click_count + 1, updated_at = ? WHERE id = ?")
					.bind(new Date().toISOString(), link.id)
					.run()
			);

			return new Response(null, { status: 302, headers: { Location: link.target_url } });
		}

		return new Response("Not found", { status: 404 });
	}
};
