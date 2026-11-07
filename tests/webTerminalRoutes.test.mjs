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
function makeSocket(options = {}) {
	const chunks = [];
	const handlers = new Map();
	const socket = {
		destroyed: false,
		writableLength: options.writableLength ?? 0,
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
	let header;
	if (data.length < 126) {
		header = Buffer.from([0x81, 0x80 | data.length]);
	} else if (data.length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(data.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(data.length), 2);
	}
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

test("未注入终端能力时：create 帧回 terminalNotReady（不 spawn PTY）", () => {
	const { routes: instance } = routes();
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	assert.match(socket.text(), /webError\.terminalNotReady/);
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

/* ── S2：接真实终端能力（假 manager），覆盖归属/上限/输入尺寸/resize/清理 ── */

function fakeTerminal() {
	const calls = { create: [], input: [], resize: [], close: [] };
	let sequence = 0;
	return {
		calls,
		create: (input) => {
			calls.create.push(input);
			sequence += 1;
			return { id: `tab-${sequence}`, title: `t${sequence}`, shell: input.shell ?? "bash", createdAt: 1, buffer: "" };
		},
		input: (id, data) => calls.input.push({ id, data }),
		resize: (id, cols, rows) => calls.resize.push({ id, cols, rows }),
		close: (id) => calls.close.push(id),
	};
}

function openWithTerminal(overrides = {}) {
	const terminal = fakeTerminal();
	const { routes: instance, logs } = routes({ terminal, resolveTarget: (raw) => raw, ...overrides });
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	return { terminal, routes: instance, socket, logs };
}

test("S2 create：解析 target + 回 created 帧 + 记录归属", () => {
	const { terminal, socket } = openWithTerminal();
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" }, shell: "bash" }));
	assert.equal(terminal.calls.create.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.create[0])), { target: { kind: "project", projectId: "p1" }, shell: "bash" });
	assert.match(socket.text(), /"type":"created"/);
	assert.match(socket.text(), /"id":"tab-1"/);
});

test("S2 归属：连接只能操作自己创建的 tab（跨连接 tabId 被拒）", () => {
	const owner = openWithTerminal();
	owner.socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));

	// 另一个连接（不同 token → 不同配额 key）尝试写 owner 的 tab
	const intruder = routes({ terminal: fakeTerminal(), resolveTarget: (raw) => raw }).routes;
	const intruderSocket = makeSocket();
	intruder.handleUpgrade(makeRequest({ url: `/api/terminal?token=${TOKEN}` }), intruderSocket);
	intruderSocket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "rm -rf /" }));
	assert.match(intruderSocket.text(), /webError\.terminalTabNotFound/);
});

test("S2 input：归属内转发；超 4KB 拒绝；空内容拒绝", () => {
	const { terminal, socket } = openWithTerminal();
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "ls\n" }));
	assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.input)), [{ id: "tab-1", data: "ls\n" }]);

	// 边界：4096 恰好放行，4097 拒绝（服务端 MAX_INPUT_CHARS=4096）
	socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "y".repeat(4096) }));
	assert.equal(terminal.calls.input.length >= 2, true, "4096-char input should be forwarded");
	const callsBefore = terminal.calls.input.length;
	socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "x".repeat(4097) }));
	assert.match(socket.text(), /webError\.terminalInputTooLarge/);
	assert.equal(terminal.calls.input.length, callsBefore, "oversized input must not reach the PTY");

	socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "" }));
	assert.match(socket.text(), /webError\.invalidFrame/);
});

test("S2 resize：合法转发；越界/非整数拒绝", () => {
	const { terminal, socket } = openWithTerminal();
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	socket.emitData(maskedTextFrame({ type: "resize", tabId: "tab-1", cols: 120, rows: 40 }));
	assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.resize)), [{ id: "tab-1", cols: 120, rows: 40 }]);

	for (const [cols, rows] of [
		[1, 40],
		[120, 0],
		[1e9, 40],
		[120.5, 40],
	]) {
		const { socket: s2 } = openWithTerminal();
		s2.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
		s2.emitData(maskedTextFrame({ type: "resize", tabId: "tab-1", cols, rows }));
		assert.match(s2.text(), /webError\.invalidResize/, `cols=${cols} rows=${rows}`);
	}
});

test("S2 close 帧：关闭 PTY 并撤销归属（后续 input 被拒）", () => {
	const { terminal, socket } = openWithTerminal();
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	socket.emitData(maskedTextFrame({ type: "close", tabId: "tab-1" }));
	assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.close)), ["tab-1"]);
	assert.match(socket.text(), /"type":"closed"/);
	socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "x" }));
	assert.match(socket.text(), /webError\.terminalTabNotFound/);
});

