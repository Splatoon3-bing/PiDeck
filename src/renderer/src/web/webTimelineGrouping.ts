/**
 * webTimelineGrouping — Web 时间线分组纯函数（叶子模块，无 React 依赖，vm 沙箱可单测）。
 *
 * 桌面端对应物：groupAgentRuns + buildTurnDisplay（SessionRecord → run → 段落聚合）。
 * Web 端数据源是 AI SDK UIMessage 扁平数组，这里把它聚合成「用户气泡 / 助手回合」交替序列，
 * 提升规则与桌面 buildTurnDisplay 逐条对齐（差异仅在数据形状，语义相同）。
 */
import type { UIMessage } from "ai";

export type WebToolPart = {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
};

/** 回合内一段过程内容：合并后的思考块 / 工具调用 / 中间回复。思考块 running 取块内最后一个 reasoning part 的流式状态（AI SDK state 字段），不再用整轮流式标志。 */
export type TurnSegment = { kind: "thinking"; id: string; texts: string[]; running?: boolean } | { kind: "tool"; id: string; part: WebToolPart } | { kind: "interim"; id: string; text: string };

/**
 * 回合内的媒体产物（图片/视频/音频）。
 *
 * 生图（imagegen）与生视频（videogen）的 assistant 消息正文是空串，产物在
 * `images` / `videos` 字段 —— chatMessagesToUiMessages 会把它们映射成 AI SDK 的
 * `file` part。若不在这里收成独立段，整条消息在 Web 时间线里就是「什么都没有」
 * （用户看到的正是「生图没渲染」）。
 */
export type MediaSegment = {
	kind: "media";
	id: string;
	/** 可直接放进 <img>/<video>/<audio> 的地址（data URL 或带令牌的 HTTP URL） */
	src: string;
	/** MIME（`image/png` / `video/mp4` …），决定用哪种标签渲染 */
	mediaType: string;
	/** 无障碍文案：alt 或文件名 */
	alt?: string;
};

/** 回合内段的联合类型（过程段 + 媒体段）。 */
export type TimelineSegment = TurnSegment | MediaSegment;

/** 一轮助手回合：用户消息之后的连续 assistant 消息聚合（对齐桌面 run 语义）。 */
export interface AssistantTurn {
	/** 回合内首条消息 id（容器 key/锚点） */
	id: string;
	/** 回合内全部消息 id（含首条；锚点补偿用） */
	messageIds: string[];
	/** 过程内容（不含常驻正文）+ 媒体产物，按原始顺序 */
	segments: TimelineSegment[];
	/** 最后一段非空正文：常驻折叠容器外；仅在回合结束后提升（见 groupTimelineEntries） */
	finalText: string;
	/** 流式中的末段正文段 id：挂折叠容器外常显（打字机），不提升为 finalText。
	 * 对齐桌面 buildTurnDisplay 的 liveInterimId 语义（末条 Live 正文挂在折叠容器外）。 */
	liveTextId?: string;
	toolCount: number;
	/** 思考段数（合并后块内 texts 总数，对齐桌面「N 次思考」） */
	thinkingCount: number;
	/** 中间回复段数（不含 final） */
	interimCount: number;
}

export type TimelineEntry = { kind: "user"; id: string; message: UIMessage } | { kind: "turn"; id: string; turn: AssistantTurn };

/** AI SDK `file` part 的最小子集（data URL 或 URL 两种形态）。 */
export type WebFilePart = { type: "file"; mediaType?: string; data?: string; url?: string; filename?: string };

/** data URL 的 MIME（`data:image/png;base64,…` → `image/png`）。 */
function mediaTypeOfDataUrl(url: string): string | undefined {
	const match = /^data:([^;,]+)[;,]/.exec(url);
	return match?.[1]?.toLowerCase();
}

/**
 * `file` part → 媒体段；不是媒体或拿不到地址时返回 null（保持原行为，不锻造空 src）。
 *
 * 地址优先级与 webMessageParts.uiMessageImages 一致：`data`（data URL）优先于 `url`。
 * 生图/生视频历史里 `url` 是带令牌的 blob 路由（`/api/imagegen/blob/<ref>?token=…`），
 * `<img>`/`<video>` 不能带 Authorization，所以令牌必须已经拼在地址里。
 */
