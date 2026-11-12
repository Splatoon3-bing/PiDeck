/**
 * Web 端媒体模型目录投影（生图 / 生视频）。
 *
 * 为什么需要：这两类模型的配置与凭据都在各自独立文件（imagegen.json / videogen.json），
 * 不在 pi 的模型目录里，Web 端 `/api/models` 永远拿不到它们。桌面端选择器已把两类作为
 * 独立分类列出（见 renderer sessionPickerOptions 的 buildImageGenModelGroups），Web 端
 * 要对齐就必须有一条只读投影通道。
 *
 * 安全边界（与 WebImageGenRoutes 的 toWebImageGenConfig 同一口径，必须逐条守住）：
 * - **只给 id / name / models / referenceMode**：apiKey、baseUrl、extraParams、defaults、
 *   priceNote 一律不出现——Web 端不需要，发出去就是凭据泄漏面。
 * - 生视频只读：Web 端仍然不能提交视频任务（长任务 + 事件流不在 Web 开放），
 *   这里下发目录仅用于「让用户在列表里看到自己有哪些模型」，渲染层按只读展示。
 */
import type { ImageGenConfigFile, ImageGenReferenceMode } from "../../shared/imageGenConfig";
import type { VideoGenConfigFile } from "../../shared/videoGenConfig";

export type WebMediaImageProvider = { id: string; name: string; models: string[]; referenceMode: ImageGenReferenceMode };
export type WebMediaVideoProvider = { id: string; name: string; models: string[] };

export type WebMediaModels = {
	imageGen: { configured: boolean; providers: WebMediaImageProvider[]; activeProviderId: string; activeModel: string };
	videoGen: { configured: boolean; providers: WebMediaVideoProvider[]; activeProviderId: string; activeModel: string };
};

function cleanModels(models: unknown): string[] {
	if (!Array.isArray(models)) return [];
	const out: string[] = [];
	for (const raw of models) {
		const id = typeof raw === "string" ? raw.trim() : "";
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

export function toWebMediaModels(imageGen: ImageGenConfigFile, videoGen: VideoGenConfigFile): WebMediaModels {
	const imageProviders: WebMediaImageProvider[] = imageGen.providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		models: cleanModels(provider.models),
		referenceMode: provider.referenceMode ?? "none",
	}));
	const videoProviders: WebMediaVideoProvider[] = videoGen.providers.map((provider) => ({
		id: provider.id,
		name: provider.name,
		models: cleanModels(provider.models),
	}));
	return {
		imageGen: {
			// 只有「供应商 + 至少一个模型」才算可用（与生图路由同一判定）。
			configured: imageProviders.some((provider) => provider.models.length > 0),
			providers: imageProviders,
			activeProviderId: imageGen.activeProviderId,
			activeModel: imageGen.activeModel,
		},
		videoGen: {
			configured: videoProviders.some((provider) => provider.models.length > 0),
			providers: videoProviders,
			activeProviderId: videoGen.activeProviderId,
			activeModel: videoGen.activeModel,
		},
	};
}
