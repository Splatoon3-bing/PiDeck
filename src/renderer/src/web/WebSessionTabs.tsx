/**
 * WebSessionTabs — Web 端会话多标签栏（对齐桌面 SessionTabsBar 的最小语义）。
 *
 * 只负责渲染与事件转发；标签集合/关闭后激活谁由 `webSessionTabs.ts` 纯函数决定。
 * 视觉沿用 Web 现有 token：行高 34px、13px 控件字号、1px 墨线、选中用底色差 + 底边线，
 * 不加投影（DESIGN.md「The Flat Timeline Rule」）。
 */
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { isActiveSessionStatus, sessionStatusDotClass } from "@/agentListDisplay";
import { WebBackendMark } from "./WebBackendMark";
import { webTabTitle } from "./webSessionTabs";
import type { WebAcpTool, WebRuntime, WebSession } from "./webTypes";

export function WebSessionTabs(props: { sessions: WebSession[]; tabIds: string[]; activeSessionId: string; runtimeFor: (sessionId: string) => WebRuntime | undefined; acpTools?: WebAcpTool[]; onSelect: (sessionId: string) => void; onClose: (sessionId: string) => void }) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const tabRefs = useRef(new Map<string, HTMLElement | null>());
	const sessionsById = new Map(props.sessions.map((session) => [session.id, session]));

	// 切标签后把当前项滚进可视区（横向），避免新建/恢复后当前标签被挤出屏幕。
	useEffect(() => {
		const element = tabRefs.current.get(props.activeSessionId);
		element?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [props.activeSessionId, props.tabIds.length]);

	return (
		<div className="web-session-tabs relative shrink-0 border-b border-border/60 bg-background" data-testid="web-session-tabs">
			{/* scroll-ok: bounded —— 标签数有硬上限（MAX_WEB_TABS=20），横向滚动不随数据无限增长。 */}
			<div ref={scrollRef} className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto px-1.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label={t("web.tabs")}>
				{props.tabIds.map((sessionId) => {
					const session = sessionsById.get(sessionId);
					const active = sessionId === props.activeSessionId;
					const runtime = props.runtimeFor(sessionId);
					const dotClass = sessionStatusDotClass(runtime?.status);
					const running = isActiveSessionStatus(runtime?.status);
					return (
						<div
							key={sessionId}
							ref={(element) => {
								if (element) tabRefs.current.set(sessionId, element);
								else tabRefs.current.delete(sessionId);
							}}
							role="tab"
							tabIndex={active ? 0 : -1}
							aria-selected={active}
							title={session?.title || t("common.untitled")}
							data-session-id={sessionId}
							className={cn(
								"group/tab relative flex h-8 min-w-0 max-w-[15rem] shrink-0 items-center gap-1.5 rounded-md border border-transparent pr-0.5 pl-2 text-control text-muted-foreground transition-[background-color,border-color,color] duration-150",
								"hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								active && "border-border bg-muted/80 text-foreground",
							)}
							onClick={() => props.onSelect(sessionId)}
							onAuxClick={(event) => {
								// 中键关闭：浏览器标签的肌肉记忆，不打断当前激活项。
								if (event.button === 1) {
									event.preventDefault();
									props.onClose(sessionId);
								}
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									props.onSelect(sessionId);
								}
							}}
						>
							{dotClass ? <span className={cn("size-1.5 shrink-0 rounded-full", dotClass, running && "animate-pulse")} aria-hidden="true" /> : null}
							<WebBackendMark backend={session?.backend} acpToolId={session?.acpToolId} acpTools={props.acpTools} className="size-3.5 shrink-0" />
							<span className="min-w-0 flex-1 truncate">{webTabTitle(session?.title, t("common.untitled"))}</span>
							<button
								type="button"
								className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/tab:opacity-100 [@media(hover:none)]:opacity-100"
								aria-label={t("web.closeTab")}
								title={t("web.closeTab")}
								onClick={(event) => {
									event.stopPropagation();
									props.onClose(sessionId);
								}}
							>
								<X className="size-3.5" aria-hidden="true" />
							</button>
							{active ? <span className="pointer-events-none absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-primary" aria-hidden="true" /> : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
