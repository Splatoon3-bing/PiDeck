import type { AvailableModel, ModelListReport } from "../../../../shared/types";
import type { ImageGenConfigFile } from "../../../../shared/imageGenConfig";
import type { VideoGenConfigFile } from "../../../../shared/videoGenConfig";
// 下拉列表排序键与配置页 / 落盘顺序共用 shared 比较器（避免两边秩不一致）。
import { compareModelRows } from "../../../../shared/modelOrder";
import { resolveModelDisplayName } from "../../../../shared/modelDisplayName";
import { buildProviderRank } from "../../utils/providerOrder";
import type { TranslationKey } from "../../i18n";

/** Shared thinking options used by both the composer picker and the first-session setup. */
export const THINKING_LEVELS = [
	{ value: "off", labelKey: "thinking.levelLabel.off", descriptionKey: "thinking.level.off" },
	{ value: "minimal", labelKey: "thinking.levelLabel.minimal", descriptionKey: "thinking.level.minimal" },
	{ value: "low", labelKey: "thinking.levelLabel.low", descriptionKey: "thinking.level.low" },
	{ value: "medium", labelKey: "thinking.levelLabel.medium", descriptionKey: "thinking.level.medium" },
	{ value: "high", labelKey: "thinking.levelLabel.high", descriptionKey: "thinking.level.high" },
	{ value: "xhigh", labelKey: "thinking.levelLabel.xhigh", descriptionKey: "thinking.level.xhigh" },
	{ value: "max", labelKey: "thinking.levelLabel.max", descriptionKey: "thinking.level.max" },
] satisfies Array<{ value: string; labelKey: TranslationKey; descriptionKey: TranslationKey }>;

export type ThinkingPickerLevel = {
	value: string;
	labelKey?: TranslationKey;
	descriptionKey?: TranslationKey;
	label?: string;
	description?: string;
};

/** Map Pi/DSH wire level ids to localized options without dropping future ids. */
export function toThinkingPickerLevels(levels: readonly string[]): ThinkingPickerLevel[] {
	const seen = new Set<string>();
	const options: ThinkingPickerLevel[] = [];
	for (const value of levels) {
		const normalized = value.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		const known = THINKING_LEVELS.find((level) => level.value === normalized);
		if (known) {
			options.push({
				value: known.value,
				labelKey: known.labelKey,
				descriptionKey: known.descriptionKey,
			});
		} else {
			options.push({ value: normalized, label: normalized });
		}
	}
	return options;
}

/**
 * Resolve selectable thinking levels without making menu availability depend on an
 * asynchronous capability probe. 统一标准：capability cache 是唯一展示源，runtime
 * RPC 仅在 cache 未覆盖该模型时兑底（其值只会来自 idle + cache-miss 的后台探测）；
 * 两者同时存在时（cache 后来才刷新）以 cache 为准。缺失 DSH 元数据与 Pi probe
 * 不可用都属兼容 fallback：后端始终是最终能力裁决者。
 */
export function resolveThinkingPickerLevels(input: { backend: "pi" | "dsh"; runtimePiLevels?: readonly string[]; cachedPiLevels?: readonly string[]; dshReasoningEfforts?: ReadonlyArray<{ id: string }> }): ThinkingPickerLevel[] {
	if (input.backend === "dsh") {
		const declaredLevels = toThinkingPickerLevels(input.dshReasoningEfforts?.map((effort) => effort.id) ?? []);
		return declaredLevels.length > 0 ? declaredLevels : [...THINKING_LEVELS];
	}
	if (input.cachedPiLevels !== undefined) {
		return toThinkingPickerLevels(input.cachedPiLevels);
	}
	if (input.runtimePiLevels !== undefined) {
		return toThinkingPickerLevels(input.runtimePiLevels);
	}
	return [...THINKING_LEVELS];
}

/** Keep provider grouping deterministic so the same model order appears in both pickers. */
export function groupModelsByProvider(models: AvailableModel[]) {
	const groups = models.reduce<Record<string, AvailableModel[]>>((result, model) => {
		const provider = model.provider || "other";
		(result[provider] ??= []).push(model);
		return result;
	}, {});

	for (const providerModels of Object.values(groups)) {
		providerModels.sort(compareModelRows);
	}
	return groups;
}

/**
 * 模型选择器供应商分组排序权重：内置置顶供应商的固定顺序。
 * 未出现在 recentProviders（最近使用）里的分组按此顺序 + 字母序排；
 * 'other' 是白名单外供应商的兜底组，始终最后。
 */
