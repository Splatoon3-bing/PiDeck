# T11 Web 生图/生视频 — 接口与安全切片（v1：生图）

> Scope: FR-015 / design §4.8。v1 只开生图；生视频后置（原因见 §5）。

## 1. 硬边界

- **供应商凭据只在主进程**：`ImageGenConfigStore` 的 `apiKey` / `baseUrl` / `extraParams` 一律不出 `/api/*`；Web 只拿到 `id` / `name` / `models[]` / `referenceMode`。
- 浏览器不能传任意 `baseUrl` / `apiKey` / `model` 之外的供应商参数：`provider` 必须在服务端配置里，`model` 必须属于该 provider。
- 会话归属 fail-closed：`sessionId` 必须存在且 `backend === "imagegen"`；其它后端一律拒（生图不走 pi/DSH runtime）。
- 产物不内联进 JSON 响应：生成后落 `ImageBlobStore`，响应只回 `ref`；Web 经 `GET /api/imagegen/blob/<ref>` 取字节（内容寻址 → 长缓存；`/api/*` 令牌链覆盖）。

## 2. 路由

| Method | Path | 入参 | 返回 |
|---|---|---|---|
| GET | `/api/imagegen/config` | — | `{configured, providers:[{id,name,models,referenceMode}], activeProviderId, activeModel}` |
| POST | `/api/imagegen/generate` | `{sessionId, prompt, provider?, model?, size?, watermark?, outputFormat?, referenceImages?}` | `{ref, mimeType}` |
| GET | `/api/imagegen/blob/<ref>` | — | 图片字节（`nosniff` + CSP sandbox + 内容寻址缓存） |

校验：prompt 非空 ≤4000；`referenceImages` 走 `parseImageGenReferenceImages`（数量/mime/体积），非法 400；配置为空 → 409 `webError.imageGenNotConfigured`；供应商错误码按 `ImageGenErrorCode` 映射（401/403 invalidKey 等 → 400 + 稳定 code，详情截断）。

## 3. 持久化

生成成功后写 `ImageSessionStore`（user 提示词 + assistant 图片两条消息，图片只存 `ref`，**base64 不进 JSONL**），并 `promoteToActive`。v1 不更新会话标题（桌面 `persistImageGen` 的自动命名需要项目/占位标题判定，属主进程业务；Web 端标题保持占位，后续与桌面共用同一归一化）。

## 4. 渲染层

- `webImageGen.ts`：配置读取、`generateWebImage`、`webImageBlobUrl(ref)`（GET 走 `?token=`，`<img>` 无法带 Authorization）。
- 历史图片：`chatMessagesToUiMessages` 对 `images[].ref` 输出 `url: webImageBlobUrl(ref)`（`webMessageParts` 已支持 `url`）。
- composer：生图会话的发送走 `/api/imagegen/generate`（不进 `useChat`），成功后刷新历史；未配置供应商时禁用并说明。

## 5. 不做（v1）与理由

- **生视频**：`VideoJobRunner` 是长任务（提交/轮询/取消/事件），需要独立的任务归属、并发上限与清理评审（与 T6 终端同类长连接面）；本轮只保留桌面端。
- 供应商新增/编辑、模型拉取（会用到 apiKey 与出网）：不在 Web 开放。
- 生图任务的流式进度：imagegen 是单次请求，UI 用本地"生成中"态即可。

## 6. 验收

- 单测：投影不含 apiKey/baseUrl；非 imagegen 会话 400；未知 provider/model 400；空/超长 prompt 400；非法参考图 400；未配置 409；blob 非法 ref 404、缺字节 404、成功响应头（nosniff / CSP / immutable）。
- E2E：生图会话在未配置时给出可读禁用提示；非生图会话不出现该提示。
- 门禁：typecheck + 单测 + Web E2E + check:format；巨文件不净增长。
