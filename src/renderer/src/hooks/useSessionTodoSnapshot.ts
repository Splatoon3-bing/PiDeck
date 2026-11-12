/**
 * useSessionTodoSnapshot — 会话 todo 快照 hook（历史会话重建 + 活会话对账）。
 *
 * 两条用途共用同一份落盘快照：
 * - 历史会话（无 coherent runtime）没有 runtime widgets，任务列表完全由快照重建；
 * - 活会话在缺少 todo widget 时兜底（换代清空 / 首帧未到），避免任务条直接消失。
 *   刻意不做「快照反向覆盖 widget」：快照异步读取可能比内存帧更旧，反向覆盖会把
 *   新状态推回旧的。
 *
 * 与 useSessionSubagents 同构：切换会话后按 sessionId 重建。
 */
import { useEffect, useState } from "react";
import type { SessionTodoSnapshot } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

export function useSessionTodoSnapshot(sessionId: string, enabled: boolean): SessionTodoSnapshot | undefined {
	const [snapshot, setSnapshot] = useState<SessionTodoSnapshot | undefined>(undefined);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		desktopApi.sessions
			.listSessionTodo(sessionId)
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// 读失败保持上一次结果：TasksPane 回落到空态或上一份快照，不阻塞其它段
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, enabled]);

	return snapshot;
}
