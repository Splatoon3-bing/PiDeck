/**
 * WebSocket 帧编解码（T6 S1）：只覆盖终端协议用到的子集 + 协议拒绝分支。
 *
 * 关键约束：客户端帧必须 mask；分片/RSV/二进制/控制帧超长一律 fail-closed，
 * 避免半套重组实现成为内存放大或解析绕过面。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebSocketFrameDecoder, encodeFrame, encodeTextFrame, encodeCloseFrame, encodePongFrame, MAX_TERMINAL_FRAME_BYTES, WS_OPCODE } = loadTsCommonJs("src/main/web/WebSocketFrame.ts");

/** 构造客户端帧（必须 mask）。 */
function clientFrame(opcode, payload, { fin = true } = {}) {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
	const mask = Buffer.from([1, 2, 3, 4]);
	let header;
	if (data.length < 126) {
		header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length]);
	} else if (data.length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(data.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = (fin ? 0x80 : 0) | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(data.length), 2);
	}
	const masked = Buffer.from(data);
	for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
	return Buffer.concat([header, mask, masked]);
}

test("encodeTextFrame 覆盖三种长度编码（<126 / 16bit / 64bit）并带 FIN", () => {
	for (const length of [5, 300, 70_000]) {
		const frame = encodeTextFrame("x".repeat(length));
		assert.equal(frame[0], 0x81, `opcode/FIN for length ${length}`);
		if (length < 126) assert.equal(frame[1], length);
		else if (length < 65_536) {
			assert.equal(frame[1], 126);
			assert.equal(frame.readUInt16BE(2), length);
		} else {
			assert.equal(frame[1], 127);
			assert.equal(Number(frame.readBigUInt64BE(2)), length);
		}
	}
});

test("解码客户端文本帧：payload 与 mask 还原正确", () => {
	const decoder = new WebSocketFrameDecoder();
	const result = decoder.push(clientFrame(WS_OPCODE.text, '{"type":"ping"}'));
	assert.equal(result.error, undefined);
	assert.equal(result.frames.length, 1);
	assert.equal(result.frames[0].opcode, WS_OPCODE.text);
	assert.equal(result.frames[0].payload.toString("utf8"), '{"type":"ping"}');
});

test("粘包与半包：一次 push 多帧、分两次 push 一帧", () => {
	const single = clientFrame(WS_OPCODE.text, "hello");
	const decoder = new WebSocketFrameDecoder();
	const sticky = decoder.push(Buffer.concat([single, single]));
	assert.equal(sticky.frames.length, 2);

	const decoder2 = new WebSocketFrameDecoder();
	assert.equal(decoder2.push(single.subarray(0, 3)).frames.length, 0);
	const tail = decoder2.push(single.subarray(3));
	assert.equal(tail.frames.length, 1);
	assert.equal(tail.frames[0].payload.toString("utf8"), "hello");
});

test("未 mask 的客户端帧 → 1002（RFC 强制）", () => {
	const unmasked = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]);
	const result = new WebSocketFrameDecoder().push(unmasked);
	assert.equal(result.error?.code, 1002);
});

test("分片帧、RSV 位、二进制帧、控制帧超长一律拒绝", () => {
	const fragmented = new WebSocketFrameDecoder().push(clientFrame(WS_OPCODE.text, "x", { fin: false }));
	assert.equal(fragmented.error?.code, 1003, "fragmented");

	const rsv = clientFrame(WS_OPCODE.text, "x");
	rsv[0] |= 0x40;
	assert.equal(new WebSocketFrameDecoder().push(rsv).error?.code, 1002, "rsv");

	assert.equal(new WebSocketFrameDecoder().push(clientFrame(WS_OPCODE.binary, Buffer.from([1, 2]))).error?.code, 1003, "binary");

	const largePing = clientFrame(WS_OPCODE.ping, Buffer.alloc(126));
	assert.equal(new WebSocketFrameDecoder().push(largePing).error?.code, 1002, "control frame >125");
});

test("超过单帧上限 → 1009，不在内存里攒出超大 payload", () => {
	const frame = clientFrame(WS_OPCODE.text, Buffer.alloc(MAX_TERMINAL_FRAME_BYTES + 1));
	const result = new WebSocketFrameDecoder().push(frame);
	assert.equal(result.error?.code, 1009);
});

test("close/pong 帧编码：close 带 2 字节 code，pong 回显 ≤125 字节", () => {
	const close = encodeCloseFrame(1000, "bye");
	assert.equal(close[0], 0x88);
	assert.equal(close.readUInt16BE(2), 1000);

	const pong = encodePongFrame(Buffer.from("x".repeat(200)));
	assert.equal(pong[0], 0x8a);
	// 未 mask 的服务端帧：长度字段直接是 125（被截断）
	assert.equal(pong[1], 125);

	assert.equal(encodeFrame(WS_OPCODE.text, Buffer.from("hi"))[0], 0x81);
});
