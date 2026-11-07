/**
 * Web 终端路由（WebTerminalRoutes.ts）— S1 骨架
 *
 * 切片 S1 的目标（见 .ai/sdd/specs/001-web-parity/t6-terminal-security-review.md §7）：
 * 先把**握手四校验 + 帧协议 + 生命周期清理 + 审计**钉死，**不开 PTY**（create 帧回
 * `webError.terminalNotReady`）。S2 再注入 `createTerminal` 接真实终端管理。
 *
 * 职责边界：
 * - 这里不认识 Electron、不认识 ProjectStore：只做 WS 连接与帧的搬运；
 * - 开关/令牌由调用方以 getter 注入（每次握手取最新值，改设置不需要重启服务）；
 * - 连接登记在实例内，`closeAll()` 由 WebServiceManager.stop() 调用。
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { getAppLogger } from "../logging/sharedLogger";
import { WebWriteRateLimiter } from "./WebRateLimit";
import { evaluateTerminalHandshake } from "./WebSocketHandshake";
import { encodeCloseFrame, encodePongFrame, encodeTextFrame, WebSocketFrameDecoder, WS_OPCODE } from "./WebSocketFrame";

/** 握手限速：每主体每分钟 10 次，挡住反复握手触发的 spawn/日志放大。 */
const HANDSHAKE_LIMIT = { limit: 10, windowMs: 60_000 };
/** 单连接帧率上限（每秒）：终端输入是按键级别，200/s 已远超人手速度。 */
const FRAME_RATE_LIMIT_PER_SECOND = 200;

export type WebTerminalRoutesDeps = {
	/** webTerminalEnabled（默认 false）。 */
	enabled: () => boolean;
	/** webServiceRequiresAuth（默认 true）。 */
	requiresAuth: () => boolean;
	/** 当前有效令牌。 */
	token: () => string;
	/** S2 注入：创建 PTY。S1 不注入，create 帧回 terminalNotReady。 */
	createTerminal?: (input: { rawTarget: unknown; shell?: unknown }) => Promise<{ tabId: string; buffer?: string }>;
	/** 审计出口（测试可注入；生产写 appLogger）。 */
	log?: (message: string, details: Record<string, unknown>) => void;
};

type TerminalConnection = {
	socket: Duplex;
	decoder: WebSocketFrameDecoder;
	/** 当前秒窗口内的帧计数（S1 的简单帧率闸门）。 */
	frameWindow: { second: number; count: number };
	closed: boolean;
};

function sha256Short(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** 写一个完整的 HTTP 响应并关闭 socket（握手拒绝/协议错误用）。 */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
	const body = JSON.stringify({ code, message });
	const response = [
		`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "Bad Request"}`,
		"content-type: application/json; charset=utf-8",
		"cache-control: no-store",
		`content-length: ${Buffer.byteLength(body)}`,
		"connection: close",
		"",
		body,
	].join("\r\n");
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

export class WebTerminalRoutes {
	private readonly connections = new Set<TerminalConnection>();
	private readonly handshakeLimiter = new WebWriteRateLimiter(HANDSHAKE_LIMIT);

	constructor(private readonly deps: WebTerminalRoutesDeps) {}

	/** 供 WebServiceManager 分发 upgrade 请求；与其它路由一样「命中即处理」。 */
	handleUpgrade(request: IncomingMessage, socket: Duplex, head?: Buffer): void {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const log = this.deps.log ?? ((message, details) => void getAppLogger()?.info("web-terminal", message, details));

		// C17：握手限速（先于任何服务端资源分配）。
		const rateKey = sha256Short(request.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || request.socket?.remoteAddress || "unknown");
		const verdict = this.handshakeLimiter.take(rateKey);
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

		const connection: TerminalConnection = { socket, decoder: new WebSocketFrameDecoder(), frameWindow: { second: Math.floor(Date.now() / 1000), count: 0 }, closed: false };
		this.connections.add(connection);
		log("connection.open", { connections: this.connections.size });

		const cleanup = () => {
			if (connection.closed) return;
			connection.closed = true;
			this.connections.delete(connection);
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
			log("connection.close", { connections: this.connections.size });
		};

		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("end", cleanup);
		socket.on("data", (chunk: Buffer) => this.handleData(connection, chunk, cleanup));
		if (head && head.length > 0) this.handleData(connection, head, cleanup);
	}

	/** 服务停止/令牌轮换时统一切断所有 Web 终端连接。 */
	closeAll(reason = "server shutting down"): void {
		for (const connection of this.connections) {
			this.sendFrame(connection, encodeCloseFrame(1001, reason));
			try {
				connection.socket.destroy();
			} catch {
				/* ignore */
			}
			connection.closed = true;
		}
		this.connections.clear();
	}

	get openConnectionCount(): number {
		return this.connections.size;
	}

	private handleData(connection: TerminalConnection, chunk: Buffer, cleanup: () => void): void {
		if (connection.closed) return;
		const decoded = connection.decoder.push(chunk);
		if (decoded.error) {
			this.fail(connection, decoded.error.code, decoded.error.reason, cleanup);
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
			// 只启用文本帧：二进制在 S1–S4 协议里没有用途。
			this.handleTextFrame(connection, frame.payload, cleanup);
		}
	}

	private handleTextFrame(connection: TerminalConnection, payload: Buffer, cleanup: () => void): void {
		const nowSecond = Math.floor(Date.now() / 1000);
		if (connection.frameWindow.second !== nowSecond) {
			connection.frameWindow = { second: nowSecond, count: 0 };
		}
		connection.frameWindow.count += 1;
		if (connection.frameWindow.count > FRAME_RATE_LIMIT_PER_SECOND) {
			this.fail(connection, 1008, "frame rate limit exceeded", cleanup);
			return;
		}

		let message: unknown;
		try {
			message = JSON.parse(payload.toString("utf8"));
		} catch {
			this.fail(connection, 1007, "invalid json frame", cleanup);
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
		// S1：PTY 未接线。create/input/resize/close 统一回 notReady（明确告知而不是静默丢弃）。
		if (type === "create" || type === "input" || type === "resize" || type === "close") {
			this.sendError(connection, "webError.terminalNotReady", "web terminal backend is not wired yet");
			return;
		}
		this.sendError(connection, "webError.invalidFrame", "unknown frame type");
	}

	private sendJson(connection: TerminalConnection, payload: Record<string, unknown>): void {
		this.sendFrame(connection, encodeTextFrame(JSON.stringify(payload)));
	}

	private sendError(connection: TerminalConnection, code: string, message: string): void {
		this.sendJson(connection, { type: "error", code, message });
	}

	private sendFrame(connection: TerminalConnection, frame: Buffer): void {
		if (connection.closed) return;
		const socket = connection.socket as Duplex & { bufferedAmount?: number; writableLength?: number };
		// C8 背压：发送队列超过 1MB 视为客户端不读，直接断开而不是无限缓冲。
		const queued = socket.writableLength ?? 0;
		if (queued > 1024 * 1024) {
			this.fail(connection, 1008, "output backpressure", () => undefined);
			return;
		}
		try {
			socket.write(frame);
		} catch {
			/* 对端已断：close/error 监听会负责清理 */
		}
	}

	private fail(connection: TerminalConnection, code: number, reason: string, cleanup: () => void): void {
		this.sendFrame(connection, encodeCloseFrame(code, reason));
		cleanup();
	}
}
