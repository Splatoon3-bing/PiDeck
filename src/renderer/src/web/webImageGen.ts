/**
 * Web 生图客户端（T11 v1）。
 *
 * 边界：浏览器只提交 prompt / 参考图 / 尺寸等参数，供应商与凭据由主进程按配置解析；
 * 产物只回 `ref`，展示走内容寻址的 `/api/imagegen/blob/<ref>`（`<img>` 不能带 Authorization，
 * 因此 GET 用 `?token=`，与既有 SSE 同一套令牌链）。
 */
import { getWebToken, webImageBlobUrl } from "./webApi";

export { webImageBlobUrl };

export type WebImageGenProvider = { id: string; name: string; models: string[]; referenceMode: "none" | "edits" | "image-field" };
export type WebImageGenConfig = { configured: boolean; providers: WebImageGenProvider[]; activeProviderId: string; activeModel: string };

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const token = getWebToken();
	const response = await fetch(path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } });
	const payload = (await response.json().catch(() => null)) as (T & { code?: string; field?: string }) | null;
	if (!response.ok) throw Object.assign(new Error(payload?.code ?? `imagegen ${response.status}`), { code: payload?.code, field: payload?.field });
	return payload as T;
}

export function fetchWebImageGenConfig(): Promise<WebImageGenConfig> {
	return jsonRequest<WebImageGenConfig>("/api/imagegen/config");
}

/** 参考图为 data URL（composer 附件形态）→ 主进程要的 `{data, mimeType}`。 */
export function dataUrlToImageContent(dataUrl: string): { data: string; mimeType: string } | null {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
	if (!match) return null;
	return { mimeType: match[1], data: match[2] };
}

export function generateWebImage(input: { sessionId: string; prompt: string; referenceImages?: Array<{ data: string; mimeType: string }> }): Promise<{ ref: string; mimeType: string }> {
	return jsonRequest<{ ref: string; mimeType: string }>("/api/imagegen/generate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...input, ...(input.referenceImages?.length ? { referenceImages: input.referenceImages } : {}) }),
	});
}
