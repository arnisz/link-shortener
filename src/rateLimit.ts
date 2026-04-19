import { log } from "./utils";

/**
 * 🔴 SICHERHEIT: Key-basiertes Rate Limiting mit D1.
 *
 * IP-basiertes Limiting ist anfällig gegen:
 * - IPv6-Rotation: /128 Adressen können beliebig generiert werden
 * - CF-Connecting-IP Header-Spoofing: Wenn direkt auf Origin erreichbar
 * - Verteilte Angriffe
 *
 * Lösung hier: Für Cloudflare Workers ist CF-Connecting-IP sicher, wenn:
 * 1. Traffic über Cloudflare Proxy läuft (Production)
 * 2. Für Localhost/Tests: Fallback IP verwendet
 *
 * Window = current minute (truncated ISO: "2026-04-11T14:05")
 * Default limit = 10 requests per window per key.
 * Key ist typischerweise eine IP, kann aber auch composite sein wie "login:1.2.3.4"
 * oder "redirect:1.2.3.4" für separate Counters pro Tier.
 * Alte Windows (> 5 Minuten) werden bei jedem Check gelöscht.
 */

/** Truncates a Date to the current minute: "2026-04-11T14:05" */
function currentWindow(date: Date = new Date()): string {
	return date.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

/** Returns the window string 5 minutes before now (for cleanup). */
function cutoffWindow(): string {
	return currentWindow(new Date(Date.now() - 5 * 60 * 1000));
}

/**
 * Extrahiert die echte Client-IP mit Fallback-Logik.
 * CF-Connecting-IP ist sicher, wenn über Cloudflare Proxy.
 * Ohne CF-Header: Fallback auf "127.0.0.1" (lokale Tests).
 */
function extractClientIp(request: Request): string {
	// Cloudflare Workers: CF-Connecting-IP ist die echte Client-IP
	// Nur verfügbar wenn Traffic über CF läuft
	const cfIp = request.headers.get("CF-Connecting-IP");
	if (cfIp) {
		return cfIp;
	}

	// Fallback für lokale Development/Tests ohne CF
	// X-Forwarded-For ist nicht vertrauenswürdig ohne CF
	return "127.0.0.1";
}

export async function checkRateLimit(
	key: string,
	db: D1Database,
	limit = 10
): Promise<{ allowed: boolean }> {
	try {
		const window = currentWindow();
		const cutoff = cutoffWindow();

		// Clean up stale windows to prevent unbounded table growth
		await db
			.prepare("DELETE FROM rate_limits WHERE window_start < ?")
			.bind(cutoff)
			.run();

		// Atomic upsert: insert or increment in a single statement
		await db
			.prepare(
				"INSERT INTO rate_limits (ip, window_start, count) VALUES (?, ?, 1) ON CONFLICT(ip, window_start) DO UPDATE SET count = count + 1"
			)
			.bind(key, window)
			.run();

		const row = await db
			.prepare("SELECT count FROM rate_limits WHERE ip = ? AND window_start = ?")
			.bind(key, window)
			.first<{ count: number }>();

		return { allowed: (row?.count ?? 0) <= limit };
	} catch (e) {
		// 🔴 SICHERHEIT: Fail-open bei DB-Fehler — Rate-Limiting darf den Service nicht crashen.
		// Cloudflare bietet eigene DDoS-Mitigation, daher ist kurzzeitiger Ausfall des Limitings akzeptabel.
		log("RATE_LIMIT", `DB error (fail-open): ${e instanceof Error ? e.message : String(e)}`);
		return { allowed: true };
	}
}

// 🔴 SICHERHEIT: Export für externe Nutzung
export { extractClientIp };

