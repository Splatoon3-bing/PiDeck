# SDD Brief: Web 与桌面端页面/功能对齐

> Source: `.ai/sdd/specs/001-web-parity/`
> Status: implementation:done
> Last Updated: 2026-11-07

## Ready for implementation

- `requirements.md` — 20 条 FR + 8 条 NFR，含已完成 Wave 1 与后续阶段。
- `design.md` — 路由/服务/安全/UX/测试策略；TD-001..TD-004。
- `tasks.md` — Phase 1A/1B 全部交付：T0.1–T0.5、T1 设置、T2 文件管理、T3 Git 分支、T4 命令面板、T5 精修/测试；待做：T6 终端（需安全评审）、T7–T15 后续阶段。

## Current slice

Phase 1B 完成：T1 设置白名单投影/面板（含桌面广播与快捷键/流式展开接线）、T3 分支真实仓库 E2E、
T4 键盘命令面板、T5 390px 与写路由边界回归。下一阶段入口是 T6 终端（默认关闭 + 安全评审）。

## Verification contract

- `npm run typecheck`
- `node --test tests/<相关>.test.mjs`
- `npx electron-vite build`
- `npx playwright test e2e/<相关>.spec.ts`
- `npm run check:format`

## Boundaries

- 不新增 pi↔PiDeck 通道；写路由复用主进程服务与 `shared/` 契约。
- 文件写只在项目根内；删除走回收站；设置白名单；终端默认关闭。
- 巨文件不净增长；新文件 ≤400 行。

## Open questions

- T1 是否包含供应商登录/模型目录更新（当前不包含）。
- T3 push/pull 是否在 Phase 1.5 开启（当前只做 fetch + 分支切换）。
- T6 终端的开关默认值、并发上限与移动端输入方案需先做安全评审。
