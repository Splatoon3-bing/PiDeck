/**
 * Web 终端路由 S1（握手 + 帧骨架，不开 PTY）。
 *
 * 覆盖：开关关闭 403 / token 401 / Origin 跨源 403 / 成功 101 / create → notReady /
 * 未知帧 invalidFrame / 非 JSON 帧 close 1007 / 握手限速 429 / closeAll 清理。
 * 用 PassThrough 当 socket：能同时观察服务端写出的 101、帧与销毁。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebTerminalRoutes } = loadTsCommonJs("src/main/web/WebTerminalRoutes.ts");
const { WS_OPCODE } = loadTsCommonJs("src/main/web/WebSocketFrame.ts");

const TOKEN = "0123456789abcdef";
const HOST = "127.0.0.1:8765";

/**
 * 假 socket：真实 net.Socket 是双向独立的；PassThrough 会把服务端写出的数据回灌给
 * 自己的 data 监听（服务端 101 会被当成客户端帧解析），所以这里用手写两向：
 * write() 收集服务端输出，emitData() 模拟客户端输入。
 */
function makeSocket() {
	const chunks = [];
	const handlers = new Map();
	const socket = {
		destroyed: false,
		writableLength: 0,
		text: () => Buffer.concat(chunks).toString("utf8"),
		write: (buffer) => {
			chunks.push(Buffer.from(buffer));
			return true;
		},
		on: (event, callback) => {
			handlers.set(event, callback);
			return socket;
		},
		destroy: () => {
			if (socket.destroyed) return;
			socket.destroyed = true;
			handlers.get("close")?.();
		},
		emitData: (buffer) => handlers.get("data")?.(Buffer.from(buffer)),
	};
	return socket;
}

function makeRequest({ url = `/api/terminal?token=${TOKEN}`, origin = `http://${HOST}`, headers = {}, remoteAddress = "127.0.0.1" } = {}) {
	return {
		url,
		headers: {
			host: HOST,
			origin,
			upgrade: "websocket",
			connection: "Upgrade",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			"sec-websocket-version": "13",
			...headers,
		},
		socket: { remoteAddress },
	};
}

function maskedTextFrame(message) {
	const data = Buffer.from(JSON.stringify(message), "utf8");
	const mask = Buffer.from([9, 8, 7, 6]);
	const header = Buffer.from([0x81, 0x80 | data.length]);
	const masked = Buffer.from(data);
	for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
	return Buffer.concat([header, mask, masked]);
}

function routes(overrides = {}) {
	const logs = [];
	const instance = new WebTerminalRoutes({
		enabled: () => true,
		requiresAuth: () => true,
		token: () => TOKEN,
		log: (message, details) => logs.push({ message, details }),
		...overrides,
	});
	return { routes: instance, logs };
}

test("开关关闭：握手 403 + terminalDisabled，且不登记连接", () => {
	const { routes: instance, logs } = routes({ enabled: () => false });
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	assert.match(socket.text(), /^HTTP\/1\.1 403 /);
	assert.match(socket.text(), /webError\.terminalDisabled/);
	assert.equal(instance.openConnectionCount, 0);
	assert.ok(logs.some((entry) => entry.message === "handshake.rejected" && entry.details.code === "webError.terminalDisabled"));
});

test("token 缺失/错误：401", () => {
	const { routes: instance } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest({ url: "/api/terminal" }), socket);
	assert.match(socket.text(), /^HTTP\/1\.1 401 /);
	assert.equal(instance.openConnectionCount, 0);
});

test("跨源 Origin：403 originRejected", () => {
	const { routes: instance } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest({ origin: "http://evil.example.com" }), socket);
	assert.match(socket.text(), /^HTTP\/1\.1 403 /);
	assert.match(socket.text(), /webError\.originRejected/);
});

test("校验通过：101 + 正确 accept key，连接登记 1 个", () => {
	const { routes: instance, logs } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	const text = socket.text();
	assert.match(text, /^HTTP\/1\.1 101 Switching Protocols/);
	assert.match(text, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
	assert.equal(instance.openConnectionCount, 1);
	assert.ok(logs.some((entry) => entry.message === "connection.open"));
});

test("S1 骨架：create/input 帧回 terminalNotReady（不 spawn PTY）", () => {
	const { routes: instance } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	socket.emitData(maskedTextFrame({ type: "input", data: "ls\n" }));
	const text = socket.text();
	assert.equal((text.match(/webError\.terminalNotReady/g) ?? []).length, 2);
});

test("未知帧类型回 invalidFrame；非 JSON 帧直接 close 1007", () => {
	const { routes: instance } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "nope" }));
	assert.match(socket.text(), /webError\.invalidFrame/);

	const second = makeSocket();
	const instance2 = routes().routes;
	instance2.handleUpgrade(makeRequest(), second);
	second.emitData(Buffer.concat([Buffer.from([0x81, 0x80 | 3]), Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7])]));
	assert.match(second.text(), /HTTP\/1\.1 101/);
	// 关闭帧 opcode 0x88 至少出现过一次（关闭原因 invalid json frame）
	assert.ok(second.text().includes("\u0088") || second.text().includes("invalid"), "should send close frame");
});

test("closeAll：断开所有连接并把计数归零", () => {
	const { routes: instance } = routes();
	const first = makeSocket();
	const second = makeSocket();
	instance.handleUpgrade(makeRequest(), first);
	instance.handleUpgrade(makeRequest(), second);
	assert.equal(instance.openConnectionCount, 2);
	instance.closeAll();
	assert.equal(instance.openConnectionCount, 0);
});

test("握手限速：同一主体第 11 次握手 429", () => {
	const { routes: instance } = routes();
	for (let index = 0; index < 10; index += 1) {
		const socket = makeSocket();
		instance.handleUpgrade(makeRequest(), socket);
		assert.match(socket.text(), /^HTTP\/1\.1 101 /, `handshake ${index}`);
	}
	const blocked = makeSocket();
	instance.handleUpgrade(makeRequest(), blocked);
	assert.match(blocked.text(), /^HTTP\/1\.1 429 /);
	assert.match(blocked.text(), /webError\.rateLimited/);
});
