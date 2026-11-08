/**
 * Web 通知域：toast 历史（NoticeHistoryStore）与公告（AnnouncementService）的安全投影。
 *
 * 两者都是只读数据 + 少量用户状态写（清空历史 / 标记已读），业务全部在主进程既有实例，
 * Web 只做投影、入参收窄与审计；不新增 pi↔PiDeck 通道，也不解释公告正文（渲染层走既有
 * Markdown 净化链）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NoticeHistoryStore } from "../notices/NoticeHistoryStore";
import type { AnnouncementService } from "../announcements/AnnouncementService";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WEB_CORS_HEADERS } from "./WebHttpResponders";

const MAX_BODY_BYTES = 8 * 1024;
/** 公告 id 上限：feed 校验侧同量级，这里只挡误传的超长串。 */
const MAX_ID_CHARS = 200;

export type WebNoticeRoutesDeps = {
	notices: () => NoticeHistoryStore | null;
	announcements: () => AnnouncementService | null;
	log?: (message: string, details: Record<string, unknown>) => void;
};

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(body));
}
function fail(response: ServerResponse, status: number, code: string): void {
	json(response, status, { code, message: "notice operation rejected" });
}
function readId(body: Record<string, unknown>): string {
	const value = body.id;
	if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_CHARS) throw Object.assign(new Error("id is invalid"), { name: "WebNoticeValidationError" });
	return value.trim();
}

export class WebNoticeRoutes {
	constructor(private readonly deps: WebNoticeRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!url.pathname.startsWith("/api/notices") && !url.pathname.startsWith("/api/announcements")) return false;
		try {
			if (url.pathname === "/api/notices" && request.method === "GET") {
				const store = this.deps.notices();
				if (!store) return this.unavailable(response);
				json(response, 200, { entries: await store.load() });
				return true;
			}
			if (url.pathname === "/api/announcements" && request.method === "GET") {
				const service = this.deps.announcements();
				if (!service) return this.unavailable(response);
				const state = service.getState();
				// notifiedIds 是「本机已弹过提醒」的内部簿记，Web 不需要也不该据此推断终端行为。
				json(response, 200, { items: state.items, readIds: state.readIds, fetchedAt: state.fetchedAt, source: state.source });
				return true;
			}
			if (request.method !== "POST") {
				fail(response, 405, "webError.methodNotAllowed");
				return true;
			}
			if (url.pathname === "/api/notices/clear") {
				const store = this.deps.notices();
				if (!store) return this.unavailable(response);
				await readJson(request, MAX_BODY_BYTES);
				await store.clear();
				this.log("notices.clear", {});
				json(response, 200, { ok: true });
				return true;
			}
			if (url.pathname === "/api/announcements/mark-read") {
				const service = this.deps.announcements();
				if (!service) return this.unavailable(response);
				const id = readId(await readJson<Record<string, unknown>>(request, MAX_BODY_BYTES));
				service.markRead(id);
				this.log("announcements.mark-read", { id });
				json(response, 200, { ok: true });
				return true;
			}
			if (url.pathname === "/api/announcements/mark-all-read") {
				const service = this.deps.announcements();
				if (!service) return this.unavailable(response);
				await readJson(request, MAX_BODY_BYTES);
				service.markAllRead();
				this.log("announcements.mark-all-read", {});
				json(response, 200, { ok: true });
				return true;
			}
			fail(response, 404, "webError.apiNotFound");
			return true;
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			if (name === "WebBodyTooLargeError") fail(response, 413, "webError.bodyTooLarge");
			else if (name === "WebInvalidJsonError") fail(response, 400, "webError.invalidJson");
			else fail(response, 400, "webError.invalidNotice");
			return true;
		}
	}

	private unavailable(response: ServerResponse): boolean {
		fail(response, 503, "webError.noticeUnavailable");
		return true;
	}

	private log(message: string, details: Record<string, unknown>): void {
		if (this.deps.log) this.deps.log(message, details);
		else void getAppLogger()?.info("web-notices", message, details);
	}
}