export const PROVIDER_ORDER = ["tokendance", "anthropic", "openai", "google", "deepseek", "other"];

/**
 * 对供应商分组 key 排序：
 * 1) 用户在模型页自定义过顺序的（providerOrder）严格按该顺序，且整体排在最前——
 *    这是显式偏好，不再被「最近使用」覆盖（未自定义过顺序的供应商仍走旧策略）；
 * 2) 未自定义过顺序的：最近使用过的（recentProviders，最新在前）排前，让高频供应商免搜索直达；
 * 3) 仍未命中的按内置置顶顺序（PROVIDER_ORDER）+ 字母序；
 * 4) 'other' 兜底组恒最后，避免未知供应商混进常用区。
 * 纯函数便于单测：排序策略离开 React 也能验证。
 */
export function orderProviderGroups(providers: string[], recentProviders?: string[], providerOrder?: string[]): string[] {
	const customRank = buildProviderRank(providerOrder);
	const recent = recentProviders ?? [];
	const recentIndex = new Map<string, number>();
	recent.forEach((provider, index) => {
		if (!recentIndex.has(provider)) recentIndex.set(provider, index);
	});
	return [...providers].sort((a, b) => {
		// other 恒最后：不受最近使用影响（它是白名单外兜底，不是用户选的供应商）。
		if (a === "other") return 1;
		if (b === "other") return -1;
		const aCustom = customRank.get(a);
		const bCustom = customRank.get(b);
		if (aCustom !== undefined && bCustom !== undefined) return aCustom - bCustom;
		if (aCustom !== undefined) return -1;
		if (bCustom !== undefined) return 1;
		const aRecent = recentIndex.get(a);
		const bRecent = recentIndex.get(b);
		if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent;
		if (aRecent !== undefined) return -1;
		if (bRecent !== undefined) return 1;
		const aIndex = PROVIDER_ORDER.indexOf(a);
		const bIndex = PROVIDER_ORDER.indexOf(b);
		if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;
		return a.localeCompare(b);
	});
}

/**
 * 模型选择器行内展示名：用户在「模型」页配置的 name（渠道别名、中文名很常见）——
 * 提供商返回的 id 可能又长又乱，用自定义名称映射更好认；缺失或仅含空白时回退 id。
 */
export function modelRowName(model: { id: string; name?: string }): string {
	return resolveModelDisplayName(model.name, model.id);
}

/**
 * 模型行身份（第二行）：`provider · id`。
 *
 * 名称（name）是渠道别名，可能重复：本机 models.json 里 `cn:hy4free` 与 `cn:hy4std` 的 name
 * 都是「Hy4」，`cn:hy3` 与 `cn:hy3-x` 都是「Hy3」。旧行文案只有 `provider/名称`，于是两行
 * 长得一模一样、id 只藏在 tooltip 里——用户搜到的那行仍显示别名，结论是「我要的模型没有」。
 * 因此 id 必须进正文：名称给可读性，id 给唯一身份。
 */
export function modelRowIdentity(model: { id: string; provider: string }): string {
	return `${model.provider} · ${model.id}`;
}

/**
 * 思考档位的规范顺序（与 pi-ai 的 clampThinkingLevel 同源）：只用于挑「最高档」，
 * 不参与展示顺序——展示顺序仍由后端返回的 levels 决定。
 */
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 一组档位里的最高档：规范顺序里有的一律按序取最大，未知档位（后端新增）按出现顺序兜底。 */
export function highestThinkingLevel(levels: readonly string[]): string {
	let best: string | undefined;
	let bestRank = -1;
	for (const level of levels) {
		const normalized = level.trim();
		if (!normalized || normalized === "off") continue;
		const rank = (THINKING_LEVEL_ORDER as readonly string[]).indexOf(normalized);
		// 未知档位（rank=-1）不覆盖已知档位，但整体没有已知档位时用它兜底。
		if (rank > bestRank) {
			best = normalized;
			bestRank = rank;
		}
	}
	return best ?? "off";
}

/**
 * 模型思考能力的展示口径（纯函数，可单测）：
 * - unsupported：后端明确只接受 off（或 --list-models 的 thinking 列为 no）——模型没有思考能力；
 * - supported：后端给出权威档位，maxLevel 是其中最高的一档（如 high / max）；
 * - unknown：能力尚未探测（旧 pi / probe 未就绪）——既不能说支持也不能说不支持，
 *   调用方保持旧行为（全量档位回退），不能凭空宣称「不支持」。
 */
