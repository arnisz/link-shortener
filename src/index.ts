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

/**
 * Decodes and validates a Google ID token (JWT).
 * Performs critical security checks:
 * - JWT format (3 parts: header.payload.signature)
 * - Signature algorithm (RS256 only)
 * - Signature validity against Google's public keys
 * - Token issuer (Google)
 * - Email verification status
 * @param idToken The JWT string from Google OAuth callback
 * @returns Parsed and validated token payload
 * @throws If token is malformed, invalid, or fails any security check
 */
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
	googleKeysExpiry = Date.now() + GOOGLE_KEYS_CACHE_TTL_MS;
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

// ── Configuration & Constants ─────────────────────────────────────────────────

// Session configuration
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OAUTH_COOKIE_MAX_AGE_SECONDS = 600; // 10 minutes

// Cache configuration
const GOOGLE_KEYS_CACHE_TTL_MS = 3600 * 1000; // 1 hour

// Short code generation
const SHORT_CODE_LENGTH = 6;
const SHORT_CODE_GENERATION_RETRIES = 5;
const SHORT_CODE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Hard limits for user-supplied strings. */
const TARGET_URL_MAX_LEN = 2000;
const TITLE_MAX_LEN = 200;

function generateShortCode(length = SHORT_CODE_LENGTH): string {
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

/**
 * Validates alias according to business rules.
 * Rules: 3-50 chars, lowercase letters/digits/hyphen/underscore only.
 * Reserved words (api, login, logout, app, r) are forbidden.
 * @param alias The candidate alias string
 * @returns Error message if invalid; null if acceptable
 */
function validateAlias(alias: string): string | null {
	if (!ALIAS_REGEX.test(alias)) {
		return "Alias must be 3–50 chars: lowercase letters, digits, hyphen or underscore";
	}
	if (ALIAS_RESERVED.has(alias)) {
		return `"${alias}" is a reserved word`;
	}
	return null;
}

/**
 * Checks if the input is a valid future ISO 8601 date.
 * Used for link expiration dates.
 * @param input An ISO 8601 date string
 * @returns true if the date is valid and strictly in the future
 */
function isValidFutureIso(input: string): boolean {
	const d = new Date(input);
	return !isNaN(d.getTime()) && d.getTime() > Date.now();
}

/**
 * Checks if a request declares `Content-Type: application/json`.
 * Used to enforce JSON request format on API endpoints.
 * @param request The incoming request
 * @returns true if content-type header includes "application/json"
 */
function requireJson(request: Request): boolean {
	const ct = request.headers.get("content-type") ?? "";
	return ct.includes("application/json");
}

/**
 * Returns a JSON error response with the specified status code.
 * @param message Error message to include in response body
 * @param status HTTP status code (e.g., 400, 401, 415)
 * @returns Response with JSON error object
 */
function errResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" }
	});
}

/**
 * Returns a JSON success response with the specified status code.
 * @param data The object to serialize as JSON in the response body
 * @param status HTTP status code (default: 200)
 * @returns Response with JSON body and appropriate content-type header
 */
function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" }
	});
}

/**
 * Logs a categorized message to console (visible in wrangler tail).
 * Used only for critical errors (OAuth, token, redirect failures).
 * Does NOT persist; logs are ephemeral in Cloudflare Workers.
 * @param category Log category: "AUTH", "TOKEN", "REDIRECT", "DB"
 * @param message Human-readable error or state description
 */
function log(category: string, message: string): void {
	console.log(`[${category}] ${message}`);
}

// ── Route Handlers ────────────────────────────────────────────────────────────

/**
 * GET /api/me – Returns current authenticated user or null.
 * Always succeeds; returns authenticated: false if no valid session.
 * @param request The incoming request (must include session cookie)
 * @param env Worker environment bindings
 * @returns JSON response with authentication status and user details
 */
async function handleGetMe(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return jsonResponse({ authenticated: false });
	}
	return jsonResponse({ authenticated: true, user });
}

/**
 * POST /logout – Clears session and invalidates all cookies.
 * Always succeeds (302 redirect) whether or not a session exists.
 * @param request The incoming request (may or may not have session cookie)
 * @param env Worker environment bindings
 * @returns 302 redirect to / with cleared session cookie
 */
