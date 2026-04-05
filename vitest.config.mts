import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Provide test-only values for secrets not in wrangler.jsonc
					bindings: {
						GOOGLE_CLIENT_ID: "test-google-client-id",
						GOOGLE_CLIENT_SECRET: "test-google-secret",
						SESSION_SECRET: "test-session-secret",
					},
				},
			},
		},
	},
});
