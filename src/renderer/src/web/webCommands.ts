/**
 * Web 命令面板的纯函数（过滤 / 分组 / 键盘索引）。
 *
 * 组件只负责渲染与事件，这里保持无 React 依赖，便于单测覆盖「键盘可达」的核心语义：
 * - 空查询 = 全部命令（按分组顺序，组内保持调用方给的顺序）；
 * - 多词查询按 AND 语义逐词匹配标题/关键词（「打开 git」能命中「打开 Git 面板」）；
 * - 排序：标题前缀命中优先于仅包含命中，同档保持原顺序（不额外引入评分机制）。
 */

export type WebCommandGroup = "session" | "workspace" | "app";

export type WebCommand = {
	id: string;
	group: WebCommandGroup;
	/** 已本地化的展示标题 */
	title: string;
	/** 额外的检索词（英文名/别名，避免只靠中文标题匹配） */
	keywords?: string;
	/** 展示用快捷键提示（如 ⌘⇧P），不参与匹配 */
	shortcut?: string;
	run: () => void;
};

/** 分组顺序即展示顺序：会话 → 工作区 → 应用。 */
export const WEB_COMMAND_GROUP_ORDER: readonly WebCommandGroup[] = ["session", "workspace", "app"];

function haystack(command: WebCommand): string {
	return `${command.title} ${command.keywords ?? ""}`.toLowerCase();
}

/** 查询切词：空/纯空白返回空数组（= 不过滤）。 */
export function splitCommandQuery(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesWebCommand(command: WebCommand, terms: readonly string[]): boolean {
	if (terms.length === 0) return true;
	const text = haystack(command);
	return terms.every((term) => text.includes(term));
}

/** 过滤 + 稳定排序：标题以首词开头的结果排前。 */
export function filterWebCommands(commands: readonly WebCommand[], query: string): WebCommand[] {
	const terms = splitCommandQuery(query);
	if (terms.length === 0) return [...commands];
	const first = terms[0];
	const matched = commands.filter((command) => matchesWebCommand(command, terms));
	const prefix: WebCommand[] = [];
	const rest: WebCommand[] = [];
	for (const command of matched) {
		(command.title.toLowerCase().startsWith(first) ? prefix : rest).push(command);
	}
	return [...prefix, ...rest];
}

/**
 * 键盘索引移动（循环）；length=0 时返回 -1（无选中项）。
 * delta=+1 向下、-1 向上，Home/End 由调用方直接给目标下标。
 */
export function moveCommandIndex(index: number, delta: number, length: number): number {
	if (length <= 0) return -1;
	if (index < 0) return delta > 0 ? 0 : length - 1;
	return (index + delta + length) % length;
}

/** 按固定分组顺序拼成渲染用的分组列表（空分组不出现）。 */
export function groupWebCommands(commands: readonly WebCommand[]): Array<{ group: WebCommandGroup; commands: WebCommand[] }> {
	const groups: Array<{ group: WebCommandGroup; commands: WebCommand[] }> = [];
	for (const group of WEB_COMMAND_GROUP_ORDER) {
		const inGroup = commands.filter((command) => command.group === group);
		if (inGroup.length > 0) groups.push({ group, commands: inGroup });
	}
	return groups;
}

/** 扁平化后的命令顺序必须与分组渲染顺序一致：键盘上下移动按这个顺序走。 */
export function flattenGroupedCommands(groups: readonly { commands: WebCommand[] }[]): WebCommand[] {
	return groups.flatMap((entry) => entry.commands);
}