async function handleLogout(request: Request, env: Env): Promise<Response> {
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

/**
 * GET /api/hello – Test endpoint that increments a counter and echoes the visit count.
 * Returns current application time and database-persisted counter.
 * @param env Worker environment bindings (hello_cf_spa_db)
 * @returns JSON with message, visit count, and current timestamp
 */
async function handleHello(env: Env): Promise<Response> {
	await env.hello_cf_spa_db
		.prepare("UPDATE counters SET value = value + 1 WHERE name = ?")
		.bind("hello")
		.run();

	const row = await env.hello_cf_spa_db
		.prepare("SELECT value FROM counters WHERE name = ?")
		.bind("hello")
		.first<{ value: number }>();

	const response = jsonResponse({
		message: "Hallo vom Cloudflare Worker mit D1!",
		visits: row?.value ?? 0,
		time: new Date().toISOString()
	});
	response.headers.set("cache-control", "no-store");
	return response;
}

/**
 * POST /api/links – Creates a new shortened link.
 * Requires authentication. Validates target_url, optional title, optional alias, optional expires_at.
 * Alias is normalized (Unicode dashes → ASCII hyphen) and validated.
 * If alias is not provided or is empty after normalization, generates a random short code.
 * @param request The incoming request with authenticated session
 * @param env Worker environment bindings (database)
 * @returns 201 JSON with created link object; or 4xx/5xx on error
 */
async function handleCreateLink(request: Request, env: Env): Promise<Response> {
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

	// Validate optional expires_at
	let expiresAt: string | null = null;
	if (body.expires_at != null) {
		if (typeof body.expires_at !== "string" || !isValidFutureIso(body.expires_at)) {
			return errResponse("expires_at must be a valid future ISO date", 400);
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
		// Auto-generate short code – retry up to SHORT_CODE_GENERATION_RETRIES times on collision
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

/**
 * GET /api/links – Lists all links owned by the authenticated user.
 * Requires authentication. Returns links in reverse chronological order (newest first).
 * @param request The incoming request with authenticated session
 * @param env Worker environment bindings (database)
 * @returns 200 JSON array of link objects; or 401 if not authenticated
 */
async function handleGetLinks(request: Request, env: Env): Promise<Response> {
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

/**
 * POST /api/links/:id/update – Updates link properties (title, expires_at, is_active).
 * Requires authentication and ownership of the link.
 * At least one property must be provided.
 * @param linkId The link ID from URL path
 * @param request The incoming request with authenticated session
 * @param env Worker environment bindings (database)
 * @returns 200 JSON with updated link object; or 4xx on error
 */
async function handleUpdateLink(linkId: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
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

/**
 * POST /api/links/:id/delete – Permanently deletes a link owned by the authenticated user.
 * Requires authentication and ownership of the link.
 * Physical deletion (no soft-delete or archive).
 * @param linkId The link ID from URL path
 * @param request The incoming request with authenticated session
 * @param env Worker environment bindings (database)
 * @returns 200 JSON { ok: true }; or 4xx on error
 */
async function handleDeleteLink(linkId: string, request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return errResponse("Unauthorized", 401);
	}

	// Verify ownership before deleting
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

/**
 * GET /r/:code – Public redirect handler for shortened links.
 * Checks link status (active, not expired) before redirecting.
 * Increments click count asynchronously (does not delay redirect).
 * @param code The short code / alias from URL path
 * @param env Worker environment bindings (database)
 * @param ctx Execution context for waitUntil (async click count increment)
 * @returns 302 redirect to target_url; or 404/410 if link unavailable
 */
async function handleRedirect(code: string, env: Env, ctx: ExecutionContext): Promise<Response> {
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

	// Increment click count asynchronously – redirect is not delayed.
	ctx.waitUntil(
		env.hello_cf_spa_db
			.prepare("UPDATE links SET click_count = click_count + 1, updated_at = ? WHERE id = ?")
			.bind(new Date().toISOString(), link.id)
			.run()
	);

	return new Response(null, { status: 302, headers: { Location: link.target_url } });
}

// ── Google OAuth Handlers ─────────────────────────────────────────────────────

/**
 * Validates OAuth state and nonce from query params and cookies.
 * Implements CSRF protection via state token matching.
 * Returns early with 400 if validation fails.
 * @param code OAuth authorization code from query parameter
 * @param state OAuth state from query parameter (must match cookie)
 * @param cookieState OAuth state from request cookies
 * @param cookieNonce Nonce from request cookies (prevents token replay)
 * @returns Success object or error response (400 Bad Request)
 */
function validateOAuthState(
	code: string | null,
	state: string | null,
	cookieState: string | null,
	cookieNonce: string | null
): { success: true } | { success: false; response: Response } {
	if (!code || !state || !cookieState || state !== cookieState || !cookieNonce) {
		log("AUTH", "State validation failed");
		return {
			success: false,
			response: new Response("Invalid login state", { status: 400 })
		};
	}
	return { success: true };
}

/**
 * Exchanges OAuth authorization code for a Google ID token.
 * Makes HTTP POST request to Google's token endpoint.
 * Returns early with 502 on network or token error.
 * @param code OAuth authorization code from Google callback
 * @param env Worker environment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_BASE_URL)
 * @returns Success object with id_token or error response (502 Bad Gateway)
 */
async function exchangeCodeForToken(
	code: string,
	env: Env
): Promise<{ success: true; idToken: string } | { success: false; response: Response }> {
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
		log("TOKEN", `Exchange failed: status ${tokenResp.status}`);
		return {
			success: false,
			response: new Response(`Google token exchange failed: ${await tokenResp.text()}`, { status: 502 })
		};
	}

	const tokenJson = await tokenResp.json<GoogleTokenResponse>();
	if (!tokenJson.id_token) {
		log("TOKEN", "Missing id_token in response");
		return {
			success: false,
			response: new Response("Missing id_token", { status: 502 })
		};
	}

	return { success: true, idToken: tokenJson.id_token };
}

/**
 * Processes a valid Google OAuth callback after token exchange.
 * All security validations (nonce, signature, issuer, email_verified, aud, exp) are performed.
 * Upserts user into database and creates a new session.
 * @param idToken JWT from Google (already successfully obtained)
 * @param cookieNonce Nonce from request cookies (validates replay prevention)
 * @param env Worker environment (database, GOOGLE_CLIENT_ID)
 * @returns Success object with userId & sessionId or error response (400/401)
 */
async function processGoogleCallback(
	idToken: string,
	cookieNonce: string,
	env: Env
): Promise<{ success: true; userId: string; sessionId: string } | { success: false; response: Response }> {
	let payload: GoogleIdTokenPayload;
	try {
		payload = await parseGoogleIdToken(idToken);
	} catch (e: any) {
		log("TOKEN", `JWT verification failed: ${e.message}`);
		return {
			success: false,
			response: new Response(`ID token verification failed: ${e.message}`, { status: 400 })
		};
	}

	// Verify nonce to guard against token replay / CSRF
	if (payload.nonce !== cookieNonce) {
		log("AUTH", "Nonce mismatch");
		return {
			success: false,
			response: new Response("Invalid nonce", { status: 400 })
		};
	}

	if (payload.aud !== env.GOOGLE_CLIENT_ID) {
		log("AUTH", "Invalid token audience");
		return {
			success: false,
			response: new Response("Invalid token audience", { status: 400 })
		};
	}

	if (payload.exp * 1000 < Date.now()) {
		log("TOKEN", "Token expired");
		return {
			success: false,
			response: new Response("Expired token", { status: 400 })
		};
	}

	const userId = await upsertUserFromGoogle(payload, env);
	const { sessionId } = await createSession(userId, env);

	return { success: true, userId, sessionId };
}

/**
 * Main handler for GET /api/auth/google/callback – Orchestrates the OAuth flow.
 * Steps: 1) Validate state/nonce (CSRF), 2) Exchange code for token (network call),
 * 3) Parse & verify JWT payload, 4) Create session & return 302 redirect to app.
 * Logs errors and returns appropriate error responses at each step.
 * @param request The incoming callback request from Google OAuth
 * @param env Worker environment (secrets, database, APP_BASE_URL)
 * @returns 302 redirect to /app.html with session cookie; or 4xx/5xx error response
 */
async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const cookieState = getCookie(request, "oauth_state");
	const cookieNonce = getCookie(request, "oauth_nonce");

	// Step 1: Validate OAuth state/nonce
	const stateValidation = validateOAuthState(code, state, cookieState, cookieNonce);
	if (!stateValidation.success) {
		return stateValidation.response;
	}

	// Step 2: Exchange code for token
	const tokenExchange = await exchangeCodeForToken(code!, env);
	if (!tokenExchange.success) {
		return tokenExchange.response;
	}

	// Step 3: Process & verify token payload
	const callbackProcessing = await processGoogleCallback(tokenExchange.idToken, cookieNonce!, env);
	if (!callbackProcessing.success) {
		return callbackProcessing.response;
	}

	// Step 4: Build successful response with session cookies
	const headers = new Headers();
	headers.set("Location", "/app.html");
	headers.append("Set-Cookie", makeSessionCookie(callbackProcessing.sessionId, SESSION_COOKIE_MAX_AGE_SECONDS));
	headers.append("Set-Cookie", `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
	headers.append("Set-Cookie", `oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

	return new Response(null, { status: 302, headers });
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
				`Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`
			].join("; ");

			const nonceCookie = [
				`oauth_nonce=${nonce}`,
				"Path=/",
				"HttpOnly",
				"Secure",
				"SameSite=Lax",
				`Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`
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
			return await handleGoogleCallback(request, env);
		}

		if (url.pathname === "/api/me") {
			return await handleGetMe(request, env);
		}

		if (url.pathname === "/logout" && request.method === "POST") {
			return await handleLogout(request, env);
		}

		if (url.pathname === "/api/hello") {
			return await handleHello(env);
		}

		// ── POST /api/links – create a new short link ────────────────────────

		if (url.pathname === "/api/links" && request.method === "POST") {
			return await handleCreateLink(request, env);
		}

		// ── GET /api/links – list current user's links ────────────────────────

		if (url.pathname === "/api/links" && request.method === "GET") {
			return await handleGetLinks(request, env);
		}

		// ── POST /api/links/:id/update – update title / expiry / active state ──

		const updateLinkMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/update$/);
		if (updateLinkMatch && request.method === "POST") {
			return await handleUpdateLink(updateLinkMatch[1], request, env);
		}

		// ── POST /api/links/:id/delete – permanently delete a link ───────────

		const deleteLinkMatch = url.pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
		if (deleteLinkMatch && request.method === "POST") {
			return await handleDeleteLink(deleteLinkMatch[1], request, env);
		}

		// ── GET /r/:code – redirect short link ───────────────────────────────
		// Pattern includes hyphen + underscore to support custom aliases.

		const redirectMatch = url.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
		if (redirectMatch) {
			return await handleRedirect(redirectMatch[1], env, ctx);
		}

		return new Response("Not found", { status: 404 });
	}
};
