/**
 * 分屏（只读 peek）的状态与选择规则（T7b）
 *
 * 设计取舍：分屏右侧是**只读预览**（最近消息 + 会话状态），可一键「切到这一栏」。
 * 不做第二份 useChat：那需要把聊天/流式/排队抽成可复用 pane，改动面远大于本轮收益。
 *
 * 纯函数（选搭档 / 持久化）单独可测；hook 只做状态与收敛（会话被删/自己分自己）。
 */
import { useCallback, useEffect, useState } from "react";

export const WEB_SPLIT_STORAGE_KEY = "pideck-web-split";

export function readStoredSplitSession(): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(WEB_SPLIT_STORAGE_KEY) || null;
	} catch {
		return null;
	}
}

export function storeSplitSession(sessionId: string | null): void {
	if (typeof window === "undefined") return;
	try {
		if (sessionId) window.localStorage.setItem(WEB_SPLIT_STORAGE_KEY, sessionId);
		else window.localStorage.removeItem(WEB_SPLIT_STORAGE_KEY);
	} catch {
		// 隐私模式/存储禁用：仅本次会话生效
	}
}

/**
 * 选分屏搭档：当前标签的**左邻**优先，其次右邻（跳过自己）。
 * 只有一个标签时返回 null（分屏没有意义）。
 */
export function pickSplitPartner(ids: readonly string[], activeSessionId: string): string | null {
	if (ids.length < 2) return null;
	const index = ids.indexOf(activeSessionId);
	if (index < 0) return ids.find((id) => id !== activeSessionId) ?? null;
	return ids[index - 1] ?? ids[index + 1] ?? null;
}

export function useSplitSession<T extends { id: string }>(input: {
	openTabIds: readonly string[];
	activeSessionId: string;
	sessions: readonly T[];
}): {
	splitSession: T | null;
	toggleSplit: () => void;
	closeSplit: () => void;
	promoteSplit: () => T | null;
} {
	const [splitSessionId, setSplitSessionId] = useState<string | null>(() => readStoredSplitSession());

	// 会话被删除/归档/切换后收敛：分屏不能指向不存在或当前会话。
	useEffect(() => {
		if (!splitSessionId) return;
		if (splitSessionId === input.activeSessionId || !input.sessions.some((session) => session.id === splitSessionId)) {
			setSplitSessionId(null);
		}
	}, [input.activeSessionId, input.sessions, splitSessionId]);

	useEffect(() => {
		storeSplitSession(splitSessionId);
	}, [splitSessionId]);

	const toggleSplit = useCallback(() => {
		setSplitSessionId((current) => {
			if (current) return null;
			return pickSplitPartner(input.openTabIds, input.activeSessionId);
		});
	}, [input.activeSessionId, input.openTabIds]);

	const closeSplit = useCallback(() => setSplitSessionId(null), []);

	const promoteSplit = useCallback(() => {
		const session = splitSessionId ? (input.sessions.find((candidate) => candidate.id === splitSessionId) ?? null) : null;
		setSplitSessionId(null);
		return session;
	}, [input.sessions, splitSessionId]);

	return { splitSession: splitSessionId ? (input.sessions.find((session) => session.id === splitSessionId) ?? null) : null, toggleSplit, closeSplit, promoteSplit };
}