export function mediaSegmentFromFilePart(part: WebFilePart, id: string): MediaSegment | null {
	const src = typeof part.data === "string" && part.data ? part.data : typeof part.url === "string" ? part.url : "";
	if (!src) return null;
	const mediaType = (part.mediaType || mediaTypeOfDataUrl(src) || "").toLowerCase();
	// 只接住媒体：其它 file part（附件/文档）继续走原有渲染，不在时间线里硬塞
	if (!/^(image|video|audio)\//.test(mediaType)) return null;
	return { kind: "media", id, src, mediaType, ...(part.filename ? { alt: part.filename } : {}) };
}

/**
 * 把扁平 messages 聚合成「用户气泡 / 助手回合」交替序列（桌面 groupToolMessages +
 * buildTurnDisplay 的 Web 版，提升规则与其逐条对齐）。
 *
 * - 连续 assistant 消息归为一个回合，跨消息的连续 reasoning part 合并成同一思考块
 *   （修复：一轮里被拆成多个思考卡片）；
 * - 最终回答：仅当「回合已完成（!isStreaming）且末段是正文」时才提升为 finalText
 *   常驻折叠容器外——桌面同款门控（buildTurnDisplay 的 isRunTail && stop==="stop"，
 *   流式中不提升）。旧版把流式中的末段正文直接当 finalText，工具回合继续后它被降回
 *   过程组，造成「先看到中间回复、过程组才出现在其上方」的跳动；
 * - 流式中（isStreaming 的末尾回合）：末段正文不提升，改记 liveTextId 挂在折叠
 *   容器外常显（桌面 liveInterimId 同款）：打字机可见；工具在其后开跑时末段变工具，
 *   liveTextId 清空、正文落回容器内（容器流式中自动展开，视觉上只是从容器下方
 *   移到容器内末尾，不再有提升/降级跳动）；
 * - 末段是工具/思考（非正文）时：无论是否流式都不提升——全部正文都是中间回复
 *   （对齐桌面「工具回合中阶段性文本不具备最终回答资格」）；
 * - 纯函数，行为由 tests/webTimelineGrouping.test.mjs 锁定。
 */
export function groupTimelineEntries(messages: UIMessage[], options: { isStreaming?: boolean } = {}): TimelineEntry[] {
	const isStreaming = options.isStreaming === true;
	const entries: TimelineEntry[] = [];
	let messageIds: string[] = [];
	let segments: TimelineSegment[] = [];
	let finalText = "";
	let finalId = "";
	let liveTextId: string | undefined;
	let turnId = "";
	/** 回合收口。complete：用户消息断开（必完整）或末尾回合且已结束（!isStreaming）。 */
	const flush = (complete: boolean) => {
		if (!turnId) return;
		// 媒体段不参与「末段」判定：生图/生视频回合往往以产物结尾（正文为空），
		// 若拿媒体当末段，产物之前的正文会被降级成中间回复（收进折叠容器）。
		const tail = segments.filter((segment) => segment.kind !== "media").at(-1);
		if (complete) {
			// 回合结束：仅末段是正文时提升为最终回答（对齐桌面 isRunTail 判定）
			if (tail && tail.kind === "interim") {
				finalText = tail.text;
				finalId = tail.id;
			}
		} else {
			// 流式中：不提升；末段正文挂容器外常显（打字机）
			liveTextId = tail && tail.kind === "interim" ? tail.id : undefined;
		}
		// 提升的 final 段从过程组剔除（只剔除一次，同 id 不会重复）；liveText 保留在
		// segments 里（计数包含它），渲染层按 liveTextId 排除避免双显
		const processSegments = finalId ? segments.filter((segment) => !(segment.kind === "interim" && segment.id === finalId)) : segments;
		entries.push({
			kind: "turn",
			id: turnId,
			turn: {
				id: turnId,
				messageIds,
				segments: processSegments,
				finalText,
				...(liveTextId ? { liveTextId } : {}),
				toolCount: processSegments.filter((segment) => segment.kind === "tool").length,
				thinkingCount: processSegments.reduce((sum, segment) => sum + (segment.kind === "thinking" ? segment.texts.length : 0), 0),
				interimCount: processSegments.filter((segment) => segment.kind === "interim").length,
			},
		});
		messageIds = [];
		segments = [];
		finalText = "";
		finalId = "";
		liveTextId = undefined;
		turnId = "";
	};
	for (const message of messages) {
		if (message.role !== "assistant") {
			flush(true);
			entries.push({ kind: "user", id: message.id, message });
			continue;
		}
		if (!turnId) turnId = message.id;
		messageIds.push(message.id);
		for (let index = 0; index < message.parts.length; index += 1) {
			const part = message.parts[index];
			if (part.type === "file") {
				const media = mediaSegmentFromFilePart(part as unknown as WebFilePart, `${message.id}:p${index}`);
				if (media) segments.push(media);
			} else if (part.type === "reasoning") {
				const text = part.text ?? "";
				if (!text.trim()) continue;
				const running = (part as { state?: "streaming" | "done" }).state === "streaming";
				const last = segments.at(-1);
				if (last && last.kind === "thinking") {
					last.texts.push(text);
					// 合并块的流式状态以最后一个 part 为准：新 part 还在流 → 块继续 sweep；新 part 已 done → 块停
					last.running = running;
				} else {
					segments.push({ kind: "thinking", id: `${message.id}:p${index}`, texts: [text], running });
				}
			} else if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-"))) {
				const toolPart = part as unknown as WebToolPart;
				segments.push({ kind: "tool", id: toolPart.toolCallId ?? `${message.id}:p${index}`, part: toolPart });
			} else if (part.type === "text") {
				const text = part.text ?? "";
				if (!text.trim()) continue;
				const id = `${message.id}:p${index}`;
				segments.push({ kind: "interim", id, text });
			}
		}
	}
	// 末尾回合：isStreaming 时它仍在流式（不提升），否则按完成收口
	flush(!isStreaming);
	return entries;
}

