/**
 * Web 终端路由（WebTerminalRoutes.ts）
 *
 * 切片 S1 已落地：握手四校验（C1/C2/C3/C17）+ 帧协议 + 生命周期清理 + 审计。
 * 切片 S2 在此之上接真实终端（但仍是 Web 专属 manager 实例，见下）：
 * - C4 会话/项目归属：`resolveTarget` 由装配层注入（复用桌面 IPC 的 target parser + runtime 校验）；
 * - C5 tab 归属：连接只可操作自己创建的 tab；
 * - C6 输入：单帧 ≤4KB，单连接输入速率 ≤64KB/s；
 * - C7 resize：cols ∈ [2,500]、rows ∈ [1,300]，安全整数；
 * - C8 背压：发送队列 >1MB 断开；
 * - C9 并发：每主体 4 tab、全局 16 tab；
 * - C10 清理：连接关闭 → 关闭该连接全部 tab；服务 stop → closeAll。
 *
 * 职责边界：这里不认识 Electron / ProjectStore / node-pty；终端能力以窄接口注入
 * （`create/input/resize/close`），输出通过 `dispatchTerminalEvent` 从装配层回灌。
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import type { TerminalShell, TerminalTarget, TerminalTab } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import { WebWriteRateLimiter } from "./WebRateLimit";
import { evaluateTerminalHandshake } from "./WebSocketHandshake";
import { encodeCloseFrame, encodePongFrame, encodeTextFrame, WebSocketFrameDecoder, WS_OPCODE } from "./WebSocketFrame";

/** 握手限速：每主体每分钟 10 次，挡住反复握手触发的 spawn/日志放大。 */
const HANDSHAKE_LIMIT = { limit: 10, windowMs: 60_000 };
/** 单连接帧率上限（每秒）：终端输入是按键级别，200/s 已远超人手速度。 */
const FRAME_RATE_LIMIT_PER_SECOND = 200;
/** 单帧输入上限（字符）：粘贴大段文本也够用，挡住「一帧塞一整个文件」。 */
const MAX_INPUT_CHARS = 4 * 1024;
/** 单连接输入速率（字符/秒）：防脚本化刷屏写爆 PTY。 */
const INPUT_BYTES_PER_SECOND = 64 * 1024;
/** 并发上限：每主体（token/IP）4 个 tab，全局 16 个。 */
const PER_OWNER_TAB_LIMIT = 4;
const GLOBAL_TAB_LIMIT = 16;
/** 发送队列背压阈值：超过即断开（客户端长时间不读）。 */
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

export type WebTerminalCapability = {
	create: (input: { target: TerminalTarget; shell?: TerminalShell }) => TerminalTab;
	input: (tabId: string, data: string) => void;
	resize: (tabId: string, cols: number, rows: number) => void;
	close: (tabId: string) => void;
};

export type WebTerminalRoutesDeps = {
	/** webTerminalEnabled（默认 false）。 */
	enabled: () => boolean;
	/** webServiceRequiresAuth（默认 true）。 */
	requiresAuth: () => boolean;
	/** 当前有效令牌。 */
	token: () => string;
	/** target 解析 + 归属校验（注入方复用桌面 parser 与 runtime 校验）。 */
	resolveTarget: (raw: unknown) => TerminalTarget;
	/** 终端能力；未注入时 create 帧回 terminalNotReady（S1 行为）。 */
	terminal?: WebTerminalCapability;
	/** 审计出口（测试可注入；生产写 appLogger）。 */
	log?: (message: string, details: Record<string, unknown>) => void;
};

type TerminalConnection = {
	socket: Duplex;
	decoder: WebSocketFrameDecoder;
	/** 当前秒窗口内的帧计数（简单帧率闸门）。 */
	frameWindow: { second: number; count: number };
	/** 当前秒窗口内的输入字符数（C6 输入速率）。 */
	inputWindow: { second: number; chars: number };
	/** 该连接创建的 tab（C5 归属白名单）。 */
	tabs: Set<string>;
	/** 配额 key（token 哈希或 IP，与握手限速同源）。 */
	quotaKey: string;
	closed: boolean;
};

function sha256Short(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function statusText(status: number): string {
	if (status === 401) return "Unauthorized";
	if (status === 403) return "Forbidden";
	if (status === 429) return "Too Many Requests";
	return "Bad Request";
}

/** 写一个完整的 HTTP 响应并关闭 socket（握手拒绝用）。 */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
	const body = JSON.stringify({ code, message });
	const response = [`HTTP/1.1 ${status} ${statusText(status)}`, "content-type: application/json; charset=utf-8", "cache-control: no-store", `content-length: ${Buffer.byteLength(body)}`, "connection: close", "", body].join("\r\n");
	try {
		socket.write(response);
	} catch {
		/* 对端已断：忽略 */
	}
	try {
		socket.destroy();
	} catch {
		/* ignore */
	}
}

