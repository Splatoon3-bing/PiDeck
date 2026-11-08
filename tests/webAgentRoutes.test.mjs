import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebAgentRoutes } = loadTsCommonJs("src/main/web/WebAgentRoutes.ts");
const agent = { id: "a1", name: "Writer", description: "", icon: "", systemPrompt: "You help", category: "general", createdAt: 1, updatedAt: 1, usageCount: 0 };
function response() {
	return {
		status: 0,
		body: "",
		writeHead(status) {
			this.status = status;
		},
		end(body) {
			if (body !== undefined) this.body += String(body);
		},
		write(body) {
			this.body += String(body);
		},
	};
}
function request(body, method = "POST") {
	const value = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}))]);
	value.method = method;
	return value;
}
async function call(routes, path, body, method = "POST") {
	const res = response();
	const handled = await routes.handle(new URL(`http://localhost${path}`), request(body, method), res);
	return { handled, status: res.status, body: res.body.startsWith("{") ? JSON.parse(res.body) : res.body };
}
function fixture(overrides = {}) {
	const calls = [];
	const store = {
		getSnapshot: () => ({ revision: 2, agents: [agent], agentOrder: [], settings: { selectionToolEnabled: true, systemSelectionEnabled: false, sessionAgentBindings: { s1: "a1" } } }),
		create: async (input) => {
			calls.push(["create", input]);
			return { ...agent, ...input };
		},
		update: async (id, patch) => {
			calls.push(["update", id, patch]);
			return { ...agent, ...patch };
		},
		delete: async (id) => id !== "a1",
		duplicate: async () => agent,
		resetBuiltin: async () => agent,
		bindSession: async (input) => {
			calls.push(["bind", input]);
			return { sessionAgentBindings: { [input.sessionId]: input.agentId } };
		},
	};
	const deps = { store: () => store, invoke: () => null, hasSession: (id) => id === "s1", log: () => undefined, ...overrides };
	return { routes: new WebAgentRoutes(deps), calls };
}

test("GET 只投影预设与绑定，不下发划词/系统开关", async () => {
	const result = await call(fixture().routes, "/api/agents", undefined, "GET");
	assert.equal(result.status, 200);
	assert.deepEqual(result.body.sessionAgentBindings, { s1: "a1" });
	assert.equal("systemSelectionEnabled" in result.body, false);
});

test("create/update 白名单、patch 缺键保留、非法字段与模型拒绝", async () => {
	const { routes, calls } = fixture();
	assert.equal((await call(routes, "/api/agents/create", { name: "A", systemPrompt: "Help", backend: "pi" })).status, 200);
	assert.equal((await call(routes, "/api/agents/update", { agentId: "a1", patch: { description: "new" } })).status, 200);
	assert.equal("name" in calls[1][2], false);
	for (const [path, body] of [
		["/api/agents/create", { name: "A", systemPrompt: "Help", cwd: "/tmp" }],
		["/api/agents/update", { agentId: "a1", patch: { builtin: true } }],
		["/api/agents/create", { name: "A", systemPrompt: "Help", backend: "acp" }],
		["/api/agents/create", { name: "A", systemPrompt: "Help", model: { provider: "bad\n", modelId: "m" } }],
	])
		assert.equal((await call(routes, path, body)).status, 400);
	assert.equal(calls.length, 2);
});

test("绑定必须指向真实会话，删除内置与缺失服务明确失败", async () => {
	const { routes } = fixture();
	assert.equal((await call(routes, "/api/agents/bind-session", { sessionId: "s1", agentId: null })).status, 200);
	assert.equal((await call(routes, "/api/agents/bind-session", { sessionId: "missing", agentId: "a1" })).status, 404);
	assert.equal((await call(routes, "/api/agents/delete", { agentId: "a1" })).status, 404);
	assert.equal((await call(fixture({ store: () => null }).routes, "/api/agents", undefined, "GET")).status, 503);
});

test("一次性调用拒收 systemPrompt；事件仅按 runId 重放，取消只认活跃 run", async () => {
	let callbacks;
	const invoke = {
		invoke: async (input, next) => {
			assert.equal("systemPrompt" in input, false);
			callbacks = next;
			return { ok: true, runId: "run-web" };
		},
		cancel: () => callbacks.onAborted(),
	};
	const { routes } = fixture({ invoke: () => invoke });
	assert.equal((await call(routes, "/api/agents/invoke", { agentId: "a1", text: "hello", model: { provider: "p", modelId: "m" }, systemPrompt: "override" })).status, 400);
	const started = await call(routes, "/api/agents/invoke", { agentId: "a1", text: "hello", model: { provider: "p", modelId: "m" } });
	assert.equal(started.status, 200);
	callbacks.onDelta("answer");
	callbacks.onDone("answer");
	const events = await call(routes, "/api/agents/invoke/events?runId=run-web", undefined, "GET");
	assert.match(events.body, /"phase":"delta"/);
	assert.match(events.body, /"phase":"done"/);
	assert.equal((await call(routes, "/api/agents/invoke/cancel", { runId: "unknown" })).status, 404);
	assert.equal((await call(routes, "/api/agents/invoke/cancel", { runId: "run-web" })).status, 404);
});

test("body 边界：非法 JSON 400、超限 413、未知路径 404", async () => {
	const { routes } = fixture();
	assert.equal((await call(routes, "/api/agents/create", "{bad")).status, 400);
	assert.equal((await call(routes, "/api/agents/create", { name: "A", systemPrompt: "x".repeat(70_000) })).status, 413);
	assert.equal((await call(routes, "/api/agents/unknown", {})).status, 404);
});
