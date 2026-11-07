# Feature: PiDeck Web 与桌面端页面/功能对齐

> Status: Draft → Approved（用户 2026-11-07 指示先落 spec 后继续）
> Source: 用户需求（Web 日常使用，尽可能齐全）+ 现有 `docs/architecture.md` / `AGENTS.md`
> Last Updated: 2026-11-07

## Overview

PiDeck Web 是用户在手机/平板/其他电脑上日常使用 PiDeck 的入口。桌面端已经覆盖多项目、会话时间线、文件/Git、终端、自动化、智能体、收藏、设置、远程项目等完整工作台；Web 端当前已有聊天主链路与第一波工作台（多标签、文件编辑、Git stage/commit、草稿本），但仍缺少设置、文件管理、Git 分支、终端、自动化、智能体、收藏等页面。

本 spec 定义**整个 Web 对齐路线**：先补齐日常高频能力，再按安全边界逐波开放高风险能力（终端、远程、插件）。所有能力必须复用主进程既有服务与 `shared/` 契约，**不得新增第二条 pi↔PiDeck 通道**，不得把 Web 变成任意文件/命令/宿主控制通道。

## Business Context

- **Problem:** 用户主要在 Web 上使用 PiDeck，但桌面端的大量日常入口在 Web 上缺失，导致频繁切回桌面。
- **Users:** 单一高级用户（冰神）+ 未来可能的 LAN 远程使用者。
- **Value:** 在浏览器里完成 80% 以上的日常开发操作；移动端可完成查看、回复、轻编辑与 Git 提交。
- **Success signal:** 用户连续一周只在 Web 端工作，不需要为了设置/文件管理/Git 分支/终端切回桌面。

## Goals

- 页面结构与桌面工作台对齐：会话标签、工作区抽屉、设置、终端、自动化、智能体、收藏。
- 高频操作在 Web 上可直接完成：改设置、建/改名/删文件、切分支、stage/commit、终端命令。
- 保持移动端可用：390px 视口无横向溢出，触控目标 ≥ 32px，底部安全区。
- 每个阶段都有单测/API 边界测试/E2E，不引入「先合再修」。

## Non-Goals / Out of Scope

- 桌面专属系统集成：原生窗口控件、托盘、桌宠、壁纸、全局划词、系统级快捷键、CUA 桌面输入。
- 在 Web 端执行任意宿主 JS/shell/文件系统访问；不得绕过项目根/安全等级边界。
- 重新设计 PiDeck 视觉语言；沿用 `DESIGN.md` 与现有 Web token。
- 一次性重写全部 Web 组件；按域抽模块，存量巨文件不得净增长。
- 团队多租户/账号体系；当前仍是单用户 + Web token。

## User Stories

### US-001: 日常会话与工作台

**As a** Web 用户  
**I want to** 打开多个会话、切换标签、查看历史、编辑文件、提交 Git  
**So that** 不离开浏览器就能完成一次完整开发回合

**Acceptance Criteria:**
- [x] 多标签持久化、关闭落点、状态点、移动端可用
- [x] 文件树、文件预览/编辑、Git 变更/diff/log、stage/commit
- [x] 草稿本自动保存、刷新读回

### US-002: 改设置

**As a** Web 用户  
**I want to** 在 Web 上调整外观、会话默认值、输入行为  
**So that** 不必为了一个主题或默认模型切回桌面

**Acceptance Criteria:**
- [ ] 外观（明暗/主题色/字号）、会话默认（后端/模型/思考/权限）、输入行为可改
- [ ] 保存后立即生效；刷新后保持；非法值被服务端拒绝
- [ ] 不暴露 token、密钥、供应商凭据、宿主路径

### US-003: 文件管理

**As a** Web 用户  
**I want to** 新建文件/目录、重命名、删除（回收站）  
**So that** 不必为一次小改动打开桌面端

**Acceptance Criteria:**
- [ ] 项目内新建/重命名/删除；删除走系统回收站
- [ ] 越界路径、覆盖已有文件、删除项目根被拒绝
- [ ] 操作后文件树刷新；失败有结构化错误

