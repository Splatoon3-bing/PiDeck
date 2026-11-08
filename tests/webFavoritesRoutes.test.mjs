import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { WebFavoritesRoutes } = loadTsCommonJs("src/main/web/WebFavoritesRoutes.ts");
function fixture() {
	const added = [];
	const store = {
		list: () => [{ id: "f1", text: "private snapshot" }],
		add: async (input) => {
			added.push(input);
			return { id: "f2", ...input };
		},
		remove: async (id) => id === "f1",
	};
	return { routes: new WebFavoritesRoutes({ store: () => store, getSession: (id) => (id === "s1" ? { id, title: "Source", projectId: "p1" } : undefined), log: () => undefined }), added };
}
async function call(routes, path, body, method = "POST") {
	const request = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}))]);
	request.method = method;
	const response = {
		status: 0,
		body: "",
		writeHead(status) {
			this.status = status;
		},
		end(value) {
			this.body = String(value ?? "");
		},
	};
	await routes.handle(new URL(`http://localhost${path}`), request, response);
	return { status: response.status, body: JSON.parse(response.body) };
}
test("列表复用 store，添加会话只接受 id 且来源由主进程填充", async () => {
	const { routes, added } = fixture();
	assert.deepEqual((await call(routes, "/api/favorites", undefined, "GET")).body.entries[0].id, "f1");
	assert.equal((await call(routes, "/api/favorites/add-session", { sessionId: "s1" })).status, 200);
	assert.deepEqual(JSON.parse(JSON.stringify(added[0])), { kind: "session", text: "", sessionId: "s1", sessionTitle: "Source", projectId: "p1", role: null, messageId: null, model: null, partial: false });
});
test("写路由拒绝未知字段、非法 id、未知来源与未知收藏", async () => {
	const { routes, added } = fixture();
	for (const body of [{ sessionId: "s1", text: "forged" }, { sessionId: "missing" }, { sessionId: "x".repeat(201) }]) assert.equal((await call(routes, "/api/favorites/add-session", body)).status >= 400, true);
	assert.equal(added.length, 0);
	assert.equal((await call(routes, "/api/favorites/delete", { favoriteId: "missing" })).status, 404);
	assert.equal((await call(routes, "/api/favorites/delete", { favoriteId: "f1" })).status, 200);
});
test("非法 JSON 400、能力缺失 503、未命中 false", async () => {
	const { routes } = fixture();
	assert.equal((await call(routes, "/api/favorites/delete", "{bad")).status, 400);
	assert.equal(await routes.handle(new URL("http://localhost/api/other"), { method: "GET" }, {}), false);
});