export type ModelThinkingSupport = { kind: "unknown" } | { kind: "unsupported" } | { kind: "supported"; maxLevel: string };

export function resolveModelThinkingSupport(model: { reasoning?: boolean; thinkingLevels?: readonly string[] }): ModelThinkingSupport {
	const levels = model.thinkingLevels;
	if (levels !== undefined) {
		const maxLevel = highestThinkingLevel(levels);
		return maxLevel === "off" ? { kind: "unsupported" } : { kind: "supported", maxLevel };
	}
	if (model.reasoning === false) return { kind: "unsupported" };
	return { kind: "unknown" };
}

/**
 * 生图 / 生视频模型的分类视图（纯函数，可单测）。
 *
 * 为什么不在同一个目录里：这两类模型的配置与凭据完全独立（imagegen.json / videogen.json），
 * 不在 pi 的模型目录里，也不接受 set_model。选择器把它们作为**独立分类**列出来（按供应商分组），
 * 选中即切到对应模式——让用户在一个地方看全「我能用的模型」，而不是靠记模式再去找。
 *
 * 能力标注只写配置里确有的事实：
 * - 生图模型恒为文生图，生视频模型恒为文生视频（一期没有参考素材）；
 * - 「能接参考图」是**供应商级**声明（referenceMode，见 shared/imageGenConfig）：同一网关下
 *   可能只有带 -edit 的模型真能改图（实测 hunyuan-image-alpha 收 edits 请求直接 4xx），
 *   因此不能在每一行上都打「改图」——那会把用户引到会失败的组合上。放到分组标题提示。
 */
export type MediaModelCapability = "textToImage" | "textToVideo";

export type MediaModelGroup = {
	/** 分组 id：与语言模型的 `provider:<名称>` 隔离命名空间，避免同名供应商撞组。 */
	id: string;
	providerId: string;
	providerLabel: string;
	models: Array<{ id: string; capabilities: MediaModelCapability[] }>;
	/** 供应商声明了参考图输入方式（edits / image-field）：分组提示「可带参考图」，不声称每个模型都行。 */
	supportsReferenceImage?: boolean;
};

