import { Env as SrcEnv } from "../src/types";

declare global {
	namespace Cloudflare {
		interface Env extends SrcEnv {
			APP_HTML_CONTENT: string;
				INDEX_HTML_CONTENT: string;
				SW_JS_CONTENT: string;
		}
	}
}
