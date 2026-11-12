/**
 * Web 生视频产物出口（只读）：/api/videogen/blob/<ref>?token=…
 *
 * 为什么需要它：生视频产物是内容寻址落盘的 `userData/videogen/blobs/<sha256>.mp4`，
 * 会话消息里只存 `ref`。桌面能播是因为注册了 `pideck-video://` 自定义协议，
 * 浏览器没有这个协议；而 `/api/file-raw` 走 `resolveReadableFile` 的项目沙箱，
 * blobs 在 userData 下、不在任何项目根内，会被直接拒。于是「历史视频在 Web 上什么都没有」。
 *
 * 边界（刻意收窄）：
 * - **只读**：不提供 submit/poll，生成链路（长任务 + 事件流）仍然不在 Web 开放。
 *   这条路由不碰任何上游 API，所以看历史视频永远不会触发计费；
 * - ref 白名单由 `VideoBlobStore.resolvePath` 承担（64hex + 扩展名 + 目录归属兜底），
 *   这里只多做一层「路径段里不许有分隔符」的廉价拦截；
 * - **必须支持单段 Range**：`<video>` 拖进度/续播靠 206 + `Content-Range`，
 *   不能照抄 `/api/imagegen/blob`（图片整读整发够用，视频没 Range 就拖不动）；
 * - 内容寻址 ⇒ 同一 ref 字节永不变，可 `immutable` 长缓存；
 * - 令牌校验交给 `WebServiceManager` 的 `/api/*` 统一链（WebTokenAuth），不另起一套。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { videoBlobMimeType } from "../videogen/VideoBlobStore";
import { sendError, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { parseSingleByteRange } from "./byteRange";

const BLOB_PREFIX = "/api/videogen/blob/";

export type WebVideoGenRoutesDeps = {
	/** 引用名 → 绝对路径；非法引用名或越界一律 null（白名单在 VideoBlobStore 内）。 */
	resolveBlobPath: (ref: string) => string | null;
};

/**
 * 依赖用模块级 holder 延迟装配：本路由在启动序列里比 videoBlobStore 构造更早注册，
 * 值传递会把 null 固定下来（与 imagegen / hostPlugins 同一个坑）。
 */
let webVideoGenDeps: WebVideoGenRoutesDeps | null = null;

export function installWebVideoGenDeps(deps: WebVideoGenRoutesDeps): void {
	webVideoGenDeps = deps;
}

export function getWebVideoGenDeps(): WebVideoGenRoutesDeps | null {
	return webVideoGenDeps;
}

export class WebVideoGenRoutes {
	constructor(private readonly deps: WebVideoGenRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!url.pathname.startsWith(BLOB_PREFIX)) return false;
		const method = request.method ?? "";
		if (method !== "GET" && method !== "HEAD") {
			sendError(response, 405, "webError.methodNotAllowed", "method not allowed");
			return true;
		}
		const absolute = this.resolve(url.pathname.slice(BLOB_PREFIX.length));
		const info = absolute ? await stat(absolute).catch(() => null) : null;
		if (!absolute || !info?.isFile()) {
			// 与 imagegen 同码：不区分「ref 非法」与「文件不存在」，避免当探测口
			sendError(response, 404, "webError.videoBlobNotFound", "video not found");
			return true;
		}
		const size = info.size;
		const range = parseSingleByteRange(request.headers.range, size);
		if (range === null) {
			response.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", ...WEB_CORS_HEADERS });
			response.end();
			return true;
		}
		response.writeHead(range ? 206 : 200, {
			"content-type": videoBlobMimeType(absolute),
			"accept-ranges": "bytes",
			// 内容寻址：ref 变则内容必变，可以放心长缓存
			"cache-control": "private, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"content-length": String(range ? range.end - range.start + 1 : size),
			...WEB_CORS_HEADERS,
			...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
		});
		if (method === "HEAD" || size === 0) {
			response.end();
			return true;
		}
		// 流式回传：视频动辄几十 MB，绝不整读进主进程内存。客户端拖进度/关页面导致的 EPIPE 无需处理。
		await pipeline(createReadStream(absolute, range ? { start: range.start, end: range.end } : undefined), response).catch(() => undefined);
		return true;
	}

	/** 路径段 → 绝对路径（解码失败、含分隔符、白名单不通过一律 null）。 */
	private resolve(rawSegment: string): string | null {
		let ref: string;
		try {
			ref = decodeURIComponent(rawSegment);
		} catch {
			return null;
		}
		if (!ref || ref.length > 200 || ref.includes("/") || ref.includes("\\")) return null;
		return this.deps.resolveBlobPath(ref);
	}
}