function uniqModelIds(models: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of models) {
		const id = typeof raw === "string" ? raw.trim() : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

export function buildImageGenModelGroups(config: Pick<ImageGenConfigFile, "providers"> | undefined): MediaModelGroup[] {
	if (!config) return [];
	const groups: MediaModelGroup[] = [];
	for (const provider of config.providers) {
		const models = uniqModelIds(provider.models ?? []);
		if (models.length === 0) continue;
		groups.push({
			id: `imagegen:${provider.id}`,
			providerId: provider.id,
			providerLabel: provider.name?.trim() || provider.id,
			models: models.map((id) => ({ id, capabilities: ["textToImage"] })),
			...(provider.referenceMode && provider.referenceMode !== "none" ? { supportsReferenceImage: true } : {}),
		});
	}
	return groups;
}

export function buildVideoGenModelGroups(config: Pick<VideoGenConfigFile, "providers"> | undefined): MediaModelGroup[] {
	if (!config) return [];
	const groups: MediaModelGroup[] = [];
	for (const provider of config.providers) {
		const models = uniqModelIds(provider.models ?? []);
		if (models.length === 0) continue;
		groups.push({
			id: `videogen:${provider.id}`,
			providerId: provider.id,
			providerLabel: provider.name?.trim() || provider.id,
			models: models.map((id) => ({ id, capabilities: ["textToVideo"] })),
		});
	}
	return groups;
}

/**
 * 模型选择器搜索过滤：子串精确匹配（替代 cmdk 内置 fuzzy）。
 *
 * 为什么不用默认 fuzzy：cmdk 1.1 的 command-score 对「任意子序列」都返回 >0 即显示，
 * 而每个模型的 keywords 都含供应商名（如 tokendance），1-2 字符搜索词（de/en/an 等）
 * 会命中全部模型——表现为「搜索了但 tokendance 没被过滤」。子串匹配下：
 * - 搜 "deepseek" 只显示 id/name 含 deepseek 的模型（不再误匹配 claude/glm 等子序列）；
 * - 分隔符归一化保留容错："gpt4o" / "gpt-4o" / "gpt 4o" 互相命中；
 * - 搜供应商名（如 tokendance）仍命中该供应商全部模型（value=provider/id 参与匹配）。
 * 返回 cmdk filter 约定分数：1 = 命中，0 = 不显示。
 */
export function modelPickerSearchFilter(value: string, search: string, keywords: string[] | undefined): number {
	const query = search.trim().toLowerCase();
	if (!query) return 1;
	// 只保留字母/数字/中文，去掉 - _ . / 空格等分隔符：模型 ID 常见 "gpt-4o"
	// 形式，用户输入 "gpt4o" 也应命中；中文模型名（如「通义千问」）原样保留。
	const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
	const haystack = normalize(`${value} ${(keywords ?? []).join(" ")}`);
	return haystack.includes(normalize(query)) ? 1 : 0;
}

/**
 * 模型选择器主体状态判定（纯函数，可单测）：loading / guide / list。
 *
 * 背景：首屏加载期间 models=[] 且 report=null，旧实现两个分支都不命中，面板渲染空白，
 * 用户看到「选择器是空的」而不知道在加载。这里把「还没拿到任何报告」明确判成 loading。
 *
 * - 有模型 → list（即便仍在刷新，也先展示旧列表，避免闪空）；
 * - 无模型且已有报告 → guide（失败原因引导 / 空态引导，调用方据 report 渲染文案）；
 * - 无模型且未接入 report（调用方不传，如设置页视觉模型选择器）→ list，保持旧行为；
 * - 无模型、report 为 null 且正在加载 → loading。
 */
export function resolveModelPickerBody(input: { modelCount: number; report?: ModelListReport | null; loading?: boolean }): "loading" | "guide" | "list" {
	if (input.modelCount > 0) return "list";
	if (input.report) return "guide";
	// report 为 undefined = 调用方未接入报告通道，不能把永久空态伪装成加载中。
	if (input.report === undefined) return "list";
	return input.loading ? "loading" : "list";
}

/**
 * 模型选择器初始展开规则（「当前选中模型可见」驱动）：打开时只保证当前模型所在分组可见，
 * 其余提供商分组全部折叠。
 *
 * 1) 当前模型在收藏栏 → 仅展开收藏栏；
 * 2) 当前模型在某个提供商分组 → 展开收藏栏 + 该提供商分组（面板据此滚动定位到选中项）；
 * 3) 收藏为 0 → 展开当前模型所在提供商；无当前模型/当前提供商不在列表时，展开第一个提供商兜底，避免空列表。
 *
 * 返回需要初始展开的分组 id：收藏栏固定为 "favorites"，提供商分组为 "provider:<provider>"。
 */
export function computeModelPickerDefaultExpanded(params: {
	/** 已按收藏栏展示顺序排列的收藏模型（仅目录内存在的） */
	favorites: Array<{ provider: string; id: string }>;
	/** 当前选中模型（无选中时省略，如欢迎页草稿期） */
	current?: { provider?: string; modelId?: string };
	/** 排序后的提供商 key 列表（与选择器分组顺序一致） */
	providers: string[];
	/** 调用方要求全展开：收藏栏与所有提供商分组都展开（外部连接设置等「翻找某个模型」的场景）。 */
	expandAll?: boolean;
}): string[] {
	const { favorites, current, providers } = params;
	const expanded: string[] = [];
	if (favorites.length > 0) expanded.push("favorites");

	// 全展开场景：不按「当前选中模型可见」收敛——这里是「自己挑一个模型加入列表」，
	// 用户需要直接看到所有供应商的模型，而不是先展开第一个供应商再逐个点开。
	if (params.expandAll) return [...expanded, ...providers.map((provider) => `provider:${provider}`)];

	const currentProvider = current?.provider?.trim();
	const currentModelId = current?.modelId?.trim();
	const currentKey = currentProvider && currentModelId ? `${currentProvider}/${currentModelId}` : undefined;
	const currentInFavorites = currentKey ? favorites.some((model) => `${model.provider}/${model.id}` === currentKey) : false;
	// 当前模型不在收藏栏：展开其所在提供商分组，保证打开时能看到选中项（面板会滚动定位）。
	if (currentKey && !currentInFavorites && currentProvider && providers.includes(currentProvider)) {
		expanded.push(`provider:${currentProvider}`);
	}
	// 兜底：无任何可见分组时（收藏为 0 且无当前模型 / 当前提供商不在列表），
	// 展开第一个提供商，避免打开即空列表。
	if (expanded.length === 0 && providers[0]) {
		expanded.push(`provider:${providers[0]}`);
	}
	return expanded;
}
