declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		// Secrets injected via vitest.config.mts miniflare.bindings
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		SESSION_SECRET: string;
		// Var from wrangler.jsonc
		APP_BASE_URL: string;
		// HTML source of public/app.html, read at config time for pattern regression tests
		APP_HTML_CONTENT: string;
	}
}
