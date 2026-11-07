---
title: "Handoff — Web 对齐 Phase 1A/1B（发布前评审已过，剩非阻断项 + T6）"
created: 2026-11-07
updated: 2026-11-07（评审 + 阻断项修复轮）
source_session: 01a1b4db-4e52-7780-bcc5-e06dec67192e
goal: "Phase 1 阻断项已修、门禁全绿；下一步二选一：非阻断收尾（N2/N4/N5…）或 T6 终端安全评审"
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
| Phase 1A/1B（T0.1–T5） | 完成，且已过发布前评审 |
| 评审阻断项 | 4 项全部修复（B1 白名单原型链、B2 symlink 边界、B3 审计日志、B4 巨文件） |
| 评审 N1（body 413/400） | 已修 |
| 文档收敛（FR-009 快捷键、design §4.3 pull/push） | 已改 |
| 代码状态 | **未提交**（Phase 1A+1B+评审修复累积在同一工作树） |
| NEXT | A：非阻断收尾；B：T6 终端（先安全评审） |

## Remaining（按优先级）

| # | 项 | 位置 | 修法 | 量级 |
|---|---|---|---|---|
| N2 | Web 改设置时桌面误弹「标题栏设置保存后需要重启 PiDeck 生效。」 | `src/renderer/src/App.tsx` bootstrapProps.onSettingsApplied（~1776） | 广播路径不弹该 toast，或按 patched keys 区分（主题/字号无需重启） | 15m |
| N4 | 命令面板输入框 `focus-visible:ring-0` 抹掉焦点环 | `src/renderer/src/web/WebCommandPalette.tsx:100` | 保留 `focus-visible:ring-1`（NFR-004 键盘焦点可见） | 5m |
| N5 | 390px 只测了设置面板 + 聊天页；抽屉/Git 面板无自动断言 | `e2e/web-workbench.spec.ts` | 加一条：390px 打开抽屉 → 切 Git → `scrollWidth ≤ clientWidth` | 30m |
| N9 | symlink 自身作为删除目标时的 `recursive` 语义未钉住 | `tests/webWorkspaceWrites.test.mjs` | create symlink 指向目录后 delete `link`，断言 trash 的是链接本身 / 明确 403 | 20m |
| N10 | `defaultAgentBackend` 投影把 acp/imagegen 一律显示为 pi | `src/main/web/WebSettingsProjection.ts` + `WebSettingsPanel.tsx` | 加只读 `defaultAgentBackendKind` 或面板提示「桌面专属后端」 | 20m |
| N3 | 写路由无速率限制、CORS 恒 `*`、无 Origin 校验（design §6 有承诺） | `WebHttpResponders.ts` / `WebServiceManager.ts` | per-token/IP 令牌桶 + Origin 白名单（需先定策略） | 1–2h |
| N6 | `WebGitPanel.tsx` 422 行 > 新增文件 400 行目标 | `src/renderer/src/web/WebGitPanel.tsx` | 拆出分支下拉/导航子组件 | 1h |
| N-t | 桌面端「Web 改设置 → 桌面即时生效」无自动化用例 | `e2e/web-settings.spec.ts` | 新用例：POST /api/settings 后断言桌面窗口 `html[data-theme]` | 30m |
| 已知红 | `e2e/web-service.spec.ts`「thinking and tool frames render as cards」 | 该 spec + `WebTimeline` 过程组 | HEAD 基线既有失败（独立 worktree 已确认）；与 Phase 1 无关，需单独排查 thinking 帧卡片渲染 | 未估 |

## Failed approaches（避免重复）

- 不要把 `test.skip(...)` 放测试文件顶层（会跳过整个文件），必须放测试体内。
- 不要让 Web 收到宿主绝对路径：草稿本/文件管理只传 `(scope,id)` / 项目相对路径。
- 不要给 Radix 菜单/对话框套 `drawer` 作用域查询（portal 到 body），E2E 用 `page.getByRole`。
- 不要用 8765 跑 E2E（本机 `pideck.service` 常驻）：web-service 用 8878、settings 用 8879、commands/workbench 各自端口。
- **不要把延迟赋值的单例按值传进装配**：`scratchPadService` 是模块级 `let`，Web 装配可能早于赋值；`registerWebRoutes` 用 provider `scratchPad: () => scratchPadService` 延迟读取（按值传会得到 `reading 'create'` 的 400）。
- 源码契约测试跟着结构走：`webSessionRoute` 原先断言 WebChatApp 内联三段 effect，已改为「组合根接线 hook + hook 内含逻辑」，不要为消红删断言。

