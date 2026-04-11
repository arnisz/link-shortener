export function base64UrlDecode(input: string): string {
	input = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = input.length % 4;
	if (pad) input += "=".repeat(4 - pad);
	return atob(input);
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

export function makeSessionCookie(sessionId: string, maxAgeSeconds: number): string {
	return [
		`sid=${sessionId}`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		`Max-Age=${maxAgeSeconds}`
	].join("; ");
}

export function clearSessionCookie(): string {
	return [
		"sid=",
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
