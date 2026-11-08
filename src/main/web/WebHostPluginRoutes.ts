/**
 * Web 宿主插件（T14）：**只读**安全投影。
 *
 * 边界（评审见 .ai/sdd/specs/001-web-parity/t14-host-plugin-security-review.md）：
 * - 只允许 `GET /api/host-plugins`；安装/卸载/授权/rescan/面板/执行一律不存在（405/404）。
 * - 投影只留 `id/name/version/description/enabled/requiresConsent/permissions`；
 *   **不下发** `directory`（宿主绝对路径）、`fingerprint`（授权材料）、`network`/`services`
 *   （目的地与本地服务名）以及 `contributes`（入口路径）。
 * - 授权状态只回布尔（enabled / requiresConsent），Web 不能改。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostPluginCatalog, HostPluginPermission } from "../../shared/types/hostPlugin";
import { getAppLogger } from "../logging/sharedLogger";
import { WEB_CORS_HEADERS } from "./WebHttpResponders";

export type WebHostPluginSummary = { id: string; name: string; version: string; description?: string; enabled: boolean; requiresConsent: boolean; permissions: HostPluginPermission[] };

export type WebHostPluginRoutesDeps = { catalog: () => HostPluginCatalog | null };

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(body));
}

/** 逐字段白名单投影：宁可少一个字段，也不把宿主路径/授权指纹带到浏览器。 */
export function toWebHostPluginSummaries(catalog: HostPluginCatalog): WebHostPluginSummary[] {
	return catalog.plugins.map((plugin) => ({
		id: plugin.manifest.id,
		name: plugin.manifest.name,
		version: plugin.manifest.version,
		...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
		enabled: plugin.enabled === true,
		requiresConsent: plugin.requiresConsent === true,
		permissions: [...plugin.manifest.permissions],
	}));
}

let installed: WebHostPluginRoutesDeps | null = null;

/** 装配入口：域模块自己持有依赖，装配层不新增模块级 `let`。 */
export function installWebHostPluginDeps(deps: WebHostPluginRoutesDeps): void {
	installed = deps;
}

export function getWebHostPluginDeps(): WebHostPluginRoutesDeps | null {
	return installed;
}

export class WebHostPluginRoutes {
	constructor(private readonly deps: WebHostPluginRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/host-plugins") return false;
		if (request.method !== "GET") {
			// 只读端点：任何写方法都是「不存在的能力」，明确 405 而不是落进 500。
			json(response, 405, { code: "webError.methodNotAllowed", message: "host plugins are read-only on web" });
			return true;
		}
		try {
			const catalog = this.deps.catalog();
			if (!catalog) {
				json(response, 503, { code: "webError.hostPluginsUnavailable", message: "host plugins are not available" });
				return true;
			}
			json(response, 200, { plugins: toWebHostPluginSummaries(catalog) });
		} catch (error) {
			void getAppLogger()?.warn("web-host-plugins", "catalog failed", { error: error instanceof Error ? error.message : String(error) });
			json(response, 503, { code: "webError.hostPluginsUnavailable", message: "host plugins are not available" });
		}
		return true;
	}
}
