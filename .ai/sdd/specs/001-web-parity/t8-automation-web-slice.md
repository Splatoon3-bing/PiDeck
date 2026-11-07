# T8 Web 自动化页 — 接口与安全切片（实现前）

> Status: **S1–S3 已实施（2026-11-07）**：数据面 + UI + E2E；v1 不含设置写入/模型编辑/实时日志流。
> Scope: `tasks.md` T8 / `design.md` §4.8 / `requirements.md` FR-012、NFR-001、NFR-008
> Last Updated: 2026-11-07

## 1. 目标与不做

**做（v1）**：Web 上查看定时任务列表/详情、创建、编辑（名称/提示词/cron/后端/模式/预算/启停）、删除、手动运行、中止运行、查看运行历史（分页/清理终态）。

**不做（v1）**：
- 全局设置（`maxConcurrentRuns`/`historyLimit`）只读展示，不在 Web 改（会影响整机调度）。
- 不做模型/思考档位/权限预设编辑（需要 provider×model 校验与桌面同源菜单，后置）。
- 不做运行日志实时流（历史轮询即可；实时流属于 T6 同类长连接，需独立评审）。
- 不开放 imagegen/videogen 定时任务（`AutomationTask.backend` 本就排除 imagegen）。

## 2. 数据面（复用，不新建 store）

- 读：`AutomationStore.getSnapshot()`（`tasks: AutomationTaskSummary[]` + `runs: AutomationRun[]` + `settings`）。
- 写：`createTask/updateTask/deleteTask`（内部已做归一化与 cron 校验）。
- 运行：`AutomationRunCoordinator.runNow(taskId)` / `abortRun(runId)`。
- 变更通知：`AutomationStore.onChanged`（Web 侧走既有 `/api/state` 轮询即可，v1 不加新推送通道）。

## 3. 安全投影（WebAutomationProjection）

- `AutomationTaskSummary`：保留 id/name/projectId/prompt/schedule/enabled/backend/mode/budget/createdAt/updatedAt/lastScheduledAt/nextRunAt。
  - `prompt` 是用户自己的数据，照发；但列表接口可截断（>20KB 截断并标记）避免大 payload。
  - **不含**任何宿主路径（现有类型本来就没有）。
- `AutomationRun`：保留 id/taskId/taskName/projectId/trigger/status/时间戳/tokens/cost/steps/changedFiles/**skippedReason/budgetReason**；
  - `error` 截断 2KB；`events[].message` 截断 512B、最多 50 条（与 `MAX_RUN_EVENTS` 同量级，防历史胀包）。
  - 不含 agentId/runtimeGeneration/sessionId？v1 保留 `sessionId`（用户可据此跳回会话），保留 `agentId` 无安全价值 → 去掉。
- `settings` 只读投影（maxConcurrentRuns/historyLimit）。
- 分页：`runs` 按 `updatedAt` 倒序，默认 50、上限 200；`?taskId=` 过滤。

## 4. 路由（`/api/automations`，全部走既有令牌链 + 写限速）

| Method | Path | 入参 | 返回 | 备注 |
|---|---|---|---|---|
| GET | `/api/automations` | `?taskId=&limit=` | `{revision, settings, tasks, runs}` | 只读投影 |
| POST | `/api/automations/create` | `CreateAutomationTaskInput`（白名单字段） | `{task}` | projectId 必须本地存在且非 chat |
| POST | `/api/automations/update` | `{taskId, patch}` | `{task}` | patch 仍走白名单字段；未传字段保持原值（store 语义） |
| POST | `/api/automations/delete` | `{taskId}` | `{ok}` | 不可逆，UI 二次确认 |
| POST | `/api/automations/run` | `{taskId}` | `{run}` | 已有活跃 run → 409 `webError.automationBusy` |
| POST | `/api/automations/abort` | `{runId}` | `{ok}` | 非活跃 → 409 |
| POST | `/api/automations/clear-runs` | `{}` | `{removed}` | 只清终态 |
| GET | `/api/automations/preview-cron` | `?expression=` | `AutomationCronPreview` | 编辑器预览；非法表达式 200 + valid:false |

## 5. 校验与安全清单

| # | 控制 | 实现 |
|---|---|---|
| A1 | 开关粒度：仅登录 token（无独立开关）；高风险动作（run）有二次确认 | UI confirm + `webError.automationBusy` 处理 |
| A2 | 项目归属：create/update 的 projectId 必须在 `projectStore` 且 `kind !== "chat"` | 路由层校验（404/400） |
| A3 | 字段白名单：create/update 只接受 v1 支持的字段（name/prompt/schedule/enabled/backend/mode/budget + projectId/taskId）；未知键 400 | 像 settings 一样逐键判定，`Object.hasOwn` 防原型链 |
| A4 | 长度/枚举：name ≤200、prompt ≤100k、backend ∈ {pi,dsh,acp}、mode ∈ {normal,plan,goal}、budget 数值正整数；cron 由 `parseAutomationCron` 校验 | 路由预检 + store 归一化双保险 |
| A5 | 运行副作用：run 前做 task 存在 + 非活跃检查；abort 只接受活跃 run | coordinator 已有语义，路由映射 409 |
| A6 | 投影脱敏：error 2KB、event 512B×50、无 agentId/runtimeGeneration/宿主路径 | `WebAutomationProjection` |
| A7 | 审计：`web-automation` 命名空间记 create/update/delete/run/abort/clear（id + 结果），**不记 prompt/正文** | `getAppLogger()` |
| A8 | 限速：继承写路由限速（240/min/主体） | `WebServiceManager` 已有 |
| A9 | 并发：run 与 coordinator 的 single-flight 一致；不新增旁路 | 复用 `AutomationRunCoordinator` |

## 6. 实施切片

1. **T8-S1 数据面**：`WebAutomationProjection.ts` + `WebAutomationRoutes.ts`（读写 + 校验 + 审计 + 投影）；`registerWebRoutes` 注入 `automation: { store: () => automationStore, runs: () => automationRunCoordinator, projects }`；单测（假 store/coordinator：白名单、未知键、项目校验、busy 409、投影截断/去字段）。
2. **T8-S2 UI**：抽屉新增「自动化」面板（列表 + 详情 + 编辑器 Dialog + 历史 + 运行/中止/删除确认）；i18n 三语 + genZhTw。
3. **T8-S3 E2E**：新建任务（manual）→ 列表出现 → 运行 → 历史出现 succeeded/failed → 中止/删除；390px 无溢出。

## 7. 验收

- 单测：A2/A3/A4/A5/A6 每条至少 1 个拒绝用例；run busy 409；投影不含 agentId 且 error 截断。
- E2E：manual 任务创建 → run → 历史；删除确认；移动端入口可达。
- 门禁：typecheck + 单测 + E2E + check:format；巨文件不增长。
