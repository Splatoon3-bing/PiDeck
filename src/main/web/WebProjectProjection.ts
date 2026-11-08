/**
 * Web 可见项目投影（T12 v1）。
 *
 * 远程（SSH）项目只有 `locator.remotePath`，没有本机可读 `path`：Web 的文件/Git/终端
 * 路由全部以本机根路径 + realpath 边界实现，把远程项目投影给浏览器只会得到「点得动但必然失败」
 * 的入口。v1 因此**不把远程项目纳入 Web 投影**；开放需要先做 locator 级文件/Git 通道与
 * 独立评审（见 .ai/sdd/specs/001-web-parity/t12-remote-wsl-security-review.md）。
 *
 * WSL / worktree 项目带本机路径（UNC / 子目录），继续沿用既有 realpath 边界，不在此过滤。
 */
import type { Project } from "../../shared/types";

/** 只有「有本机路径」的项目对 Web 可用；chat 项目与 WSL/worktree 都属于这一档。 */
export function isWebVisibleProject(project: Project): boolean {
	return typeof (project as { path?: unknown }).path === "string";
}

export function visibleWebProjects(projects: readonly Project[]): Project[] {
	return projects.filter((project) => isWebVisibleProject(project));
}

/** 会话跟随其项目可见性：项目不可见时，会话也不该在 Web 侧栏出现（避免指向被过滤项目的死链）。 */
export function visibleWebSessions<T extends { projectId: string }>(sessions: readonly T[], projects: readonly Project[]): T[] {
	const ids = new Set(visibleWebProjects(projects).map((project) => project.id));
	return sessions.filter((session) => ids.has(session.projectId));
}
