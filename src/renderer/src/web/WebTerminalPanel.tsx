/**
 * WebTerminalPanel — 工作区抽屉里的「终端」面板（S4）
 *
 * 只负责 DOM/xterm 生命周期；协议与 tab 状态在 `useWebTerminal`。
 * - xterm 动态加载（C20：不进首屏 bundle），addon 只启用 fit；
 * - 每个 tab 一个 xterm 实例，切换时隐藏而非销毁（保留 scrollback）；
 * - 输出按 tabId 写入对应实例（服务端只把数据发给创建它的连接）；
 * - 断线不自动重连：显示「已断开 + 重新连接」。
 */
import { useEffect, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { Loader2, Plus, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useWebTerminal } from "./useWebTerminal";
import "@xterm/xterm/css/xterm.css";

type TerminalBox = { terminal: Terminal; fit: FitAddon; element: HTMLDivElement };
type XtermModules = { Terminal: typeof Terminal; FitAddon: typeof FitAddon };

/** 主题跟随页面 CSS 变量（明暗两套由 foundation/web.css 提供）。 */
function readTheme() {
	const styles = getComputedStyle(document.documentElement);
	return {
		background: styles.getPropertyValue("--color-bg-panel").trim() || "#ffffff",
		foreground: styles.getPropertyValue("--color-text-primary").trim() || "#0f1115",
		cursor: styles.getPropertyValue("--color-accent").trim() || "#3964fe",
	};
}

export function WebTerminalPanel(props: { projectId: string; active: boolean }) {
	const controller = useWebTerminal({ projectId: props.projectId, enabled: true });
	const { status, tabs, activeTabId, error, connect, disconnect, createTab, closeTab, selectTab, sendInput, sendResize, subscribeOutput } = controller;

	const hostRef = useRef<HTMLDivElement>(null);
	const boxesRef = useRef(new Map<string, TerminalBox>());
	const modulesRef = useRef<XtermModules | null>(null);
	const [ready, setReady] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	// 首次切到终端面板才连接：打开工作区就 spawn 一个 PTY 是浪费，也容易让人以为「自己开了终端」。
	const [activated, setActivated] = useState(props.active);

	// xterm 动态加载：失败（离线缓存缺 chunk）时给可读提示，不白屏。
	useEffect(() => {
		let disposed = false;
		void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
			.then(([xterm, fit]) => {
				if (disposed) return;
				modulesRef.current = { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
				setReady(true);
			})
			.catch(() => {
				if (!disposed) setLoadFailed(true);
			});
		return () => {
			disposed = true;
		};
	}, []);

	// 输出订阅：tabId → 对应 xterm。
	useEffect(() => subscribeOutput((tabId, data) => boxesRef.current.get(tabId)?.terminal.write(data)), [subscribeOutput]);

	// 跟随 tabs 创建/销毁 xterm 实例。
	useEffect(() => {
		const host = hostRef.current;
		const modules = modulesRef.current;
		if (!ready || !host || !modules) return;
		const seen = new Set(tabs.map((tab) => tab.id));
		for (const tab of tabs) {
			if (boxesRef.current.has(tab.id)) continue;
			const element = document.createElement("div");
			element.className = "h-full w-full";
			element.style.display = "none";
			element.dataset.testid = `web-terminal-${tab.id}`;
			host.appendChild(element);
			const terminal = new modules.Terminal({
				convertEol: true,
				fontSize: 12,
				fontFamily: '"SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace',
				cursorBlink: true,
				scrollback: 2000,
				theme: readTheme(),
			});
			const fit = new modules.FitAddon();
			terminal.loadAddon(fit);
			terminal.open(element);
			terminal.onData((data) => sendInput(tab.id, data));
			boxesRef.current.set(tab.id, { terminal, fit, element });
			requestAnimationFrame(() => {
				fit.fit();
				sendResize(tab.id, terminal.cols, terminal.rows);
			});
		}
		for (const [tabId, box] of boxesRef.current) {
			if (seen.has(tabId)) continue;
			box.terminal.dispose();
			box.element.remove();
			boxesRef.current.delete(tabId);
		}
	}, [ready, tabs, sendInput, sendResize]);

	// 激活 tab 显示 + 重新 fit（隐藏容器里的 fit 结果不可靠，切回必须重算）。
	useEffect(() => {
		for (const [tabId, box] of boxesRef.current) box.element.style.display = tabId === activeTabId ? "block" : "none";
		if (!props.active || !activeTabId) return;
		const box = boxesRef.current.get(activeTabId);
		if (!box) return;
		requestAnimationFrame(() => {
			box.fit.fit();
			sendResize(activeTabId, box.terminal.cols, box.terminal.rows);
		});
	}, [activeTabId, props.active, ready, sendResize, status]);

	// 容器尺寸变化（移动端软键盘/旋转/分栏）→ refit + 通知服务端。
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !props.active) return;
		const observer = new ResizeObserver(() => {
			if (!activeTabId) return;
			const box = boxesRef.current.get(activeTabId);
			if (!box) return;
			box.fit.fit();
			sendResize(activeTabId, box.terminal.cols, box.terminal.rows);
		});
		observer.observe(host);
		return () => observer.disconnect();
	}, [activeTabId, props.active, sendResize]);

	useEffect(() => {
		if (props.active) setActivated(true);
	}, [props.active]);

	// 首次激活后保持连接（切到文件/Git 面板不杀 PTY）；切项目或卸载时断开，服务端负责清理。
	useEffect(() => {
		if (!activated) return;
		connect();
		return () => disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activated, props.projectId]);

	const blocked = status === "closed" || status === "error";
	const connected = status === "open";

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="web-terminal-panel">
			<div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 pb-1">
				<div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
					{tabs.map((tab) => (
						<div key={tab.id} className={cn("flex h-7 max-w-48 shrink-0 items-center gap-1 rounded px-1.5 text-caption", tab.id === activeTabId ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
							<button type="button" className="min-w-0 truncate" title={tab.title} onClick={() => selectTab(tab.id)}>
								{tab.title}
								{tab.exited ? ` · ${t("web.terminalExited")}` : ""}
							</button>
							<button type="button" className="shrink-0" aria-label={t("web.terminalCloseTab")} title={t("web.terminalCloseTab")} onClick={() => closeTab(tab.id)}>
								<X className="size-3" aria-hidden="true" />
							</button>
						</div>
					))}
				</div>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={t("web.terminalNew")} title={t("web.terminalNew")} disabled={!connected} onClick={createTab}>
					<Plus className="size-3.5" aria-hidden="true" />
				</Button>
			</div>

			{error ? (
				<div className="mb-1 shrink-0 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-micro text-danger" role="alert">
					{error}
				</div>
			) : null}

			{status === "connecting" ? (
				<div className="flex flex-1 items-center justify-center gap-2 text-caption text-muted-foreground">
					<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
					{t("web.terminalConnecting")}
				</div>
			) : null}

			{blocked ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 text-caption text-muted-foreground">
					<span>{t("web.terminalDisconnected")}</span>
					<Button type="button" variant="outline" size="sm" onClick={connect}>
						<RotateCw className="mr-1 size-3.5" aria-hidden="true" />
						{t("web.terminalReconnect")}
					</Button>
				</div>
			) : null}

			{loadFailed ? <div className="flex flex-1 items-center justify-center text-caption text-danger">{t("web.terminalLoadFailed")}</div> : null}

			{/* xterm 容器：每个 tab 一个子 div，非激活项 display:none（保留 scrollback）。 */}
			<div ref={hostRef} className={cn("min-h-0 flex-1 overflow-hidden rounded-md bg-[var(--color-bg-panel)] p-1", (!connected || loadFailed || !activated) && "hidden")} data-testid="web-terminal-host" />
		</div>
	);
}
