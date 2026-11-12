import type { TodoItem, TodoItemStatus } from "../agents/todo-list";

/** 与官方 BeUI TodoItem 对齐的解析结果（title 恒为 string）。 */
export type AgentTodoItem = TodoItem;

/**
 * 一个 todo 数据源的快照。
 *
 * `lines` 是渲染与 dismiss 指纹用的行式；`items` 是**已经结构化**的条目（DSH runtime
 * todos、历史快照、对账替换），给了就直接用，不再回绕行式 parser —— 否则正文里的
 * `1. `/`#3 ` 会被当成扩展生成的前缀剥掉，展示文本与原文分叉。
 */
export type AgentTodoWidget = { key: string; lines: readonly string[]; items?: readonly AgentTodoItem[] };

// 内置扩展（resources/extensions/pi-deck-todo.ts / pi-deck-plan-mode.ts）的 widget 行格式
// 是数据契约而非 UI 文案，解析侧硬编码这些字面量是合理的（不经过 i18n）。
/** 计划元数据由 pi-deck-todo 专用入口过滤；通用 parser 不解释它，避免影响第三方 widget。 */
const PI_DECK_TODO_PLAN_METADATA_LINE = /^\[\[pid:todo-plan:[^\]]+\]\]$/;
/** todo/plan 的摘要行不是列表项。 */
const SUMMARY_LINE = /^\d+\/\d+$/;
/** plan 扩展首行进度摘要（如 "计划进度 1/3"），不是列表项。 */
const PLAN_PROGRESS_LINE = /^计划进度\s*\d+\/\d+$/;
/** plan 扩展草案首行（如 "计划草案 3 步"），不是列表项。 */
const PLAN_DRAFT_LINE = /^计划草案\s*\d+\s*步$/;
/** 分组标题行（如 "── 待办 ──" / "── 已完成 ──"），仅作分组提示，不进入列表。 */
const SECTION_HEADER_LINE = /^── .+ ──$/;
/** 行首状态标记（扩展生成）：todo 用 ☐/☑/◐，plan 同款，兼容 [x]/[ ] 文本标记。 */
const MARKER_PREFIX = /^(?:☑|☐|◐|⏳|\[[ xX]\])\s*/;
/** 完成态标记：todo 扩展用 ☑，兼容 [x]/[X] 文本标记。 */
const COMPLETED_MARKER = /^(?:☑|\[[xX]\])/;
/** 进行中标记（扩展未输出，但类型支持；parser 保守支持以免未来扩展复用行式）。 */
const IN_PROGRESS_MARKER = /^(?:◐|⏳)/;

export function stripPiDeckTodoWidgetMetadata(lines: readonly string[]): string[] {
	return lines.filter((line) => !PI_DECK_TODO_PLAN_METADATA_LINE.test(line.trim()));
}

/**
 * 行首前导的剥离策略。
 *
 * 每一类 widget 的行都由**其生产者**拼成，前缀归属因此可以精确判定：
 * - `pi-deck-todo`：`☑ #id text`，前导是扩展自己的 `#id`；
 * - `pi-deck-plan-todos`：`☑ 1. text`，前导是扩展自己的步骤号；
 * - `dsh-todos` / `snapshot`：行由 PiDeck 自己从结构化数据生成（`☑ title`），
 *   前导只有状态标记 —— 标题里的 `1. `/`#1 ` 是用户正文，剥掉就是状态串味；
 * - 第三方 widget：行格式未知，沿用历史宽松口径（两种前缀都尝试剥离）。
 */
type PrefixPolicy = { stripTodoId: boolean; stripPlanNumbering: boolean };

const LOOSE_PREFIX_POLICY: PrefixPolicy = { stripTodoId: true, stripPlanNumbering: true };
const TODO_WIDGET_POLICY: PrefixPolicy = { stripTodoId: true, stripPlanNumbering: false };
const PLAN_WIDGET_POLICY: PrefixPolicy = { stripTodoId: false, stripPlanNumbering: true };
const VERBATIM_POLICY: PrefixPolicy = { stripTodoId: false, stripPlanNumbering: false };

function policyForWidgetKey(key: string): PrefixPolicy {
	if (key === "pi-deck-todo") return TODO_WIDGET_POLICY;
	if (key === "pi-deck-plan-todos") return PLAN_WIDGET_POLICY;
	if (key === "dsh-todos" || key === "snapshot") return VERBATIM_POLICY;
	return LOOSE_PREFIX_POLICY;
}

function stripGeneratedPrefixes(title: string, policy: PrefixPolicy): string {
	let result = title.replace(MARKER_PREFIX, "");
	if (policy.stripTodoId) result = result.replace(/^#\d+\s*/, "");
	if (policy.stripPlanNumbering) result = result.replace(/^\d+[.)]\s*/, "");
	return result.trim();
}

/**
 * 结构化条目 → 展示条目（DSH runtime todos / 历史快照共用）。
 *
 * 已带稳定 status 的数据不能绕回行文本 parser：否则标题正文里的 `1. `/`#1 `
 * 会被当成扩展生成的前缀剥掉（原文与展示文本分叉，dismiss 指纹也随之漂移）。
 * 重复正文追加出现序号，避免状态更新时 React 列表错误复用行节点。
 */
