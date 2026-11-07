/**
 * Web 命令面板的清单装配（组合根传能力，本文件只拼命令）。
 *
 * 把「命令有哪些」从 WebChatApp 里拆出来：加一条命令不再动组合根，
 * 也让命令清单（分组/顺序/快捷键提示）成为可读的一处清单。
 * 过滤/排序/键盘索引仍在 webCommands.ts，两边都由单测覆盖。
 */
import { t } from "@/i18n";
import type { WebCommand } from "./webCommands";
import type { WebWorkspacePanel } from "./WebWorkspaceDrawer";

/** 最近会话最多列几条（再多就靠侧栏/搜索，面板不是会话列表）。 */
const MAX_RECENT_SESSION_COMMANDS = 8;

export type WebCommandContext = {
	activeSessionId: string;
	/** 新建会话默认落在哪个项目（当前会话所属项目，否则第一个项目）。 */
	activeProjectId?: string;
	hasActiveSession: boolean;
	sessions: ReadonlyArray<{ id: string; title: string; projectId: string; updatedAt?: number }>;
	canInstall: boolean;
	onNewSession: (projectId: string) => void;
	onCloseTab: (sessionId: string) => void;
	onSelectSession: (sessionId: string) => void;
	onOpenPanel: (panel: WebWorkspacePanel) => void;
	onCloseWorkspace: () => void;
	onOpenSettings: () => void;
	onToggleTheme: () => void;
	onOpenSearch: () => void;
	onRefreshModels: () => void;
	onInstall: () => void;
};

export function buildWebCommands(ctx: WebCommandContext): WebCommand[] {
	const list: WebCommand[] = [];
	if (ctx.activeProjectId) {
		const projectId = ctx.activeProjectId;
		list.push({ id: "session.new", group: "session", title: t("web.commandSessionNew"), keywords: "new session 新建 会话", run: () => ctx.onNewSession(projectId) });
	}
	if (ctx.activeSessionId) {
		const sessionId = ctx.activeSessionId;
		list.push({ id: "session.close-tab", group: "session", title: t("web.commandTabClose"), keywords: "close tab 关闭 标签", run: () => ctx.onCloseTab(sessionId) });
	}
	const recent = [...ctx.sessions]
		.filter((session) => session.id !== ctx.activeSessionId)
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
		.slice(0, MAX_RECENT_SESSION_COMMANDS);
	for (const session of recent) {
		list.push({
			id: `session.switch:${session.id}`,
			group: "session",
			title: session.title.trim() || session.id,
			keywords: `switch session 切换 会话 ${session.projectId}`,
			run: () => ctx.onSelectSession(session.id),
		});
	}
	if (ctx.hasActiveSession) {
		list.push({ id: "workspace.files", group: "workspace", title: t("web.commandWorkspaceFiles"), keywords: "files 文件", run: () => ctx.onOpenPanel("files") });
		list.push({ id: "workspace.git", group: "workspace", title: t("web.commandWorkspaceGit"), keywords: "git 分支 提交", run: () => ctx.onOpenPanel("git") });
		list.push({ id: "workspace.notes", group: "workspace", title: t("web.commandWorkspaceNotes"), keywords: "notes scratchpad 草稿本", run: () => ctx.onOpenPanel("notes") });
		list.push({ id: "workspace.close", group: "workspace", title: t("web.commandWorkspaceClose"), keywords: "close 关闭 工作区", run: () => ctx.onCloseWorkspace() });
	}
	list.push({ id: "app.settings", group: "app", title: t("web.settings"), keywords: "settings 设置 外观 字号", run: () => ctx.onOpenSettings() });
	list.push({ id: "app.theme", group: "app", title: t("web.commandThemeToggle"), keywords: "theme 主题 明暗 dark light", run: () => ctx.onToggleTheme() });
	list.push({ id: "app.search", group: "app", title: t("web.searchTitle"), keywords: "search 搜索", shortcut: "Ctrl+K", run: () => ctx.onOpenSearch() });
	list.push({ id: "app.refresh-models", group: "app", title: t("web.commandRefreshModels"), keywords: "refresh models 刷新 模型", run: () => ctx.onRefreshModels() });
	if (ctx.canInstall) list.push({ id: "app.install", group: "app", title: t("web.installApp"), keywords: "pwa install 安装 桌面", run: () => ctx.onInstall() });
	return list;
}

/**
 * 组合根用的薄 hook：只是把 buildWebCommands 声明成「随渲染重建」。
 *
 * 不 useMemo：命令里捕获的是当次渲染的闭包（会话列表/回调），memo 依赖只要漏一项
 * 就会拿到过期的会话标题或失效的项目 id；而面板关闭时 Dialog 内容不挂载，重建成本可忽略。
 */
export function useWebCommands(ctx: WebCommandContext): WebCommand[] {
	return buildWebCommands(ctx);
}
