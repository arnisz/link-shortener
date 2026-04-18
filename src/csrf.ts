import type { Env } from "./types";

/**
 * Validates CSRF protection for state-mutating requests (POST).
 *
 * Strategy:
 * - If no Origin header is present: allow (non-browser clients: curl, mobile apps, tests).
 * - If Origin is present: it must match APP_BASE_URL AND X-Requested-With must be set.
 *
 * This blocks cross-origin form submissions and XHR from foreign sites,
 * while remaining transparent for server-side and automated callers.
 */
export function validateCsrf(request: Request, env: Env): boolean {
	if (request.method !== "POST") return true;

	const origin = request.headers.get("Origin");
	if (origin === null) {
		// No Origin header → non-browser caller (curl, tests, mobile app). Allow.
		return true;
	}

	// Origin present but doesn't match our app → cross-site request. Block.
	if (origin !== env.APP_BASE_URL) return false;

	// Origin matches, but custom header missing → likely a native <form> submission
	// from a phishing page that somehow matches origin (shouldn't happen, but belt-and-suspenders).
	return !!request.headers.get("X-Requested-With");
}


