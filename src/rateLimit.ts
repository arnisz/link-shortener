/**
 * IP-based rate limiting using D1.
 *
 * Window = current minute (truncated ISO: "2026-04-11T14:05")
 * Limit  = 10 requests per window per IP.
 * Old windows (> 5 minutes) are cleaned up on each check.
 */

/** Truncates a Date to the current minute: "2026-04-11T14:05" */
function currentWindow(date: Date = new Date()): string {
	return date.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

/** Returns the window string 5 minutes before now (for cleanup). */
function cutoffWindow(): string {
	return currentWindow(new Date(Date.now() - 5 * 60 * 1000));
}

export async function checkRateLimit(
	ip: string,
	db: D1Database
): Promise<{ allowed: boolean }> {
	const window = currentWindow();
	const cutoff = cutoffWindow();

	// Clean up stale windows to prevent unbounded table growth
	await db
		.prepare("DELETE FROM rate_limits WHERE window_start < ?")
		.bind(cutoff)
		.run();

	// Upsert: create row if not exists, then increment
	await db
		.prepare(
			"INSERT OR IGNORE INTO rate_limits (ip, window_start, count) VALUES (?, ?, 0)"
		)
		.bind(ip, window)
		.run();

	await db
		.prepare(
			"UPDATE rate_limits SET count = count + 1 WHERE ip = ? AND window_start = ?"
		)
		.bind(ip, window)
		.run();

	const row = await db
		.prepare("SELECT count FROM rate_limits WHERE ip = ? AND window_start = ?")
		.bind(ip, window)
		.first<{ count: number }>();

	return { allowed: (row?.count ?? 0) <= 10 };
}
