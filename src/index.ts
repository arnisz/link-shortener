import type { Env } from "./types";
import { handleGetMe, handleLogout, handleLogin, handleGoogleCallback } from "./handlers/auth";
import { handleCreateLink, handleGetLinks, handleUpdateLink, handleDeleteLink, handleRedirect, handleCreateAnonymousLink } from "./handlers/links";
import { handleHello } from "./handlers/hello";
import { applySecurityHeaders, errResponse } from "./utils";
import { validateCsrf } from "./csrf";

async function router(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const { pathname, method } = { pathname: url.pathname, method: request.method };

	// ── CSRF protection: reject cross-origin POST requests ────────────────────
	if (!validateCsrf(request, env)) {
		return errResponse("CSRF validation failed", 403);
	}

	if (pathname === "/login" && method === "GET")                         return handleLogin(request, env);
	if (pathname === "/api/auth/google/callback" && method === "GET")      return handleGoogleCallback(request, env);
	if (pathname === "/api/me" && method === "GET")                        return handleGetMe(request, env);
	if (pathname === "/logout" && method === "POST")    return handleLogout(request, env);
	if (pathname === "/api/hello" && method === "GET")                     return handleHello(env);
	if (pathname === "/api/links/anonymous" && method === "POST") return handleCreateAnonymousLink(request, env);
	if (pathname === "/api/links" && method === "POST") return handleCreateLink(request, env);
	if (pathname === "/api/links" && method === "GET")  return handleGetLinks(request, env);

	const updateMatch = pathname.match(/^\/api\/links\/([^/]+)\/update$/);
	if (updateMatch && method === "POST") return handleUpdateLink(updateMatch[1], request, env);

	const deleteMatch = pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
	if (deleteMatch && method === "POST") return handleDeleteLink(deleteMatch[1], request, env);

	const redirectMatch = pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
	if (redirectMatch && method === "GET") return handleRedirect(redirectMatch[1], env, ctx, request);

	return new Response("Not found", { status: 404 });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return applySecurityHeaders(await router(request, env, ctx));
	}
};