### US-004: Git 分支

**As a** Web 用户  
**I want to** 查看/切换/新建分支、fetch/pull/push  
**So that** 能在 Web 上完成分支级工作流

**Acceptance Criteria:**
- [ ] 分支列表/当前分支/切换/新建
- [ ] 有未提交改动时切换给出明确确认/拒绝
- [ ] fetch/pull/push 有确认、超时和错误呈现；凭据不落日志

### US-005: 终端

**As a** Web 用户  
**I want to** 在浏览器里打开项目终端  
**So that** 不必切回桌面执行命令

**Acceptance criteria（Phase 2）:**
- [ ] 仅显式开启后可用；按项目/会话创建；多终端；resize
- [ ] 断开/刷新后可重连或明确提示；退出清理
- [ ] 不暴露任意宿主 shell；命令输入只进入 PTY

### US-006: 自动化/智能体/收藏

**As a** Web 用户  
**I want to** 管理定时任务、智能体、收藏  
**So that** Web 端是完整工作台而不是聊天窗口

**Acceptance criteria（Phase 3）:**
- [ ] 列表/详情/创建/编辑/启停/运行历史
- [ ] 与桌面同一份存储；写入边界与桌面一致
- [ ] 空态/加载/错误/权限不足可读

## Functional Requirements

### FR-001: 多标签工作台 — Must Have（已交付）

WHEN 用户打开两个及以上会话  
THE SYSTEM SHALL 显示可横向滚动的会话标签栏，并持久化标签顺序  
SO THAT 刷新/分享后仍能回到同一组会话。

### FR-002: 工作区抽屉 — Must Have（已交付）

WHEN 用户打开工作区  
THE SYSTEM SHALL 提供文件/Git/草稿本三面板，并在桌面端与聊天并排、移动端全屏覆盖。

### FR-003: 文件编辑 — Must Have（已交付）

WHEN 用户打开项目内文本文件并选择编辑  
THE SYSTEM SHALL 允许保存，保存前校验路径在项目内、内容 ≤2MB、磁盘 mtime 未变化（冲突需确认）。

### FR-004: 草稿本 — Must Have（已交付）

WHEN 用户在草稿本输入  
THE SYSTEM SHALL 1.2s 自动保存，切面板/关抽屉时补写未落盘内容，并在项目/全局作用域间隔离。

### FR-005: Git 最小写入 — Must Have（已交付）

WHEN 用户点击 stage/unstage/commit  
THE SYSTEM SHALL 只执行对应 Git 命令，拒绝绝对路径与 `..`，不开放 discard/reset/push。

### FR-006: 设置读写 — Must Have（Phase 1）

WHEN Web 用户打开设置  
THE SYSTEM SHALL 返回 Web 安全投影（主题、字号、会话默认、输入行为等白名单字段）  
AND SHALL 只接受白名单字段的写入，忽略/拒绝其余字段  
SO THAT 浏览器不能改安全策略、凭据、CUA、终端开关等高风险设置。

### FR-007: 文件管理 — Must Have（Phase 1）

WHEN 用户在项目内新建/重命名/删除文件或目录  
THE SYSTEM SHALL 在项目根边界内执行，删除走系统回收站，拒绝覆盖已有目标与删除项目根。

### FR-008: Git 分支操作 — Should Have（Phase 1）

WHEN 用户查看/切换/新建分支  
THE SYSTEM SHALL 返回分支列表并在切换前检查工作区状态；push/pull/fetch 需要显式确认与超时。

### FR-009: 命令面板与快捷键 — Should Have（Phase 1）

WHEN 用户按 Ctrl/Cmd+Shift+P 或从 ⋮ 菜单打开命令面板（Ctrl/Cmd+K 保留为会话内搜索）
THE SYSTEM SHALL 提供会话切换、标签操作、面板打开、设置跳转、主题切换等命令，并支持键盘导航。

