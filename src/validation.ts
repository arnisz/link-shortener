import { SHORT_CODE_LENGTH, SHORT_CODE_CHARS } from "./config";
import { log } from "./utils";

export const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,50}$/;
export const ALIAS_RESERVED = new Set(["api", "login", "logout", "app", "r"]);

export function generateShortCode(length = SHORT_CODE_LENGTH): string {
	const charsetLen = SHORT_CODE_CHARS.length;
	// Reject bytes >= maxUnbiased to eliminate modulo bias.
	// With 62 chars: Math.floor(256 / 62) * 62 = 248; bytes 248–255 are discarded.
	const maxUnbiased = Math.floor(256 / charsetLen) * charsetLen;
	const result: string[] = [];
	while (result.length < length) {
		// Generate extra bytes to almost always finish in a single pass (~3 % rejection rate).
		const arr = new Uint8Array(length * 2);
		crypto.getRandomValues(arr);
		for (const b of arr) {
			if (result.length >= length) break;
			if (b < maxUnbiased) result.push(SHORT_CODE_CHARS[b % charsetLen]);
		}
	}
	return result.join("");
}

export function isValidHttpUrl(input: string): boolean {
	try {
		const u = new URL(input);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Validates alias according to business rules.
 * Rules: 3-50 chars, letters/digits/hyphen/underscore only.
 * Reserved words (api, login, logout, app, r) are forbidden.
 * Assumes input has been normalized (NFKC, dash-replacement).
 */
export function validateAlias(alias: string): string | null {
	if (!ALIAS_REGEX.test(alias)) {
		return "Alias must be 3\u201350 chars: letters, digits, hyphen or underscore";
	}
	if (ALIAS_RESERVED.has(alias)) {
		return `"${alias}" is a reserved word`;
	}
	return null;
}

/** Returns true if the input is a valid ISO date strictly in the future. */
export function isValidFutureIso(input: string): boolean {
	const d = new Date(input);
	return !isNaN(d.getTime()) && d.getTime() > Date.now();
}

/** Returns true if the request declares Content-Type: application/json. */
export function requireJson(request: Request): boolean {
	const ct = request.headers.get("content-type") ?? "";
	return ct.includes("application/json");
}

// Module-level keyword cache: populated on first call, refreshed every 5 minutes.
let spamKeywordCache: string[] | null = null;
let spamKeywordCacheExpiry = 0;

/**
 * Resets the spam keyword cache.
 * @internal Only for use in tests to ensure isolation between test runs.
 */
export function _resetSpamKeywordCache(): void {
	spamKeywordCache = null;
	spamKeywordCacheExpiry = 0;
}

/**
 * Returns true if the URL matches any spam keyword from the spam_keywords table.
 * Keywords are matched case-insensitively against the full URL string.
 * The keyword list is cached in module scope and refreshed every 5 minutes.
 */
export async function checkSpamFilter(url: string, db: D1Database): Promise<boolean> {
	if (spamKeywordCache === null || Date.now() > spamKeywordCacheExpiry) {
		try {
			const { results } = await db.prepare("SELECT keyword FROM spam_keywords")
				.all<{ keyword: string }>();

			// Always update expiry, even if results.length === 0, to avoid re-fetching on every request.
			spamKeywordCacheExpiry = Date.now() + 5 * 60 * 1000;

			if (results.length > 0) {
				// Pre-lowercase once at cache-fill time to avoid per-request work.
				spamKeywordCache = results.map(r => r.keyword.toLowerCase());
			} else if (spamKeywordCache === null) {
				// First load returned no keywords: set an explicit empty array so the TTL
				// is honoured and the DB is not queried on every subsequent request.
				spamKeywordCache = [];
			}
			// If results.length === 0 and cache was previously populated: keep the existing
			// cache to guard against transient DB issues wiping all keywords.
		} catch (e) {
			log("SPAM", `Cache load failed: ${e instanceof Error ? e.message : String(e)}`);
			// On DB error: do not update cache or expiry so the next request retries.
		}
	}
	const lowerUrl = url.toLowerCase();
	return spamKeywordCache?.some(kw => lowerUrl.includes(kw)) ?? false;
}
