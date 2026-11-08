# Tasks: PiDeck Web 与桌面端页面/功能对齐

> Requirements: @requirements.md
> Design: @design.md
> Status: Approved（用户 2026-11-07 指示先落 spec 后继续）
> Last Updated: 2026-11-07

## Requirement Coverage

| Requirement | Tasks | Notes |
|-------------|-------|-------|
| FR-001 多标签 | T0.1 | 已交付 |
| FR-002 工作区抽屉 | T0.2 | 已交付 |
| FR-003 文件编辑 | T0.3 | 已交付 |
| FR-004 草稿本 | T0.4 | 已交付 |
| FR-005 Git 最小写入 | T0.5 | 已交付 |
| FR-006 设置 | T1 | 已交付 |
| FR-007 文件管理 | T2 | 已交付 |
| FR-008 Git 分支 | T3 | 已交付 |
| FR-009 命令面板 | T4 | 已交付 |
| FR-010 终端 | T6 | Phase 2 |
| FR-011 分屏/状态 | T7 | Phase 2 |
| FR-012 自动化 | T8 | Phase 3 |
| FR-013 智能体 | T9 | Phase 3 |
| FR-014 收藏 | T10 | Phase 3 |
| FR-015 生图/视频 | T11 | Phase 3 |
| FR-016 远程/WSL/Worktree | T12 | Phase 4 |
| FR-017 通知/公告/反馈 | T13 | Phase 4 |
| FR-018 PWA/移动 | T5, T15 | T5 已交付 |
| FR-019 安全 | T5, T6 | 跨阶段 |
| FR-020 宿主插件 | T14 | Phase 4 |

## Design Coverage Check

| Requirement | Design Coverage | Status | Notes |
|-------------|-----------------|--------|-------|
| FR-001–005 | §4.1–4.3 | Pass | 已交付 |
| FR-006 | §4.4 / TD-001 | Pass | 待实施 |
| FR-007 | §4.2 / TD-002 | Pass | 待实施 |
| FR-008 | §4.3 / TD-003 | Pass | 待实施 |
| FR-009 | §4.5 | Pass | 待实施 |
| FR-010 | §4.6 / TD-004 | Partial | 需要安全评审 |
| FR-011–015 | §4.7–4.8 | Partial | 需要接口细化 |
| FR-016–020 | §4.9 | Partial | Phase 4 |
| NFR-001–008 | §6–§11 | Pass | 跨阶段 |

## Implementation Readiness Check

| Check | Status | Notes |
|-------|--------|-------|
| Must Have requirements have tasks | Pass | T1/T2/T6 |
| Tasks map to requirements/design | Pass | 下方映射 |
| Critical questions answered | Partial | 见 requirements Open Questions；T1/T2 不阻塞 |
| Tasks have dependencies/acceptance/files/verification | Pass | 见各任务 |
| Verification commands identified | Pass | 见各任务 |
| No blocking gaps for Phase 1 | Pass | T1/T2/T3/T4 可并行 |

## Implementation Slices

### MVP Slice（Phase 1A）

- **Goal:** Web 上能改设置、管理文件、切分支。
- **Requirements:** FR-006、FR-007、FR-008。
- **Tasks:** T1、T2、T3。
- **Independent validation:** 改主题/字号刷新保持；新建/改名/删除文件；切换分支。

### Phase 1B

- **Goal:** 命令面板 + 移动端精修。
- **Tasks:** T4、T5。

### Phase 2+

- 终端、分屏、自动化、智能体、收藏、生图、远程、通知、插件。

## Task Summary

| Task | Title | Priority | Estimate | Dependencies | Status |
|------|-------|----------|----------|--------------|--------|
| T0.1 | 多标签工作台 | P0 | done | none | done |
| T0.2 | 工作区抽屉 | P0 | done | T0.1 | done |
| T0.3 | 文件编辑 | P0 | done | T0.2 | done |
| T0.4 | 草稿本 | P1 | done | T0.2 | done |
| T0.5 | Git stage/commit | P0 | done | T0.2 | done |
| T1 | 设置投影 + 设置面板 | P0 | 3h | none | done |
| T2 | 文件管理（新建/改名/删除） | P0 | 3h | T0.2 | done |
| T3 | Git 分支（列表/切换/新建/fetch） | P1 | 3h | T0.5 | done |
| T4 | 命令面板 | P1 | 2h | T0.1 | done |
| T5 | 移动端/安全/回归测试 | P1 | 2h | T1–T4 | done |
| T6 | 终端（默认关闭） | P0 | 8h | 安全评审 | pending |
| T7 | 分屏/状态面板 | P2 | 6h | T0.1 | done（T7a 状态面板 + T7b 只读 peek 分屏） |
| T8 | 自动化页 | P2 | 6h | 路由基建 | done（S1 数据面 + S2 UI + S3 E2E） |
| T9 | 智能体页 | P2 | 4h | 路由基建 | done |
| T10 | 收藏页 | P2 | 3h | 路由基建 | done |
| T11 | 生图/生视频 | P3 | 6h | 后端链路 | done（v1 生图；生视频后置，见切片 §5） |
| T12 | 远程/WSL/Worktree | P3 | 10h | 安全评审 | done（v1：远程不投影；locator 通道后置） |
| T13 | 通知/公告/反馈 | P2 | 4h | 路由基建 | done |
| T14 | 宿主插件（只读） | P3 | 3h | 安全评审 | done（只读 API + 投影；UI 入口后置） |
| T15 | PWA/离线 | P2 | 3h | T5 | done（离线可读性；SW 策略沿用既有） |

## Dependency Diagram

