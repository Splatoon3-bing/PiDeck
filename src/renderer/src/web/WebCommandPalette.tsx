/**
 * WebCommandPalette — Web 端命令面板（Ctrl/Cmd+Shift+P）。
 *
 * 键盘优先：打开即聚焦输入框，↑/↓ 移动、Enter 执行、Esc 关闭；鼠标只是可选路径。
 * 纯展示组件：命令清单与动作由组合根（WebChatApp）提供，过滤/排序/索引逻辑在
 * webCommands.ts 里单测覆盖，本文件只管 DOM 与焦点。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { filterWebCommands, flattenGroupedCommands, groupWebCommands, moveCommandIndex, type WebCommand, type WebCommandGroup } from "./webCommands";

function groupLabel(group: WebCommandGroup): string {
	if (group === "session") return t("web.commandsGroupSession");
	if (group === "workspace") return t("web.commandsGroupWorkspace");
	return t("web.commandsGroupApp");
}

export function WebCommandPalette(props: { open: boolean; onOpenChange: (open: boolean) => void; commands: WebCommand[] }) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const filtered = useMemo(() => filterWebCommands(props.commands, query), [props.commands, query]);
	const groups = useMemo(() => groupWebCommands(filtered), [filtered]);
	const flat = useMemo(() => flattenGroupedCommands(groups), [groups]);

	useEffect(() => {
		if (!props.open) return;
		setQuery("");
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [props.open]);

	// 全局快捷键（Ctrl/Cmd+Shift+P）：挂在面板自己身上，组合根不再单独持有键盘逻辑。
	// 与 Ctrl/Cmd+K（会话搜索）区分；面板开着时再按一次 = 关闭。
	const { onOpenChange, open } = props;
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
				event.preventDefault();
				onOpenChange(!open);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onOpenChange, open]);

	// 查询变化后选中项回到第一条；否则会停在已被过滤掉的下标上。
	useEffect(() => {
		setActiveIndex(0);
	}, [query]);

	// 键盘上下移动时把选中项滚进视口（命令多时键盘操作不能「看不见选中项」）。
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const active = list.querySelector<HTMLElement>('[data-active="true"]');
		active?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, flat.length]);

	const runCommand = (command: WebCommand | undefined) => {
		if (!command) return;
		props.onOpenChange(false);
		// 关闭后再执行：命令可能打开另一个 Dialog（设置/搜索），同帧挂两个模态会抢焦点。
		requestAnimationFrame(() => command.run());
	};

	let flatCursor = 0;
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="flex max-h-[80dvh] flex-col gap-2 p-0 sm:max-w-lg" data-testid="web-command-palette">
				<DialogHeader className="sr-only">
					<DialogTitle>{t("web.commandsTitle")}</DialogTitle>
					<DialogDescription>{t("web.commandsDescription")}</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
					<Search className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />
					<Input
						ref={inputRef}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("web.commandsPlaceholder")}
						aria-label={t("web.commandsPlaceholder")}
						aria-controls="web-command-list"
						aria-activedescendant={flat[activeIndex] ? `web-command-${flat[activeIndex].id}` : undefined}
						className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-1"
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setActiveIndex(moveCommandIndex(activeIndex, 1, flat.length));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setActiveIndex(moveCommandIndex(activeIndex, -1, flat.length));
							} else if (event.key === "Home") {
								event.preventDefault();
								setActiveIndex(flat.length > 0 ? 0 : -1);
							} else if (event.key === "End") {
								event.preventDefault();
								setActiveIndex(flat.length - 1);
							} else if (event.key === "Enter") {
								event.preventDefault();
								runCommand(flat[activeIndex]);
							}
						}}
					/>
					<kbd className="hidden shrink-0 rounded border border-border/60 px-1 text-micro text-text-tertiary sm:inline">Esc</kbd>
				</div>
				{/* scroll-ok: transient —— 命令面板是一次性弹层，条目数由命令表决定。 */}
				<div ref={listRef} id="web-command-list" role="listbox" aria-label={t("web.commandsTitle")} className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
					{flat.length === 0 ? <p className="py-6 text-center text-caption text-text-tertiary">{t("web.commandsEmpty")}</p> : null}
					{groups.map((group) => (
						<div key={group.group} className="py-0.5">
							<div className="px-2 py-1 text-micro font-medium tracking-wide text-text-tertiary uppercase">{groupLabel(group.group)}</div>
							{group.commands.map((command) => {
								const index = flatCursor++;
								const active = index === activeIndex;
								return (
									<button
										key={command.id}
										id={`web-command-${command.id}`}
										type="button"
										role="option"
										aria-selected={active}
										data-active={active ? "true" : undefined}
										data-command-id={command.id}
										// 鼠标移动不抢焦点（否则输入框失焦，继续打字会丢字符）
										onMouseMove={() => setActiveIndex(index)}
										onClick={() => runCommand(command)}
										className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-control pointer-coarse:h-10", active ? "bg-muted text-foreground" : "text-text-secondary hover:bg-muted/60")}
									>
										<span className="min-w-0 flex-1 truncate">{command.title}</span>
										{command.shortcut ? <kbd className="shrink-0 rounded border border-border/60 px-1 text-micro text-text-tertiary">{command.shortcut}</kbd> : null}
										{active ? <CornerDownLeft className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" /> : null}
									</button>
								);
							})}
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
