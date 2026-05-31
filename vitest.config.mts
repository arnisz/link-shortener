import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Provide test-only values for secrets not in wrangler.jsonc
				bindings: {
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-secret",
					SESSION_SECRET: "test-session-secret",
					WAECHTER_TOKEN: "test-waechter-token",
					ADMIN_TOKEN: "test-admin-token",
					MAIL_NOTIFY_URL: "https://notify.example.com/abuse",
					MAIL_NOTIFY_TOKEN: "test-mail-token",
					TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
					TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
					// Injected at config time (Node.js) to avoid Workers node:fs
					// Windows path issues. Used by the HTML pattern regression tests.
					APP_HTML_CONTENT: readFileSync("./public/app.html", "utf-8"),
					INDEX_HTML_CONTENT: readFileSync("./public/index.html", "utf-8"),
					SW_JS_CONTENT: readFileSync("./public/sw.js", "utf-8"),
				},
			},
		}),
	],
	test: {},
});