```mermaid
flowchart LR
    T01[T0.1 标签] --> T02[T0.2 抽屉]
    T02 --> T03[T0.3 编辑]
    T02 --> T04[T0.4 草稿本]
    T02 --> T05[T0.5 Git 写]
    T1[T1 设置] --> T5[T5 精修/测试]
    T02 --> T2[T2 文件管理]
    T05 --> T3[T3 Git 分支]
    T01 --> T4[T4 命令面板]
    T1 --> T5
    T2 --> T5
    T3 --> T5
    T4 --> T5
    T5 --> T6[T6 终端]
    T5 --> T7[T7 分屏]
    T5 --> T8[T8 自动化]
    T8 --> T9[T9 智能体]
    T8 --> T10[T10 收藏]
    T8 --> T13[T13 通知]
    T5 --> T15[T15 PWA]
```

## Task T0.1: 多标签工作台（已交付）

**Priority:** P0  
**Estimate:** done  
**Dependencies:** none  
**Covers:** FR-001, NFR-004  
**Status:** done

- 已完成：`webSessionTabs.ts`、`WebSessionTabs.tsx`、localStorage、关闭落点、溢出滚动、状态点。
- 验证：`tests/webSessionTabs.test.mjs`、`e2e/web-workbench.spec.ts`。

## Task T0.2: 工作区抽屉（已交付）

**Priority:** P0  
**Estimate:** done  
**Dependencies:** T0.1  
**Covers:** FR-002, FR-003, FR-004, FR-005  
**Status:** done

- 已完成：`WebWorkspaceDrawer` + `WebFilesPanel` / `WebGitPanel` / `WebNotesPanel`；文件编辑 `WebFileEditor`；`ScratchPadService` 共享。
- 验证：`tests/scratchPadService.test.mjs`、`tests/webWorkspaceWrites.test.mjs`、`e2e/web-workbench.spec.ts`。

## Task T1: 设置投影 + 设置面板

**Priority:** P0  
**Estimate:** 3h  
**Dependencies:** none  
**Covers:** FR-006, NFR-001, NFR-005  
**Status:** done

### Overview

在 Web 上提供外观、会话默认、输入行为三组设置。服务端只暴露/接受白名单字段，前端复用现有 shadcn 控件。

### Work

- [x] `WebSettingsProjection.ts`：白名单键集 + 校验（未知键/非法值/空 body 抛 `WebSettingsValidationError`）、`toSafeWebSettings`。
- [x] `WebSettingsRoutes.ts`：`GET/POST /api/settings` + `createWebSettingsRoutes` 装配工厂（`SettingsStore.update` → nativeTheme 重放 → 窗口广播）。
- [x] `WebServiceManager.settingsRoutes` 注入点（与 workspaceRoutes 同型，未装配时 404）；`main/index.ts` 只留一行装配。
- [x] `WebSettingsPanel.tsx` + `useWebSettings` hook：外观（明暗/全局/界面/会话字号）、会话默认（pi/dsh）、输入行为（发送快捷键/流式展开）；`theme` 改由服务端权威。
- [x] 发送快捷键接进 WebComposer（`getComposerEnterIntent`），流式展开接进 WebTimeline 过程组。
- [x] i18n 三语 + `genZhTwCopy.mjs`。
- [x] 单测 11 条：投影无 secrets、未知键不部分写入、非法值、空 body、非法 JSON、413、500、405。
- [x] E2E 3 条：改字号/明暗 → 刷新保持 + 磁盘投影校验；未知键 400 不部分写入；390px 移动端入口可达且无横向溢出。

### Acceptance Criteria

- [x] Web 端可改 7 个安全设置（明暗 + 3 档字号 + 默认后端 + 发送快捷键 + 流式展开）并立即生效。
- [x] 投影响应不含 token/auth/security/cua/terminal/remote 字段（单测逐项断言）。
- [x] 未知字段返回 400，且不部分写入。
- [x] 刷新后设置保持；桌面端经既有 `settings:apply-window` 广播同步。

### Files

- `src/main/web/WebSettingsProjection.ts` — 新增
- `src/main/web/WebSettingsRoutes.ts` — 新增
- `src/main/web/WebServiceManager.ts` — 注入 deps
- `src/main/index.ts` — 装配
- `src/renderer/src/web/WebSettingsPanel.tsx` — 新增
- `src/renderer/src/web/webApi.ts` — 类型/请求
- `src/renderer/src/web/WebChatApp.tsx` — 入口
- `tests/webSettingsRoutes.test.mjs` — 新增
- `e2e/web-settings.spec.ts` — 新增

### Verification

- [x] `node --test tests/webSettingsRoutes.test.mjs`（11 条全绿）
- [x] `npm run typecheck`
- [x] `npx electron-vite build`
- [x] `npx playwright test e2e/web-settings.spec.ts`（3 passed）
- [x] `npm run check:format`

## Task T2: 文件管理（新建/改名/删除）

**Priority:** P0  
**Estimate:** 3h  
**Dependencies:** T0.2  
**Covers:** FR-007, NFR-001  
**Status:** done

### Overview

在文件面板提供新建文件/目录、重命名、删除（回收站）。所有操作限制在项目根内，拒绝覆盖与删除项目根。

### Work

- [ ] `WebWorkspaceRoutes` 新增 `POST /api/files/create|rename|delete`；校验名称/路径/项目归属；删除走 `FileSystemService.delete`（回收站）。
- [ ] `main/index.ts` 注入 `create/rename/delete` 能力（`FileSystemService`）。
- [ ] `WebFilesPanel` 增加工具栏（新建/刷新）与行内菜单（重命名/删除）；确认对话框；操作后刷新。
- [ ] i18n 三语。
- [ ] 单测：路径穿越、同名冲突、项目根删除、未知项目、能力缺失 503。
- [ ] E2E：新建 → 改名 → 删除 → 磁盘/回收站断言。

### Acceptance Criteria

- [ ] 项目内新建/改名/删除可用；文件树刷新。
- [ ] 同名/越界/项目根删除被拒绝，错误可读。
- [ ] 删除进入系统回收站；回收站不可用时报错不硬删。

### Files

- `src/main/web/WebWorkspaceRoutes.ts`
- `src/main/index.ts`
- `src/renderer/src/web/WebFilesPanel.tsx`
- `src/renderer/src/web/webApi.ts`
- `tests/webWorkspaceWrites.test.mjs`（扩展）
- `e2e/web-workbench.spec.ts`（扩展）

