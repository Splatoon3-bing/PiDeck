/** Web 收藏：正文/来源由既有 Store 与 catalog 决定，浏览器只能添加当前会话引用或删除。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FavoritesStore } from "../favorites/FavoritesStore";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WEB_CORS_HEADERS } from "./WebHttpResponders";

type SourceSession = { id: string; title: string; projectId: string };
export type WebFavoritesRoutesDeps = {
	store: () => FavoritesStore | null;
	getSession: (sessionId: string) => SourceSession | undefined;
	log?: (message: string, details: Record<string, unknown>) => void;
};
function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(value));
}
function id(body: unknown, field: string): string {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw Object.assign(new Error("invalid body"), { name: "WebFavoriteValidationError" });
	const input = body as Record<string, unknown>;
	if (Object.keys(input).length !== 1 || !Object.hasOwn(input, field) || typeof input[field] !== "string" || !input[field].trim() || input[field].length > 200) throw Object.assign(new Error(`${field} is invalid`), { name: "WebFavoriteValidationError", field });
	return input[field].trim();
}
export class WebFavoritesRoutes {
	constructor(private readonly deps: WebFavoritesRoutesDeps) {}
	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/favorites" && !url.pathname.startsWith("/api/favorites/")) return false;
		try {
			if (url.pathname === "/api/favorites" && request.method === "GET") {
				json(response, 200, { entries: this.store().list() });
				return true;
			}
			if (request.method !== "POST") {
				json(response, 405, { code: "webError.methodNotAllowed" });
				return true;
			}
			const body = await readJson(request, 4096);
			if (url.pathname === "/api/favorites/add-session") {
				const sessionId = id(body, "sessionId");
				const session = this.deps.getSession(sessionId);
				if (!session) throw Object.assign(new Error("session not found"), { name: "WebFavoriteNotFoundError" });
				const entry = await this.store().add({ kind: "session", text: "", sessionId, sessionTitle: session.title, projectId: session.projectId, role: null, messageId: null, model: null, partial: false });
				this.log("add-session", { favoriteId: entry.id, sessionId });
				json(response, 200, { entry });
				return true;
			}
			if (url.pathname === "/api/favorites/delete") {
				const favoriteId = id(body, "favoriteId");
				if (!(await this.store().remove(favoriteId))) throw Object.assign(new Error("favorite not found"), { name: "WebFavoriteNotFoundError" });
				this.log("delete", { favoriteId });
				json(response, 200, { ok: true });
				return true;
			}
			json(response, 404, { code: "webError.apiNotFound" });
			return true;
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			const status = name === "WebBodyTooLargeError" ? 413 : name === "WebFavoriteNotFoundError" ? 404 : 400;
			const code = name === "WebBodyTooLargeError" ? "webError.bodyTooLarge" : name === "WebInvalidJsonError" ? "webError.invalidJson" : name === "WebFavoriteNotFoundError" ? "webError.favoriteNotFound" : name === "WebFavoriteUnavailableError" ? "webError.favoriteUnavailable" : "webError.invalidFavorite";
			json(response, name === "WebFavoriteUnavailableError" ? 503 : status, { code, message: "favorite operation rejected" });
			return true;
		}
	}
	private store(): FavoritesStore {
		const store = this.deps.store();
		if (!store) throw Object.assign(new Error("favorites unavailable"), { name: "WebFavoriteUnavailableError" });
		return store;
	}
	private log(message: string, details: Record<string, unknown>): void {
		if (this.deps.log) this.deps.log(message, details);
		else void getAppLogger()?.info("web-favorites", message, details);
	}
}
