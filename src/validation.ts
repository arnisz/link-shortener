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
 * Strikte Validierung der Ziel-URL mit Schema-Whitelist und SSRF-Schutz.
 * Verhindert: javascript:, data:, file: URIs und Zugriffe auf Private/Interne IPs.
 */
const ALLOWED_SCHEMES = ['https:', 'http:'] as const;

export function validateTargetUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { ok: false, error: 'Invalid URL format' };
	}

	// Schema-Whitelist erzwingen
	if (!ALLOWED_SCHEMES.includes(parsed.protocol as typeof ALLOWED_SCHEMES[number])) {
		return { ok: false, error: 'Only http:// and https:// URLs are allowed' };
	}

	// SSRF-Schutz: Blockiere Private/Internal IPs
	const hostname = parsed.hostname.toLowerCase();
	if (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname.endsWith('.internal') ||
		hostname.endsWith('.localhost') ||
		/^10\.\d+\.\d+\.\d+$/.test(hostname) ||
		/^192\.168\.\d+\.\d+$/.test(hostname) ||
		/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
		/^fc[0-9a-f]{2}:/i.test(hostname) || // IPv6 ULA
		/^fe80:/i.test(hostname)  // IPv6 Link-Local
	) {
		return { ok: false, error: 'Private/internal URLs are not allowed' };
	}

	return { ok: true, url: parsed };
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

/**
 * CRIT-2: SSRF-Schutz bei Geo-Link-Konstruktion.
 * Validiert Koordinaten strikt und konstruiert eine sichere Maps-URL
 * ohne String-Interpolation von User-Input.
 */
const COORD_REGEX = /^-?\d{1,3}\.\d{1,15}$/;

export function buildGeoUrl(lat: string, lng: string): string {
	if (!COORD_REGEX.test(lat) || !COORD_REGEX.test(lng)) {
		throw new Error("Invalid coordinates");
	}
	const latNum = parseFloat(lat);
	const lngNum = parseFloat(lng);

	if (latNum < -90 || latNum > 90) throw new Error("Latitude out of range");
	if (lngNum < -180 || lngNum > 180) throw new Error("Longitude out of range");

	// Koordinaten werden NICHT als String interpoliert, sondern als URLSearchParams
	const params = new URLSearchParams({ q: `${latNum},${lngNum}` });
	return `https://maps.google.com/maps?${params.toString()}`;
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
