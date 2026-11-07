# T6 Web 终端 — 安全评审（实施前）

> Status: **S1–S5 已实施（2026-11-07）**：开关 + 握手四校验 + 帧协议 + 独立 manager 接 PTY + Web UI/E2E + 边界补测/文档；剩部署前手动走查（隧道 Origin、手机软键盘）。
> Scope: `tasks.md` T6 / `design.md` §4.6 / `requirements.md` FR-010、NFR-001、NFR-007
> Last Updated: 2026-11-07

## 0. 结论

**可以做，但不能按「把桌面 TerminalDock 接到 WebSocket 上」直接做。** 桌面终端现有的所有信任前提
（Electron 渲染进程、IPC sender 绑定、单机单用户）在浏览器侧全部失效。建议按本文 C1–C20 实施，
其中 **C1（默认关闭）、C3（Origin 同源校验）、C4/C5（会话归属 + tab 归属）、C8（背压）、C10（生命周期清理）**
是进入 S2 的硬门槛；缺任何一条不建议开启开关。

## 1. 现状事实（代码证据）

| 事实 | 证据 |
|---|---|
| 终端管理已有完整实现，cwd 只从可信 store 解析，永不接受路径 | `TerminalSessionManager.cwdFor`：`getAgentCwd(agentId)` / `projectStore.get(projectId)`；拒绝 chat 项目、拒绝远端项目 |
| shell 走平台候选表，不接受任意命令 | `TerminalSessionLauncher.getTerminalShellCandidates` + `parseTerminalShell` 枚举（9 个值） |
| 输入/尺寸/关闭都直达 PTY，无命令解析 | `TerminalSessionManager.input/resize/close` |
| 输出有回放缓冲与合批上限 | `terminalReplayBuffer` 200K 字符/分段压实；`terminalDataBatching` 16ms / 64K 字符 |
| 输出通过**全局 IPC 广播**发出 | `TerminalSessionManager` 构造注入 `emit`，`emit(ipcChannels.terminalData, …)` 发给所有窗口 |
| IPC 侧已有 target 校验与 remote sender 释放范式 | `terminalIpc.parseTerminalTarget` / `requireTerminalTarget` / `remoteSender`；`RemoteTerminalSessionManager.releaseSender` |
| Web 服务**生产模式没有 upgrade 监听**，只有 dev HMR 代理 | `WebServiceManager.start`：`if (this.staticAssets.devRendererUrl) server.on("upgrade", …)` |
| Web 侧已有令牌链、写限速、SSE | `WebTokenAuth`（Bearer 全方法、GET 可 query token）、`WebRateLimit`（240 写/分钟）、`WebStateEventHub` |
| 不存在 `webTerminalEnabled` 设置项 | `grep webTerminalEnabled src/` 无结果；`settings.ts` 只有终端外观类字段（theme/font/scrollback…） |
| Web 端尚无 xterm 组件，但依赖已在 | `@xterm/xterm@6` + addons 在 `package.json`（桌面用） |

## 2. 威胁模型

| # | 攻击者 | 能力 | 目标 |
|---|---|---|---|
| T1 | 无 token 的 LAN/公网扫描器 | 能连端口 | 绕过鉴权开 PTY |
| T2 | 拿到 token 的恶意页面（浏览器） | 受害者浏览器可发起同源/跨源 WS | CSRF 式开终端（WS 无 CORS 预检） |
| T3 | 持 token 的低权用户 | 合法 API | 越权操作别人的 tab/项目（串台） |
| T4 | 持 token 的高频客户端 | 大量帧 | 打爆主进程（无限 PTY/输出洪水/超大帧） |
| T5 | 本地其他进程 | 本机 socket | 伪造 Origin/Host 绕过同源校验 |
| T6 | 日志/错误回显 | 读主进程日志 | 从日志拿到命令内容、宿主路径、token |
| T7 | 断线/刷新/服务重启 | 生命周期事件 | 孤儿 PTY 进程泄漏 |

## 3. 控制项（必须落地）

