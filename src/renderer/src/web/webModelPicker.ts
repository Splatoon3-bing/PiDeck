/**
 * Web 模型选择器的纯逻辑：行分组、能力徽标、最近使用。
 *
 * 抽出来的原因（对齐「纯策略可单测」）：模型选择器是 Web 端使用频率最高的弹层，
 * 分组顺序、最近使用去重、能力判定都属产品规则，不写在 JSX 里。
 */
import type { AvailableModel } from "../../../shared/types";

export type WebModelKey = string;

/** 模型唯一键：provider 与 id 都参与（不同供应商可能有同名模型）。 */
export function modelKey(model: Pick<AvailableModel, "provider" | "id">): WebModelKey {
	return `${model.provider}::${model.id}`;
}

/** 最近使用上限：够覆盖常见 2–3 个主力模型，又不至于把列表压到看不见其他分组。 */
export const RECENT_MODEL_LIMIT = 5;

export type ModelCapabilityChip = {
	kind: "reasoning" | "vision";
	label: string;
};

/** 上下文窗口的紧凑写法：200000 → "200K"，1000000 → "1M"，缺失返回 undefined。 */
export function formatContextWindow(tokens: number | undefined): string | undefined {
	if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return undefined;
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
	return String(tokens);
}

/**
 * 能力徽标（带语义色，颜色在视图层按 kind 取 token）。
 * - 推理：pi 明确声明 reasoning，或探针给出了可用思考档位；
 * - 视觉：images 列为 true，或 input 模态里含 image。
 * 判定只认后端上报，不按模型名猜测（改名/代理供应商时猜错比不显示更糟）。
 */
export function modelCapabilityChips(model: AvailableModel, labels: { reasoning: string; vision: string }): ModelCapabilityChip[] {
	const chips: ModelCapabilityChip[] = [];
	const reasoning = model.reasoning === true || (model.thinkingLevels?.length ?? 0) > 0;
	if (reasoning) chips.push({ kind: "reasoning", label: labels.reasoning });
	const vision = model.images === true || model.input?.includes("image") === true;
	if (vision) chips.push({ kind: "vision", label: labels.vision });
	return chips;
}

export type WebModelGroup = { key: string; label: string; models: AvailableModel[] };

/**
 * 弹层分组顺序：最近使用（首项强制为当前模型）→ 各供应商（保持目录顺序）。
 * 当前模型不在最近使用里也要出现在最上方：用户打开弹层第一件事是「确认现在是谁」，
 * 让它必须滚动才能看到等于没做置顶。
 */
export function buildModelGroups(models: AvailableModel[], recentKeys: readonly WebModelKey[], currentKey: string | null, recentLabel: string): WebModelGroup[] {
	const byKey = new Map(models.map((model) => [modelKey(model), model]));
	const recentOrder: WebModelKey[] = [];
	if (currentKey && byKey.has(currentKey)) recentOrder.push(currentKey);
	for (const key of recentKeys) {
		if (recentOrder.length >= RECENT_MODEL_LIMIT) break;
		if (key === currentKey || !byKey.has(key) || recentOrder.includes(key)) continue;
		recentOrder.push(key);
	}
	const groups: WebModelGroup[] = [];
	if (recentOrder.length > 0) {
		groups.push({ key: "recent", label: recentLabel, models: recentOrder.map((key) => byKey.get(key)!).filter(Boolean) });
	}
	const byProvider = new Map<string, AvailableModel[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider);
		if (list) list.push(model);
		else byProvider.set(model.provider, [model]);
	}
	for (const [provider, list] of byProvider) groups.push({ key: `provider:${provider}`, label: provider, models: list });
	return groups;
}

/** 最近使用列表推进一位（去重、置顶、截断），返回新数组，不改入参。 */
export function pushRecentModel(list: readonly WebModelKey[], key: WebModelKey, limit = RECENT_MODEL_LIMIT): WebModelKey[] {
	return [key, ...list.filter((item) => item !== key)].slice(0, limit);
}

/** 最近使用的存储键：仅 Web 端本地偏好，不参与设置同步。 */
export const RECENT_MODELS_STORAGE_KEY = "pideck:web-recent-models";

/** 最小存储面：便于单测传入假 storage，也避免直接依赖 window。 */
export type RecentModelStorage = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
};

/** 读最近使用；损坏/越权数据一律当作空列表（localStorage 可能被用户或旧版本写坏）。 */
export function readRecentModels(storage: RecentModelStorage | undefined): WebModelKey[] {
	if (!storage) return [];
	try {
		const raw = storage.getItem(RECENT_MODELS_STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && item.includes("::")).slice(0, RECENT_MODEL_LIMIT);
	} catch {
		return [];
	}
}

/** 写最近使用；存储不可用（隐私模式/配额满）时静默失败，不影响选择模型。 */
export function writeRecentModels(storage: RecentModelStorage | undefined, keys: readonly WebModelKey[]): void {
	if (!storage) return;
	try {
		storage.setItem(RECENT_MODELS_STORAGE_KEY, JSON.stringify(keys.slice(0, RECENT_MODEL_LIMIT)));
	} catch {
		/* 存不下就算了，功能降级为不记忆 */
	}
}
