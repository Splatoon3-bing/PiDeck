/**
 * Web 终端控制器（useWebTerminal）
 *
 * 职责：**只做 WebSocket 协议**——连接/断开、帧收发、tab 列表、断线状态。
 * 不碰 DOM/xterm（那是 WebTerminalPanel 的事），便于单测与复用。
 *
 * 协议（S2 后端）：
 *   客户端 → {type:"create", target:{kind:"project",projectId}} | {type:"input",tabId,data}
 *            | {type:"resize",tabId,cols,rows} | {type:"close",tabId} | {type:"ping"}
 *   服务端 → {type:"created",tab} | {type:"data",tabId,data} | {type:"exit",tabId,exitCode}
 *            | {type:"closed",tabId} | {type:"error",code,message} | {type:"pong"}
 *
 * 断线策略（T6 评审）：**不自动重连**——重连等于新 PTY，半路命令会丢；由用户点「重新连接」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import { getWebToken } from "./webApi";

export type WebTerminalTab = { id: string; title: string; shell: string; createdAt: number; exited?: boolean; exitCode?: number | null };
export type WebTerminalStatus = "idle" | "connecting" | "open" | "closed" | "error";

export type WebTerminalController = {
	status: WebTerminalStatus;
	tabs: WebTerminalTab[];
	activeTabId: string | null;
	error: string | null;
	connect: () => void;
	disconnect: () => void;
	createTab: () => void;
	closeTab: (tabId: string) => void;
	selectTab: (tabId: string) => void;
	sendInput: (tabId: string, data: string) => void;
	sendResize: (tabId: string, cols: number, rows: number) => void;
	/** 订阅输出（返回退订）。xterm 挂载后注册，卸载时退订。 */
	subscribeOutput: (handler: (tabId: string, data: string) => void) => () => void;
};

function terminalSocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss" : "ws";
	const token = getWebToken();
	const query = token ? `?token=${encodeURIComponent(token)}` : "";
	return `${protocol}://${window.location.host}/api/terminal${query}`;
}

/** 服务端错误码 → 可读文案（未知码退回通用失败）。 */
function terminalErrorMessage(code: string): string {
	if (code === "webError.terminalDisabled") return t("web.terminalDisabled");
	if (code === "webError.unauthorized") return t("web.terminalUnauthorized");
	if (code === "webError.originRejected") return t("web.terminalOriginRejected");
	if (code === "webError.terminalLimit") return t("web.terminalLimit");
	if (code === "webError.terminalProjectUnsupported") return t("web.terminalProjectUnsupported");
	if (code === "webError.projectNotFound") return t("web.terminalProjectNotFound");
	if (code === "webError.terminalCreateFailed") return t("web.terminalCreateFailed");
	return t("web.terminalFailed");
}

