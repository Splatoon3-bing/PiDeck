/**
 * 媒体文件的类型判定（纯函数契约层，主进程 / Web 渲染层共用同一份表）。
 *
 * 为什么需要它：Web 端要把本地文件当媒体内联展示（`<img>` / `<video>` / `<audio>` /
 * PDF iframe），这条路必须由**服务端**给出 `Content-Type`——浏览器不猜字节类型，
 * 猜错就变成下载或空白。桌面端走自定义协议时也用同一份表，避免两套扩展名口径漂移。
 *
 * 边界：只做「扩展名 → MIME」与「展示大类」的最小事，不读文件头（magic byte 判定
 * 需要额外依赖，且媒体渲染只要 MIME 对得上即可）。
 */

/** 展示大类：决定渲染层用哪种标签（未知返回 null，仍按文本/二进制走原路径）。 */
export type MediaKind = "image" | "video" | "audio" | "pdf";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	// 图片
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
	ico: "image/x-icon",
	// 视频
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ogv: "video/ogg",
	// 音频
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	flac: "audio/flac",
	opus: "audio/ogg",
	// 文档
	pdf: "application/pdf",
};

const KIND_BY_MIME_PREFIX: ReadonlyArray<[string, MediaKind]> = [
	["image/", "image"],
	["video/", "video"],
	["audio/", "audio"],
];

/** 路径（`/` 或 `\` 分隔，可带 query/hash）→ 小写扩展名；没有扩展名返回空串。 */
export function extensionOfPath(path: string): string {
	const withoutSuffix = path.replace(/[?#].*$/, "");
	const leaf = withoutSuffix.slice(Math.max(withoutSuffix.lastIndexOf("/"), withoutSuffix.lastIndexOf("\\")) + 1);
	const dot = leaf.lastIndexOf(".");
	return dot < 0 ? "" : leaf.slice(dot + 1).toLowerCase();
}

/** 扩展名 → MIME；不认识返回 null（调用方按 `application/octet-stream` 处理）。 */
export function mediaMimeTypeByPath(path: string): string | null {
	const extension = extensionOfPath(path);
	return extension ? (MIME_BY_EXTENSION[extension] ?? null) : null;
}

/** MIME → 展示大类（`image/svg+xml` → image）；非媒体返回 null。 */
export function mediaKindOfMimeType(mimeType: string | null | undefined): MediaKind | null {
	if (!mimeType) return null;
	const normalized = mimeType.trim().toLowerCase();
	if (normalized === "application/pdf") return "pdf";
	for (const [prefix, kind] of KIND_BY_MIME_PREFIX) {
		if (normalized.startsWith(prefix)) return kind;
	}
	return null;
}

/** 路径 → 展示大类；未知返回 null。 */
export function mediaKindOfPath(path: string): MediaKind | null {
	return mediaKindOfMimeType(mediaMimeTypeByPath(path));
}
