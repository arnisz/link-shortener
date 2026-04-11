import type { Env } from "../types";
import { jsonResponse } from "../utils";

/** GET /api/hello – increments a counter and echoes the visit count. */
export async function handleHello(env: Env): Promise<Response> {
	await env.hello_cf_spa_db
		.prepare("UPDATE counters SET value = value + 1 WHERE name = ?")
		.bind("hello")
		.run();

	const row = await env.hello_cf_spa_db
		.prepare("SELECT value FROM counters WHERE name = ?")
		.bind("hello")
		.first<{ value: number }>();

	const response = jsonResponse({
		message: "Hallo vom Cloudflare Worker mit D1!",
		visits: row?.value ?? 0,
		time: new Date().toISOString()
	});
	response.headers.set("cache-control", "no-store");
	return response;
}
