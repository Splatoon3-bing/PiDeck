/**
 * WebSocket 握手校验（WebTerminalHandshake.ts）
 *
 * 只放纯判定：开关、令牌、Origin 同源、Upgrade 头齐全性。副作用（写 101/拒绝响应、
 * 注册连接）留在 WebTerminalRoutes。纯函数便于单测覆盖每条拒绝分支。
 *
 * 安全评审对应项（.ai/sdd/specs/001-web-parity/t6-terminal-security-review.md）：
 * - C1 开关默认关闭：`enabled=false` 一律拒绝（不暴露「能力存在」的细节）。
 * - C2 令牌：WS 握手是 GET，沿用 `/api/events` 的 `?token=` 规则（浏览器 WS 无法带 header）。
 * - C3 Origin 同源：WS 不受 CORS 预检保护，必须校验 Origin 的 host 与 Host 一致；
 *   缺失 Origin 或 `Origin: null` 一律拒绝（防任意网页用受害者浏览器开终端）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** RFC 6455 固定 GUID。 */
export const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `Sec-WebSocket-Accept` = base64(sha1(key + GUID))。 */
export function computeWebSocketAccept(key: string): string {
	return createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
}

export type TerminalHandshakeInput = {
	/** 桌面设置 webTerminalEnabled（默认 false）。 */
	enabled: boolean;
	/** webServiceRequiresAuth（默认 true）。 */
	requiresAuth: boolean;
	/** 当前有效令牌。 */
	token: string;
	url: URL;
	headers: IncomingMessage["headers"];
};

export type TerminalHandshakeVerdict = { ok: true; accept: string } | { ok: false; status: number; code: string; message: string };

function reject(status: number, code: string, message: string): TerminalHandshakeVerdict {
	return { ok: false, status, code, message };
}

/** Origin 同源：host（含端口）必须与请求 Host 一致；`null`/缺失/非法协议一律拒绝。 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
	if (!origin || !host) return false;
	if (origin === "null") return false;
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	if (parsed.username || parsed.password) return false;
	return parsed.host === host;
}

/** 令牌比对：长度不等/空串直接拒绝，内容用 timingSafeEqual 常数时间比较。 */
function tokenMatches(candidate: string | null, expected: string): boolean {
	if (!candidate || !expected) return false;
	const a = Buffer.from(candidate, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export function evaluateTerminalHandshake(input: TerminalHandshakeInput): TerminalHandshakeVerdict {
	// C1：开关优先判定——关闭时不透露 token/Origin 校验细节。
	if (!input.enabled) return reject(403, "webError.terminalDisabled", "web terminal is disabled");

	// C2：令牌。查询参数仅限 GET 语义（WS 握手本身就是 GET）。
	if (input.requiresAuth) {
		const queryToken = input.url.searchParams.get("token");
		if (!tokenMatches(queryToken, input.token)) return reject(401, "webError.unauthorized", "A valid web service token is required");
	}

	// C3：Origin 同源（Host 头是浏览器发往本服务的 authority）。
	if (!isSameOrigin(input.headers.origin, input.headers.host)) {
		return reject(403, "webError.originRejected", "origin is not allowed");
	}

	// RFC 6455 握手头齐全性。
	const upgrade = input.headers.upgrade;
	if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") return reject(400, "webError.invalidUpgrade", "Upgrade: websocket is required");
	const connection = input.headers.connection;
	if (
		typeof connection !== "string" ||
		!connection
			.toLowerCase()
			.split(/\s*,\s*/)
			.includes("upgrade")
	)
		return reject(400, "webError.invalidUpgrade", "Connection: Upgrade is required");
	const key = input.headers["sec-websocket-key"];
	if (typeof key !== "string" || !key.trim()) return reject(400, "webError.invalidUpgrade", "Sec-WebSocket-Key is required");
	const version = input.headers["sec-websocket-version"];
	if (version !== "13") return reject(400, "webError.invalidUpgrade", "Sec-WebSocket-Version 13 is required");

	return { ok: true, accept: computeWebSocketAccept(key.trim()) };
}