### Verification

- [x] `node --test tests/webWorkspaceWrites.test.mjs`（15 条全绿，含新建/改名/删除边界）
- [x] `npm run typecheck`
- [x] `npx electron-vite build`
- [x] `npx playwright test e2e/web-workbench.spec.ts`（4 passed / 1 skipped）
- [ ] `npm run check:format`（本轮已跑通过，交付前复跑）


- [ ] `node --test tests/webWorkspaceWrites.test.mjs`
- [ ] `npm run typecheck`
- [ ] `npx playwright test e2e/web-workbench.spec.ts`

## Task T3: Git 分支（列表/切换/新建/fetch）

**Priority:** P1  
**Estimate:** 3h  
**Dependencies:** T0.5  
**Covers:** FR-008, NFR-001  
**Status:** done

### Overview

Git 面板增加分支下拉：列表、切换、新建并切换、fetch。push/pull 留到 Phase 1.5（TD-003）。

### Work

- [ ] `WebWorkspaceRoutes` 新增 `GET /api/git/branches`、`POST /api/git/checkout`、`POST /api/git/fetch`。
- [ ] `main/index.ts` 注入 `getBranches` / `checkout` / `fetch`。
- [ ] 分支名校验（列表或合法 ref 正则）；checkout 前 status 脏检查；fetch 超时。
- [ ] `WebGitPanel` 分支下拉 + 新建分支输入 + fetch 按钮 + 确认/错误。
- [ ] i18n 三语。
- [ ] 单测：非法分支、脏工作区、fetch 能力缺失、未知项目。
- [ ] E2E：创建分支 → 切换 → 断言当前分支。

### Acceptance Criteria

- [x] 分支列表/当前分支正确。
- [x] 切换/新建可用；脏工作区有明确提示（409，E2E 覆盖确认后强制切换）。
- [x] fetch 有超时/错误提示，不阻塞 UI。

### Files

- `src/main/web/WebWorkspaceRoutes.ts`
- `src/main/index.ts`
- `src/renderer/src/web/WebGitPanel.tsx`
- `src/renderer/src/web/webApi.ts`
- `tests/webWorkspaceWrites.test.mjs`
- `e2e/web-workbench.spec.ts`

### Verification

- [x] 后端 routes + `assertBranchName` + 脏工作区 409 + force 重试
- [x] `webApi` 的 `checkoutGitBranch` / `fetchGitRemote` / `WebGitOperationError`
- [x] `WebGitPanel` 分支下拉/新建/fetch/脏工作区确认
- [x] `node --test tests/webWorkspaceWrites.test.mjs`（15 条全绿）
- [x] `npm run typecheck`
- [x] T3 E2E（真实 git 仓库创建/切换分支）——已补：`web workbench: git branches can be created and switched`


- [ ] `node --test tests/webWorkspaceWrites.test.mjs`
- [ ] `npm run typecheck`
- [ ] `npx playwright test e2e/web-workbench.spec.ts`

## Task T4: 命令面板

**Priority:** P1  
**Estimate:** 2h  
**Dependencies:** T0.1  
**Covers:** FR-009, NFR-004  
**Status:** done

### Overview

Web 端命令面板（Ctrl/Cmd+Shift+P）：会话切换、关闭标签、打开文件/Git/草稿本/设置、搜索、主题、刷新模型。

### Work

- [x] `webCommands.ts`：过滤（AND/前缀优先）/分组/循环索引纯函数。
- [x] `webCommandList.ts`：`buildWebCommands` + `useWebCommands`（命令清单独立于组合根）。
- [x] `WebCommandPalette.tsx`：Dialog + listbox/aria-activedescendant + ↑↓/Home/End/Enter/Esc + 焦点回收 + 快捷键自带。
- [x] `WebChatApp` 接线；移动端 ⋮ 菜单里有「命令面板」入口。
- [x] 单测 6 条 + E2E 键盘路径（过滤/执行/导航/Esc/菜单入口）。

### Acceptance Criteria

- [x] 键盘打开/过滤/执行/关闭；无鼠标可用。
- [x] 命令执行后可观察结果（打开设置/切会话/打开文件面板）。

## Task T5: 移动端/安全/回归测试

**Priority:** P1  
**Estimate:** 2h  
**Dependencies:** T1–T4  
**Covers:** FR-018, FR-019, NFR-001–005  
**Status:** pending

**Status:** done

- [x] 390px 无横向溢出：`e2e/web-settings.spec.ts` 第 3 条（面板打开前后都断言 `scrollWidth ≤ clientWidth`）。
- [x] 触控入口：设置/命令面板都从 ⋮ 菜单可达；面板控件沿用 `pointer-coarse` 尺寸。
- [x] 新写路由的 400/413/405/500 边界（单测）；401/403 由 WebServiceManager 鉴权链统一覆盖（既有 web-service spec）。
- [x] 全量 Web E2E：`web-workbench` + `web-settings` + `web-commands` = 9 passed / 1 skipped（visual 手动）。

## Task T6: 终端（默认关闭）

**Priority:** P0  
**Estimate:** 8h（S1–S5 切片）  
**Dependencies:** 安全评审  
**Covers:** FR-010, NFR-001, NFR-007  
**Status:** done（安全评审：[t6-terminal-security-review.md](./t6-terminal-security-review.md)；S1–S5 全部完成；部署前手动走查见 S5）

- 新增 `webTerminalEnabled`（默认 false）。
- `WebTerminalRoutes` WebSocket：token、会话归属、输入/尺寸/关闭、并发/缓冲上限。
- `WebTerminalDock`：xterm.js、单会话多终端、移动端输入。
- 清理：关闭/刷新/退出；单测 + E2E。

## Task T7–T15

