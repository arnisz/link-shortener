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

	it("passes Turnstile and other cross-origin requests straight to the network", () => {
		// The service worker must not intercept cross-origin requests (e.g., to Google for OAuth, or to Cloudflare for Turnstile).
		// It should let the browser handle them. The correct way is to check `url.origin` and return early.
		// A previous version of this test had a bug: it checked that `e.respondWith(fetch(e.request))` *never* appeared.
		// This is wrong, because for same-origin requests that are network-only, this is the correct code.
		// The key is that the cross-origin check must happen *before* any `respondWith` call.

		const sw = env.SW_JS_CONTENT;

		// 1. There is a generic cross-origin guard.
		expect(sw).toContain("if (url.origin !== self.location.origin)");
		// 2. The guard causes an early exit.
		expect(sw).toContain("return;");
		// 3. There is no hardcoded special rule for Turnstile.
		expect(sw).not.toContain("url.hostname === 'challenges.cloudflare.com'");

		// 4. The origin guard must appear before the first call to `e.respondWith`.
		const originGuardPos = sw.indexOf("if (url.origin !== self.location.origin)");
		const firstRespondWithPos = sw.indexOf("e.respondWith");

		expect(originGuardPos).toBeGreaterThanOrEqual(0);
		expect(firstRespondWithPos).toBeGreaterThan(originGuardPos);

		// 5. The code block between the guard and the first `respondWith` must contain the early exit.
		const guardBlock = sw.slice(originGuardPos, firstRespondWithPos);
		expect(guardBlock).toContain("return;");
	});
});