/** target 解析错误 → 帧错误码（不把内部错误原文透给浏览器）。 */
function targetErrorCode(message: string): string {
	if (message === "PROJECT_NOT_FOUND") return "webError.projectNotFound";
	if (message === "TERMINAL_PROJECT_UNSUPPORTED") return "webError.terminalProjectUnsupported";
	if (message === "INVALID_TERMINAL_TARGET") return "webError.invalidTarget";
	if (message === "INVALID_TERMINAL_SHELL") return "webError.invalidShell";
	return "webError.sessionChanged";
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export class WebTerminalRoutes {
	private readonly connections = new Set<TerminalConnection>();
	private readonly handshakeLimiter = new WebWriteRateLimiter(HANDSHAKE_LIMIT);
	/** tabId → 连接：输出事件按 tab 归属路由，避免广播到其它连接。 */
	private readonly tabOwners = new Map<string, TerminalConnection>();
	private readonly tabsByQuota = new Map<string, number>();
	private totalTabs = 0;

	constructor(private readonly deps: WebTerminalRoutesDeps) {}

	/** 供 WebServiceManager 分发 upgrade 请求；与其它路由一样「命中即处理」。 */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head?: Buffer): void {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const log = this.logger();

		// C17：握手限速（先于任何服务端资源分配）。
		const quotaKey = sha256Short(request.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || request.socket?.remoteAddress || "unknown");
		const verdict = this.handshakeLimiter.take(quotaKey);
		if (!verdict.allowed) {
			log("handshake.rejected", { code: "webError.rateLimited" });
			rejectUpgrade(socket, 429, "webError.rateLimited", "too many terminal handshakes");
			return;
		}

		const handshake = evaluateTerminalHandshake({
			enabled: this.deps.enabled(),
			requiresAuth: this.deps.requiresAuth(),
			token: this.deps.token(),
			url,
			headers: request.headers,
		});
		if (!handshake.ok) {
			log("handshake.rejected", { code: handshake.code, status: handshake.status });
			rejectUpgrade(socket, handshake.status, handshake.code, handshake.message);
			return;
		}

		const responseHeaders = ["HTTP/1.1 101 Switching Protocols", "upgrade: websocket", "connection: Upgrade", `sec-websocket-accept: ${handshake.accept}`, "", ""].join("\r\n");
		try {
			socket.write(responseHeaders);
		} catch {
			log("handshake.rejected", { code: "webError.socketClosed" });
			socket.destroy();
			return;
		}

		const connection: TerminalConnection = {
			socket,
			decoder: new WebSocketFrameDecoder(),
			frameWindow: { second: Math.floor(Date.now() / 1000), count: 0 },
			inputWindow: { second: Math.floor(Date.now() / 1000), chars: 0 },
			tabs: new Set(),
			quotaKey,
			closed: false,
		};
		this.connections.add(connection);
		log("connection.open", { connections: this.connections.size });

		const cleanup = () => this.closeConnection(connection);
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("end", cleanup);
		socket.on("data", (chunk: Buffer) => this.handleData(connection, chunk, cleanup));
		if (head && head.length > 0) this.handleData(connection, head, cleanup);
	}

	/** 服务停止时统一切断所有 Web 终端连接（含各自 tab）。 */
	closeAll(reason = "server shutting down"): void {
		for (const connection of [...this.connections]) {
			this.sendFrame(connection, encodeCloseFrame(1001, reason));
			this.closeConnection(connection);
		}
	}

	get openConnectionCount(): number {
		return this.connections.size;
	}

	get openTabCount(): number {
		return this.totalTabs;
	}

	/** 终端输出回灌（装配层把 Web 专属 manager 的 emit 接到这里）。 */
	dispatchTerminalEvent(type: "data" | "exit", payload: unknown): void {
		if (typeof payload !== "object" || payload === null) return;
		const tabId = (payload as { tabId?: unknown }).tabId;
		if (typeof tabId !== "string") return;
		const connection = this.tabOwners.get(tabId);
		if (!connection) return;
		if (type === "data") {
			const data = (payload as { data?: unknown }).data;
			if (typeof data !== "string") return;
			this.sendJson(connection, { type: "data", tabId, data });
			return;
		}
		const exitCode = (payload as { exitCode?: unknown }).exitCode;
		this.sendJson(connection, { type: "exit", tabId, exitCode: typeof exitCode === "number" ? exitCode : null });
	}

	private closeConnection(connection: TerminalConnection): void {
		if (connection.closed) return;
		connection.closed = true;
		this.connections.delete(connection);
		for (const tabId of connection.tabs) {
			this.tabOwners.delete(tabId);
			this.releaseQuota(connection.quotaKey);
			try {
				this.deps.terminal?.close(tabId);
			} catch {
				/* tab 已退出/manager 已销毁：忽略 */
			}
		}
		connection.tabs.clear();
		try {
			connection.socket.destroy();
		} catch {
			/* ignore */
		}
		this.logger()("connection.close", { connections: this.connections.size, tabs: this.totalTabs });
	}

	private handleData(connection: TerminalConnection, chunk: Buffer, cleanup: () => void): void {
		if (connection.closed) return;
		const decoded = connection.decoder.push(chunk);
		if (decoded.error) {
			this.fail(connection, decoded.error.code, decoded.error.reason);
			return;
		}
		for (const frame of decoded.frames) {
			if (frame.opcode === WS_OPCODE.close) {
				this.sendFrame(connection, encodeCloseFrame(1000, ""));
				cleanup();
				return;
			}
			if (frame.opcode === WS_OPCODE.ping) {
				this.sendFrame(connection, encodePongFrame(frame.payload));
				continue;
			}
			if (frame.opcode === WS_OPCODE.pong) continue;
			this.handleTextFrame(connection, frame.payload);
		}
	}

	private handleTextFrame(connection: TerminalConnection, payload: Buffer): void {
		const nowSecond = Math.floor(Date.now() / 1000);
		if (connection.frameWindow.second !== nowSecond) {
			connection.frameWindow = { second: nowSecond, count: 0 };
		}
		connection.frameWindow.count += 1;
		if (connection.frameWindow.count > FRAME_RATE_LIMIT_PER_SECOND) {
			this.fail(connection, 1008, "frame rate limit exceeded");
			return;
		}

		let message: unknown;
		try {
			message = JSON.parse(payload.toString("utf8"));
		} catch {
			this.fail(connection, 1007, "invalid json frame");
			return;
		}
		if (typeof message !== "object" || message === null) {
			this.sendError(connection, "webError.invalidFrame", "frame must be a JSON object");
			return;
		}
		const type = (message as { type?: unknown }).type;
		if (type === "ping") {
			this.sendJson(connection, { type: "pong" });
			return;
		}
		if (type === "create") {
			this.handleCreate(connection, message as { target?: unknown; shell?: unknown });
			return;
		}
		if (type === "input") {
			this.handleInput(connection, message as { tabId?: unknown; data?: unknown });
			return;
		}
		if (type === "resize") {
			this.handleResize(connection, message as { tabId?: unknown; cols?: unknown; rows?: unknown });
			return;
		}
		if (type === "close") {
			this.handleClose(connection, message as { tabId?: unknown });
			return;
		}
		this.sendError(connection, "webError.invalidFrame", "unknown frame type");
	}

	private handleCreate(connection: TerminalConnection, message: { target?: unknown; shell?: unknown }): void {
		const terminal = this.deps.terminal;
		if (!terminal) {
			this.sendError(connection, "webError.terminalNotReady", "web terminal backend is not wired yet");
			return;
		}
		const owned = this.tabsByQuota.get(connection.quotaKey) ?? 0;
		if (owned >= PER_OWNER_TAB_LIMIT || this.totalTabs >= GLOBAL_TAB_LIMIT) {
			this.sendError(connection, "webError.terminalLimit", "terminal tab limit reached");
			return;
		}
		let target: TerminalTarget;
		try {
			target = this.deps.resolveTarget(message.target);
		} catch (error) {
			const messageText = error instanceof Error ? error.message : "INVALID_TERMINAL_TARGET";
			this.sendError(connection, targetErrorCode(messageText), "invalid terminal target");
			this.logger()("create.rejected", { code: targetErrorCode(messageText), ...targetMeta(message.target) });
			return;
		}
		try {
			const tab = terminal.create({ target, shell: message.shell as TerminalShell | undefined });
			connection.tabs.add(tab.id);
			this.tabOwners.set(tab.id, connection);
			this.tabsByQuota.set(connection.quotaKey, owned + 1);
			this.totalTabs += 1;
			this.sendJson(connection, {
				type: "created",
				tab: { id: tab.id, title: tab.title, shell: tab.shell, createdAt: tab.createdAt, buffer: typeof tab.buffer === "string" ? tab.buffer : "" },
			});
			this.logger()("create", { tabId: tab.id, ...targetMeta(target) });
		} catch (error) {
			// 只透出 errno/错误码语义，不回显 cwd / 宿主路径。
			const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "webError.terminalCreateFailed";
			this.sendError(connection, code, "terminal could not be created");
			this.logger()("create.failed", { code, ...targetMeta(target) });
		}
	}

	private handleInput(connection: TerminalConnection, message: { tabId?: unknown; data?: unknown }): void {
		const tabId = typeof message.tabId === "string" ? message.tabId : "";
		if (!this.ownsTab(connection, tabId)) {
			this.sendError(connection, "webError.terminalTabNotFound", "unknown terminal tab");
			return;
		}
		if (typeof message.data !== "string" || message.data.length === 0) {
			this.sendError(connection, "webError.invalidFrame", "input data must be a non-empty string");
			return;
		}
		if (message.data.length > MAX_INPUT_CHARS) {
			this.sendError(connection, "webError.terminalInputTooLarge", "input frame too large");
			return;
		}
		const nowSecond = Math.floor(Date.now() / 1000);
		if (connection.inputWindow.second !== nowSecond) connection.inputWindow = { second: nowSecond, chars: 0 };
		connection.inputWindow.chars += message.data.length;
		if (connection.inputWindow.chars > INPUT_BYTES_PER_SECOND) {
			this.fail(connection, 1008, "input rate limit exceeded");
			return;
		}
		this.deps.terminal?.input(tabId, message.data);
	}

	private handleResize(connection: TerminalConnection, message: { tabId?: unknown; cols?: unknown; rows?: unknown }): void {
		const tabId = typeof message.tabId === "string" ? message.tabId : "";
		if (!this.ownsTab(connection, tabId)) {
			this.sendError(connection, "webError.terminalTabNotFound", "unknown terminal tab");
			return;
		}
		if (!isSafeIntegerInRange(message.cols, 2, 500) || !isSafeIntegerInRange(message.rows, 1, 300)) {
			this.sendError(connection, "webError.invalidResize", "cols/rows out of range");
			return;
		}
		this.deps.terminal?.resize(tabId, message.cols, message.rows);
	}

	private handleClose(connection: TerminalConnection, message: { tabId?: unknown }): void {
		const tabId = typeof message.tabId === "string" ? message.tabId : "";
		if (!this.ownsTab(connection, tabId)) {
			this.sendError(connection, "webError.terminalTabNotFound", "unknown terminal tab");
			return;
		}
		connection.tabs.delete(tabId);
		this.tabOwners.delete(tabId);
		this.releaseQuota(connection.quotaKey);
		try {
			this.deps.terminal?.close(tabId);
		} catch {
			/* 已退出：忽略 */
		}
		this.sendJson(connection, { type: "closed", tabId });
		this.logger()("close", { tabId });
	}

	private ownsTab(connection: TerminalConnection, tabId: string): boolean {
		return tabId.length > 0 && connection.tabs.has(tabId);
	}

	private releaseQuota(quotaKey: string): void {
		const current = this.tabsByQuota.get(quotaKey) ?? 0;
		if (current <= 1) this.tabsByQuota.delete(quotaKey);
		else this.tabsByQuota.set(quotaKey, current - 1);
		if (this.totalTabs > 0) this.totalTabs -= 1;
	}

	private sendJson(connection: TerminalConnection, payload: Record<string, unknown>): void {
		this.sendFrame(connection, encodeTextFrame(JSON.stringify(payload)));
	}

	private sendError(connection: TerminalConnection, code: string, message: string): void {
		this.sendJson(connection, { type: "error", code, message });
	}

	private sendFrame(connection: TerminalConnection, frame: Buffer): void {
		if (connection.closed) return;
		if ((connection.socket.writableLength ?? 0) > BACKPRESSURE_LIMIT_BYTES) {
			this.fail(connection, 1008, "output backpressure");
			return;
		}
		try {
			connection.socket.write(frame);
		} catch {
			/* 对端已断：close/error 监听负责清理 */
		}
	}

	private fail(connection: TerminalConnection, code: number, reason: string): void {
		this.sendFrame(connection, encodeCloseFrame(code, reason));
		this.closeConnection(connection);
	}

	private logger(): (message: string, details: Record<string, unknown>) => void {
		return this.deps.log ?? ((message, details) => void getAppLogger()?.info("web-terminal", message, details));
	}
}

/** 审计里只放 target 的类型与 id，不放路径。 */
function targetMeta(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null) return { target: "invalid" };
	const value = raw as { kind?: unknown; projectId?: unknown; sessionId?: unknown; agentId?: unknown };
	if (value.kind === "project" && typeof value.projectId === "string") return { target: "project", projectId: value.projectId };
	if (value.kind === "agent" && typeof value.sessionId === "string" && typeof value.agentId === "string") return { target: "agent", sessionId: value.sessionId, agentId: value.agentId };
	return { target: "invalid" };
}
