import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { AgentProfileStore } from "../agents/AgentProfileStore";
import type { FavoritesStore } from "../favorites/FavoritesStore";
import type { AutomationStore } from "../automation/AutomationStore";
import type { AutomationRunCoordinator } from "../automation/AutomationRunCoordinator";
import type { AgentInvokeService } from "../agents/AgentInvokeService";
import type { NoticeHistoryStore } from "../notices/NoticeHistoryStore";
import type { AnnouncementService } from "../announcements/AnnouncementService";

/**
 * Web 域 Store 的求值时机集中在这里。
 *
 * 这些 store 与 catalog 都是启动后段才赋值的模块级 `let`，而 Web 路由在更早的装配段注册；
 * 因此一律传 getter（provider），按请求求值——按值传会在运行期拿到 undefined
 * （已踩两次：`projectStore.get` 丢 this、`catalog.get` 报 reading 'get'）。
 */
export type WebDomainStoreGetters = {
	catalog: () => SessionCatalog;
	agents: () => AgentProfileStore | null;
	invoke: () => AgentInvokeService | null;
	favorites: () => FavoritesStore | null;
	automation: () => AutomationStore | null;
	runs: () => AutomationRunCoordinator | null;
	notices: () => NoticeHistoryStore | null;
	announcements: () => AnnouncementService | null;
};

export function webDomainProviders(get: WebDomainStoreGetters) {
	return {
		automation: { store: get.automation, runs: get.runs },
		notices: { notices: get.notices, announcements: get.announcements },
		agents: {
			store: get.agents,
			invoke: get.invoke,
			hasSession: (sessionId: string) => get.catalog().get(sessionId) !== undefined,
		},
		favorites: {
			store: get.favorites,
			// 会话收藏只存引用：标题/项目由主进程按 catalog 读，浏览器只能传 sessionId。
			getSession: (sessionId: string) => {
				const entry = get.catalog().get(sessionId);
				return entry ? { id: entry.id, title: entry.title, projectId: entry.projectId } : undefined;
			},
		},
	};
}
