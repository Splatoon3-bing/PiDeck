/**
 * WebSocket 握手校验（T6 S1）。
 *
 * 覆盖安全评审的 C1/C2/C3 与 RFC 6455 头处理：开关关闭、令牌、Origin 同源、
 * Upgrade 头齐全性。所有拒绝都必须 fail-closed（不带 accept key）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeWebSocketAccept, evaluateTerminalHandshake, isSameOrigin } = loadTsCommonJs("src/main/web/WebSocketHandshake.ts");

const HEADERS = {
	host: "127.0.0.1:8765",
	origin: "http://127.0.0.1:8765",
	upgrade: "websocket",
	connection: "Upgrade",
	"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
	"sec-websocket-version": "13",
};

function input(overrides = {}) {
	return {
		enabled: true,
		requiresAuth: true,
		token: "token-12345678",
		url: new URL("http://127.0.0.1:8765/api/terminal?token=token-12345678"),
		headers: HEADERS,
		...overrides,
	};
}

test("Sec-WebSocket-Accept 按 RFC 6455 示例计算", () => {
	// RFC 6455 §1.3 的示例 key/accept（客户端 key 固定，服务端结果也必须固定）
	assert.equal(computeWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("Origin 同源：只有 http(s) 且 host 与 Host 完全一致才放行", () => {
	assert.equal(isSameOrigin("http://127.0.0.1:8765", "127.0.0.1:8765"), true);
	assert.equal(isSameOrigin("https://pideck.example.com", "pideck.example.com"), true);
	assert.equal(isSameOrigin("http://evil.example.com", "127.0.0.1:8765"), false);
	assert.equal(isSameOrigin("http://127.0.0.1:9999", "127.0.0.1:8765"), false);
	assert.equal(isSameOrigin("null", "127.0.0.1:8765"), false);
	assert.equal(isSameOrigin(undefined, "127.0.0.1:8765"), false);
	assert.equal(isSameOrigin("file:///tmp/x", "127.0.0.1:8765"), false);
	assert.equal(isSameOrigin("http://user:pass@127.0.0.1:8765", "127.0.0.1:8765"), false);
});

test("开关关闭时 fail-closed（403，不透露令牌/Origin 细节）", () => {
	const verdict = evaluateTerminalHandshake(input({ enabled: false }));
	assert.equal(verdict.ok, false);
	assert.equal(verdict.status, 403);
	assert.equal(verdict.code, "webError.terminalDisabled");
});

test("开启鉴权时 token 错误/缺失一律 401", () => {
	for (const url of [new URL("http://127.0.0.1:8765/api/terminal"), new URL("http://127.0.0.1:8765/api/terminal?token=wrong-token")]) {
		const verdict = evaluateTerminalHandshake(input({ url }));
		assert.equal(verdict.ok, false);
		assert.equal(verdict.status, 401);
		assert.equal(verdict.code, "webError.unauthorized");
	}
});

test("关闭鉴权时不要求 token（与 HTTP 路由同一策略），但 Origin 仍必须同源", () => {
	const noAuth = input({ requiresAuth: false, url: new URL("http://127.0.0.1:8765/api/terminal") });
	assert.equal(evaluateTerminalHandshake(noAuth).ok, true);
	const crossOrigin = input({ requiresAuth: false, headers: { ...HEADERS, origin: "http://evil.example.com" } });
	const verdict = evaluateTerminalHandshake(crossOrigin);
	assert.equal(verdict.ok, false);
	assert.equal(verdict.status, 403);
	assert.equal(verdict.code, "webError.originRejected");
});

test("缺少 Origin 或跨源 Origin 一律拒绝（WS 不受 CORS 预检保护）", () => {
	for (const origin of [undefined, "null", "http://127.0.0.1:9999"]) {
		const { origin: _omit, ...withoutOrigin } = HEADERS;
		const headers = origin === undefined ? withoutOrigin : { ...HEADERS, origin };
		const verdict = evaluateTerminalHandshake(input({ headers }));
		assert.equal(verdict.ok, false, `origin=${String(origin)}`);
		assert.equal(verdict.status, 403);
		assert.equal(verdict.code, "webError.originRejected");
	}
});

test("握手头不齐（Upgrade/Connection/Key/Version）返回 400", () => {
	const cases = [
		{ ...HEADERS, upgrade: "h2c" },
		{ ...HEADERS, connection: "keep-alive" },
		{ ...HEADERS, "sec-websocket-key": "" },
		{ ...HEADERS, "sec-websocket-version": "8" },
	];
	for (const headers of cases) {
		const verdict = evaluateTerminalHandshake(input({ headers }));
		assert.equal(verdict.ok, false);
		assert.equal(verdict.status, 400);
	}
});

test("全部校验通过时返回正确的 accept key", () => {
	const verdict = evaluateTerminalHandshake(input());
	assert.equal(verdict.ok, true);
	assert.equal(verdict.accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});