function structuredToItems(items: readonly { text: string; status: TodoItemStatus }[], idPrefix: string): AgentTodoItem[] {
	const occurrences = new Map<string, number>();
	const result: AgentTodoItem[] = [];
	for (const item of items) {
		const title = item.text.trim();
		if (!title) continue;
		const occurrence = (occurrences.get(title) ?? 0) + 1;
		occurrences.set(title, occurrence);
		result.push({
			id: `${idPrefix}${occurrence === 1 ? title : `${title}#${occurrence}`}`,
			title,
			status: item.status,
		});
	}
	return result;
}

function parseLines(lines: readonly string[], policy: PrefixPolicy, idPrefix: string): AgentTodoItem[] {
	const seenTitles = new Map<string, number>();
	const items: AgentTodoItem[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (SUMMARY_LINE.test(trimmed) || PLAN_PROGRESS_LINE.test(trimmed) || PLAN_DRAFT_LINE.test(trimmed)) continue;
		if (SECTION_HEADER_LINE.test(trimmed)) continue;

		const completed = COMPLETED_MARKER.test(trimmed);
		const active = IN_PROGRESS_MARKER.test(trimmed);
		const title = stripGeneratedPrefixes(trimmed, policy);
		// 只有标记没有正文的行（如 "☑"）不产生列表项
		if (!title) continue;

		const occurrence = (seenTitles.get(title) ?? 0) + 1;
		seenTitles.set(title, occurrence);
		const key = occurrence === 1 ? title : `${title}#${occurrence}`;
		items.push({
			id: `${idPrefix}${key}`,
			title,
			status: completed ? "completed" : active ? "in-progress" : "pending",
		});
	}
	return items;
}

/**
 * 将 pi 扩展的轻量 widget 行转换为官方 BeUI TodoItem 数据模型（宽松口径）。
 *
 * 规则：
 * - `pi-deck-todo` 的计划身份元数据必须先由 `stripPiDeckTodoWidgetMetadata` 过滤；
 *   该元数据只属于内置 widget 协议，通用 parser 不应误伤第三方 widget；
 * - 跳过空行、折叠摘要（"2/4" / "计划进度 1/3" / "计划草案 3 步"）、
 *   分组标题（"── 待办 ──"）——
 *   旧实现会把标题行误解析成 pending 项，这里按真实扩展格式修正；
 * - 状态映射：☑/[x]/[X] → completed，◐/⏳ → in-progress，其余（含 ☐）→ pending；
 * - 标题剥离标记与前缀：todo 的 "#3"、plan 的 "1." / "1)" 均不进标题，
 *   todo id 与 plan 步骤号信息保留在原行中（widget 快照可随时重建）；
 * - id 以清洗后的标题为基（同标题追加出现序号消歧）：状态切换 / 行增删时 key 稳定，
 *   官方 TodoList 的 strikethrough 与 layout 动画才能正确播放。
 *
 * 这是「不知道来源」时的宽松入口（第三方 widget / 契约测试）；知道来源的调用方
 * 应走 `parseTodoWidgetItems`，它会按生产者精确裁剪前缀，不会吃掉正文。
 */
export function parseAgentTodoItems(lines: readonly string[]): AgentTodoItem[] {
	return parseLines(lines, LOOSE_PREFIX_POLICY, "");
}

/**
 * 单个 widget 源 → 展示条目（按 key 選択前缀策略 + id 加来源前缀）。
 *
 * id 带 `${key}:` 前缀是必要的：`pi-deck-todo` 与 `pi-deck-plan-todos` 可能同时
 * 存在于同一会话，两个源里同名任务若共用 id，React 会把它们当成同一行 ——
 * 状态互相顶掉，看起来就是「完成了又没完成」。
 */
export function parseTodoWidgetItems(widget: AgentTodoWidget): AgentTodoItem[] {
	const lines = stripPiDeckTodoWidgetMetadata(widget.lines);
	return parseLines(lines, policyForWidgetKey(widget.key), `${widget.key}:`);
}

/**
 * 会话 todo 快照（pi-deck-todo custom 条目）→ TodoItem 列表。
 *
 * 直接走结构化转换：快照本来就有稳定三态字段，绕回 `☑ #id text` 行式再解析会
 * 把正文里的 `1. `/`#1 ` 当成扩展前缀剥掉（与活会话 widget 路径不同口径）。
 */
export function sessionTodoSnapshotToItems(snapshot: import("../../../../shared/types").SessionTodoSnapshot | undefined): AgentTodoItem[] {
	if (!snapshot) return [];
	return structuredToItems(
		snapshot.todos.map((todo) => ({
			text: todo.text,
			status: todo.status === "completed" ? "completed" : todo.status === "in_progress" ? "in-progress" : "pending",
		})),
		"",
	);
}

/**
 * 将 DSH runtime 的结构化 todo 投影适配为与 Pi widget 相同的展示模型。
 *
 * DSH 已提供稳定的状态字段，不能绕回行文本 parser；按正文生成稳定 key，
 * 并为重复正文追加序号，避免状态更新时 React 列表错误复用行节点。
 */
export function runtimeTodosToItems(todos: readonly import("../../../../shared/types").TodoItem[] | null | undefined): AgentTodoItem[] {
	if (!todos) return [];
	return structuredToItems(
		todos.map((todo) => ({
			text: todo.content,
			status: todo.status === "in_progress" ? "in-progress" : todo.status,
		})),
		"",
	);
}