## Verification evidence（评审轮，全部本机实跑）

- `npm run typecheck` → 0 错
- 针对性单测 14 个文件 → **145 pass / 0 fail**（含新增：白名单原型键 6 例、symlink 逃逸 3 例、超限 413 / 非法 JSON 400）
- `npx electron-vite build` → 通过
- `npx playwright test e2e/web-workbench.spec.ts e2e/web-settings.spec.ts e2e/web-commands.spec.ts` → **9 passed / 1 skipped**（visual 手动）
- `npm run check:format` → 通过；`npm run check:ipc-wiring` → ok（815 通道）
- `e2e/web-service.spec.ts` thinking/tool → **HEAD 基线同样失败**（独立 worktree `git worktree add /tmp/... HEAD` + 仅改端口后复现）

## Artifacts

| Artifact | Path | Why |
|---|---|---|
| Spec | `.ai/sdd/specs/001-web-parity/{requirements,design,tasks}.md` | FR/NFR、设计、任务与 Progress Log（评审轮在最上方） |
| 设置白名单 | `src/main/web/WebSettingsProjection.ts` | 唯一事实来源（写权限 = 键集） |
| 设置路由 | `src/main/web/WebSettingsRoutes.ts` + `src/main/settings/settingsBroadcast.ts` | 投影/写入 + 桌面广播 |
| 工作区写路由 | `src/main/web/WebWorkspaceRoutes.ts` | 文件/Git/草稿本边界 + 审计日志 |
| Web 装配 | `src/main/web/registerWebRoutes.ts` | 能力注入（新增域在这里加，不要回填 main/index.ts） |
| Web 组合根 | `src/renderer/src/web/WebChatApp.tsx` | 只装配；导航/标签副作用在 `useWebSessionNavigation.ts` |
| 架构规则 | `docs/architecture.md` | 目录/依赖/IPC/巨文件纪律 |
| UI 规则 | `docs/ui-and-css.md` | 焦点环/移动端 token |
| 项目规则 | `AGENTS.md` | 门禁、提交与部署 |

## Policy / safety notes

- 设置只走白名单；不得暴露 token、密钥、凭据、宿主绝对路径。
- 文件操作只在项目根内（realpath + symlink 检查），删除走回收站，拒绝删除项目根。
- Git 分支名校验走 `assertBranchName` + `git check-ref-format`；脏工作区 409，force 需用户确认。
- 不自动提交、不自动部署；部署会重启 `pideck.service` 并中断会话，需明确授权。

## Uncommitted files（本任务累积，全部未提交）

- 新增：`.ai/sdd/**`、`src/main/web/registerWebRoutes.ts`、`src/main/web/WebSettingsProjection.ts`、`src/main/web/WebSettingsRoutes.ts`、`src/main/settings/settingsBroadcast.ts`、`src/main/scratchPad/`、`src/renderer/src/web/{useWebSessionNavigation,useWebSettings,webCommandList,webCommands,webSessionTabs}.ts`、`src/renderer/src/web/{WebCommandPalette,WebComposerBanner,WebFileEditor,WebFilesPanel,WebGitPanel,WebNotesPanel,WebSessionTabs,WebSettingsPanel}.tsx`、`src/renderer/src/hooks/appearance/fontSizeAttributes.ts`、`e2e/web-{workbench,settings,commands}.spec.ts`、`tests/{scratchPadService,webCommands,webSessionTabs,webSettingsRoutes,webWorkspaceWrites}.test.mjs`
- 修改：`src/main/index.ts`、`src/main/web/WebWorkspaceRoutes.ts`、`src/main/web/WebServiceManager.ts`、`src/main/ipc/scratchPadIpc.ts`、`src/renderer/src/web/WebChatApp.tsx` 等 Phase 1A/1B 文件、`src/shared/types/settings.ts`、i18n 三份、`tests/webSessionRoute.test.mjs`、`docs/unified-api.md`、`e2e/web-service.spec.ts`