- T7 分屏/状态：复用 tab 状态 + 只读 strips；移动端单列。
- T8 自动化：`AutomationStore` + scheduler；列表/编辑器/历史。
- T9 智能体：`AgentProfileStore` + invoke；列表/编辑/绑定。
- T10 收藏：`FavoritesStore`；列表/搜索/跳转。
- T11 生图/视频：供应商参数、进度、产物；密钥只在主进程。
- T12 远程/WSL/Worktree：locator 投影 + 边界；单独评审。
- T13 通知/公告/反馈：`NoticeHistoryStore` / `AnnouncementService` / feedback。
- T14 宿主插件：只读投影；不开放执行/安装。
- T15 PWA/离线：SW 缓存策略、离线壳、重连。

## Progress Log

### 2026-11-08 — 全量红单清零（20 → 0）

起点 `npm test`：16452 pass / 20 fail / 0 cancelled；收口：**16504 tests / 16477 pass / 0 fail / 27 skipped / 0 cancelled（rc=0）**。

- **sessionCatalog（3）**：根因是「同一文件只有一种字节形态」没有落到 identity/磁盘探测。新增 `normalizeSessionFilePathSyntax`（按形态选 win32/posix 语义，折叠分隔符/`//`/`.`/`..`，不折大小写）供 `canonicalizeSessionPath` 使用；落盘侧另加 `healSessionPathForStorage`（只愈合 POSIX 反斜杠形态，Windows 形态保持上报字节——`C:/a/b` 与 `C:\a\b` 等价但侧栏/回调按字节比较）。大小写变体只在 Windows 成立，测试按 `process.platform` 门控并写明理由。
- **cua/CuaMcpHttpHost（2）**：MCP 契约不依赖 Win32 bindings。测试注入「只读方法替身 + 真 CuaEngine 写/门禁路径」的 engine；`listWindows/getDisplay/getVirtualDesktop/getForegroundWindow` 平台无关，无审批拒绝写入仍走真实 gate。
- **acpGracefulStop（2）**：①`killAcpProcessTree` 接受 platform（原实现读 `process.platform`，注入 `"win32"` 的用例杀不到 taskkill）；②`AcpAgentManager.shutdownProcess` 在交给 `shutdownAcpProcess` 前先关 stdin（非 Windows 直接 SIGTERM 也要给 CLI EOF 跑 SessionEnd）。
- **长尾（8）**：`securityPolicy` 的相对 allowDir 按基址形态选 win32.resolve；`localImageAccess.isInsideRoot` 按路径形态选 win32/posix relative（8.3 短名事故全在 Windows 形态）；`agentMemory/paths.canonicalPath` 对盘符/UNC 走 `win32.resolve`（`C:/p` 与 `C:\p` 同键）；`PiResourceTargetResolver` 的绝对路径判定按形态（POSIX 上 UNC 不是 `isAbsolute`）；`packageResourceResolver.readPackageVersion` 把起点是文件时的 `ENOTDIR` 当「继续向上」；`piDeckRuntimeRetryContract` 的机器语料断言改为「扩展判为瞬态必须改写 + 改写后双运行时都可重试」（原「至少救回一条」依赖本机历史）；`skillCatalog` 项目根夹具改按宿主平台构造；`webServiceHardening` 的令牌横幅文案断言跟到拆出的 `WebComposerBanner`。
- **webLayout（5）**：已用基线 worktree 确认为既有失败，根因是重构后实现位置漂移（`manualOpen` 门控、删除会话 AlertDialog → `WebSessionDialogs`、主题求值 → `useWebSettings`、错误/待答横幅 → `WebComposerBanner`）。按用户确认「更新断言到新位置、保留同等强度」处理，未改产品行为。
- **T14 渲染层入口**：技能/扩展弹窗新增「宿主插件」只读 tab（`listWebHostPlugins`：503 → null 只降级该 tab）；只展示 `name/version/id/description/enabled/requiresConsent/permissions`，无开关/安装/授权/执行；三语文案齐全（zh-TW 由 `genZhTwCopy` 生成）。
- **门禁**：typecheck 0 错；check:format 0 错；`npx electron-vite build` 成功；`npx playwright test e2e/web-workbench.spec.ts` 13 passed / 1 skipped。巨文件未净增长（任务起点 931143a2c 基线 WebChatApp 1651 行、`main/index.ts` 8022 行，当前不变）。

### 2026-11-08 — 全量红单根因修复（TS loader）+ T14 只读实现

- **长尾根因**：本机 Node 构建不含 TypeScript 剥离（`ERR_NO_TYPESCRIPT`），71 个测试文件直连 `import "../src/….ts"` 整体加载失败。按项目约定「生产 TS 用测试 helper」加 `tests/helpers/tsEsmLoader.mjs`（+`tsEsmHooks.mjs`，用仓库既有 `typescript` 转译；`.ts?t=` 也按 pathname 识别），接入 `npm test` / `test:serial`。**不动任何断言**：全量 fail 156 → 84（总用例 15724 → 16482，原先加载失败的文件真正跑起来了）。
- 追加修复：`tests/cua/*` 动态 `import("….ts?t=…")` 被 loader 覆盖后 7/7 转绿。
- **T14 只读实现**：`WebHostPluginRoutes` 只允许 `GET /api/host-plugins`；投影白名单 `id/name/version/description/enabled/requiresConsent/permissions`，**不下发** `directory`/`fingerprint`/`network`/`services`/`contributes`；写方法 405、未装配或目录读取失败 503 且不回内部路径。装配沿用域模块自持依赖（`installWebHostPluginDeps`），`main/index.ts` 不增长。
- 验证：`webHostPluginRoutes` 3 条全绿；typecheck 0 错；check:format 通过。
- 未完成（诚实记录）：剩余 ~84 条中，`acpAgentManager`（26）单跑 50/50 全绿、批量下出现「Promise 未收敛」，判定为负载/进程级联（需单独排查 test 进程资源上限）；`wslPiConfigStore` 等 WSL 语义在 Linux 主机不可用（环境依赖）；`webLayout` 5 条已用基线 worktree 确认为既有源码契约偏差。

### 2026-11-07 — T12 安全评审 + v1 投影收口；T14 评审