### FR-010: 终端 — Must Have（Phase 2）

WHEN 终端功能被显式开启且用户打开终端  
THE SYSTEM SHALL 为该会话创建 PTY，经受鉴权的 WebSocket/SSE 通道双向传输，支持 resize 与退出清理。

### FR-011: 分屏/状态面板 — Should Have（Phase 2）

WHEN 用户需要并排查看两个会话或查看会话状态  
THE SYSTEM SHALL 提供分屏与状态/活动面板，且不破坏移动端单列布局。

### FR-012: 自动化 — Should Have（Phase 3）

WHEN 用户打开自动化页  
THE SYSTEM SHALL 列表/创建/编辑/启停/查看历史，复用 `AutomationStore` 与 scheduler。

### FR-013: 智能体 — Should Have（Phase 3）

WHEN 用户打开智能体页  
THE SYSTEM SHALL 列表/编辑/绑定会话/一次性调用，复用 `AgentProfileStore` 与 `AgentInvokeService`。

### FR-014: 收藏 — Should Have（Phase 3）

WHEN 用户打开收藏页  
THE SYSTEM SHALL 列表/搜索/复制/跳回来源会话，复用 `FavoritesStore`。

### FR-015: 生图/生视频 — Could Have（Phase 3）

WHEN 用户选择 imagegen/videogen 后端  
THE SYSTEM SHALL 在 Web 上展示生成参数、进度与产物；供应商密钥只在主进程使用。

### FR-016: 远程/WSL/Worktree — Could Have（Phase 4）

WHEN 用户使用远端项目/WSL/worktree  
THE SYSTEM SHALL 按现有 locator/权限模型展示与操作；不允许 Web 绕过本机项目边界。

### FR-017: 通知/公告/反馈 — Should Have（Phase 4）

WHEN 用户打开通知中心/公告/反馈  
THE SYSTEM SHALL 复用现有 store 与服务；反馈新建会话走既有会话创建链路。

### FR-018: PWA/离线/移动端 — Must Have（Cross-cutting）

WHEN 用户在移动端或弱网使用  
THE SYSTEM SHALL 不横向溢出、保留安全区、断线可恢复、构建更新需用户确认。

### FR-019: 安全与鉴权 — Must Have（Cross-cutting）

WHEN 任意 Web 写操作到达服务端  
THE SYSTEM SHALL 校验 token、输入类型/长度/路径、项目归属与安全等级；失败返回结构化错误；日志不含凭据/正文。

### FR-020: 宿主插件 — Could Have（Phase 4）

WHEN 用户查看宿主插件  
THE SYSTEM SHALL 只展示安全投影；安装/执行/权限提升不在 Web 开放（除非单独安全评审）。

## Non-Functional Requirements

### NFR-001: 安全 / 隐私

- 写操作必须 fail-closed；路径规范化 + realpath + 项目根边界。
- Web token 默认开启；CORS/Origin 与速率限制在路由层收口。
- 不得在响应/日志中出现 token、密钥、供应商凭据、会话正文以外的敏感数据。

### NFR-002: 兼容 / 契约

- 复用 `shared/types` 与既有主进程服务；新 IPC 通道三处同步（如新增）。
- 不新增 pi↔PiDeck 通道；不扩 `pideck-cua`/`pideck` MCP 工具面。

### NFR-003: 性能

- `/api/state` 继续条件请求；新增轮询接口必须有 ETag/去抖/上限。
- 大会话不全量下发；文件读取 ≤2MB（截断预览 512KB）；草稿 ≤1MB。

### NFR-004: 可用性 / 无障碍

- 390px 视口无横向溢出；触控目标 ≥32px；键盘焦点可见；`prefers-reduced-motion` 尊重。
- 关键状态（加载/空/错误/冲突/离线）都有文案与恢复入口。

### NFR-005: i18n

- 文案只走 `rendererCopy.*`；zh-CN/en-US 同步；zh-TW 由 `scripts/genZhTwCopy.mjs` 生成。

### NFR-006: 可测试性