/* ── 回合前缀缓存（2027-02 性能治理，WebTimeline 流式分组只用尾部） ──────────────
 *
 * 背景：useChat 在流式期间每个 delta 重建整个 messages 数组，groupTimelineEntries
 * 全量重跑会铸造全新 turn 对象，memo(WebAssistantTurn) 对所有历史回合失效——
 * 长会话打字机期每帧 O(全部消息) 分组 + O(全部回合) 重渲染。消息数组的前缀部分
 * 引用稳定（AI SDK 只重建流式尾消息），已完成回合的分组结果可以按引用判据复用。
 *
 * 边界安全性：缓存前缀必须结束在「回合边界」——即下一条消息是 user（或数组
 * 末尾）。流式期边界取最后一条 user 消息下标（当前回合起点），收流后取全量。
 */

/** 前缀缓存：覆盖 messages[0..consumed) 的分组条目（consumed 落在回合边界上）。 */
export type TurnPrefixCache = { messages: UIMessage[]; entries: TimelineEntry[]; consumed: number };

/**
 * 校验缓存前缀在当前 messages 上仍逐引用稳定（编辑/删除/重排会让引用变化）。
 * 稳定返回缓存条目与消费数；失稳返回 null（调用方整段重算，行为退回全量分组）。
 */
export function validTurnPrefix(cache: TurnPrefixCache, messages: UIMessage[]): { entries: TimelineEntry[]; consumed: number } | null {
	const limit = Math.min(messages.length, cache.messages.length, cache.consumed);
	for (let index = 0; index < limit; index += 1) {
		if (messages[index] !== cache.messages[index]) return null;
	}
	// messages 比缓存短（删除尾部）或前缀失稳都被上面的循环覆盖；
	// 消费数超出当前长度（不可能稳定）同样判失稳。
	if (cache.consumed > messages.length) return null;
	return { entries: cache.entries, consumed: cache.consumed };
}

/**
 * 可缓存边界：流式中 = 最后一条 user 消息下标（其后的当前回合每帧在变，不缓存）；
 * 非流式 = 数组全长（本轮分组即终态，全部可缓存）。0 表示没有可缓存前缀。
 */
export function turnPrefixBoundary(messages: UIMessage[], isStreaming: boolean): number {
	if (!isStreaming) return messages.length;
	let lastUser = -1;
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.role !== "assistant") lastUser = index;
	}
	return lastUser > 0 ? lastUser : 0;
}

/**
 * 从全量 entries 裁出恰好覆盖 messages[0..boundary) 的前缀条目：自后向前按每条
 * entry 覆盖的消息数（user=1、turn=messageIds.length）回退。边界不落在 entry 交界
 * 上（不应发生——boundary 一定是回合边界）返回 null，调用方放弃本次缓存。
 */
export function sliceEntriesToBoundary(entries: TimelineEntry[], boundary: number): TimelineEntry[] | null {
	if (boundary <= 0) return null;
	let need = boundary;
	let cut = entries.length;
	while (need > 0 && cut > 0) {
		const entry = entries[cut - 1];
		if (!entry) return null;
		need -= entry.kind === "user" ? 1 : entry.turn.messageIds.length;
		cut -= 1;
	}
	if (need !== 0) return null;
	return entries.slice(0, cut);
}
