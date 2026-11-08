import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebImageGenRoutes, toWebImageGenConfig } = loadTsCommonJs("src/main/web/WebImageGenRoutes.ts");

const provider = {
	id: "p1",
	name: "Provider One",
	baseUrl: "https://secret-base-url.example/v1",
	apiKey: "sk-must-not-leak",
	models: ["m1", "m2"],
	extraParams: { size: true, watermark: false, output_format: false },
	referenceMode: "none",
};

function fixture(overrides = {}) {
	const calls = { generate: [], append: [], promote: [] };
	const deps = {
		getConfig: async () => ({ providers: [provider], activeProviderId: "p1", activeModel: "m1" }),
		generate: async (request) => {
			calls.generate.push(request);
			return { ok: true, image: { type: "image", data: "aGk=", mimeType: "image/png" } };
		},
		putBlob: async () => "ref1",
		readBlob: async (ref) => (ref === "ref1" ? { data: Buffer.from("hi").toString("base64"), mimeType: "image/png" } : null),
		getSession: (id) => (id === "s1" ? { id, projectId: "pr1", backend: "imagegen" } : id === "s2" ? { id, projectId: "pr1", backend: "pi" } : undefined),
		appendMessages: async (id, messages) => calls.append.push({ id, messages }),
		promote: async (id) => calls.promote.push(id),
		log: () => undefined,
		...overrides,
	};
	return { routes: new WebImageGenRoutes(deps), calls };
}

async function call(routes, path, body, method = "POST") {
	const init = method === "POST" ? Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body ?? {}))]) : { method };
	init.method = method;
	const res = {
		status: 0,
		body: "",
		headers: {},
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers ?? {};
		},
		end(value) {
			this.body = Buffer.isBuffer(value) ? value : String(value ?? "");
		},
	};
	const handled = await routes.handle(new URL(`http://localhost${path}`), init, res);
	return { handled, status: res.status, headers: res.headers, body: res.body instanceof Buffer ? res.body : res.body ? JSON.parse(res.body) : null };
}

test("配置投影：不含 apiKey / baseUrl / extraParams", async () => {
	const { routes } = fixture();
	const result = await call(routes, "/api/imagegen/config", undefined, "GET");
	assert.equal(result.status, 200);
	assert.deepEqual(result.body.providers[0], { id: "p1", name: "Provider One", models: ["m1", "m2"], referenceMode: "none" });
	const serialized = JSON.stringify(result.body);
	assert.equal(serialized.includes("sk-must-not-leak"), false);
	assert.equal(serialized.includes("secret-base-url"), false);
	assert.equal(serialized.includes("extraParams"), false);
});

test("会话归属 fail-closed：非 imagegen 会话、未知会话、未知字段一律拒绝", async () => {
	const { routes, calls } = fixture();
	const wrongBackend = await call(routes, "/api/imagegen/generate", { sessionId: "s2", prompt: "cat" });
	assert.equal(wrongBackend.status, 400);
	assert.equal(wrongBackend.body.field, "sessionId");
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "missing", prompt: "cat" })).status, 404);
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat", baseUrl: "https://evil" })).status, 400);
	assert.equal(calls.generate.length, 0);
});

test("provider/model 必须在服务端配置内；prompt 与参考图有界", async () => {
	const { routes } = fixture();
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat", provider: "nope" })).status, 400);
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat", model: "m9" })).status, 400);
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "" })).status, 400);
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "x".repeat(4001) })).status, 400);
	assert.equal((await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat", referenceImages: "not-an-array" })).status, 400);
});

test("未配置供应商 → 409；成功后落 blob 并只把 ref 写进历史", async () => {
	const empty = fixture({ getConfig: async () => ({ providers: [{ ...provider, models: [] }], activeProviderId: "p1", activeModel: "" }) });
	const notConfigured = await call(empty.routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat" });
	assert.equal(notConfigured.status, 409);
	assert.equal(notConfigured.body.code, "webError.imageGenNotConfigured");

	const { routes, calls } = fixture();
	const ok = await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat", size: "1024x1024" });
	assert.equal(ok.status, 200);
	assert.deepEqual(ok.body, { ref: "ref1", mimeType: "image/png" });
	assert.equal(calls.generate[0].model, "m1");
	assert.equal(calls.promote[0], "s1");
	const assistant = calls.append[0].messages[1];
	assert.equal(assistant.images[0].ref, "ref1");
	assert.equal(assistant.images[0].data, undefined);
});

test("供应商失败按错误码回结构化 JSON，不吐内部细节", async () => {
	const { routes } = fixture({ generate: async () => ({ ok: false, error: "invalidKey", detail: "upstream said sk-must-not-leak" }) });
	const result = await call(routes, "/api/imagegen/generate", { sessionId: "s1", prompt: "cat" });
	assert.equal(result.status, 400);
	assert.equal(result.body.code, "webError.imageGenFailed");
	assert.equal(result.body.error, "invalidKey");
	assert.equal(JSON.stringify(result.body).includes("sk-must-not-leak"), false);
});

test("blob 路由：内容寻址响应头、非法 ref 与缺失 blob 404", async () => {
	const { routes } = fixture();
	const ok = await call(routes, "/api/imagegen/blob/ref1", undefined, "GET");
	assert.equal(ok.status, 200);
	assert.equal(ok.headers["cache-control"], "private, max-age=31536000, immutable");
	assert.equal(ok.headers["x-content-type-options"], "nosniff");
	assert.match(String(ok.headers["content-security-policy"]), /sandbox/);
	assert.equal(ok.body.toString(), "hi");

	assert.equal((await call(routes, "/api/imagegen/blob/..%2Fsecret", undefined, "GET")).status, 404);
	assert.equal((await call(routes, "/api/imagegen/blob/missing", undefined, "GET")).status, 404);
	assert.equal((await call(routes, "/api/settings", undefined, "GET")).handled, false);
});

test("投影辅助函数：空 providers 时 configured=false", () => {
	assert.equal(toWebImageGenConfig({ providers: [], activeProviderId: "", activeModel: "" }).configured, false);
});
