/**
 * 最小 WebSocket 帧编解码（WebSocketFrame.ts）
 *
 * 项目没有 `ws` 依赖（桌面只用 Electron 内置），Web 终端只需 RFC 6455 的一个子集：
 * 文本帧、close、ping/pong。这里只实现这个子集，并对协议边界 fail-closed：
 * - 客户端帧必须 mask（RFC 强制），未 mask → 1002；
 * - 拒绝 RSV 位与分片（S1–S4 的协议不需要分片，拒绝比实现半套重组安全）；
 * - 单帧上限 64KB → 1009；
 * - 控制帧 ≤125 且必须 FIN；
 * - 只接受 text/close/ping/pong，其它 opcode → 1003。
 *
 * 纯函数 + 增量解码器，便于单测（无需真实 socket）。
 */

/** 单帧上限：终端输入/控制帧都是短 JSON；64KB 足够且能挡住内存放大。 */
export const MAX_TERMINAL_FRAME_BYTES = 64 * 1024;

export const WS_OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

export type DecodedFrame = { opcode: number; payload: Buffer };
export type FrameDecodeError = { code: number; reason: string };
export type FrameDecodeResult = { frames: DecodedFrame[]; error?: FrameDecodeError };

/** 服务端→客户端帧（不 mask）。 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, length]);
	} else if (length < 65_536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

export function encodeTextFrame(text: string): Buffer {
	return encodeFrame(WS_OPCODE.text, Buffer.from(text, "utf8"));
}

/** close 帧：code 为 2 字节大端 + 可选 reason（总 payload ≤125）。 */
export function encodeCloseFrame(code: number, reason = ""): Buffer {
	const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
	const payload = Buffer.alloc(2 + reasonBytes.length);
	payload.writeUInt16BE(code, 0);
	reasonBytes.copy(payload, 2);
	return encodeFrame(WS_OPCODE.close, payload);
}

export function encodePongFrame(payload: Buffer): Buffer {
	return encodeFrame(WS_OPCODE.pong, payload.subarray(0, 125));
}

/** 增量解码器：一次 push 可能含 0..n 帧（TCP 粘包/半包）。 */
export class WebSocketFrameDecoder {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): FrameDecodeResult {
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		const frames: DecodedFrame[] = [];
		for (;;) {
			if (this.buffer.length < 2) break;
			const first = this.buffer[0];
			const second = this.buffer[1];
			const fin = (first & 0x80) !== 0;
			const rsv = first & 0x70;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;

			if (rsv !== 0) return { frames, error: { code: 1002, reason: "reserved bits must be zero" } };
			if (length === 126) {
				if (this.buffer.length < 4) break;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) break;
				const big = this.buffer.readBigUInt64BE(2);
				if (big > BigInt(MAX_TERMINAL_FRAME_BYTES)) return { frames, error: { code: 1009, reason: "frame too large" } };
				length = Number(big);
				offset = 10;
			}
			if (length > MAX_TERMINAL_FRAME_BYTES) return { frames, error: { code: 1009, reason: "frame too large" } };
			if (!masked) return { frames, error: { code: 1002, reason: "client frames must be masked" } };
			if (this.buffer.length < offset + 4 + length) break;

			const isControl = opcode === WS_OPCODE.close || opcode === WS_OPCODE.ping || opcode === WS_OPCODE.pong;
			if (!fin) return { frames, error: { code: 1003, reason: "fragmented frames are not supported" } };
			if (isControl && length > 125) return { frames, error: { code: 1002, reason: "control frame too large" } };
			if (opcode !== WS_OPCODE.text && !isControl) return { frames, error: { code: 1003, reason: "unsupported opcode" } };

			const maskKey = this.buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
			for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4];

			this.buffer = this.buffer.subarray(offset + 4 + length);
			frames.push({ opcode, payload });
		}
		return { frames };
	}
}
