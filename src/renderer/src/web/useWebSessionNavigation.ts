/**
 * Web 会话导航（URL ↔ activeSessionId ↔ 标签栏）的副作用集合。
 *
 * 为什么从组合根抽出来：这 5 个 effect 只做「浏览器地址栏 / localStorage 标签 / 会话目录」
 * 三者同步，不含业务规则，留在 `WebChatApp` 里会把组合根继续推高（巨文件纪律）。
 *
 * 语义与抽出前逐条一致：
 * - 首次恢复前不回写 URL（落地页加载瞬间不能把 `/s/<id>` 冲掉）；
 * - 死链（URL 里的会话不在目录里且已确认连通）回根路径；
 * - 选中变化 → pushState；popstate 驱动的变化自然短路；
 * - 标签只持久化 id 数组；打开会话即入标签；目录裁剪时保留当前激活项。
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { addWebTab, pruneWebTabs, WEB_TABS_STORAGE_KEY } from "./webSessionTabs";
import { sessionFromPath, sessionPath } from "./webSessionRoute";

type SessionLike = { id: string };

/**
 * URL → 选中会话（首次恢复 + 选中 → pushState + 浏览器回退）。
 * `restoredRef` 由调用方持有，供其它逻辑判断「路由是否已接管」。
 */
export function useWebSessionRoute(args: { activeSessionId: string; sessions: readonly SessionLike[]; connected: boolean; restoredRef: { current: boolean }; setActiveSessionId: Dispatch<SetStateAction<string>> }): void {
	const { activeSessionId, sessions, connected, restoredRef, setActiveSessionId } = args;

	useEffect(() => {
		if (restoredRef.current) return;
		const id = sessionFromPath(window.location.pathname);
		if (!id) {
			restoredRef.current = true;
			return;
		}
		// 列表未拉到（空且未确认连通）时等待下一轮；确认后无此会话 → 死链，回根路径
		if (sessions.some((session) => session.id === id)) {
			setActiveSessionId(id);
			restoredRef.current = true;
		} else if (sessions.length > 0 || connected) {
			window.history.replaceState(null, "", "/");
			restoredRef.current = true;
		}
	}, [sessions, connected, restoredRef, setActiveSessionId]);

	// 选中变化 → pushState（popstate 驱动的变化路径已一致，自然短路不回写）
	useEffect(() => {
		if (!restoredRef.current) return;
		const desired = sessionPath(activeSessionId);
		if (window.location.pathname === desired) return;
		window.history.pushState(null, "", desired);
	}, [activeSessionId, restoredRef]);

	// 浏览器回退/前进：按 URL 恢复选中
	useEffect(() => {
		const onPopState = () => {
			setActiveSessionId(sessionFromPath(window.location.pathname));
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [setActiveSessionId]);
}

/**
 * 标签栏与 localStorage 同步：持久化 / 打开即入标签 / 目录裁剪。
 * `activeSessionIdRef` 供裁剪时保留当前激活项（新建窗口期它可能还不在目录里）。
 */
export function useWebTabSync(args: { openTabIds: readonly string[]; setOpenTabIds: Dispatch<SetStateAction<string[]>>; activeSessionId: string; activeSessionIdRef: { current: string }; sessions: readonly SessionLike[] }): void {
	const { openTabIds, setOpenTabIds, activeSessionId, activeSessionIdRef, sessions } = args;

	// 标签持久化：只写 id 数组，坏数据由 parseStoredWebTabs 在下次启动时兜底。
	useEffect(() => {
		if (typeof window === "undefined") return;
		window.localStorage.setItem(WEB_TABS_STORAGE_KEY, JSON.stringify(openTabIds));
	}, [openTabIds]);

	// 打开会话即入标签（已存在不重复）；新建会话先有 active 后有 catalog 记录，
	// 因此依赖里同时看 sessions，等记录到达再补一次。
	useEffect(() => {
		if (!activeSessionId) return;
		if (!sessions.some((session) => session.id === activeSessionId)) return;
		setOpenTabIds((current) => (current.includes(activeSessionId) ? current : addWebTab(current, activeSessionId)));
	}, [activeSessionId, sessions, setOpenTabIds]);

	// 外部删除/归档后裁剪失效标签；当前激活项即使暂时不在目录里也保留（新建窗口期）。
	useEffect(() => {
		if (sessions.length === 0) return;
		const known = new Set(sessions.map((session) => session.id));
		setOpenTabIds((current) => pruneWebTabs(current, known, activeSessionIdRef.current));
	}, [sessions, setOpenTabIds, activeSessionIdRef]);
}
