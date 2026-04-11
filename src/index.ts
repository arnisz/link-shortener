import type { Env } from "./types";
import { handleGetMe, handleLogout, handleLogin, handleGoogleCallback } from "./handlers/auth";
import { handleCreateLink, handleGetLinks, handleUpdateLink, handleDeleteLink, handleRedirect, handleCreateAnonymousLink } from "./handlers/links";
import { handleHello } from "./handlers/hello";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { pathname, method } = { pathname: url.pathname, method: request.method };

		if (pathname === "/login")                          return handleLogin(request, env);
		if (pathname === "/api/auth/google/callback")       return handleGoogleCallback(request, env);
		if (pathname === "/api/me")                         return handleGetMe(request, env);
		if (pathname === "/logout" && method === "POST")    return handleLogout(request, env);
		if (pathname === "/api/hello")                      return handleHello(env);
		if (pathname === "/api/links/anonymous" && method === "POST") return handleCreateAnonymousLink(request, env);
		if (pathname === "/api/links" && method === "POST") return handleCreateLink(request, env);
		if (pathname === "/api/links" && method === "GET")  return handleGetLinks(request, env);

		const updateMatch = pathname.match(/^\/api\/links\/([^/]+)\/update$/);
		if (updateMatch && method === "POST") return handleUpdateLink(updateMatch[1], request, env);

		const deleteMatch = pathname.match(/^\/api\/links\/([^/]+)\/delete$/);
		if (deleteMatch && method === "POST") return handleDeleteLink(deleteMatch[1], request, env);

		const redirectMatch = pathname.match(/^\/r\/([a-zA-Z0-9_-]+)$/);
		if (redirectMatch) return handleRedirect(redirectMatch[1], env, ctx);

		return new Response("Not found", { status: 404 });
	}
};
