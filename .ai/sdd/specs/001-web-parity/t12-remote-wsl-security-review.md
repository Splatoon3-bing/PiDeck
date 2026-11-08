# T12 远程 / WSL / Worktree — 安全评审（v1 结论：远程不开放）

> Scope: FR-016 / design §4.9。评审先于代码（用户要求 T12 必须先评审）。

## 1. 现状核查（评审发现）

- `/api/state` 的 `projects` 直接下发 `projectStore.list()`，**包含 SSH 远程项目**。
- 但 Web 的文件/Git/终端路由全部以「本机项目根 + realpath 边界」实现（`WebWorkspaceRoutes.projectRoot` 只认 `project.path`）。
- 远程项目没有 `path`（只有 `locator.remotePath`）⇒ 列出来必然「点得动但失败」，且错误语义混乱（404/无法读取而非「不支持」）。

## 2. 威胁模型

| 威胁 | 影响 | 现有控制 |
|---|---|---|
| 浏览器经 Web 触发远程 SSH 命令 | 高：等于把远端主机操作面暴露给 LAN 客户端 | **不开放**（v1 无远端通道） |
| 远程路径注入到本机文件 API | 高：`/srv/app` 被当本机路径拼进 realpath 边界 | 路由只接受本机 `path`，远程项目无 `path` |
| WSL UNC 路径被当作项目外路径 | 中：越界读取/写入 | 既有 `createProjectFileReadBoundary` + realpath |
| Worktree 子目录越界 | 中：改到父仓库或主工作区 | worktree 项目有独立本机路径，沿用同一 realpath 边界 |

## 3. v1 决定

1. **远程（SSH）项目不进 Web 投影**：`WebProjectProjection.visibleWebProjects` 只保留有本机路径的项目；会话跟随项目可见性过滤（避免死链）。
2. **WSL / worktree 保持现状**：它们有本机可读路径，复用既有 realpath/symlink 边界；不新增特权。
3. **不新增远端通道**：没有 locator 级文件/Git/终端实现前，Web 不出现「远程」入口，也不返回半可用状态。

## 4. 未来开放（T12 full）前置条件

- locator 级文件/Git 通道（与桌面 `SshVerifiedConnection` 同源），Web 只传 `(projectId, relativePath)`；
- 远端命令必须走固定 argv + host pin，不得落回字符串拼接；
- 远端写操作（删除/提交）需与本地同级审计与确认；
- 独立评审 + 拒绝用例（跨主机、越界路径、凭据不出主进程）齐备后才可开。

## 5. 验证

`tests/webProjectProjection.test.mjs`（2 条）：远程项目被过滤；会话随项目过滤。
