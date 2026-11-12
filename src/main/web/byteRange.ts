/**
 * 单段字节 Range 解析（`bytes=start-end` / `bytes=start-` / `bytes=-suffix`）。
 *
 * 为什么单独一个叶子模块：`/api/file-raw` 与 `/api/videogen/blob` 都要用，
 * 而后者若从 WebWorkspaceRoutes 里 import，会把整个工作区依赖图（terminal/git/fs）
 * 拖进生视频 blob 出口——路由之间不该有这样的耦合，测试也不好装。
 *
 * 返回值语义（对齐 express `send` 的处理分支）：
 * - `undefined`：不处理 Range（无头 / 多段 / 非 bytes 单位 / 语法非法）→ 回 200 全量；
 * - `null`：区间落在文件之外 → 416；
 * - `{start,end}`：可满足的单段（闭区间，已夹在文件边界内）→ 206。
 */
export function parseSingleByteRange(header: string | undefined, size: number): { start: number; end: number } | undefined | null {
	if (!header) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return undefined;
	const [, rawStart, rawEnd] = match;
	if (rawStart === "" && rawEnd === "") return undefined;
	if (size <= 0) return null;
	if (rawStart === "") {
		// 后缀形态：bytes=-N 表示最后 N 字节
		const suffix = Number(rawEnd);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(rawStart);
	if (!Number.isFinite(start) || start >= size) return null;
	const end = rawEnd === "" ? size - 1 : Number(rawEnd);
	if (!Number.isFinite(end) || end < start) return null;
	return { start, end: Math.min(end, size - 1) };
}
