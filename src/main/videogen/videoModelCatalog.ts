/**
 * 生视频模型目录拉取（主进程，唯一联网点）。
 *
 * 只服务 OpenAI 风格视频网关（`openai-videos` 协议族）：它提供
 * `GET {baseUrl}/v1/videos/models`。TokenDance 两族没有目录端点，调用方直接返回
 * 空数组（composer 退回协议族预设，不纠正参数）。
 *
 * 边界：这里只做「一次 GET + 解析」，不缓存、不重试——模型目录是 UI 提示，
 * 拉取失败不该影响发送；渲染层按 providerId 会话内缓存一次即可。
 */
import { parseVideoModelCatalog, type VideoModelCapability } from "../../shared/videoModelCatalog";
import type { VideoGenProtocolFamily } from "../../shared/videoGenConfig";

/** 目录拉取超时：目录很小，5s 足够；卡住时不能让设置页/底栏干等。 */
const CATALOG_TIMEOUT_MS = 5000;

export type VideoModelCatalogResult = { ok: true; models: VideoModelCapability[] } | { ok: false; error: "unsupported" | "notConfigured" | "network" | "http" };

export async function fetchVideoModelCatalog(input: { protocol: VideoGenProtocolFamily; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<VideoModelCatalogResult> {
	if (input.protocol !== "openai-videos") return { ok: false, error: "unsupported" };
	const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
	const apiKey = input.apiKey.trim();
	if (!baseUrl || !apiKey) return { ok: false, error: "notConfigured" };
	const doFetch = input.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await doFetch(`${baseUrl}/v1/videos/models`, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(input.timeoutMs ?? CATALOG_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, error: "network" };
	}
	if (!response.ok) return { ok: false, error: "http" };
	const payload = await response.json().catch(() => null);
	const models = parseVideoModelCatalog(payload);
	// 空目录按「上游没声明能力」处理：不能把它当成错误弹窗（有些网关确实不返回该端点数据）
	return { ok: true, models };
}
