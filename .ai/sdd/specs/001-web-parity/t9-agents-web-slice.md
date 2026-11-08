# T9 Web 智能体 — 接口与安全切片

> Scope: FR-013 / design §4.8；复用 `AgentProfileStore` 与 `AgentInvokeService`。

## 接口

- `GET /api/agents` → `{revision, agents, agentOrder, sessionAgentBindings}`。智能体正文属于当前用户数据；不返回划词/系统级开关。
- `POST /api/agents/create|update|delete|duplicate|reset-builtin`：只收桌面编辑器字段；patch 仅校验出现的键；删除内置返回 409。
- `POST /api/agents/bind-session` → `{sessionAgentBindings}`：`sessionId` 必须存在于 catalog，agentId 必须存在或为 null；绑定仍由 store 唯一写入。
- `POST /api/agents/invoke`：仅 `{agentId,text,instruction?,action?,targetLanguage?,model}`；经既有 `parseAgentInvokeInput`，**拒收 systemPrompt**。返回 `{runId}`。
- `GET /api/agents/invoke/events?runId=`：SSE 重放该 run 的增量与唯一终态；`POST /api/agents/invoke/cancel` 仅接受已知活跃 runId。

## 安全

- 全部 `/api/*` 走 token + 写限速 + CORS；审计只记 id/阶段，不记 systemPrompt、输入正文或模型输出。
- Store/service 以 provider 延迟读取。调用继续走例外四的独立一次性补全 sidecar，不增加 pi↔PiDeck 通道、无工具、无会话文件写入。
- 事件按 runId 隔离，只向请求同一 runId 的鉴权客户端发送；缓冲上限 512 事件 / 2MB，终态后短期保留供重连重放。取消不能按浏览器自造 runId 影响桌面调用。
- create/update 每类至少覆盖未知字段、非法枚举/长度、未知 id；bind 覆盖未知会话；invoke 覆盖 systemPrompt、非法模型、未知 agent；cancel 覆盖未知 runId。

## UI / 验证

工作区抽屉增加智能体面板：搜索、编辑/新建、复制、删除/内置重置、绑定当前会话、一次性调用与取消。模型缺省时复用当前会话模型，没有可用模型则禁用调用并解释。E2E 建自定义预设 → 编辑 → 绑定 → 删除，不调用真实模型。门禁：typecheck、针对性单测、Web E2E、check:format；巨文件不净增长。