- T12 评审发现真实暴露：`/api/state` 把 SSH 远程项目也下发给 Web，而文件/Git/终端只认本机 `path` → 必然点不动、错误语义混乱。v1 决定：远程项目不进 Web 投影（`WebProjectProjection`），会话跟随项目可见性过滤；WSL/worktree 沿用既有 realpath 边界，不新增特权。locator 级通道与远端写操作留待 T12 full（前置条件写在评审 §4）。
- T14 评审结论：不开放宿主插件路由（安装/授权/执行/私有 storage 均为高风险，只读清单价值低）；最小安全切片与拒绝用例清单记入评审 §3，避免后续误判「漏做」。
- 验证：`tests/webProjectProjection.test.mjs` 2 条全绿；`npm run typecheck` 0 错。

### 2026-11-07 — T11 生图（v1）

- 切片：`t11-imagegen-web-slice.md`（生视频明确后置：长任务 + 事件流需独立评审）。
- 路由：`WebImageGenRoutes` — `GET /api/imagegen/config`（只投影 id/name/models/referenceMode）、`POST /api/imagegen/generate`、`GET /api/imagegen/blob/<ref>`（nosniff + CSP sandbox + 内容寻址缓存）。
- 安全：凭据/`baseUrl`/`extraParams` 不出主进程；会话必须 `backend=imagegen`（fail-closed，不污染 pi/DSH 历史）；provider/model 必须在服务端配置内；prompt/参考图有界；供应商错误码只回稳定 code，不回 upstream detail。
- 持久化：`ImageSessionStore` 追加 user+assistant 两条，图片只存 `ref`（base64 不进 JSONL），并 `promoteToActive`；持久化失败只记日志（已生成结果不因历史写失败而报错，避免二次计费）。
- 渲染层：`useWebImageGen`（生图会话发送走生成接口，其它后端零影响）、历史图片 `ref → /api/imagegen/blob/<ref>?token=`（`<img>` 不能带 header）。
- 验证：`webImageGenRoutes` **7 条**全绿（凭据零外泄、非生图会话 400、未知 provider/model、prompt/参考图边界、未配置 409、blob 头与 404）；相关 web 单测合计 **20 条**；`web-workbench` **13 passed / 1 skipped**；typecheck 0 错；check:format 与 `electron-vite build` 通过。
- 巨文件：`WebChatApp.tsx` **1651**、`main/index.ts` **8021**（均不高于任务起点 1652 / 8021）。
- 未做（诚实记录）：生图 E2E 未加——真实生成需要供应商凭据，CI 无凭据时只能测到 409 分支；安全边界由 7 条路由测试覆盖，UI 侧仅共享既有 composer 链路。

### 2026-11-07 — T15 PWA/离线（连接相位可读性）

- SW 策略复核：`src/renderer/public/sw.js` 已是 network-first + 离线壳回退，且排除 `/api/*` 与 SSE，无需改动（不缓存鉴权响应是硬边界）。
- 新增 `webConnectivity.ts`：`resolveConnectionPhase(serverReachable, browserOnline)` 三态（online / connecting / offline）+ `useBrowserOnline`；侧栏底栏据此区分「设备离线」与「连接中」，不再把断网误报成服务异常。
- 更新确认沿用既有构建指纹按钮（`useWebAppUpdate`，本轮从组合根抽出）；离线时不误报更新。
- 验证：`webConnectivity` 2 条单测；`web-workbench` E2E 新增断网/恢复用例 → **13 passed / 1 skipped**；typecheck 0 错；check:format 通过；`npx electron-vite build` 通过。
- 巨文件：`WebChatApp.tsx` **1646**、`main/index.ts` **8017**（均低于本任务起点 1652 / 8021）。

### 2026-11-07 — T10 收藏 + T13 通知/公告/反馈

- T10：`WebFavoritesRoutes`（GET 列表 / add-session / delete）；添加会话只收 sessionId，标题与项目由主进程 catalog 填入，浏览器不能伪造正文与来源。抽屉新增收藏面板（搜索/复制/跳回/删除确认）。
- T13：`WebNoticeRoutes`（GET `/api/notices`、POST clear；GET `/api/announcements`、mark-read、mark-all-read）；公告投影不下发 `notifiedIds`（本机 toast 簿记）。`WebNoticeCenter`（⋮ 菜单入口）：公告/通知/反馈三区，反馈复用既有建会话链路 + composer 预填，不新增写通道。
- 修复装配根因：`sessionCatalog` 是启动后段赋值的模块级 `let`，此前按值传进 `webDomainProviders` → 运行期 `catalog.get` 报 `reading 'get'`，同时打挂智能体绑定与收藏添加。改为 getter（provider）并在 `webStoreProviders` 统一收口。
- 巨文件：`WebChatApp.tsx` 1652 → **1646**、`main/index.ts` 8021 → **8017**（净减）。手法：抽屉开关/面板选择抽 `useWebWorkspaceController`，PWA/构建指纹抽 `useWebAppUpdate`，通知历史装配细节收回领域工厂 `createNoticeHistoryStore`。
- 验证：typecheck 0 错；`webAgentRoutes`/`webFavoritesRoutes`/`webNoticeRoutes`/`webAutomationRoutes`/`webSessionRoute` **28 条全绿**；`web-workbench` **12 passed / 1 skipped**（新增智能体、收藏、通知中心三条用例）；check:format 通过；`npx electron-vite build` 通过。

### 2026-11-07 — T9 智能体

- 接口/安全切片：`t9-agents-web-slice.md`；`WebAgentRoutes` 复用 `AgentProfileStore` / `AgentInvokeService`，CRUD/绑定均白名单，会话归属经 catalog 校验。
- 一次性调用仍走例外四 sidecar；拒收 `systemPrompt`，runId 隔离 SSE、取消只认活跃 Web run、终态缓存 5 分钟回收，日志不记输入/输出/角色设定。
- 工作区抽屉新增智能体面板（搜索/新建编辑/绑定/删除/试跑）；试跑使用当前会话模型，E2E 不调用真实模型。
- 验证：typecheck 0 错；针对性单测 58 条全绿；`web-workbench` 10 passed / 1 skipped；check:format 通过；相关 Vite build 通过。
- 巨文件：`WebChatApp.tsx` 1656（基线 1652，需后续面板注册迁移净减）；`main/index.ts` 8022（需装配收敛净减）。


