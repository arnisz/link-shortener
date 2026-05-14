import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("public login navigation regression", () => {
	it("uses a direct login anchor instead of a nested button", () => {
		expect(env.INDEX_HTML_CONTENT).toContain('<a href="/login" class="google-login">');
		expect(env.INDEX_HTML_CONTENT).not.toMatch(/<a\s+href="\/login"[^>]*>\s*<button/i);
	});

	it("treats login and OAuth callback routes as network-only in the service worker", () => {
		expect(env.SW_JS_CONTENT).toContain("'/login'");
		expect(env.SW_JS_CONTENT).toContain("'/logout'");
		expect(env.SW_JS_CONTENT).toContain("'/api/auth/google/callback'");
		expect(env.SW_JS_CONTENT).toContain("e.request.mode === 'navigate'");
	});
});


