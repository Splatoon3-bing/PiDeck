import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebHostPluginRoutes, toWebHostPluginSummaries } = loadTsCommonJs("src/main/web/WebHostPluginRoutes.ts");

const catalog = {
	directory: "/home/user/.config/PiDeck/host-plugins",
	issues: [{ directory: "/secret/dir", code: "bad-manifest" }],
	plugins: [
		{
			fingerprint: "sha256:must-not-leak",
			enabled: true,
			requiresConsent: false,
			manifest: {
				schemaVersion: 1,
				apiVersion: 1,
				id: "example.plugin",
				name: "Example",
				version: "1.2.3",
				description: "demo",
				permissions: ["sessions.read.workspace", "network.https"],
				network: { https: true, httpsOrigins: ["https://internal.example"] },
				services: ["billion-context"],
				contributes: { panels: [{ id: "p", title: "P", entry: "index.html" }], commands: [] },
			},
		},
	],
};

async function call(routes, method = "GET") {
	const response = {
		status: 0,
		body: "",
		headers: {},
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers ?? {};
		},
		end(value) {
			this.body = String(value ?? "");
		},
	};
	const request = { method };
	const handled = await routes.handle(new URL("http://localhost/api/host-plugins"), request, response);
	return { handled, status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

test("投影只留白名单字段：不下发目录、指纹、网络目的地、服务名与贡献点", () => {
	const plain = (value) => JSON.parse(JSON.stringify(value));
	const [plugin] = plain(toWebHostPluginSummaries(catalog));
	assert.deepEqual(plugin, { id: "example.plugin", name: "Example", version: "1.2.3", description: "demo", enabled: true, requiresConsent: false, permissions: ["sessions.read.workspace", "network.https"] });
	const serialized = JSON.stringify(toWebHostPluginSummaries(catalog));
	for (const forbidden of ["host-plugins", "sha256:must-not-leak", "internal.example", "billion-context", "index.html"]) {
		assert.equal(serialized.includes(forbidden), false, `不应外泄 ${forbidden}`);
	}
});

test("只读端点：GET 正常返回，写方法与未知能力明确拒绝", async () => {
	const routes = new WebHostPluginRoutes({ catalog: () => catalog });
	const ok = await call(routes);
	assert.equal(ok.status, 200);
	assert.equal(ok.body.plugins.length, 1);
	for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
		const rejected = await call(routes, method);
		assert.equal(rejected.status, 405, `${method} 必须 405`);
		assert.equal(JSON.stringify(rejected.body).includes("permissions"), false, "拒绝响应不回插件能力清单");
	}
	const unrelated = await routes.handle(new URL("http://localhost/api/plugins"), { method: "GET" }, {});
	assert.equal(unrelated, false);
});

test("未装配或目录读取失败 → 503，不向浏览器抛出内部错误", async () => {
	assert.equal((await call(new WebHostPluginRoutes({ catalog: () => null }))).status, 503);
	const throwing = new WebHostPluginRoutes({
		catalog: () => {
			throw new Error("/home/user/secret path failed");
		},
	});
	const failed = await call(throwing);
	assert.equal(failed.status, 503);
	assert.equal(JSON.stringify(failed.body).includes("/home/user/secret"), false);
});