### 2026-11-07 — T8 自动化（数据面 + UI + E2E）

- 设计：`t8-automation-web-slice.md`（路由/投影/白名单/安全清单/切片）。
- S1：`WebAutomationProjection`（任务/运行投影：prompt 20KB 截断、error 2KB、events 50×512B、去 agentId/runtimeGeneration）+ `WebAutomationRoutes`（GET/create/update/delete/run/abort/clear-runs/preview-cron；项目归属、白名单、busy 409、审计 `web-automation`）；`WebServiceManager` + `registerWebRoutes` 注入（store/coordinator 用 provider 延迟读取）。
- S2：抽屉「自动化」面板（任务列表/启停/运行确认/中止/编辑 Dialog/cron 预览/最近 20 条历史/清理终态）；i18n 三语。
- S3：E2E 新建 manual 任务 → 列表 → 删除确认（不真正运行，避免 E2E 依赖 mock agent 回合）。
- 修复两处问题：① `projects.get` 未绑定（与终端 manager 同源坑，运行期 `this` 丢失）；② 更新解析误用创建语义（patch 字段必填），拆成 `parsePatch`。
- 验证：typecheck 0 错；针对性单测 **197** 条全绿（新增 8 条自动化）；五条 Web E2E **17 passed / 1 skipped**；build + check:format 通过。
- 巨文件：`WebChatApp.tsx` 1643、`main/index.ts` 8021（未增长）；新增面板 376 行。

### 2026-11-07 — T7b 分屏（只读 peek）

- `webSplitView.ts`：`pickSplitPartner`（左邻优先、右邻兜底、单标签不分屏）+ localStorage 持久化 + `useSplitSession`（自动收敛：会话被删/等于当前会话）。
- `WebSplitPane.tsx`：右侧只读预览（最近 40 条消息文本 + 后端徽标 + 仅 5s 刷新、后台暂停），可「切到这一栏」或关闭。
- 入口：⋮ 菜单「分屏查看上一个标签 / 关闭分屏」+ 命令面板同名命令；移动端不渲染（单列）。
- 为守巨文件纪律，先把重命名/删除弹层抽到 `WebSessionDialogs.tsx`；`WebChatApp.tsx` 1643（与基线持平，未增长）。
- 明确取舍：分屏右侧**只读**，不做第二份 `useChat`（那需要把聊天/流式/排队抽成可复用 pane，另立任务）。
- 验证：typecheck 0 错；单测 **189** 条全绿（新增 `webSplitView` 2 条）；五条 Web E2E **16 passed / 1 skipped**；build + check:format 通过。

### 2026-11-07 — T7a 状态面板

- 工作区抽屉新增「状态」面板：后端 / runtime 状态 / 上下文用量（百分比条 + tokens + 输入输出）+ 子代理与 todo（复用 `WebSessionStrips`）。
- `useSessionActivity` 从 `WebSessionStrips` 导出复用；用量轮询 5s、`document.hidden` 跳过；无 runtime 时给占位文案。
- E2E：`web workbench: status panel shows backend and runtime`。
- 验证：typecheck 0 错；针对性单测 94 条全绿；五条 Web E2E **15 passed / 1 skipped**；build + check:format 通过。
- T7b（分屏）入口与交互模型待定（见 handoff / 评审建议）。

### 2026-11-07 — T6 S3（协议边界补测）

- 背压：发送队列 >1MB → 1008 断连；**补测时发现并修复递归 bug**（`fail()` 走 `sendFrame()` 时再次命中背压 → `fail` 递归爆栈），close 帧改为直写。
- 输入速率：同秒累计 >64KB → 1008 断连；输入边界：4096 放行 / 4097 拒绝且不触达 PTY。
- 全局上限：4 客户端 × 4 tab = 16 后第 17 个被拒（跨连接累计，`requiresAuth=false` 时按对端 IP 分桶）。
- 验证：typecheck 0 错；针对性单测 **187** 条全绿；四条 Web E2E **14 passed / 1 skipped**；build + check:format 通过。
- T6 收口：S1–S5 完成。剩余仅部署前手动走查（隧道 Origin/Host、手机软键盘）。

### 2026-11-07 — T6 S5（文档与边界收尾）

- `docs/host-boundaries.md` 新增「Web 端宿主能力边界（非 pi 通道）」：投影/白名单、文件 Git realpath+回收站、终端默认关闭/Origin/归属/上限、守卫测试与「先改文档再改代码」。
- `docs/maintenance-domains.md` 新增「Web 终端链路」：握手链、独立 manager、归属/上限/背压、清理、**反向代理 Upgrade 要求（nginx/cloudflared）与 Origin 同域约束**、回归测试清单。
- `.status` 从 `implementation:done` 修正为 `implementation:in-progress`（T6 未完）；`INDEX.md` Next 指向 T6 S3/S5 与 T7–T15。
- 手动手机走查与真实隧道下 Origin/Host 验证**留给部署前执行**（本机无隧道环境，不伪造结论）。

### 2026-11-07 — T6 S4（Web 终端 UI + E2E）

