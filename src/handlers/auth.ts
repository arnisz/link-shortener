import type { Env, GoogleTokenResponse } from "../types";
import { SESSION_COOKIE_MAX_AGE_SECONDS, OAUTH_COOKIE_MAX_AGE_SECONDS } from "../config";
import { getCookie, makeSessionCookie, clearSessionCookie, jsonResponse, log } from "../utils";
import { parseGoogleIdToken } from "../auth/google";
import { upsertUserFromGoogle, createSession, getSessionUser } from "../auth/session";
import { checkRateLimit } from "../rateLimit";
import { errResponse } from "../utils";
import { generateCsrfToken } from "../csrf";

/** GET /api/me – returns the current user or { authenticated: false }. */
export async function handleGetMe(request: Request, env: Env): Promise<Response> {
	const user = await getSessionUser(request, env);
	if (!user) {
		return jsonResponse({ authenticated: false });
	}
	// P1-Fix: CSRF-Token im Response-Body bereitstellen, damit Browser-Clients
	// es in X-CSRF-Token Header mitschicken können (HttpOnly-Cookie ist für JS unlesbar)
	const sid = getCookie(request, "__Host-sid");
	const csrfToken = sid ? generateCsrfToken(sid, env.SESSION_SECRET) : null;
	return jsonResponse({ authenticated: true, user, csrfToken });
}

/** POST /logout – clears session and redirects to /. */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
	// 🔴 SICHERHEIT: Nur __Host-sid lesen – kein Fallback auf unsicheres sid-Cookie (Session-Fixation-Schutz)
	const sid = getCookie(request, "__Host-sid");
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

/** GET /login – initiates Google OAuth flow. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
	// Rate-limit login initiation to prevent bot floods (5/min per IP).
	const ip = request.headers.get("CF-Connecting-IP") ?? "127.0.0.1";
	const { allowed } = await checkRateLimit(`login:${ip}`, env.hello_cf_spa_db, 5);
	if (!allowed) {
		return errResponse("Too many requests", 429);
	}

	// Read optional ?next= param; only accept relative paths (must start with /)
	const loginUrl = new URL(request.url);
	const rawNext = loginUrl.searchParams.get("next") ?? "";
	const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

	// Generate CSRF state + replay-prevention nonce
	const arr = new Uint8Array(16);
	crypto.getRandomValues(arr);
	const nonce = [...arr].map(b => b.toString(16).padStart(2, "0")).join("");

	// Encode state as base64 JSON containing the random nonce and the next path
	const statePayload = btoa(JSON.stringify({ nonce, next }));

	const cookieOpts = `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_COOKIE_MAX_AGE_SECONDS}`;
	const redirectUri = `${env.APP_BASE_URL}/api/auth/google/callback`;

	const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
	googleUrl.searchParams.set("redirect_uri", redirectUri);
	googleUrl.searchParams.set("response_type", "code");
	googleUrl.searchParams.set("scope", "openid email profile");
	googleUrl.searchParams.set("state", statePayload);
	googleUrl.searchParams.set("nonce", nonce);
	googleUrl.searchParams.set("prompt", "select_account");

	const headers = new Headers();
	headers.set("Location", googleUrl.toString());
	headers.append("Set-Cookie", `__Host-oauth_state=${statePayload}; ${cookieOpts}`);
	headers.append("Set-Cookie", `__Host-oauth_nonce=${nonce}; ${cookieOpts}`);

	return new Response(null, { status: 302, headers });
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────

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
			response: errResponse("Invalid login state", 400)
		};
	}
	return { success: true };
}

async function exchangeCodeForToken(
	code: string,
	env: Env
): Promise<{ success: true; idToken: string } | { success: false; response: Response }> {
	const redirectUri = `${env.APP_BASE_URL}/api/auth/google/callback`;

	const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code"
		})
	});

	if (!tokenResp.ok) {
		const tokenError = await tokenResp.text();
		log("TOKEN", `Exchange failed: ${tokenError}`);
		return { success: false, response: errResponse("Authentication failed", 502) };
	}

	const tokenJson = await tokenResp.json<GoogleTokenResponse>();
	if (!tokenJson.id_token) {
		log("TOKEN", "Missing id_token in response");
		return {
			success: false,
			response: errResponse("Missing id_token", 502)
		};
	}

	return { success: true, idToken: tokenJson.id_token };
}

async function processGoogleCallback(
	idToken: string,
	cookieNonce: string,
	env: Env
): Promise<{ success: true; userId: string; sessionId: string } | { success: false; response: Response }> {
	let payload;
	try {
		payload = await parseGoogleIdToken(idToken);
	} catch (e) {
		log("JWT", `Verification failed: ${e instanceof Error ? e.message : String(e)}`);
		return { success: false, response: errResponse("Authentication failed", 400) };
	}

	if (payload.nonce !== cookieNonce) {
		log("AUTH", "Nonce mismatch");
		return {
			success: false,
			response: errResponse("Invalid nonce", 400)
		};
	}

	if (payload.aud !== env.GOOGLE_CLIENT_ID) {
		log("AUTH", "Invalid token audience");
		return {
			success: false,
			response: errResponse("Invalid token audience", 400)
		};
	}

	if (payload.exp * 1000 < Date.now()) {
		log("TOKEN", "Token expired");
		return {
			success: false,
			response: errResponse("Expired token", 400)
		};
	}

	const userId = await upsertUserFromGoogle(payload, env);
	const { sessionId } = await createSession(userId, env);

	return { success: true, userId, sessionId };
}

/** Decode the base64 JSON state payload and extract the `next` path (validated). */
function extractNextFromState(state: string | null): string {
	if (!state) return "/app.html";
	try {
		const parsed = JSON.parse(atob(state)) as Record<string, unknown>;
		const next = typeof parsed.next === "string" && parsed.next.startsWith("/") && !parsed.next.startsWith("//") ? parsed.next : "/app.html";
		return next;
	} catch {
		return "/app.html";
	}
}

/** GET /api/auth/google/callback – full OAuth callback flow. */
export async function handleGoogleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const cookieState = getCookie(request, "__Host-oauth_state");
	const cookieNonce = getCookie(request, "__Host-oauth_nonce");

	const stateValidation = validateOAuthState(code, state, cookieState, cookieNonce);
	if (!stateValidation.success) return stateValidation.response;

	const tokenExchange = await exchangeCodeForToken(code!, env);
	if (!tokenExchange.success) return tokenExchange.response;

	const callbackProcessing = await processGoogleCallback(tokenExchange.idToken, cookieNonce!, env);
	if (!callbackProcessing.success) return callbackProcessing.response;

	const redirectTarget = extractNextFromState(state);

	const headers = new Headers();
	headers.set("Location", redirectTarget);
	headers.append("Set-Cookie", makeSessionCookie(callbackProcessing.sessionId, SESSION_COOKIE_MAX_AGE_SECONDS));
	headers.append("Set-Cookie", `__Host-oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
	headers.append("Set-Cookie", `__Host-oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

	return new Response(null, { status: 302, headers });
}
