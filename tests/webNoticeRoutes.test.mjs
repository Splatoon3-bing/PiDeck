import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { WebNoticeRoutes } = loadTsCommonJs("src/main/web/WebNoticeRoutes.ts");

function fixture() {
	const calls = [];
	const notices = {
		load: async () => [{ timestamp: 1, kind: "info", title: "已保存", duration: 3000 }],
		clear: async () => {
			calls.push("clear");
		},
	};
	const announcements = {
		getState: () => ({ items: [{ id: "a1", title: "Release", body: "x", level: "info", category: "notice", publishedAt: "2026-01-01", effectiveUntil: "2030-01-01" }], readIds: [], notifiedIds: ["a1"], fetchedAt: 1, source: "builtin" }),
		markRead: (id) => calls.push(["read", id]),
		markAllRead: () => calls.push("read-all"),
	};
	return { routes: new WebNoticeRoutes({ notices: () => notices, announcements: () => announcements, log: () => undefined }), calls };
}

async function call(routes, path, body, method = "GET") {
	const init = method === "POST" ? Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}))]) : { method };
	init.method = method;
	const res = {
		status: 0,
		body: "",
		writeHead(status) {
			this.status = status;
		},
		end(value) {
			this.body = String(value ?? "");
		},
	};
	const handled = await routes.handle(new URL(`http://localhost${path}`), init, res);
	return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test("通知历史与公告投影：公告不下发 notifiedIds", async () => {
	const { routes } = fixture();
	const notices = await call(routes, "/api/notices");
	assert.equal(notices.status, 200);
	assert.equal(notices.body.entries.length, 1);
	const announcements = await call(routes, "/api/announcements");
	assert.equal(announcements.status, 200);
	assert.deepEqual(
		announcements.body.items.map((item) => item.id),
		["a1"],
	);
	assert.equal("notifiedIds" in announcements.body, false);
});

test("清空历史与标记已读走既有 store/service", async () => {
	const { routes, calls } = fixture();
	assert.equal((await call(routes, "/api/notices/clear", {}, "POST")).status, 200);
	assert.equal((await call(routes, "/api/announcements/mark-read", { id: "a1" }, "POST")).status, 200);
	assert.equal((await call(routes, "/api/announcements/mark-all-read", {}, "POST")).status, 200);
	assert.deepEqual(calls, ["clear", ["read", "a1"], "read-all"]);
});

test("写路由拒绝非法 id、非法 JSON、未知路径；能力缺失 503；未命中 false", async () => {
	const { routes, calls } = fixture();
	assert.equal((await call(routes, "/api/announcements/mark-read", { id: "" }, "POST")).status, 400);
	assert.equal((await call(routes, "/api/announcements/mark-read", { id: "x".repeat(201) }, "POST")).status, 400);
	assert.equal((await call(routes, "/api/announcements/mark-read", "{bad", "POST")).status, 400);
	assert.equal((await call(routes, "/api/announcements/unknown", {}, "POST")).status, 404);
	assert.equal(calls.length, 0);
	const unavailable = new WebNoticeRoutes({ notices: () => null, announcements: () => null });
	assert.equal((await call(unavailable, "/api/notices")).status, 503);
	assert.equal((await call(unavailable, "/api/announcements")).status, 503);
	assert.equal((await call(routes, "/api/settings")).handled, false);
});
