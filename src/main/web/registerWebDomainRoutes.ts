import type { WebServiceManager } from "./WebServiceManager";
import type { Project } from "../../shared/types";
import type { webDomainProviders } from "./webStoreProviders";
import { WebAutomationRoutes } from "./WebAutomationRoutes";
import { WebAgentRoutes } from "./WebAgentRoutes";
import { WebFavoritesRoutes } from "./WebFavoritesRoutes";
import { WebNoticeRoutes } from "./WebNoticeRoutes";
import { WebImageGenRoutes, type WebImageGenRoutesDeps } from "./WebImageGenRoutes";

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
export function registerWebDomainRoutes(target: Pick<WebServiceManager, "automationRoutes" | "agentRoutes" | "favoriteRoutes" | "noticeRoutes" | "imageGenRoutes">, deps: WebDomainRouteDeps): void {
	target.automationRoutes = new WebAutomationRoutes({ store: deps.automation.store, runs: deps.automation.runs, projects: { get: (projectId) => deps.projects.get(projectId) } });
	target.agentRoutes = new WebAgentRoutes({ store: deps.agents.store, invoke: deps.agents.invoke, hasSession: deps.agents.hasSession });
	target.favoriteRoutes = new WebFavoritesRoutes({ store: deps.favorites.store, getSession: deps.favorites.getSession });
	target.noticeRoutes = new WebNoticeRoutes({ notices: deps.notices.notices, announcements: deps.notices.announcements });
	const imagegen = deps.imagegen();
	if (imagegen) target.imageGenRoutes = new WebImageGenRoutes(imagegen);
}
