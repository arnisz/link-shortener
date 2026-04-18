export function base64UrlDecode(input: string): string {
	input = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = input.length % 4;
	if (pad) input += "=".repeat(4 - pad);
	return atob(input);
}

/**
 * 🔴 SICHERHEIT: HTML-Escaping für alle User-Inputs in HTML-Contexts.
 * Verhindert Stored XSS wenn Alias/URLs ungefiltert in HTML eingebettet werden.
 */
export function escapeHtml(unsafe: string): string {
	return unsafe
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');
}

export async function randomId(bytes = 24): Promise<string> {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getCookie(request: Request, name: string): string | null {
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

/**
 * 🔴 SICHERHEIT: Session-Cookie mit __Host--Präfix.
 * __Host- erzwingt:
 *   - Secure Flag (nur HTTPS)
 *   - Path=/ (gesamte Domain)
 *   - Kein Domain-Attribut (keine Subdomain-Übernahme möglich)
 * Verhindert Cookie Injection über Subdomains (*.aadd.li).
 */
export function makeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
	return [
		`__Host-sid=${sessionId}`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		`Max-Age=${maxAgeSeconds}`
	].join("; ");
}

export function clearSessionCookie(): string {
	return [
		"__Host-sid=",
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		"Max-Age=0"
	].join("; ");
}

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" }
	});
}

export function errResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "content-type": "application/json; charset=UTF-8" }
	});
}

export function log(category: string, message: string): void {
	console.log(`[${category}] ${message}`);
}

export function applySecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);

	// Prevent clickjacking — no framing allowed from other origins
	headers.set('Content-Security-Policy',
		"default-src 'self'; " +
		"script-src 'self'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data: https://lh3.googleusercontent.com; " +
		"connect-src 'self' https://accounts.google.com; " +
		"frame-ancestors 'none';"
	);

	// Belt-and-suspenders clickjacking protection (older browsers)
	headers.set('X-Frame-Options', 'DENY');

	// Prevent MIME type sniffing
	headers.set('X-Content-Type-Options', 'nosniff');

	// Control referrer on redirects — critical for /r/:code redirects
	// Only send origin, never the full path (hides short code from target server)
	headers.set('Referrer-Policy', 'strict-origin');

	// Restrict browser features — geolocation only allowed from self (PWA use)
	headers.set('Permissions-Policy',
		'geolocation=(self), camera=(), microphone=(), payment=()'
	);

	// HSTS — force HTTPS (Cloudflare handles this but belt-and-suspenders)
	headers.set('Strict-Transport-Security',
		'max-age=31536000; includeSubDomains; preload'
	);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
