# 全量红单残量（2026-11-08 收口：0）

命令：`npm test` → **16504 tests / 16477 pass / 0 fail / 27 skipped / 0 cancelled（rc=0）**。
本轮起点：16452 pass / 20 fail / 0 cancelled（更早起点 15419 / 156 / 101）。

## 本轮清掉的 20 条（12 文件）

| 文件 | 条数 | 根因 / 处理 |
|---|---|---|
| tests/sessionCatalog.test.mjs | 3 | 路径字节形态未归一：identity 用 `normalizeSessionFilePathSyntax`（按形态选 win32/posix、折叠分隔符/`//`/`.`/`..`、不折大小写）；落盘用 `healSessionPathForStorage`（只愈合 POSIX 反斜杠，Windows 保持上报字节）。大小写变体断言按 `process.platform` 门控（POSIX 区分大小写是既有契约）。 |
| tests/cua/CuaMcpHttpHost.test.mjs | 2 | 注入平台无关 engine：只替身会枚举窗口/屏幕的只读方法；写动作保留真 CuaEngine + 真 gate，无审批拒写断言不挪走。 |
| tests/acpGracefulStop.test.mjs | 2 | `killAcpProcessTree` 接受 platform；`AcpAgentManager.shutdownProcess` 先关 stdin 再走 `shutdownAcpProcess`。 |
| tests/webServiceHardening.test.mjs | 1 | 令牌失效横幅已拆到 `WebComposerBanner`（组合根只挂 `<WebAuthExpiredBanner />`）：断言跟到实现位置，文案/事件保证不变。 |
| tests/skillCatalog.test.mjs | 1 | 项目根夹具原本把 Windows 盘符路径喂给 POSIX 宿主；改按宿主平台构造夹具，保留「最近 .git / 回退 cwd」断言。 |
| tests/securityPolicy.test.mjs | 1 | 相对 allowDir 展开按基址形态选 `win32.resolve`。 |
| tests/piResourceTarget.test.mjs | 1 | UNC 形态的绝对路径判定不再依赖宿主 `path.isAbsolute`。 |
| tests/piDeckRuntimeRetryContract.test.mjs | 1 | 机器语料断言改为「扩展判为瞬态必须改写 + 改写后双运行时都可重试」，不再要求本机历史里必有可救回样本。 |
| tests/localImageProtocol.test.mjs | 1 | `isInsideRoot` 按路径形态选 win32/posix `relative`（8.3 短名/长名事故全在 Windows 形态）。 |
| tests/agentMemoryMounts.test.mjs | 1 | `projectKeyFromPath` 对盘符/UNC 走 `win32.resolve`（`C:/p` 与 `C:\p` 同键）。 |
| tests/packageResourceResolver.test.mjs | 1 | `readPackageVersion` 起点是资源文件时 `join(file,"package.json")` 报 `ENOTDIR`，应继续向上而不是放弃。 |
| tests/webLayout.test.mjs | 5 | 基线 worktree 确认既有失败；全部是重构后实现位置漂移（manualOpen 门控 / 删除会话 AlertDialog → `WebSessionDialogs` / 主题求值 → `useWebSettings` / 错误待答横幅 → `WebComposerBanner`）。按用户确认更新断言到新位置、保留同等强度。 |

## T14

渲染层只读入口补齐：技能/扩展弹窗新增「宿主插件」tab（`GET /api/host-plugins` 安全投影；503 只降级该 tab）。无开关/安装/授权/执行，三语文案齐全。测试：`tests/webHostPluginsUi.test.mjs`。

## 说明

- 27 条 skipped 是既有平台/环境门控（Windows-only、需要本机 WSL、无本机会话语料等），不是红单。
- 巨文件未净增长：任务起点 `931143a2c` 基线 WebChatApp 1651 行、`src/main/index.ts` 8022 行；当前不变。
