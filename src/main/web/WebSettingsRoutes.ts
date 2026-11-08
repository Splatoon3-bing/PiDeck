/**
 * Web 端设置路由（WebSettingsRoutes.ts）
 *
 * GET  /api/settings —— 返回白名单投影（含明暗/字号/默认后端/输入行为）
 * POST /api/settings —— 只接受白名单键，未知键 400 且不部分写入；成功返回更新后的投影
 *
 * 鉴权沿用 WebServiceManager 的 /api/* 令牌链（本模块不认识 token）；能力由装配层注入，
 * 未注入时返回 503，而不是静默成功。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppSettings, SafeWebSettings } from "../../shared/types";
import { broadcastSettingsApplied } from "../settings/settingsBroadcast";
import { readJson, WebBodyTooLargeError, WebInvalidJsonError, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { isWebSettingsValidationError, parseSafeWebSettingsPatch, toSafeWebSettings } from "./WebSettingsProjection";

export type WebSettingsRoutesDeps = {
	/** 当前持久化设置（SettingsStore.get）。 */
	read: () => AppSettings;
	/** 写设置（SettingsStore.update + 装配层的副作用/广播）。 */
	update: (patch: Partial<AppSettings>) => Promise<AppSettings>;
};

/**
 * 装配层入口：把 SettingsStore 接到路由，并统一处理两件跨窗口副作用——
 * 明暗偏好重放（决定原生标题栏/窗体配色）与「设置已生效」广播（桌面渲染层据此同步）。
 *
 * 放在这里而不是 main/index.ts：后者是合并热点，新增域的装配只留一行。
 */
export function createWebSettingsRoutes(deps: { settings: { get: () => AppSettings; update: (patch: Partial<AppSettings>) => Promise<AppSettings> }; onThemeApplied?: (settings: AppSettings) => void }): WebSettingsRoutes {
	return new WebSettingsRoutes({
		read: () => deps.settings.get(),
		update: async (patch) => {
			const next = await deps.settings.update(patch);
			if ("theme" in patch) deps.onThemeApplied?.(next);
			broadcastSettingsApplied(next);
			return next;
		},
	});
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...WEB_CORS_HEADERS,
	});
	response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string, field?: string) {
	sendJson(response, status, { code, message, ...(field ? { field } : {}) });
}

/** 请求体上限：设置补丁都是短 JSON，超出即拒（不进入 JSON.parse）。 */
const MAX_SETTINGS_BODY_BYTES = 32 * 1024;

export class WebSettingsRoutes {
	constructor(private readonly deps: WebSettingsRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/settings") return false;
		if (request.method === "GET") {
			sendJson(response, 200, { settings: this.current() });
			return true;
		}
		if (request.method !== "POST") {
			sendError(response, 405, "webError.methodNotAllowed", "method not allowed");
			return true;
		}
		try {
			const body = await this.readBody(request);
			const patch = parseSafeWebSettingsPatch(body);
			const updated = await this.deps.update(patch);
			sendJson(response, 200, { settings: toSafeWebSettings(updated) });
		} catch (error) {
			if (isWebSettingsValidationError(error)) {
				const code = error.field === "body" ? "webError.invalidRequest" : `webError.settings.${error.message.startsWith("unknown") ? "unknownKey" : "invalidValue"}`;
				sendError(response, 400, code, error.message, error.field === "body" ? undefined : error.field);
				return true;
			}
			if (error instanceof WebBodyTooLargeError) {
				sendError(response, 413, "webError.bodyTooLarge", "settings payload too large");
				return true;
			}
			if (error instanceof WebInvalidJsonError) {
				sendError(response, 400, "webError.invalidRequest", "invalid JSON body");
				return true;
			}
			const message = error instanceof Error ? error.message : "settings update failed";
			sendError(response, 500, "webError.internal", message);
		}
		return true;
	}

	private current(): SafeWebSettings {
		return toSafeWebSettings(this.deps.read());
	}

	/** 有界读 JSON：与其它 /api 路由同源（超限 413、非法 JSON 400）。 */
	private readBody(request: IncomingMessage): Promise<unknown> {
		return readJson<unknown>(request, MAX_SETTINGS_BODY_BYTES);
	}
}
