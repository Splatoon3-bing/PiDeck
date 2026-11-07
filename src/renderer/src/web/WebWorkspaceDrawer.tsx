/**
 * WebWorkspaceDrawer — Web 端工作区抽屉（文件 / Git / 草稿本）。
 *
 * 结构对齐桌面「右侧抽屉 + 活动栏」：桌面是与会话并排的一栏，手机是覆盖式面板。
 * 面板实现各自拆分（WebFilesPanel / WebGitPanel / WebNotesPanel），本文件只负责
 * 外壳、面板切换与关闭语义，避免再长成第二个 600 行巨文件。
 */
import { useCallback, useEffect, useState } from "react";
import { Activity, CalendarClock, FolderOpen, GitBranch, Pencil, SquareTerminal, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useDismissOnBack } from "./useDismissOnBack";
import { useIsMobileViewport } from "./useIsMobileViewport";
import { WebFilesPanel } from "./WebFilesPanel";
import { WebGitPanel } from "./WebGitPanel";
import { WebNotesPanel } from "./WebNotesPanel";
import { WebTerminalPanel } from "./WebTerminalPanel";
import type { AgentBackend } from "../../../shared/types";
import type { WebRuntime } from "./webTypes";
import { WebStatusPanel } from "./WebStatusPanel";
import { WebAutomationPanel } from "./WebAutomationPanel";

export type WebWorkspacePanel = "files" | "git" | "notes" | "terminal" | "status" | "automation";

const PANEL_STORAGE_KEY = "pideck-web-workspace-panel";
const PANEL_ORDER: WebWorkspacePanel[] = ["files", "git", "notes", "terminal", "status", "automation"];

/** 读取上次使用的面板（组合根与抽屉共用；命令面板「打开 Git 面板」也走同一存储）。 */
export function readStoredWorkspacePanel(): WebWorkspacePanel {
	if (typeof window === "undefined") return "files";
	const stored = window.localStorage.getItem(PANEL_STORAGE_KEY);
	return stored === "files" || stored === "git" || stored === "notes" || stored === "terminal" || stored === "status" || stored === "automation" ? stored : "files";
}

/** 记住当前面板：刷新/重开后停在同一页。 */
export function storeWorkspacePanel(panel: WebWorkspacePanel): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(PANEL_STORAGE_KEY, panel);
	} catch {
		// 隐私模式/存储禁用：仅本次会话生效
	}
}

function panelLabel(panel: WebWorkspacePanel): string {
	if (panel === "git") return t("web.panelGit");
	if (panel === "notes") return t("web.panelNotes");
	if (panel === "terminal") return t("web.panelTerminal");
	if (panel === "status") return t("web.panelStatus");
	if (panel === "automation") return t("web.panelAutomation");
	return t("web.panelFiles");
}

function panelIcon(panel: WebWorkspacePanel) {
	if (panel === "git") return GitBranch;
	if (panel === "notes") return Pencil;
	if (panel === "terminal") return SquareTerminal;
	if (panel === "status") return Activity;
	if (panel === "automation") return CalendarClock;
	return FolderOpen;
}

