/**
 * Web 端「前端已重新构建」的判定（纯函数，WebChatApp 接线）。
 *
 * 背景：Web 页面加载的是 out/renderer 里带 content hash 的 bundle。桌面端重新构建后
 * 旧 bundle 文件名不再存在，正在使用的页面一刷新就是 404 白屏。因此服务端在
 * /api/state 下发构建指纹（web.html hash），前端把「打开本页时」的指纹记为基线，
 * 之后指纹变化只显示「更新」按钮，是否重载由用户决定。
 *
 * 判定刻意保守：
 * - 没有基线（首个快照未拿到指纹，如 dev 代理模式）不提示——否则每次刷新都误报；
 * - 服务端当前指纹为空（dev / 未构建）不提示；
 * - 指纹相同不提示。
 */
export function hasNewerBuild(loadedBuildId: string | null | undefined, currentBuildId: string | null | undefined): boolean {
	if (!loadedBuildId || !currentBuildId) return false;
	return loadedBuildId !== currentBuildId;
}

/**
 * 记录基线：已记录过就保持不变（基线是「本页加载时的 bundle」），否则取首个非空指纹。
 * 单独抽出来是为了避免调用处写 `??=` 时把空串也算作基线。
 */
export function recordLoadedBuildId(loaded: string | null, current: string | null | undefined): string | null {
	if (loaded) return loaded;
	return current ? current : null;
}