- 纯规则抽纯函数配 `tests/*.test.mjs`；路由边界用假 deps 单测；关键路径补 E2E。
- 合并门禁：`npm run typecheck` + 改动涉及的针对性测试全绿。

### NFR-007: 可靠性

- 断线重连、流式恢复、令牌失效提示保持现有语义；新增长连接必须有清理与超时。

### NFR-008: 可观测性

- 写操作/失败/拒绝记主进程日志（脱敏），便于排查「点了没反应」。

## Constraints

- 现有 Web 端是独立 Vite 入口，复用桌面样式与 `shared/`；不得把桌面 Jotai 状态搬进 Web。
- 主进程 `WebServiceManager` / `WebWorkspaceRoutes` / `WebApiRoutes` 是路由入口；新增路由必须接鉴权链。
- 巨文件纪律：新文件 ≤400 行；`WebChatApp.tsx` / `main/index.ts` 不得净增长（新逻辑放新模块）。
- 部署由 `scripts/deploy-web.mjs` / systemd `pideck.service` 负责；不自动部署。

## Decisions

### D-001: 复用主进程服务，不在 Web 重写领域逻辑

**Decision:** 设置/文件/Git/终端/自动化等一律经主进程既有 Manager/Service，Web 层只做投影与校验。  
**Reason:** 避免双份边界与状态分叉（草稿本已用 `ScratchPadService` 验证）。  
**Source:** 用户长期要求 + `docs/architecture.md`。

### D-002: 写操作按阶段开放

**Decision:** Phase 1 只开设置、文件管理、Git 分支/commit；终端 Phase 2；远程/插件 Phase 4。  
**Reason:** 高风险能力需要独立安全评审与清理路径。  
**Source:** 用户「尽可能齐全」+ 安全边界。

### D-003: 设置白名单

**Decision:** `/api/settings` 只暴露/接受明确白名单；安全策略、凭据、CUA、终端开关不在此通道。  
**Reason:** 浏览器不应成为提权入口。  
**Source:** `docs/security` 与现有 IPC 边界。

### D-004: 终端显式开启 + 会话归属

**Decision:** 终端需要独立设置开关与项目/会话归属；PTY 只接受用户输入，不执行任意宿主命令拼接。  
**Reason:** 终端是最高风险面，必须可关闭、可审计、可清理。

## Success Metrics

| Metric | Target / Signal | Notes |
|--------|-----------------|-------|
| Web 日常任务覆盖 | ≥80% 的桌面高频操作可在 Web 完成 | 以本 spec FR 清单为准 |
| 回归 | 每阶段 typecheck + 针对性测试全绿 | 不新增红项 |
| 移动端 | 390px 无横向溢出 | E2E |
| 安全 | 写路由边界测试覆盖 | 每条新写路由至少 3 个拒绝用例 |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 终端/远程暴露宿主能力 | High | 独立开关、token、会话归属、清理、审计；Phase 2 单独评审 |
| 设置白名单漏字段 | High | 明确 allowlist + 单测拒绝未知字段 |
| 文件写覆盖用户改动 | Medium | mtime 冲突检测 + 回收站删除 |
| Web 端组件继续膨胀 | Medium | 新文件拆分；巨文件不净增长 |
| 移动端交互退化 | Medium | 每阶段 390px E2E + 触控目标检查 |

## Glossary

- **Web 投影:** 主进程为浏览器裁剪后的安全数据形状，不含宿主路径/密钥。
- **写入边界:** 项目根 + realpath + 回收站 + 大小上限。
- **接力:** 用 handoff 文件把当前状态、下一步、失败路径交给下一个会话。

## Open Questions

- 设置页第一版是否包含供应商登录/模型目录更新？（默认不包含，单独评审）
- Git push/pull 是否在 Phase 1 开启，还是只做 fetch/分支切换？（默认只做 fetch + 分支切换，push/pull 留到 Phase 1.5）
- 终端优先实现 PTY 还是只读命令面板？（默认 PTY，但必须显式开启）
