import { SHORT_CODE_LENGTH, SHORT_CODE_CHARS } from "./config";

export const ALIAS_REGEX = /^[a-z0-9_-]{3,50}$/;
export const ALIAS_RESERVED = new Set(["api", "login", "logout", "app", "r"]);

export function generateShortCode(length = SHORT_CODE_LENGTH): string {
	const arr = new Uint8Array(length);
	crypto.getRandomValues(arr);
	return Array.from(arr).map(b => SHORT_CODE_CHARS[b % SHORT_CODE_CHARS.length]).join("");
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
 * Rules: 3-50 chars, lowercase letters/digits/hyphen/underscore only.
 * Reserved words (api, login, logout, app, r) are forbidden.
 */
export function validateAlias(alias: string): string | null {
	if (!ALIAS_REGEX.test(alias)) {
		return "Alias must be 3\u201350 chars: lowercase letters, digits, hyphen or underscore";
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

// Module-level keyword cache: populated on first call, lives for the Worker lifetime.
let spamKeywordCache: string[] | null = null;

/**
 * Returns true if the URL matches any spam keyword from the spam_keywords table.
 * Keywords are matched case-insensitively via regex against the full URL string.
 * The keyword list is cached in module scope (refreshed on cold start only).
 */
export async function checkSpamFilter(url: string, db: D1Database): Promise<boolean> {
	if (!spamKeywordCache) {
		const { results } = await db
			.prepare("SELECT keyword FROM spam_keywords")
			.all<{ keyword: string }>();
		spamKeywordCache = results.map(r => r.keyword);
	}
	return spamKeywordCache.some(kw => new RegExp(kw, "i").test(url));
}