| # | 控制 | 实现点 | 验证 |
|---|---|---|---|
| **C1** | 开关默认关闭，且**不进 Web 设置白名单**：只有桌面设置能开 | `shared/types/settings.ts` 新增 `webTerminalEnabled: boolean`（默认 `false`）；`WebSettingsProjection` 的 `WRITABLE_SETTINGS` **不登记**；Web 面板不渲染 | 单测：白名单投影不含该键、POST 该键 400 |
| **C2** | 握手鉴权复用现有令牌链（WS 握手是 GET → 允许 `?token=`，与 `/api/events` 同规则）；过期/轮换后新连接 401、旧连接主动关闭 | `WebTokenAuth.isAuthorized`；`rotate()` 后遍历 Web 终端连接 `close(1008)` | 单测 + E2E：错误 token 401 |
| **C3** | **Origin 同源校验**（WS 不受 CORS 保护）：`Origin` 必须存在且 host:port 与 `Host` 一致；`Origin: null` 拒绝；缺失 Origin 拒绝 | 新增 `WebTerminalRoutes` 握手层；不引入白名单配置（LAN/隧道下同域成立） | 单测：缺 Origin/异源/null → 403；E2E：同源可连 |
| **C4** | 会话/项目归属只接受可信 target，复用 IPC 的 parser（抽 `parseTerminalTarget` 到共享模块，禁止复制第二份） | `terminalIpc.parseTerminalTarget` → `src/shared/terminalTarget.ts`；agent target 额外走 `sessionRuntimeCoordinator.validateTarget` | 单测：伪造 `{kind:"project", cwd:"/etc"}` → 400；未知 projectId → 404 |
| **C5** | tab 归属：连接只可操作自己创建的 tab；跨连接 tabId → 拒绝 + 审计 | 连接级 `Map<connectionId, Set<tabId>>` | 单测：A 连接输入 B 的 tabId → 拒绝 |
| **C6** | 输入只 `pty.write`，不做命令解析/拼接；单帧 `data` ≤ 4KB，超限拒绝；单连接输入速率上限（令牌桶 64KB/s，突发 4×） | 握手后帧校验；复用 `WebRateLimit` 思路（新增 token bucket） | 单测：5KB 帧拒绝；超速断连 |
| **C7** | resize 入参严格：`cols ∈ [2,500]`、`rows ∈ [1,300]`、安全整数；非法拒绝（不静默钳制） | 帧校验层 | 单测：0/NaN/1e9 → 拒绝 |
| **C8** | 输出背压：`socket.bufferedAmount > 1MB` → 丢弃输出并提示（或断开），禁止无限缓冲 | WS 发送函数 | 单测：假 socket 累计字节超限 → 停止发送 |
| **C9** | 并发上限：每 token ≤ 4 tab、全局 ≤ 16 tab、每连接 1 target；超限拒绝并可读提示 | `WebTerminalRoutes` 计数 | 单测：第 5 个 tab 拒绝 |
| **C10** | 生命周期：连接 close/error → 关闭该连接全部 tab；服务 `stop()` → `closeAll` + 销毁 upgrade socket；`quitCleanup` 已注册 web-service | `WebServiceManager.stop` 增 Web 终端清理；参考 `staticAssets.destroyHijackedSockets` | 单测：close 事件触发全清；集成：stop 后 socket 关闭 |
| **C11** | 审计：`web-terminal` 命名空间记 create/close/reject（target、tabId、原因）；**不记**按键内容、输出正文、token | `getAppLogger()?.info` | 源码契约测试：无 `data`/`token` 字段进入日志 |
| **C12** | 错误脱敏：只回 `{code, message}`；不回 cwd 绝对路径（tab 标题沿用 manager 的目录名截断语义） | 帧错误处理器 | 单测：错误帧不含 `/home` |
| **C13** | 不新增 pi↔PiDeck 通道：Web 终端只走主进程 TerminalSessionManager/Launcher，不碰 pi RPC/MCP/扩展 | 架构约束 | 评审（`docs/host-boundaries.md` 增一条） |
| **C14** | **不复用桌面 manager 的 emit**：Web 用独立 `TerminalSessionManager` 实例（`new TerminalSessionManager(getAgentCwd, webEmit, projectStore, getSettings)`），tab 表与桌面隔离；复用 Launcher/回放/合批 | `registerWebRoutes` 装配处新增实例 | 单测：Web emit 不触达桌面 `ipcChannels.terminalData` |
| **C15** | 帧协议：仅文本 JSON；`type ∈ {input,resize,close,ping}`；未知 type/二进制帧/非 JSON → 关闭连接（1003/1008）；单帧 ≤ 64KB | 解析层 | 单测：二进制帧 → 1003 |
| **C16** | 移动端：软键盘 + `visualViewport` resize + 底部安全区；断线**不自动重建** PTY（提示「终端已断开，请重新打开」）；关闭前用 `frontProcess` 提示有进程在跑 | `WebTerminalDock` | E2E 390px + 手动手机走查 |
| **C17** | WS 握手限速：每 token ≤ 10 次/分钟（复用限速器思路），防止反复握手打爆 spawn | `WebTerminalRoutes` | 单测：第 11 次 429 |
| **C18** | 关闭确认：有前台进程时二次确认（与桌面 `terminalConfirmClose` 同语义） | Web UI | E2E：运行 `sleep` 后关闭 → 弹确认 |
| **C19** | 部署：反向代理必须透传 `Upgrade`/`Connection`；`pideck.service` 8765 常驻，E2E 继续用 88xx 隔离 | `docs/maintenance-domains.md` 部署段 | 部署前手动验证 cloudflared/nginx |
| **C20** | 依赖：`@xterm/xterm` 动态 import（不进 Web 首屏 bundle）；addon 只用 fit/web-links（不启用 webgl，移动端兼容性） | `WebTerminalDock` | 构建产物检查：首屏 chunk 不含 xterm |

