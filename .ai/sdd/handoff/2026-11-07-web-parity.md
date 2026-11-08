---
title: "Handoff — Web 对齐 Phase 1A/1B（发布前评审已过，剩非阻断项 + T6）"
created: 2026-11-07
updated: 2026-11-07（T9–T13/T15 交付并提交 eb112ccae）
source_session: 01a1b4db-4e52-7780-bcc5-e06dec67192e
goal: "T9/T10/T11/T13/T15 已交付并提交；T12 v1 投影收口、T14 评审后置；下一步：T14 实现（可选）或 T6 部署前手动走查"
workspace: "/home/bing/PiDeck"
---

# Handoff — Web 对齐 Phase 1A/1B（评审已过）

**Next session goal:** 二选一
- **A（小，推荐先做）**：收尾 Phase 1 非阻断项 —— N2 误弹重启 toast、N4 命令面板焦点环、N5 抽屉 390px E2E、N9 symlink 自身删除用例、N10 后端投影失真；可选 N3 速率限制/Origin、N6 WebGitPanel 拆行、桌面广播即时性 E2E。
- **B**：进 **T6 终端**（默认关闭 + WebSocket + 会话归属 + 并发/缓冲上限），**先做安全评审再动代码**。

## Suggested first message

```
Continue from /home/bing/PiDeck/.ai/sdd/handoff/2026-11-07-web-parity.md.

Goal for this session: 收尾 Phase 1 非阻断项（N2 桌面误弹重启 toast、N4 命令面板焦点环、N5 抽屉 390px E2E、N9 symlink 自身删除用例、N10 后端投影失真）。不新增功能，只做评审遗留项。

Read the handoff file in full first. Key artifacts: .ai/sdd/specs/001-web-parity/{requirements,design,tasks}.md（Progress Log 最上方是 2026-11-07 评审轮）、docs/architecture.md、docs/ui-and-css.md、AGENTS.md。

门禁：npm run typecheck + node --test tests/webWorkbench* 相关 + 三条 Web E2E（web-workbench/web-settings/web-commands）+ npm run check:format；改 i18n 后跑 node scripts/genZhTwCopy.mjs。
```

## Decisions（不要重新讨论）

- 设置只走白名单投影，未知键 400；新增键必须同时改 `WebSettingsProjection.ts`。
- 文件写/删/改名必须过 `createProjectFileReadBoundary` + `resolveProjectFileWritePath`（realpath），与桌面 `LocalProjectFileBackend` 同源。
- 删除走系统回收站，不硬删；Git 只开 stage/unstage/commit + 分支列表/切换/新建/fetch；push/pull 留 Phase 1.5。
- 不新增 pi↔PiDeck 通道；复用 `settings:apply-window` 广播同步桌面。
- 巨文件：`WebChatApp.tsx` / `main/index.ts` 相对 HEAD 必须净减（当前 1643→1640、8022→8016）。
- 延迟赋值的模块级单例不要按值传进装配 —— 用 provider（见下 Failed approaches）。

## Current state

| Area | Status |
|------|--------|
| Phase 1A/1B（T0.1–T5）+ 评审修复 | 完成并提交 |
| T6 终端 / T7 分屏 / T8 自动化 | 完成并提交 |
| T9 智能体 | **本轮完成（未提交）**：`WebAgentRoutes` + 面板；调用走例外四 sidecar，拒收 systemPrompt |
| T10 收藏 | **本轮完成（未提交）**：`WebFavoritesRoutes` + 面板；添加会话只收 id，来源由 catalog 填 |
| T13 通知/公告/反馈 | **本轮完成（未提交）**：`WebNoticeRoutes` + `WebNoticeCenter`；反馈复用建会话 + 预填 |
| T15 PWA/离线 | **本轮完成（未提交）**：三态连接（离线 vs 连接中）；SW 策略沿用既有 |
| 已提交 | `eb112ccae`（T9/T10/T11/T13/T15 + T12 v1 + T14 评审） |
| 未做 | T14 宿主插件只读的**实现**（评审结论：v1 不开放，切片已记入评审 §3）；T6 部署前手动走查 |
| 全量红单 | **已确认无新增**：15724 tests → 15441 pass / **156 fail** / 101 cancelled，与基线 156 一致；新增 22 条测试全绿；`webLayout` 5 红用基线 worktree 对照同为既有 |
| 巨文件 | `WebChatApp.tsx` **1646**、`main/index.ts` **8017**（起点 1652 / 8021，均净减） |

## 本轮验证证据（本机实跑）

- `npm run typecheck` → 0 错
- 针对性单测：`webAgentRoutes` / `webFavoritesRoutes` / `webNoticeRoutes` / `webAutomationRoutes` / `webConnectivity` / `webSessionRoute` = **28 条全绿**（分批跑合计 22–58 条，均 0 fail）
- `npx playwright test e2e/web-workbench.spec.ts` → **13 passed / 1 skipped**（新增：智能体 编辑/绑定/删除、收藏 保存/搜索/跳回、通知中心→反馈建会话、离线/恢复）
- `npm run check:format` → 通过；`npx electron-vite build` → 通过（改渲染层后 E2E 必须重建，否则页面仍旧 bundle）

## 本轮踩坑（已修复，勿重犯）

- **`sessionCatalog` 是启动后段赋值的模块级 `let`**：按值传进 `webDomainProviders` → 运行期 `catalog.get` 报 `Cannot read properties of undefined (reading 'get')`，同时打挂智能体绑定与收藏添加。所有延迟赋值 store/catalog 一律传 getter，收口在 `src/main/web/webStoreProviders.ts`。
- **改渲染层后不重建就复跑 E2E 会误判**：抽屉入口整体失效的假象就是旧 bundle；门禁顺序固定为 build → E2E。
- E2E 列表项定位要收敛到 `li` 行（面板里同名按钮会出现多个），否则 strict mode violation。
- 领域装配细节（notice 历史路径/日志命名空间）收回域工厂 `createNoticeHistoryStore`，`main/index.ts` 只留一行，避免巨文件回涨。

## 剩余任务

| # | 任务 | 要点 |
|---|---|---|
| T11 | 生图/生视频 | 供应商配置只在主进程；Web 只传 prompt/参数/参考图；进度与产物 |
| T12 | 远程/WSL/Worktree | 先扩展 locator 投影与路径/权限边界，**单独安全评审** |
| T14 | 宿主插件（只读） | 只读安全投影；安装/执行/权限提升不开放（需安全评审） |
| — | 全量红单 | 按文件 triage，对照基线 `3744a3593` 区分既有/新增 |

## Uncommitted files（本轮）

- 新增：`src/main/web/{WebAgentRoutes,WebFavoritesRoutes,WebNoticeRoutes,registerWebDomainRoutes,webStoreProviders}.ts`、`src/renderer/src/web/{WebAgentPanel,WebFavoritesPanel,WebNoticeCenter,useWebAppUpdate,useWebWorkspaceController,webConnectivity}.ts(x)`、`tests/web{AgentRoutes,FavoritesRoutes,NoticeRoutes,Connectivity}.test.mjs`、`.ai/sdd/specs/001-web-parity/t{9-agents,t10-favorites}-web-slice.md`
- 修改：`src/main/index.ts`、`src/main/notices/NoticeHistoryStore.ts`、`src/main/web/{WebServiceManager,registerWebRoutes}.ts`、`src/renderer/src/web/{WebChatApp,WebHeader,WebSidebar,WebWorkspaceDrawer,webApi}.tsx?`、i18n 三份、`e2e/web-workbench.spec.ts`、`.ai/sdd/{INDEX.md,specs/001-web-parity/tasks.md}`

