import type { WebServiceManager } from "./WebServiceManager";
import type { Project } from "../../shared/types";
import type { webDomainProviders } from "./webStoreProviders";
import { WebAutomationRoutes } from "./WebAutomationRoutes";
import { WebAgentRoutes } from "./WebAgentRoutes";
import { WebFavoritesRoutes } from "./WebFavoritesRoutes";
import { WebNoticeRoutes } from "./WebNoticeRoutes";
import { WebImageGenRoutes, type WebImageGenRoutesDeps } from "./WebImageGenRoutes";
import { WebHostPluginRoutes, getWebHostPluginDeps } from "./WebHostPluginRoutes";

/** 域 Store 一律经 provider 求值（启动后段才赋值），这里只声明 Web 路由需要的形状。 */
export type WebDomainRouteDeps = {
	projects: { get: (projectId: string) => Project | undefined };
	automation: ReturnType<typeof webDomainProviders>["automation"];
	agents: ReturnType<typeof webDomainProviders>["agents"];
	favorites: ReturnType<typeof webDomainProviders>["favorites"];
	notices: ReturnType<typeof webDomainProviders>["notices"];
	imagegen: () => WebImageGenRoutesDeps | null;
};

/** 延迟装配的 Store 域统一在此注册，main/index.ts 只提供能力，不承担路由细节。 */
export function registerWebDomainRoutes(target: Pick<WebServiceManager, "automationRoutes" | "agentRoutes" | "favoriteRoutes" | "noticeRoutes" | "imageGenRoutes" | "hostPluginRoutes">, deps: WebDomainRouteDeps): void {
	target.automationRoutes = new WebAutomationRoutes({ store: deps.automation.store, runs: deps.automation.runs, projects: { get: (projectId) => deps.projects.get(projectId) } });
	target.agentRoutes = new WebAgentRoutes({ store: deps.agents.store, invoke: deps.agents.invoke, hasSession: deps.agents.hasSession });
	target.favoriteRoutes = new WebFavoritesRoutes({ store: deps.favorites.store, getSession: deps.favorites.getSession });
	target.noticeRoutes = new WebNoticeRoutes({ notices: deps.notices.notices, announcements: deps.notices.announcements });
	// 生图依赖由 installWebImageGenDeps() 在 registerIpc() 里装配，而本函数在启动序列里
	// 更早执行（index.ts：registerWebRoutes ≈ 6821 行，registerIpc() ≈ 7552 行）——
	// 直接取会在启动期拿到 null，imageGenRoutes 永远不注册，/api/imagegen/* 恒 404。
	// 与 hostPluginRoutes 同一个坑：无条件注册懒解析代理，deps 在首次请求时再取。
	let imagegenRoutes: WebImageGenRoutes | null = null;
	target.imageGenRoutes = {
		async handle(url, request, response) {
			if (!imagegenRoutes) {
				const imagegen = deps.imagegen();
				if (!imagegen) return false;
				imagegenRoutes = new WebImageGenRoutes(imagegen);
			}
			return imagegenRoutes.handle(url, request, response);
		},
	};
	// 宿主插件服务在 registerIpc() 后段才装配，而本函数在更早的 Web 服务启动路径里执行：
	// 路由必须**无条件注册**、catalog 在请求时再取，否则 /api/host-plugins 会因启动顺序永久 404。
	// 未装配时 catalog() 返回 null → 503（fail-closed），不会回退到 404 或本机其它能力。
	target.hostPluginRoutes = new WebHostPluginRoutes({ catalog: () => getWebHostPluginDeps()?.catalog() ?? null });
}