## 4. 数据流（建议）

```
浏览器 WebTerminalDock
  ↕ WS /api/terminal?token=…&target=<b64 json>
WebServiceManager.handleUpgrade
  ├─ C2 token / C3 Origin / C17 握手限速
  ├─ C4 target 解析（复用 IPC parser + runtime validateTarget）
  └─ WebTerminalRoutes(connection)
        ├─ create → WebTerminalManager(独立实例).create(target, shell)   // C9 上限
        ├─ input  → manager.input(tabId, data)                          // C6/C5
        ├─ resize → manager.resize(tabId, cols, rows)                   // C7
        ├─ close  → manager.close(tabId)                                // C5
        └─ 输出：manager emit(webEmit) → 连接内 tabId 路由 → WS send      // C8 背压
```

## 5. 与桌面终端的关系（决定：隔离，不共享）

- **共享 manager 不可行**：manager 单例的 `emit` 是构造期注入的全局广播，Web 连接无法只收自己的输出；
  给 manager 加多 listener 会把「IPC 广播」语义改成「多路复用」，影响桌面既有链路（回归面大）。
- **独立实例**：Web 侧自建 `TerminalSessionManager`，共用 `TerminalSessionLauncher`/回放/合批/`ProjectStore`/
  `SessionRuntimeCoordinator`。代价是同一 agent 在桌面与 Web 各有一个 shell —— 这正是期望行为
  （不同客户端的终端本就该独立），且天然避免跨端串台与 IPC 泄漏。

## 6. 验收清单（DoD）

- 单测（新增 `tests/webTerminalRoutes.test.mjs`，假 deps）：
  - 开关关闭 → 握手 403；token 错 → 401；缺/异源 Origin → 403；握手超频 → 429
  - target 伪造（含 cwd/path/未知 projectId）→ 400/404；跨连接 tabId → 拒绝
  - 帧：非 JSON / 二进制 / 未知 type / 超大 input / 非法 resize → 关闭或拒绝
  - 上限：第 5 个 tab、第 17 个全局 tab、输入超速 → 拒绝
  - 清理：连接 close → 该连接 tabs 全关；token 轮换 → 连接关闭
- E2E（`e2e/web-terminal.spec.ts`，新端口 8881）：
  - 开关关闭时入口隐藏 + 直连 WS 被拒
  - 开启后打开终端 → `echo hi` 回显 → 关闭 → tab 消失
  - 390px 软键盘/无横向溢出；断线提示可见
- 手动：cloudflared 隧道下握手成功（C3 同源校验不被代理破坏）；`pideck.service` 重启后无孤儿 PTY（`pgrep -f` 检查）

## 7. 实施切片（每片独立可验证，禁止一次落全量）

1. **S1 骨架**：`webTerminalEnabled` 设置 + `WebServiceManager.handleUpgrade` 分发 + 握手四校验（C1/C2/C3/C17）+ 审计 + 单测。**不开 PTY**。
2. **S2 单 tab**：独立 manager 实例 + create/input/resize/close + 清理（C4/C5/C6/C7/C10/C12）+ 单测。
3. **S3 上限与背压**：并发上限、输出背压、帧协议收紧（C8/C9/C15）+ 单测。
4. **S4 Web UI**：xterm 动态加载、多 tab、移动端、断线提示、关闭确认（C16/C18/C20）+ E2E。
5. **S5 收尾**：`docs/host-boundaries.md` 增条目、部署注意、手动走查、`.status` 与 tasks 状态更新。

## 8. 未决问题（需冰神拍板）

1. 开关位置：桌面「设置 → Web 服务」区新增「允许 Web 终端」？命名 `webTerminalEnabled` 可以吗？
2. 并发上限取值：每 token 4 / 全局 16，是否够用？
3. 断线重连：默认不自动重建 PTY（手动重开），还是允许重连到同一 PTY（需要会话所有权 + 缓冲续传，复杂度更高）？
4. 是否提供「只读终端」（不可输入，仅看输出）作为更保守的第一版？
5. Origin 同源校验在 cloudflared 隧道下是否成立（Host 是否保留原域名）？需要一次实测确认后再定稿 C3。
6. Web 终端是否需要「复制/粘贴」权限提示（浏览器剪贴板 API 在非安全上下文/移动端限制不同）？

## 9. 明确不做

- 不开放任意 shell 路径、不开放 `cwd` 入参、不开放命令白名单之外的执行入口。
- 不做「Web 端远程/WSL 终端」（Phase 4 的 locator 投影问题）。
- 不复用桌面 IPC `terminalData` 广播、不新增 pi↔PiDeck 通道。
- S1/S2 已按本评审落地：`WebSocketHandshake` / `WebSocketFrame` / `WebTerminalRoutes` / `WebSocketUpgradeRouter` + `terminalTarget.ts`（与桌面共用 parser）；Web 专属 `TerminalSessionManager` 实例接 PTY。
