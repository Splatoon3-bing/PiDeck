# T10 Web 收藏 — 接口与安全切片

- `GET /api/favorites` → `{entries}`，复用 `FavoritesStore.list()`；仅收藏既有数据，无宿主路径。
- `POST /api/favorites/add-session` 仅 `{sessionId}`：由主进程 catalog 读取标题、项目并构造 `AddFavoriteInput`，浏览器不得伪造正文、角色或来源。会话不存在 404。
- `POST /api/favorites/delete` 仅 `{favoriteId}`；未知 id 404，UI 二次确认。
- 搜索、复制、跳回在客户端完成；跳回只使用 `/api/state` 已存在的会话，不激活 runtime、不改会话文件。
- 全部继承 token、写限速、CORS；审计只记 favorite/session id，不记正文。拒绝未知字段、非法/超长 id、未知来源、未装配服务。
- 验证：store 同源、添加/删除落盘、搜索/复制/跳回、三类拒绝用例、工作台 E2E、typecheck/check:format；不增加巨文件。