export function useWebTerminal(input: { projectId: string; enabled: boolean }): WebTerminalController {
	const [status, setStatus] = useState<WebTerminalStatus>("idle");
	const [tabs, setTabs] = useState<WebTerminalTab[]>([]);
	const [activeTabId, setActiveTabId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const socketRef = useRef<WebSocket | null>(null);
	const outputHandlersRef = useRef(new Set<(tabId: string, data: string) => void>());
	const activeTabIdRef = useRef<string | null>(null);
	activeTabIdRef.current = activeTabId;

	const send = useCallback((payload: Record<string, unknown>) => {
		const socket = socketRef.current;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify(payload));
	}, []);

	const disconnect = useCallback(() => {
		const socket = socketRef.current;
		socketRef.current = null;
		if (socket) {
			try {
				socket.close(1000, "client closed");
			} catch {
				/* 已关闭 */
			}
		}
		setStatus("idle");
		setTabs([]);
		setActiveTabId(null);
	}, []);

	const connect = useCallback(() => {
		if (!input.enabled) return;
		if (socketRef.current) return;
		setError(null);
		setStatus("connecting");
		const socket = new WebSocket(terminalSocketUrl());
		socketRef.current = socket;

		socket.onopen = () => {
			setStatus("open");
			// 连上就开第一个终端：用户点开面板应直接可用，不需要再点一次「新建」。
			socket.send(JSON.stringify({ type: "create", target: { kind: "project", projectId: input.projectId } }));
		};
		socket.onmessage = (event) => {
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(event.data)) as Record<string, unknown>;
			} catch {
				return;
			}
			const type = message.type;
			if (type === "created") {
				const tab = message.tab as { id?: unknown; title?: unknown; shell?: unknown; createdAt?: unknown; buffer?: unknown } | undefined;
				if (!tab || typeof tab.id !== "string") return;
				const next: WebTerminalTab = {
					id: tab.id,
					title: typeof tab.title === "string" ? tab.title : tab.id,
					shell: typeof tab.shell === "string" ? tab.shell : "shell",
					createdAt: typeof tab.createdAt === "number" ? tab.createdAt : Date.now(),
				};
				setTabs((current) => [...current, next]);
				setActiveTabId((current) => current ?? next.id);
				// 服务端回放缓冲：切回/重连时重建 scrollback。
				if (typeof tab.buffer === "string" && tab.buffer.length > 0) {
					for (const handler of outputHandlersRef.current) handler(next.id, tab.buffer);
				}
				return;
			}
			if (type === "data") {
				const tabId = message.tabId;
				const data = message.data;
				if (typeof tabId !== "string" || typeof data !== "string") return;
				for (const handler of outputHandlersRef.current) handler(tabId, data);
				return;
			}
			if (type === "exit") {
				const tabId = message.tabId;
				if (typeof tabId !== "string") return;
				const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
				setTabs((current) => current.map((tab) => (tab.id === tabId ? { ...tab, exited: true, exitCode } : tab)));
				return;
			}
			if (type === "closed") {
				const tabId = message.tabId;
				if (typeof tabId !== "string") return;
				setTabs((current) => current.filter((tab) => tab.id !== tabId));
				setActiveTabId((current) => (current === tabId ? null : current));
				return;
			}
			if (type === "error") {
				const code = typeof message.code === "string" ? message.code : "webError.internal";
				setError(terminalErrorMessage(code));
				return;
			}
		};
		socket.onerror = () => {
			setError(t("web.terminalFailed"));
		};
		socket.onclose = () => {
			socketRef.current = null;
			// 主动 disconnect 已把状态置 idle；这里只处理「非主动关闭」。
			setStatus((current) => (current === "idle" ? current : "closed"));
			setTabs([]);
			setActiveTabId(null);
		};
	}, [input.enabled, input.projectId]);

	const createTab = useCallback(() => {
		send({ type: "create", target: { kind: "project", projectId: input.projectId } });
	}, [input.projectId, send]);

	const closeTab = useCallback(
		(tabId: string) => {
			send({ type: "close", tabId });
		},
		[send],
	);

	const selectTab = useCallback((tabId: string) => {
		setActiveTabId(tabId);
	}, []);

	const sendInput = useCallback(
		(tabId: string, data: string) => {
			// 单帧上限与服务端一致（4KB）：超长粘贴分片，避免整帧被拒。
			const CHUNK = 4096;
			for (let offset = 0; offset < data.length; offset += CHUNK) {
				send({ type: "input", tabId, data: data.slice(offset, offset + CHUNK) });
			}
		},
		[send],
	);

	const sendResize = useCallback(
		(tabId: string, cols: number, rows: number) => {
			send({ type: "resize", tabId, cols, rows });
		},
		[send],
	);

	const subscribeOutput = useCallback((handler: (tabId: string, data: string) => void) => {
		outputHandlersRef.current.add(handler);
		return () => outputHandlersRef.current.delete(handler);
	}, []);

	// 面板卸载（切走工作区/关闭抽屉）→ 断开；服务端负责清理 PTY。
	useEffect(() => disconnect, [disconnect]);

	return { status, tabs, activeTabId, error, connect, disconnect, createTab, closeTab, selectTab, sendInput, sendResize, subscribeOutput };
}