export function WebWorkspaceDrawer(props: { projectId: string; open: boolean; onClose: () => void; onOpenFile: (path: string) => void; panel: WebWorkspacePanel; onSelectPanel: (panel: WebWorkspacePanel) => void; terminalEnabled: boolean; sessionId: string | null; runtime?: WebRuntime; backend?: AgentBackend }) {
	const mobile = useIsMobileViewport();
	// 终端入口只在桌面端打开开关后出现（C1：浏览器不能给自己开终端）。
	const panelOrder = props.terminalEnabled ? PANEL_ORDER : PANEL_ORDER.filter((entry) => entry !== "terminal");
	const panel: WebWorkspacePanel = props.panel === "terminal" && !props.terminalEnabled ? "files" : props.panel;
	useDismissOnBack(props.onClose, props.open && mobile);

	useEffect(() => {
		if (!props.open || mobile) return;
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		document.addEventListener("keydown", closeOnEscape);
		return () => document.removeEventListener("keydown", closeOnEscape);
	}, [mobile, props.open, props.onClose]);

	const selectPanel = (next: WebWorkspacePanel) => {
		props.onSelectPanel(next);
	};

	const header = (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2.5">
			<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">{t("web.workspaceDrawer")}</span>
			<span className="shrink-0 text-micro text-muted-foreground">{panelLabel(panel)}</span>
			<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" onClick={props.onClose} aria-label={t("common.close")} title={t("common.close")}>
				<X className="size-4" aria-hidden="true" />
			</Button>
		</div>
	);

	// 手机：顶部分段切换（触控目标 32px+），内容占满剩余高度；桌面：左侧活动栏 + 内容。
	const panelNav = mobile ? (
		<div className="grid shrink-0 grid-cols-3 gap-1 border-b border-border p-1.5" role="tablist" aria-label={t("web.workspaceDrawer")}>
			{panelOrder.map((entry) => {
				const Icon = panelIcon(entry);
				const active = entry === panel;
				return (
					<button key={entry} type="button" role="tab" aria-selected={active} className={cn("flex h-8 items-center justify-center gap-1 rounded-md text-caption transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")} onClick={() => selectPanel(entry)}>
						<Icon className="size-3.5" aria-hidden="true" />
						{panelLabel(entry)}
					</button>
				);
			})}
		</div>
	) : (
		<div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 py-2" role="tablist" aria-label={t("web.workspaceDrawer")}>
			{panelOrder.map((entry) => {
				const Icon = panelIcon(entry);
				const active = entry === panel;
				return (
					<button
						key={entry}
						type="button"
						role="tab"
						aria-selected={active}
						aria-label={panelLabel(entry)}
						title={panelLabel(entry)}
						className={cn("relative flex size-8 items-center justify-center rounded-md transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
						onClick={() => selectPanel(entry)}
					>
						<Icon className="size-4" aria-hidden="true" />
						{active ? <span className="absolute left-0 h-4 w-[2px] rounded-full bg-primary" aria-hidden="true" /> : null}
					</button>
				);
			})}
		</div>
	);

	const body =
		panel === "terminal" || panel === "status" || panel === "automation" ? null : panel === "git" ? (
			/* scroll-ok: nested —— Git 面板内部是变更列表 + diff 滚动，本层只做面板级滚动窗。 */
			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
				<WebGitPanel projectId={props.projectId} active={props.open} />
			</div>
		) : panel === "notes" ? (
			<div className="flex min-h-0 flex-1 flex-col px-2.5 py-2">
				<WebNotesPanel projectId={props.projectId} active={props.open} />
			</div>
		) : (
			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
				<WebFilesPanel projectId={props.projectId} active={props.open} onOpenFile={props.onOpenFile} />
			</div>
		);

	const content = (
		<>
			{header}
			{panelNav}
			{body}
			{props.terminalEnabled ? (
				<div className={cn("min-h-0 flex-1 px-2.5 py-2", panel !== "terminal" && "hidden")}>
					<WebTerminalPanel projectId={props.projectId} active={panel === "terminal" && props.open} />
				</div>
			) : null}
			<div className={cn("min-h-0 flex-1 overflow-y-auto px-2.5 py-2", panel !== "status" && "hidden")}>
				<WebStatusPanel sessionId={props.sessionId} runtime={props.runtime} backend={props.backend} active={panel === "status" && props.open} />
			</div>
			<div className={cn("min-h-0 flex-1 overflow-y-auto px-2.5 py-2", panel !== "automation" && "hidden")}>
				<WebAutomationPanel projectId={props.projectId} active={panel === "automation" && props.open} />
			</div>
		</>
	);

	if (!mobile) {
		return (
			<aside className="flex h-full w-[clamp(20rem,32vw,30rem)] shrink-0 flex-col overflow-hidden border-l border-border bg-background" aria-label={t("web.workspaceDrawer")} data-testid="web-workspace-drawer">
				{content}
			</aside>
		);
	}
	return (
		<div className="fixed inset-0 z-50 bg-background" data-testid="web-workspace-drawer">
			<aside className="flex h-full flex-col overflow-hidden bg-background" aria-label={t("web.workspaceDrawer")}>
				{content}
			</aside>
		</div>
	);
}

/**
 * 抽屉面板状态（组合根持有）：命令面板「打开 Git 面板」与活动栏点击写同一处，
 * 面板选择再持久化到 localStorage，刷新/重开停在同一页。
 */
export function useWorkspacePanel(): [WebWorkspacePanel, (panel: WebWorkspacePanel) => void] {
	const [panel, setPanel] = useState<WebWorkspacePanel>(() => readStoredWorkspacePanel());
	const select = useCallback((next: WebWorkspacePanel) => {
		setPanel(next);
		storeWorkspacePanel(next);
	}, []);
	return [panel, select];
}
