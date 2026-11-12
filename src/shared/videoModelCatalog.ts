/**
 * 生视频模型能力目录（纯契约层，主进程 / 渲染层共用）。
 *
 * 为什么需要它：`resolution / aspect_ratio / seconds` 的合法域是**按模型**定的，
 * 不是按协议族定的。实测同一网关里 kling-video-v3 只认 720P/1080P/4K，而
 * minimax-video-h3 只认 768P/2K；给 minimax 发 1080P、给 kling 发 768P 都属于
 * 「上游不认识的值」（网关不校验，直接透传，结果由上游决定，可能直接失败）。
 * 因此 composer 切模型时必须按该模型的能力表纠正参数，而不是沿用上一个模型的默认值。
 *
 * 数据来源：`GET {baseUrl}/v1/videos/models`（OpenAI 风格视频网关的模型目录，
 * 如 wb2api 的 internal/server/video.go）。TokenDance 两族没有这个端点，能力表缺失
 * 时行为退回旧逻辑（按协议族预设，不纠正用户选择）。
 */

/** 单个视频模型的能力（只保留参数校验要用的字段）。 */
export type VideoModelCapability = {
	id: string;
	name?: string;
	/** 分辨率枚举（大写 P 形态，如 768P / 1080P）；空数组表示上游未声明 */
	resolutions: string[];
	defaultResolution?: string;
	/** 画幅枚举（16:9 / adaptive …）；空数组表示上游未声明 */
	aspectRatios: string[];
	defaultAspectRatio?: string;
	minSeconds?: number;
	maxSeconds?: number;
	defaultSeconds?: number;
};

/** composer 三个可选参数（undefined = 不传，由上游用模型默认值）。 */
export type VideoGenParamValues = { resolution?: string; duration?: string; ratio?: string };

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

function asPositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value);
}

/**
 * 解析 `GET /v1/videos/models` 响应 → 能力表。
 *
 * 容错优先：目录是上游能力的「提示」，不是必须完整的契约——缺字段就当作未声明
 * （调用方不纠正该维度），整条不可解析则丢弃该模型，绝不让一条脏数据让整个目录失效。
 */
export function parseVideoModelCatalog(payload: unknown): VideoModelCapability[] {
	if (typeof payload !== "object" || payload === null) return [];
	const data = Reflect.get(payload, "data");
	if (!Array.isArray(data)) return [];
	const out: VideoModelCapability[] = [];
	for (const row of data) {
		if (typeof row !== "object" || row === null) continue;
		const id = Reflect.get(row, "id");
		if (typeof id !== "string" || !id.trim()) continue;
		const videoGeneration = Reflect.get(row, "video_generation");
		const capabilities = typeof videoGeneration === "object" && videoGeneration !== null ? (videoGeneration as Record<string, unknown>) : {};
		const name = Reflect.get(row, "name");
		const resolutions = asStringList(capabilities.resolutions);
		const aspectRatios = asStringList(capabilities.aspectRatios);
		const defaultResolution = typeof capabilities.defaultResolution === "string" ? capabilities.defaultResolution.trim() : "";
		const defaultAspectRatio = typeof capabilities.defaultAspectRatio === "string" ? capabilities.defaultAspectRatio.trim() : "";
		out.push({
			id: id.trim(),
			...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
			resolutions,
			...(defaultResolution ? { defaultResolution } : {}),
			aspectRatios,
			...(defaultAspectRatio ? { defaultAspectRatio } : {}),
			...(asPositiveInt(capabilities.minSeconds) !== undefined ? { minSeconds: asPositiveInt(capabilities.minSeconds) } : {}),
			...(asPositiveInt(capabilities.maxSeconds) !== undefined ? { maxSeconds: asPositiveInt(capabilities.maxSeconds) } : {}),
			...(asPositiveInt(capabilities.defaultSeconds) !== undefined ? { defaultSeconds: asPositiveInt(capabilities.defaultSeconds) } : {}),
		});
	}
	return out;
}

/** 从能力表里挑一个模型的能力（没有则 undefined，调用方按「不纠正」处理）。 */
export function findVideoModelCapability(catalog: readonly VideoModelCapability[], modelId: string): VideoModelCapability | undefined {
	return catalog.find((item) => item.id === modelId);
}

/**
 * 按模型能力纠正参数。
 *
 * 规则（只纠正「用户明确选了一个值」的维度，undefined 表示「用上游默认」，一律不动）：
 * - 分辨率 / 画幅：不在枚举内 → 换成该模型的默认值，其次枚举首项；
 * - 时长：数字越界 → 夹到 [min,max]；非数字 → 原样保留（不猜用户意图）。
 *
 * 返回纠正后的参数与被改动的键，调用方据此提示/持久化。
 */
export function clampVideoGenParams(params: VideoGenParamValues, capability: VideoModelCapability | undefined): { params: VideoGenParamValues; changed: Array<keyof VideoGenParamValues> } {
	if (!capability) return { params, changed: [] };
	const next: VideoGenParamValues = { ...params };
	const changed: Array<keyof VideoGenParamValues> = [];

	if (next.resolution !== undefined && capability.resolutions.length > 0 && !capability.resolutions.includes(next.resolution)) {
		next.resolution = capability.defaultResolution && capability.resolutions.includes(capability.defaultResolution) ? capability.defaultResolution : capability.resolutions[0];
		changed.push("resolution");
	}
	if (next.ratio !== undefined && capability.aspectRatios.length > 0 && !capability.aspectRatios.includes(next.ratio)) {
		next.ratio = capability.defaultAspectRatio && capability.aspectRatios.includes(capability.defaultAspectRatio) ? capability.defaultAspectRatio : capability.aspectRatios[0];
		changed.push("ratio");
	}
	if (next.duration !== undefined) {
		const seconds = Number(next.duration.trim());
		if (Number.isFinite(seconds) && next.duration.trim() !== "") {
			const lower = capability.minSeconds;
			const upper = capability.maxSeconds;
			let clamped = Math.round(seconds);
			if (lower !== undefined) clamped = Math.max(lower, clamped);
			if (upper !== undefined) clamped = Math.min(upper, clamped);
			if (String(clamped) !== next.duration) {
				next.duration = String(clamped);
				changed.push("duration");
			}
		}
	}
	return { params: next, changed };
}
