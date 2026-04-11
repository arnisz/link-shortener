/**
 * Unit tests for src/validation.ts
 *
 * All functions here are pure (no DB, no network) and run in the Workers
 * runtime via @cloudflare/vitest-pool-workers.
 */
import { describe, it, expect } from "vitest";
import {
	isValidHttpUrl,
	isValidFutureIso,
	validateAlias,
	requireJson,
	generateShortCode,
	ALIAS_REGEX,
	ALIAS_RESERVED,
} from "../src/validation";

// ── isValidHttpUrl ────────────────────────────────────────────────────────────

describe("isValidHttpUrl", () => {
	it("accepts https:// URLs", () => {
		expect(isValidHttpUrl("https://example.com")).toBe(true);
	});

	it("accepts http:// URLs", () => {
		expect(isValidHttpUrl("http://example.com/path?q=1")).toBe(true);
	});

	it("rejects ftp:// URLs", () => {
		expect(isValidHttpUrl("ftp://files.example.com")).toBe(false);
	});

	it("rejects plain strings without a protocol", () => {
		expect(isValidHttpUrl("example.com")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isValidHttpUrl("")).toBe(false);
	});

	it("rejects javascript: URLs", () => {
		expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
	});

	it("rejects data: URLs", () => {
		expect(isValidHttpUrl("data:text/html,<h1>hi</h1>")).toBe(false);
	});

	it("accepts URLs with port numbers", () => {
		expect(isValidHttpUrl("https://localhost:8787/api")).toBe(true);
	});

	it("accepts URLs with Unicode international domain names", () => {
		expect(isValidHttpUrl("https://münchen.de")).toBe(true);
	});
});

// ── isValidFutureIso ──────────────────────────────────────────────────────────

describe("isValidFutureIso", () => {
	it("returns true for a date 1 hour in the future", () => {
		const future = new Date(Date.now() + 1000 * 60 * 60).toISOString();
		expect(isValidFutureIso(future)).toBe(true);
	});

	it("returns false for a date 1 minute in the past", () => {
		const past = new Date(Date.now() - 1000 * 60).toISOString();
		expect(isValidFutureIso(past)).toBe(false);
	});

	it("returns false for a non-ISO string", () => {
		expect(isValidFutureIso("gestern")).toBe(false);
	});

	it("returns false for an empty string", () => {
		expect(isValidFutureIso("")).toBe(false);
	});

	it("returns false for a numeric string that would parse as epoch 0", () => {
		expect(isValidFutureIso("0")).toBe(false);
	});
});

// ── validateAlias ─────────────────────────────────────────────────────────────

describe("validateAlias", () => {
	it("returns null for a valid lowercase alias", () => {
		expect(validateAlias("mein-link")).toBeNull();
	});

	it("returns null for an alias with digits and underscore", () => {
		expect(validateAlias("abc_123")).toBeNull();
	});

	it("returns null for a 3-character alias (minimum length)", () => {
		expect(validateAlias("abc")).toBeNull();
	});

	it("returns null for a 50-character alias (maximum length)", () => {
		expect(validateAlias("a".repeat(50))).toBeNull();
	});

	it("returns an error for an alias shorter than 3 characters", () => {
		expect(validateAlias("ab")).not.toBeNull();
	});

	it("returns an error for an alias longer than 50 characters", () => {
		expect(validateAlias("a".repeat(51))).not.toBeNull();
	});

	it("returns an error for uppercase letters", () => {
		expect(validateAlias("MyLink")).not.toBeNull();
	});

	it("returns an error for spaces", () => {
		expect(validateAlias("my link")).not.toBeNull();
	});

	it("returns an error for a reserved word 'api'", () => {
		expect(validateAlias("api")).not.toBeNull();
	});

	it("returns an error for a reserved word 'login'", () => {
		expect(validateAlias("login")).not.toBeNull();
	});

	it("returns an error for a reserved word 'logout'", () => {
		expect(validateAlias("logout")).not.toBeNull();
	});

	it("returns an error for a reserved word 'app'", () => {
		expect(validateAlias("app")).not.toBeNull();
	});

	it("returns an error for a reserved word 'r'", () => {
		expect(validateAlias("r")).not.toBeNull();
	});

	it("returns an error for a dot in the alias", () => {
		expect(validateAlias("my.link")).not.toBeNull();
	});
});

// ── ALIAS_REGEX ───────────────────────────────────────────────────────────────

describe("ALIAS_REGEX", () => {
	it("matches lowercase alphanumeric", () => {
		expect(ALIAS_REGEX.test("abc123")).toBe(true);
	});

	it("matches hyphen and underscore", () => {
		expect(ALIAS_REGEX.test("a-b_c")).toBe(true);
	});

	it("does not match uppercase", () => {
		expect(ALIAS_REGEX.test("Abc")).toBe(false);
	});

	it("does not match 2-char strings", () => {
		expect(ALIAS_REGEX.test("ab")).toBe(false);
	});

	it("does not match 51-char strings", () => {
		expect(ALIAS_REGEX.test("a".repeat(51))).toBe(false);
	});
});

// ── ALIAS_RESERVED ────────────────────────────────────────────────────────────

describe("ALIAS_RESERVED", () => {
	it("contains 'api'", () => {
		expect(ALIAS_RESERVED.has("api")).toBe(true);
	});

	it("contains 'login'", () => {
		expect(ALIAS_RESERVED.has("login")).toBe(true);
	});

	it("contains 'logout'", () => {
		expect(ALIAS_RESERVED.has("logout")).toBe(true);
	});

	it("contains 'app'", () => {
		expect(ALIAS_RESERVED.has("app")).toBe(true);
	});

	it("contains 'r'", () => {
		expect(ALIAS_RESERVED.has("r")).toBe(true);
	});

	it("does not contain arbitrary words", () => {
		expect(ALIAS_RESERVED.has("meinlink")).toBe(false);
	});
});

// ── requireJson ───────────────────────────────────────────────────────────────

describe("requireJson", () => {
	it("returns true for application/json content-type", () => {
		const req = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "application/json" }
		});
		expect(requireJson(req)).toBe(true);
	});

	it("returns true for application/json with charset suffix", () => {
		const req = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" }
		});
		expect(requireJson(req)).toBe(true);
	});

	it("returns false when content-type is missing", () => {
		const req = new Request("https://example.com", { method: "POST" });
		expect(requireJson(req)).toBe(false);
	});

	it("returns false for application/x-www-form-urlencoded", () => {
		const req = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" }
		});
		expect(requireJson(req)).toBe(false);
	});

	it("returns false for text/plain", () => {
		const req = new Request("https://example.com", {
			method: "POST",
			headers: { "content-type": "text/plain" }
		});
		expect(requireJson(req)).toBe(false);
	});
});

// ── generateShortCode ─────────────────────────────────────────────────────────

describe("generateShortCode", () => {
	it("generates a 6-character code by default", () => {
		expect(generateShortCode()).toHaveLength(6);
	});

	it("respects a custom length", () => {
		expect(generateShortCode(10)).toHaveLength(10);
	});

	it("only contains alphanumeric characters", () => {
		const code = generateShortCode();
		expect(/^[a-zA-Z0-9]+$/.test(code)).toBe(true);
	});

	it("produces different values across multiple calls (statistically)", () => {
		const codes = new Set(Array.from({ length: 20 }, () => generateShortCode()));
		// With 62^6 ≈ 56 billion combinations, all 20 should be unique
		expect(codes.size).toBe(20);
	});
});