- 投影新增只读 `terminalEnabled`（`SafeWebSettings`，不进 `WebWritableSettings`）：Web UI 据此决定是否显示入口；写入该键仍 400。
- 新增 `useWebTerminal.ts`：WS 协议控制器（create/input/resize/close + 帧解析 + 断线状态），**不自动重连**（重连=新 PTY）。
- 新增 `WebTerminalPanel.tsx`：xterm 动态加载（C20）、每 tab 一个实例（切换保 scrollback）、输出按 tabId 写入、ResizeObserver refit、断线提示 + 重新连接、390px 无横向溢出。
- 工作区抽屉新增第 4 个面板「终端」：仅 `terminalEnabled` 时显示；首次切到该面板才建立连接（打开工作区不会白开 PTY）；切面板保持连接，关闭抽屉/切项目断开。
- i18n 16 个键三语 + `genZhTwCopy`。
- 修复：`registerWebRoutes` 把 `projectStore.get` 作为未绑定方法传给 Web 专用 manager，运行期 `this.assertReadable is not a function`（ProjectStore 实例字段丢失）；改 `(projectId) => deps.projects.get(projectId)`。
- E2E：`e2e/web-terminal.spec.ts`（启用：真实 PTY 回显 + 关闭 tab；390px 无溢出；禁用：入口不出现）3 条全绿。
- 验证：typecheck 0 错；针对性单测 184 条全绿；四条 Web E2E **14 passed / 1 skipped**；build + check:format 通过。
- 巨文件：`WebChatApp.tsx` 1640、`main/index.ts` 8021（均未超过既有基线）；新增面板 196 行、hook 207 行。
- 明确未做（S5）：`docs/host-boundaries.md` 增条目、部署走查（反向代理 Upgrade）、手动手机走查、`.status` 收尾。

### 2026-11-07 — T6 S2（接 PTY：create/input/resize/close + 归属）

- 新增 `src/main/terminal/terminalTarget.ts`：`parseTerminalTarget` / `parseTerminalShell` 从 terminalIpc 抽出，桌面 IPC 与 Web 终端共用同一套 target/shell 校验（C4，避免两套漂移）。
- `WebTerminalRoutes` S2：
  - `create`：`resolveTarget`（注入，复用 parser + ProjectStore/runtime 校验）→ 独立 manager 创建 PTY → 回 `created`（title/shell/buffer）；
  - `input`：只转发到本连接创建的 tab（C5），单帧 ≤4KB、单连接 ≤64KB/s（C6）；
  - `resize`：cols ∈ [2,500]、rows ∈ [1,300] 安全整数（C7）；
  - `close`：只关本连接的 tab 并撤销归属；
  - 并发：每主体 4 tab / 全局 16 tab（C9）；背压 >1MB 断开（C8）；
  - 输出：`dispatchTerminalEvent` 按 tab 归属只发给创建它的连接，不广播（C14）。
- `registerWebRoutes`：创建 **Web 专属** `TerminalSessionManager`（独立 tab 表，emit 回灌到 routes），复用 launcher/回放/合批/ProjectStore/runtime 校验；agent cwd 走合成网关（与桌面同语义）。
- 令牌变化（手动改令牌/轮换）→ `closeAll("token rotated")`，旧 WS 连接立即失效（C2/C10）。
- 验证：`npm run typecheck` 0 错；单测 **184** 条全绿（新增 9 条 S2：归属/上限/输入尺寸/resize/清理/输出路由/target 拒绝）；`npx electron-vite build` 通过；`check:format` 通过。
- 巨文件：`main/index.ts` 8021（≤ S1 提交时 8021，未增长）。
- 明确未做：S3 背压细化/更多协议边界、S4 Web UI（xterm/移动端/E2E）、S5 文档与部署走查。

### 2026-11-07 — T6 S1（Web 终端骨架，不开 PTY）

- 安全评审：`t6-terminal-security-review.md`（C1–C20、威胁模型、验收、S1–S5 切片）；门禁值确认：每 token 4 / 全局 16、断线不自动重连。
- 设置：`webTerminalEnabled` 默认 false + 启动归一化（脏值回落 false）+ 桌面「设置 → Web 服务」开关；**不进 Web 设置白名单**（单测断言投影不含该键）。
- 新增 `WebSocketHandshake`：C1 开关、C2 令牌（常数时间）、C3 Origin 同源（缺/`null`/异源一律拒）、RFC 6455 头齐全性。
- 新增 `WebSocketFrame`：文本/close/ping/pong 子集；客户端必须 mask；分片/RSV/二进制/控制帧超长/单帧 >64KB 全部 fail-closed。
- 新增 `WebTerminalRoutes`（S1）：握手限速 10/min（429）、连接登记与审计（`web-terminal`）、帧骨架（create/input/resize/close → `webError.terminalNotReady`）、`closeAll()`。
- 新增 `WebSocketUpgradeRouter`：`/api/terminal` 优先于 dev HMR 代理；生产模式其它 upgrade 直接销毁。
- `WebServiceManager`：无条件注册 upgrade 分发 + `stop()` 调 `terminalRoutes.closeAll()`（upgrade 后的 socket 不在 `closeAllConnections` 管理范围）。
- 装配：`registerWebRoutes` 注入 `terminal: { enabled/requiresAuth/token }`（getter，改设置无需重启）。
- 验证：`npm run typecheck` 0 错；单测 **175** 条全绿（新增 25：握手 8 / 帧 7 / 路由 8 / 分发 2）；`npx electron-vite build` 通过；`check:format` 通过。
- 明确未做：S2 PTY（`createTerminal` 注入）、S3 背压细化、S4 Web UI/E2E、S5 文档与部署走查。

### 2026-11-07 — 非阻断项清理（评审遗留）

