/**
 * Unit tests for src/utils.ts
 *
 * All functions tested here are pure (no DB, no network) and run in the
 * Workers runtime via @cloudflare/vitest-pool-workers.
 */
import { describe, it, expect } from "vitest";
import {
	base64UrlDecode,
	getCookie,
	makeSessionCookie,
	clearSessionCookie,
	jsonResponse,
	errResponse,
	log,
	randomId,
} from "../src/utils";

// ── base64UrlDecode ───────────────────────────────────────────────────────────

describe("base64UrlDecode", () => {
	it("decodes a standard base64url string without padding", () => {
		// btoa('hello') = 'aGVsbG8=' → URL-safe: 'aGVsbG8'
		expect(base64UrlDecode("aGVsbG8")).toBe("hello");
	});

	it("converts URL-safe characters (- → +, _ → /)", () => {
		// base64 for the bytes that produce '+' and '/' in standard base64
		// 0xFB 0xFF → '+/' in standard, '-_' in base64url
		const standard = btoa("\xfb\xff");
		const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(base64UrlDecode(urlSafe)).toBe(atob(standard));
	});

	it("handles missing padding (1 missing =)", () => {
		// btoa('a') = 'YQ=='  → 'YQ' in base64url (2 chars missing)
		expect(base64UrlDecode("YQ")).toBe("a");
	});

	it("handles missing padding (2 missing =)", () => {
		// btoa('ab') = 'YWI='  → 'YWI' in base64url (1 char missing)
		expect(base64UrlDecode("YWI")).toBe("ab");
	});

	it("round-trips a JSON payload correctly", () => {
		const payload = JSON.stringify({ sub: "123", email: "user@example.com" });
		const encoded = btoa(payload)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		expect(base64UrlDecode(encoded)).toBe(payload);
	});
});

// ── getCookie ─────────────────────────────────────────────────────────────────

describe("getCookie", () => {
	it("returns the value of an existing cookie", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: "sid=abc123; theme=dark" }
		});
		expect(getCookie(req, "sid")).toBe("abc123");
	});

	it("returns the correct value when multiple cookies are present", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: "a=1; b=2; c=3" }
		});
		expect(getCookie(req, "b")).toBe("2");
	});

	it("returns null when the cookie name is not found", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: "a=1; b=2" }
		});
		expect(getCookie(req, "missing")).toBeNull();
	});

	it("returns null when there is no Cookie header", () => {
		const req = new Request("https://example.com");
		expect(getCookie(req, "sid")).toBeNull();
	});

	it("handles cookies with '=' in the value", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: "token=abc=def=ghi" }
		});
		expect(getCookie(req, "token")).toBe("abc=def=ghi");
	});

	it("is case-sensitive for cookie names", () => {
		const req = new Request("https://example.com", {
			headers: { Cookie: "SID=upper" }
		});
		expect(getCookie(req, "sid")).toBeNull();
		expect(getCookie(req, "SID")).toBe("upper");
	});
});

// ── makeSessionCookie ─────────────────────────────────────────────────────────

describe("makeSessionCookie", () => {
	it("includes sid= with the session ID", () => {
		const cookie = makeSessionCookie("mysession", 3600);
		expect(cookie).toContain("sid=mysession");
	});

	it("includes the correct Max-Age", () => {
		const cookie = makeSessionCookie("s", 7200);
		expect(cookie).toContain("Max-Age=7200");
	});

	it("includes security attributes HttpOnly, Secure, SameSite=Lax", () => {
		const cookie = makeSessionCookie("s", 1);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
	});

	it("sets Path=/", () => {
		expect(makeSessionCookie("s", 1)).toContain("Path=/");
	});
});

// ── clearSessionCookie ────────────────────────────────────────────────────────

describe("clearSessionCookie", () => {
	it("sets sid= to an empty value", () => {
		expect(clearSessionCookie()).toContain("sid=");
		// Ensure it's not a real session ID
		const value = clearSessionCookie().split(";")[0].split("=")[1];
		expect(value).toBe("");
	});

	it("sets Max-Age=0 to immediately expire the cookie", () => {
		expect(clearSessionCookie()).toContain("Max-Age=0");
	});

	it("includes HttpOnly, Secure, SameSite=Lax", () => {
		const cookie = clearSessionCookie();
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");
	});
});

// ── jsonResponse ──────────────────────────────────────────────────────────────

describe("jsonResponse", () => {
	it("returns status 200 by default", () => {
		expect(jsonResponse({}).status).toBe(200);
	});

	it("returns the provided status code", () => {
		expect(jsonResponse({}, 201).status).toBe(201);
	});

	it("sets content-type to application/json", async () => {
		const res = jsonResponse({ ok: true });
		expect(res.headers.get("content-type")).toContain("application/json");
	});

	it("serialises the data to JSON in the body", async () => {
		const res = jsonResponse({ message: "hello" });
		const body = await res.json<{ message: string }>();
		expect(body.message).toBe("hello");
	});
});

// ── errResponse ───────────────────────────────────────────────────────────────

describe("errResponse", () => {
	it("returns the given HTTP status code", () => {
		expect(errResponse("bad", 400).status).toBe(400);
		expect(errResponse("unauth", 401).status).toBe(401);
	});

	it("wraps the message in an { error } object", async () => {
		const res = errResponse("something went wrong", 400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toBe("something went wrong");
	});

	it("sets content-type to application/json", () => {
		const res = errResponse("oops", 500);
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});

// ── randomId ──────────────────────────────────────────────────────────────────

describe("randomId", () => {
	it("generates a hex string of length 2 * bytes (default 48 chars for 24 bytes)", async () => {
		const id = await randomId();
		expect(id).toHaveLength(48);
	});

	it("generates a hex string of the requested byte count", async () => {
		const id = await randomId(16);
		expect(id).toHaveLength(32);
	});

	it("only contains lowercase hex characters", async () => {
		const id = await randomId(20);
		expect(/^[0-9a-f]+$/.test(id)).toBe(true);
	});

	it("returns different values on successive calls", async () => {
		const ids = await Promise.all(Array.from({ length: 10 }, () => randomId()));
		const unique = new Set(ids);
		expect(unique.size).toBe(10);
	});
});

// ── log ───────────────────────────────────────────────────────────────────────

describe("log", () => {
	it("does not throw for any valid category and message", () => {
		expect(() => log("AUTH", "test message")).not.toThrow();
		expect(() => log("TOKEN", "another message")).not.toThrow();
		expect(() => log("REDIRECT", "redirect log")).not.toThrow();
	});
});
