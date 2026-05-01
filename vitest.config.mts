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
					// Injected at config time (Node.js) to avoid Workers node:fs
					// Windows path issues. Used by the HTML pattern regression tests.
					APP_HTML_CONTENT: readFileSync("./public/app.html", "utf-8"),
				},
			},
		}),
	],
	test: {},
});
