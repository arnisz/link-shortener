import type { Env } from "./types";
import { createHmac, timingSafeEqual } from "node:crypto";
import { errResponse, getCookie } from "./utils";

/**
 * 🔴 SICHERHEIT: CSRF-Schutz mit Double-Submit-Cookie Pattern.
 * Token ist HMAC-basiert, kein separates Token-Storage nötig.
 *
 * Vektor: POST /api/links, POST /api/links/:code/update, etc.
 * ohne CSRF-Token kann fremde Website im Browser des Nutzers Requests auslösen
 * (Cookie wird automatisch mitgesendet trotz SameSite=Lax bei Top-Level-Navigation).
 */

/**
 * Generiert CSRF-Token basierend auf Session-ID.
 * Token muss vom Client in X-CSRF-Token Header mitgesendet werden.
 */
export function generateCsrfToken(sessionId: string, secret: string): string {
	const hmac = createHmac('sha256', secret);
	hmac.update(sessionId);
	return hmac.digest('hex');
}

/**
 * Validiert CSRF-Token mit Timing-safe Comparison.
 * Erwartet Token im X-CSRF-Token Header.
 */
export function validateCsrfToken(
	request: Request,
	sessionId: string,
	secret: string
): boolean {
	const headerToken = request.headers.get('X-CSRF-Token');
	if (!headerToken) return false;

	const expectedToken = generateCsrfToken(sessionId, secret);

	// Timing-safe comparison: verhindert Timing Attacks
	if (headerToken.length !== expectedToken.length) return false;

	const a = Buffer.from(headerToken, 'utf-8');
	const b = Buffer.from(expectedToken, 'utf-8');
	return timingSafeEqual(a, b);
}

/**
 * LEGACY: Origin + X-Requested-With Check für Backwards-Compatibility.
 * Neue CSRF-Validierung läuft in Session-basierten Endpoints ab.
 */
export function validateCsrf(request: Request, env: Env): boolean {
	if (request.method !== "POST") return true;

	const origin = request.headers.get("Origin");
	if (origin === null) {
		// Kein Origin Header → non-browser caller (curl, tests, mobile app). Allow.
		return true;
	}

	// Origin present but doesn't match → block
	if (origin !== env.APP_BASE_URL) return false;

	// Origin matches, aber custom header fehlt → kann immer noch legitim sein
	// (native <form> submission). Mit Token-basiertm CSRF wird dies überprüft.
	return !!request.headers.get("X-Requested-With");
}

/**
 * Kombinierte CSRF-Prüfung für authentifizierte Mutation-Endpoints.
 * Gibt null zurück wenn OK, oder eine errResponse(403) bei Verstoß.
 *
 * Logik:
 * - Kein Origin Header → Non-Browser (curl, mobile) → erlaubt
 * - Foreign Origin → immer blockiert
 * - Same-Origin → erlaubt wenn X-CSRF-Token ODER X-Requested-With vorhanden
 */
export function validateMutationCsrf(
	request: Request,
	env: { APP_BASE_URL: string; SESSION_SECRET: string }
): Response | null {
	const origin = request.headers.get("Origin");
	if (!origin) return null; // Non-browser client

	if (origin !== env.APP_BASE_URL) {
		return errResponse("Invalid CSRF token", 403);
	}

	// Same-origin: Token ODER Legacy-Header erforderlich
	const hasXRequestedWith = !!request.headers.get("X-Requested-With");
	const sid = getCookie(request, "__Host-sid");
	const hasValidToken = sid
		? validateCsrfToken(request, sid, env.SESSION_SECRET)
		: false;

	if (!hasValidToken && !hasXRequestedWith) {
		return errResponse("Invalid CSRF token", 403);
	}

	return null;
}