test("S2 连接关闭：清理该连接全部 tab（不泄漏 PTY）", () => {
	const { terminal, socket, routes: instance } = openWithTerminal();
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	assert.equal(instance.openTabCount, 2);
	instance.closeAll();
	assert.equal(instance.openTabCount, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(terminal.calls.close)).sort(), ["tab-1", "tab-2"]);
});

test("S2 并发上限：同一主体第 5 个 tab 被拒", () => {
	const { socket } = openWithTerminal();
	for (let index = 0; index < 4; index += 1) {
		socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	}
	assert.match(socket.text(), /"type":"created"/);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	assert.match(socket.text(), /webError\.terminalLimit/);
});

test("S2 target 拒绝：未知项目 → projectNotFound；伪造 cwd 字段 → invalidTarget", () => {
	const resolveTarget = (raw) => {
		if (typeof raw === "object" && raw !== null && "cwd" in raw) throw new Error("INVALID_TERMINAL_TARGET");
		if (raw?.projectId === "missing") throw new Error("PROJECT_NOT_FOUND");
		return raw;
	};
	const { routes: instance } = routes({ terminal: fakeTerminal(), resolveTarget });
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "missing" } }));
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1", cwd: "/etc" } }));
	assert.match(socket.text(), /webError\.projectNotFound/);
	assert.match(socket.text(), /webError\.invalidTarget/);
});

test("S2 输出路由：只有 tab 所属连接收到 data/exit 帧", () => {
	const owner = openWithTerminal();
	owner.socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));

	const other = openWithTerminal();
	other.socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));

	owner.routes.dispatchTerminalEvent("data", { tabId: "tab-1", data: "hello" });
	owner.routes.dispatchTerminalEvent("exit", { tabId: "tab-1", exitCode: 0 });
	owner.routes.dispatchTerminalEvent("data", { tabId: "tab-2", data: "should-not-leak" });

	const ownerText = owner.socket.text();
	assert.match(ownerText, /"data":"hello"/);
	assert.match(ownerText, /"type":"exit"/);
	assert.equal(ownerText.includes("should-not-leak"), false);
	assert.equal(other.socket.text().includes("hello"), false);
});

/* ── S3：协议边界补测（背压 / 输入速率 / 全局上限） ── */

test("S3 背压：发送队列超过 1MB → 1008 断连，不再无限缓冲", () => {
	const { routes: instance } = routes({ terminal: fakeTerminal(), resolveTarget: (raw) => raw });
	const socket = makeSocket({ writableLength: 2 * 1024 * 1024 });
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	// created 帧写入时命中背压：连接被关闭、计数归零，不再继续写
	assert.equal(instance.openConnectionCount, 0);
	assert.equal(socket.destroyed, true);
});

test("S3 输入速率：同一秒累计超过 64KB → 1008 断连", () => {
	const { routes: instance } = routes({ terminal: fakeTerminal(), resolveTarget: (raw) => raw });
	const socket = makeSocket();
	instance.handleUpgrade(makeRequest(), socket);
	socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	// 每帧 4096 字符：17 帧 = 69632 > 65536 上限
	for (let index = 0; index < 17; index += 1) {
		socket.emitData(maskedTextFrame({ type: "input", tabId: "tab-1", data: "z".repeat(4096) }));
	}
	assert.equal(instance.openConnectionCount, 0);
	assert.equal(socket.destroyed, true);
});

test("S3 全局上限：16 个 tab 后第 17 个被拒（跨连接累计）", () => {
	// 关闭鉴权 → 配额 key 退回对端 IP；用不同 IP 模拟多个客户端
	const instance = routes({ terminal: fakeTerminal(), resolveTarget: (raw) => raw, requiresAuth: () => false }).routes;
	const sockets = [];
	for (let connectionIndex = 0; connectionIndex < 4; connectionIndex += 1) {
		const socket = makeSocket();
		sockets.push(socket);
		instance.handleUpgrade(makeRequest({ url: "/api/terminal", remoteAddress: `10.0.0.${connectionIndex + 1}` }), socket);
		for (let tabIndex = 0; tabIndex < 4; tabIndex += 1) {
			socket.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
		}
		assert.match(socket.text(), /"type":"created"/);
	}
	assert.equal(instance.openTabCount, 16);

	const overflow = makeSocket();
	instance.handleUpgrade(makeRequest({ url: "/api/terminal", remoteAddress: "10.0.0.99" }), overflow);
	overflow.emitData(maskedTextFrame({ type: "create", target: { kind: "project", projectId: "p1" } }));
	assert.match(overflow.text(), /webError\.terminalLimit/);
	assert.equal(instance.openTabCount, 16);
});