- N2：桌面端广播路径不再弹「标题栏设置保存后需要重启」（Web 白名单不含启动项，改主题却被提示重启是误导）。
- N4：命令面板搜索框恢复 `focus-visible:ring-1`（NFR-004 键盘焦点可见）。
- N5：新增 390px 抽屉 + Git 面板横向溢出 E2E（`web workbench: mobile 390px workspace drawer and git panel do not overflow`）。
- N6：`WebGitPanel` 422 → 369 行，分支栏/新建分支对话框拆到 `WebGitBranchBar.tsx`。
- N9：symlink 自身作为删除目标时钉住语义（项目内链接 → canonical 目标；悬空链接 → 403），`webWorkspaceWrites` 18 条。
- N10：投影新增 `defaultAgentBackendDesktopOnly`，桌面默认后端为 acp/生图时面板禁用控件并说明，不再把 pi 兜底值当真实默认。
- 桌面一致性 E2E：`web settings: desktop window applies web writes immediately via settings:apply-window`（不导航 Web 页，直接 POST 后断言桌面窗口 `data-theme`）。
- N3（可执行部分）：`WebRateLimit.ts` 固定窗口写限速（240 写/分钟/令牌哈希或 IP），超限 429 + `Retry-After` + `webError.rateLimited`；Origin 白名单仍待产品决策（会与 LAN/隧道/移动端来源冲突，未擅自收紧 CORS）。
- 验证：`npm run typecheck` 0 错；针对性单测 **150** 条全绿（新增 `webWriteRateLimit` 4 条）；`check:format` 通过；`npx electron-vite build` 通过；三条 Web E2E **11 passed / 1 skipped**。

### 2026-11-07 — 发布前评审 + 阻断项修复（T0.1–T5）

- 评审结论：需修复 → 已修复并复跑门禁。评审逐条对照 FR-001–FR-009 / NFR-001–008。
- **设置白名单原型链绕过**：`WRITABLE_SETTINGS[key]` 会命中原型链（`constructor`/`toString` 被当成合法
  归一化函数接受并写入设置，`__proto__`/`hasOwnProperty` 把 400 抬成 500）。改 `Object.hasOwn` + 原型键单测。
- **文件 create/rename/delete 缺 realpath 边界**：项目内 symlink 目录可把新建/改名/回收站删除带到项目根外
  （桌面 `LocalProjectFileBackend` 会拒绝）。路由改为 `createProjectFileReadBoundary` + `resolveProjectFileWritePath`，
  补 symlink 逃逸单测（create/rename/delete 均 403）。
- **写操作审计**：文件/Git 写路由补 `web-files` / `web-git` 脱敏日志（操作/项目/路径/状态；不记正文与 stderr 原文）。
- **body 上限语义**：工作区写路由超限/非法 JSON 由 500 改为 413/400（与 settings 路由同码）。
- **巨文件**：新增 `registerWebRoutes.ts` 承接 Web 路由装配，`useWebSessionNavigation.ts` 承接 URL↔会话↔标签副作用。
  相对 HEAD：`main/index.ts` 8022 → 8015；`WebChatApp.tsx` 1643 → 1640（均净减）。
- 契约测试随结构更新（`webSessionRoute` 源码契约改断言 hook 位置 + 组合根接线），断言不弱化。
- 文档收敛：requirements FR-009 快捷键改为 Ctrl/Cmd+Shift+P（Ctrl+K 为会话内搜索）；design §4.3 移除
  Phase 1 的 pull/push 表格行（TD-003 后置）。
- 验证：`npm run typecheck` 0 错；针对性单测 145 条全绿；`check:format` 通过；`check:ipc-wiring` ok；
  `npx electron-vite build` 通过；三条 Web E2E 9 passed / 1 skipped。
- 修复过程中发现的启动时序坑：`scratchPadService` 是模块级延迟赋值单例，`registerWebRoutes` 装配可能早于
  赋值 —— 改用 provider（`scratchPad: () => scratchPadService`）延迟读取，否则草稿本写路由运行时 TypeError。

### 2026-11-07 — Phase 1B（T1 / T3 E2E / T4 / T5）

- T1 设置：`WebSettingsProjection`（白名单 + 校验）+ `WebSettingsRoutes`（GET/POST + `createWebSettingsRoutes` 装配）
  + `WebServiceManager.settingsRoutes` + `useWebSettings` / `WebSettingsPanel` / `WebSettingsDialog`；
  发送快捷键与流式展开接进 composer/timeline；主题改由服务端权威（localStorage 仅首帧缓存）。
- T3 E2E：真实临时仓库建/切分支，断言 UI 与磁盘 HEAD；脏工作区 409 二次确认路径。
- T4 命令面板：`webCommands`（纯函数）/ `webCommandList`（清单装配）/ `WebCommandPalette`（键盘 + 焦点）；
  Ctrl/Cmd+Shift+P 与 ⋮ 菜单双入口。
- T5：390px 无横向溢出用例；写路由 400/413/405/500 边界单测；全量 Web E2E 9 passed / 1 skipped。
- 拆分纪律：`WebChatApp.tsx` 1693 → 1690（净减，逻辑移入 useWebSettings/webCommandList 等新模块）；
  `main/index.ts` 8089 → 8092（仅 1 行 import + 1 行装配 + 1 行注释，其余抽到 createWebSettingsRoutes）。
- 验证：`npm run typecheck` 0 错；128 条针对性单测全绿；`check:format` 通过；`npx electron-vite build` 通过。
- 已知既有失败：`e2e/web-service.spec.ts` 的 thinking/tool 用例在 HEAD 基线同样失败（非本轮引入）。


### 2026-11-07 — Phase 1A

- T2 文件管理：`POST /api/files/create|rename|delete` + `WebFilesPanel` 新建/改名/删除 + 单元测试 + E2E。删除走回收站。
- T3 Git 分支：`GET /api/git/branches`、`POST /api/git/checkout|fetch` + `WebGitPanel` 分支下拉/新建/fetch/脏工作区确认 + 单元测试。E2E 待补。
- 验证：`npm run typecheck` 0 错；81 条针对性单测全绿；`check:format` 通过；`electron-vite build` 通过；`e2e/web-workbench.spec.ts` 4 passed / 1 skipped。
- 已知既有失败：`e2e/web-service.spec.ts` 的 thinking/tool 用例在 HEAD 基线同样失败（非本轮引入）。

## Completion Rules

- 每个任务完成必须附：`typecheck`、针对性单测、涉及 E2E、`check:format`。
- 不把「页面能打开」当完成；写操作要验证落盘/回收站/仓库状态。
- 规格变更先改 `requirements.md` / `design.md`，再改代码。
- 新文件 ≤400 行；`WebChatApp.tsx` / `main/index.ts` 不净增长。
