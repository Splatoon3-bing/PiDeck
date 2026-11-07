/**
 * Web 端会话标签（多标签工作台）的纯状态逻辑。
 *
 * 桌面端用 Jotai + 主进程持久化管理标签；Web 端不引入第二套全局状态，
 * 只维护一份 localStorage 快照。规则必须能离开 React 单测：
 * - 打开会话 = 追加标签（已存在不重复、超上限丢最旧）；
 * - 关闭标签 = 返回「下一个该激活的标签」（右邻优先，其次左邻，最后空）；
 * - 会话被外部删除时裁剪失效 id，但保留当前激活项（新建会话尚未进入 state 的窗口期）。
 */

const MAX_WEB_TABS = 20;
/** localStorage 键：与 webApi 的 token key 同域但语义独立。 */
export const WEB_TABS_STORAGE_KEY = "pideck-web-tabs";

/** 从 localStorage 原值解析标签 id：坏数据按空表处理，去重并截断上限。 */
export function parseStoredWebTabs(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "string" || !entry.trim() || seen.has(entry)) continue;
			seen.add(entry);
			ids.push(entry);
			if (ids.length >= MAX_WEB_TABS) break;
		}
		return ids;
	} catch {
		return [];
	}
}

/** 打开一个会话标签：已存在则保持原顺序，新增追加到末尾，超过上限丢最旧。 */
export function addWebTab(ids: readonly string[], sessionId: string): string[] {
	if (!sessionId) return [...ids];
	if (ids.includes(sessionId)) return [...ids];
	const next = [...ids, sessionId];
	return next.length > MAX_WEB_TABS ? next.slice(next.length - MAX_WEB_TABS) : next;
}

/**
 * 关闭标签并给出下一个应激活的会话：
 * - 关的不是当前会话 → 激活项不变；
 * - 关的是当前会话 → 右邻优先、其次左邻，没有剩余则空串。
 */
export function closeWebTab(ids: readonly string[], sessionId: string, activeSessionId: string): { ids: string[]; nextActiveId: string } {
	const index = ids.indexOf(sessionId);
	if (index < 0) return { ids: [...ids], nextActiveId: activeSessionId };
	const next = ids.filter((id) => id !== sessionId);
	if (activeSessionId !== sessionId) return { ids: next, nextActiveId: activeSessionId };
	// 关闭后原索引位置就是右邻；越界时取左邻。
	const nextActiveId = next[index] ?? next[index - 1] ?? "";
	return { ids: next, nextActiveId };
}

/**
 * 用已知会话集合裁剪标签：
 * - 失效 id 移除；
 * - keepId（当前激活）即使暂时不在集合里也保留——新建会话在 /api/state 回来之前
 *   只有路由状态，没有会话记录，提前裁剪会把刚打开的标签吞掉。
 */
export function pruneWebTabs(ids: readonly string[], knownSessionIds: ReadonlySet<string>, keepId: string): string[] {
	const next = ids.filter((id) => id === keepId || knownSessionIds.has(id));
	const unchanged = next.length === ids.length && next.every((id, index) => id === ids[index]);
	// 未变化时原样返回同一引用：轮询每次 setState 一个等价新数组会白白重渲染整棵标签栏。
	return unchanged ? (ids as string[]) : next;
}

/** 标签栏只在有两个及以上标签时出现：单标签时占掉一行只会压缩时间线。 */
export function shouldShowWebTabs(ids: readonly string[]): boolean {
	return ids.length > 1;
}

/** 标签标题兜底：空标题显示未命名（与侧栏同一口径，交给调用方传 i18n 文案）。 */
export function webTabTitle(title: string | undefined, untitled: string): string {
	const trimmed = title?.trim() ?? "";
	return trimmed || untitled;
}

export { MAX_WEB_TABS };
