/**
 * Web 自动化路由（T8 S1）：白名单 / 项目归属 / 投影脱敏 / busy 映射 / body 边界。
 *
 * 用假 Store 与假 RunCoordinator：只验证 Web 层职责（校验 + 投影 + 错误映射），
 * 真正的调度语义由既有 automation 测试覆盖。
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebAutomationRoutes } = loadTsCommonJs("src/main/web/WebAutomationRoutes.ts");
const { toWebAutomationRun, toWebAutomationTask, parseWebAutomationCreateBody } = loadTsCommonJs("src/main/web/WebAutomationProjection.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeResponse() {
	return {
		status: 0,
		body: "",
		writeHead(status) {
			this.status = status;
		},
		end(payload) {
			if (payload !== undefined) this.body = String(payload);
		},
	};
}

function fakeRequest(rawBody, { invalidJson = false } = {}) {
	const payload = invalidJson ? "{not json" : JSON.stringify(rawBody);
	const request = Readable.from([Buffer.from(payload)]);
	request.method = "POST";
	return request;
}

async function call(routes, path, method = "GET", body) {
	const response = fakeResponse();
	const request = method === "POST" ? fakeRequest(body) : { method };
	const handled = await routes.handle(new URL(`http://localhost${path}`), request, response);
	return { handled, status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

function task(overrides = {}) {
	return {
		id: "t1",
		name: "Nightly",
		projectId: "p1",
		prompt: "run tests",
		schedule: { type: "manual" },
		enabled: true,
		budget: {},
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

function run(overrides = {}) {
	return {
		id: "r1",
		taskId: "t1",
		taskName: "Nightly",
		projectId: "p1",
		trigger: "manual",
		status: "succeeded",
		queuedAt: 1,
		updatedAt: 2,
		inputTokens: 1,
		outputTokens: 2,
		costUsd: 0,
		stepCount: 1,
		agentId: "agent-secret",
		runtimeGeneration: 7,
		error: "x".repeat(5000),
		events: Array.from({ length: 80 }, (_, index) => ({ id: `e${index}`, type: "metrics", at: index, message: "m".repeat(2000) })),
		...overrides,
	};
}

function stubDeps(overrides = {}) {
	const calls = { create: [], update: [], delete: [], run: [], abort: [], clear: [] };
	const store = {
		getSnapshot: () => ({
			revision: 3,
			settings: { maxConcurrentRuns: 1, historyLimit: 100 },
			tasks: [task(), task({ id: "t2", name: "Big", prompt: "p".repeat(25_000) })],
			runs: [run(), run({ id: "r2", taskId: "t2", updatedAt: 9 })],
		}),
		createTask: async (input) => {
			calls.create.push(input);
			return task({ ...input, id: "t-new" });
		},
		updateTask: async (id, patch) => {
			calls.update.push({ id, patch });
			if (id === "missing") throw new Error("Automation task not found");
			return task({ ...patch, id });
		},
		deleteTask: async (id) => {
			calls.delete.push(id);
			return id !== "missing";
		},
		clearTerminalRuns: async () => {
			calls.clear.push(true);
			return 4;
		},
	};
	const coordinator = {
		runNow: async (taskId) => {
			calls.run.push(taskId);
			if (taskId === "busy") throw new Error("Automation task already running");
			return run();
		},
		abortRun: async (runId) => {
			calls.abort.push(runId);
			return runId === "active";
		},
	};
	const deps = {
		store: () => store,
		runs: () => coordinator,
		projects: { get: (id) => (id === "p1" ? { id, name: "P", path: "/tmp/p", kind: "project" } : id === "chat" ? { id, name: "C", path: "/tmp/c", kind: "chat" } : undefined) },
		log: () => undefined,
		...overrides,
	};
	return { deps, calls };
}

test("GET 列表：投影去掉 agentId/runtimeGeneration，截断 error/events 与超长 prompt", async () => {
	const { deps } = stubDeps();
	const routes = new WebAutomationRoutes(deps);
	const result = await call(routes, "/api/automations?limit=10");
	assert.equal(result.status, 200);
	const serialized = JSON.stringify(result.body);
	assert.equal(serialized.includes("agent-secret"), false);
	assert.equal(result.body.runs.length, 2);
	assert.equal(result.body.runs[0].events.length, 50);
	assert.equal(result.body.runs[0].events[0].message.length, 512);
	assert.equal(result.body.runs[0].error.length, 2048);
	const truncated = result.body.tasks.find((item) => item.id === "t2");
	assert.equal(truncated.promptTruncated, true);
	assert.equal(truncated.prompt.length, 20_000);
});

test("GET 列表：taskId/limit 过滤与上限", async () => {
	const { deps } = stubDeps();
	const routes = new WebAutomationRoutes(deps);
	const filtered = await call(routes, "/api/automations?taskId=t2&limit=1");
	assert.equal(filtered.status, 200);
	assert.equal(filtered.body.runs.length, 1);
	assert.equal(filtered.body.runs[0].taskId, "t2");
});

test("create：合法入参转发；未知键/非法 cron 结构/未知项目/chat 项目被拒且不落库", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebAutomationRoutes(deps);

	const ok = await call(routes, "/api/automations/create", "POST", { name: "A", projectId: "p1", prompt: "hi", schedule: { type: "manual" }, enabled: true, backend: "pi", mode: "plan" });
	assert.equal(ok.status, 200);
	assert.equal(calls.create.length, 1);
	assert.equal(calls.create[0].mode, "plan");

	const unknown = await call(routes, "/api/automations/create", "POST", { name: "A", projectId: "p1", prompt: "hi", schedule: { type: "manual" }, cwd: "/etc" });
	assert.equal(unknown.status, 400);
	assert.equal(unknown.body.code, "webError.invalidAutomation");
	assert.equal(unknown.body.field, "cwd");

	const badSchedule = await call(routes, "/api/automations/create", "POST", { name: "A", projectId: "p1", prompt: "hi", schedule: { type: "every", expression: "* * * * *" } });
	assert.equal(badSchedule.status, 400);

	const missingProject = await call(routes, "/api/automations/create", "POST", { name: "A", projectId: "nope", prompt: "hi", schedule: { type: "manual" } });
	assert.equal(missingProject.status, 400);

	const chatProject = await call(routes, "/api/automations/create", "POST", { name: "A", projectId: "chat", prompt: "hi", schedule: { type: "manual" } });
	assert.equal(chatProject.status, 400);
	assert.equal(calls.create.length, 1);
});

test("update：未知 patch 键 400；任务不存在 404", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebAutomationRoutes(deps);
	const unknown = await call(routes, "/api/automations/update", "POST", { taskId: "t1", patch: { approval: "auto" } });
	assert.equal(unknown.status, 400);
	assert.equal(calls.update.length, 0);

	const ok = await call(routes, "/api/automations/update", "POST", { taskId: "t1", patch: { enabled: false } });
	assert.equal(ok.status, 200);
	assert.deepEqual(plain(calls.update[0]), { id: "t1", patch: { enabled: false } });

	const missing = await call(routes, "/api/automations/update", "POST", { taskId: "missing", patch: { enabled: false } });
	assert.equal(missing.status, 404);
});

test("delete/run/abort/clear：成功与 404/409 映射", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebAutomationRoutes(deps);

	assert.equal((await call(routes, "/api/automations/delete", "POST", { taskId: "t1" })).status, 200);
	assert.equal((await call(routes, "/api/automations/delete", "POST", { taskId: "missing" })).status, 404);

	assert.equal((await call(routes, "/api/automations/run", "POST", { taskId: "t1" })).status, 200);
	const busy = await call(routes, "/api/automations/run", "POST", { taskId: "busy" });
	assert.equal(busy.status, 409);
	assert.equal(busy.body.code, "webError.automationBusy");

	assert.equal((await call(routes, "/api/automations/abort", "POST", { runId: "active" })).status, 200);
	assert.equal((await call(routes, "/api/automations/abort", "POST", { runId: "gone" })).status, 409);

	const cleared = await call(routes, "/api/automations/clear-runs", "POST", {});
	assert.equal(cleared.status, 200);
	assert.equal(cleared.body.removed, 4);
	assert.equal(calls.run.length, 2);
});

test("preview-cron：合法返回 nextRuns，非法 200 + valid:false", async () => {
	const { deps } = stubDeps();
	const routes = new WebAutomationRoutes(deps);
	const ok = await call(routes, "/api/automations/preview-cron?expression=0%20*%20*%20*%20*");
	assert.equal(ok.status, 200);
	assert.equal(ok.body.valid, true);
	assert.equal(ok.body.nextRuns.length, 5);

	const bad = await call(routes, "/api/automations/preview-cron?expression=bad");
	assert.equal(bad.status, 200);
	assert.equal(bad.body.valid, false);
	assert.equal((await call(routes, "/api/automations/preview-cron")).status, 400);
});

test("body 边界：非法 JSON 400、超限 413、能力缺失 503、未知路径 false", async () => {
	const { deps } = stubDeps();
	const routes = new WebAutomationRoutes(deps);

	const response = fakeResponse();
	await routes.handle(new URL("http://localhost/api/automations/create"), fakeRequest(undefined, { invalidJson: true }), response);
	assert.equal(response.status, 400);

	const oversize = fakeResponse();
	const bigRequest = Readable.from([Buffer.from(JSON.stringify({ name: "A", projectId: "p1", prompt: "x".repeat(300 * 1024), schedule: { type: "manual" } }))]);
	bigRequest.method = "POST";
	await routes.handle(new URL("http://localhost/api/automations/create"), bigRequest, oversize);
	assert.equal(oversize.status, 413);

	const unavailable = new WebAutomationRoutes({ ...deps, store: () => null });
	assert.equal((await call(unavailable, "/api/automations")).status, 503);

	const unrelated = await call(routes, "/api/settings");
	assert.equal(unrelated.handled, false);
});

test("parseWebAutomationCreateBody：原型链键不再被当成合法字段", () => {
	for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
		assert.throws(
			() => parseWebAutomationCreateBody({ name: "A", projectId: "p1", prompt: "hi", schedule: { type: "manual" }, [key]: "x" }),
			(error) => error.name === "WebAutomationValidationError" && error.field === key,
		);
	}
});
