/**
 * Web 设置路由（白名单投影 / 白名单写入）。
 *
 * 浏览器第一次能改主机设置，边界必须逐条压住：
 * - 投影响应只含白名单字段，不含 token / 凭据 / 安全 / 终端 / 远端；
 * - 未知键 400 且**不部分写入**（合法的兄弟字段也不能落库）；
 * - 非法值 400、空 body 400、非法 JSON 400；
 * - 写入走 deps.update，成功返回更新后的投影。
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebSettingsRoutes } = loadTsCommonJs("src/main/web/WebSettingsRoutes.ts");
const { toSafeWebSettings, parseSafeWebSettingsPatch, WebSettingsValidationError } = loadTsCommonJs("src/main/web/WebSettingsProjection.ts");

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
	const payload = invalidJson ? "{not json" : typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
	// 真服务端的 request 是 Readable 流（readJson 用 for-await 消费）；测试里也要同形。
	const request = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
	request.method = "POST";
	return request;
}

async function call(routes, path, method = "GET", body, options) {
	const response = fakeResponse();
	const request = method === "POST" ? fakeRequest(body, options) : { method };
	const handled = await routes.handle(new URL(`http://localhost${path}`), request, response);
	return { handled, status: response.status, body: response.body ? JSON.parse(response.body) : null };
}

/** 主机设置全集（含各种敏感字段）：投影必须一个都不带出来。 */
function hostSettings(overrides = {}) {
	return {
		theme: "dark",
		themeScheduleLightStart: "06:30",
		themeScheduleDarkStart: "20:15",
		themeStyle: "terminal",
		themePalette: "graphite",
		accent: "rose",
		fontSize: "large",
		uiFontSize: "compact",
		chatFontSize: null,
		tabBarFontSize: null,
		inputFontSize: null,
		defaultAgentBackend: "dsh",
		sendShortcut: "ctrl-enter-send",
		expandInterimDuringStream: false,
		// 以下都是绝不能出现在投影里的字段
		webServiceToken: "secret-token-value",
		webServiceTokenGeneratedAt: 1,
		webServiceRequiresAuth: true,
		securityConfig: { enabled: true, levels: [] },
		acpTools: [{ id: "claude", command: "/usr/bin/claude", env: { TOKEN: "x" } }],
		terminalShells: ["/bin/zsh"],
		wslEnabled: true,
		remoteProjectTrust: { host: "secret" },
		customPiPath: "/home/user/bin/pi",
		...overrides,
	};
}

function stubDeps(overrides = {}) {
	const calls = { update: [] };
	const deps = {
		read: () => hostSettings(),
		update: async (patch) => {
			calls.update.push(patch);
			return hostSettings(patch);
		},
		...overrides,
	};
	return { deps, calls };
}

test("GET /api/settings returns the allowlisted projection only", async () => {
	const { deps } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const result = await call(routes, "/api/settings");
	assert.equal(result.handled, true);
	assert.equal(result.status, 200);
	assert.deepEqual(Object.keys(result.body.settings).sort(), ["chatFontSize", "defaultAgentBackend", "defaultAgentBackendDesktopOnly", "expandInterimDuringStream", "fontSize", "sendShortcut", "theme", "themeScheduleDarkStart", "themeScheduleLightStart", "uiFontSize"]);
	const serialized = JSON.stringify(result.body);
	for (const secret of ["secret-token-value", "securityConfig", "acpTools", "terminalShells", "wslEnabled", "customPiPath", "/usr/bin/claude", "webTerminalEnabled"]) {
		assert.equal(serialized.includes(secret), false, `projection leaked ${secret}`);
	}
	assert.equal(result.body.settings.theme, "dark");
	assert.equal(result.body.settings.defaultAgentBackend, "dsh");
	// C1：Web 终端开关绝不能出现在投影里（只有桌面能开，浏览器不能给自己开终端）。
	assert.equal("webTerminalEnabled" in result.body.settings, false);
});

test("unknown keys are rejected with 400 and nothing is written", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const result = await call(routes, "/api/settings", "POST", { theme: "light", webServiceToken: "attacker" });
	assert.equal(result.status, 400);
	assert.equal(result.body.code, "webError.settings.unknownKey");
	assert.equal(result.body.field, "webServiceToken");
	assert.deepEqual(plain(calls.update), []);
});

test("invalid enum values are rejected with 400", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	for (const [key, value] of [
		["theme", "neon"],
		["fontSize", "huge"],
		["defaultAgentBackend", "acp"],
		["sendShortcut", "double-tap"],
		["expandInterimDuringStream", "yes"],
	]) {
		const result = await call(routes, "/api/settings", "POST", { [key]: value });
		assert.equal(result.status, 400, `${key}=${value} should be rejected`);
		assert.equal(result.body.code, "webError.settings.invalidValue");
		assert.equal(result.body.field, key);
	}
	assert.deepEqual(plain(calls.update), []);
});

test("valid patch is forwarded to update and the updated projection is returned", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const result = await call(routes, "/api/settings", "POST", { theme: "light", fontSize: "xlarge", uiFontSize: null });
	assert.equal(result.status, 200);
	assert.deepEqual(plain(calls.update), [{ theme: "light", fontSize: "xlarge", uiFontSize: null }]);
	assert.equal(result.body.settings.theme, "light");
	assert.equal(result.body.settings.fontSize, "xlarge");
	assert.equal(result.body.settings.uiFontSize, null);
});

test("choosing a default backend also pins the manual flag", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const result = await call(routes, "/api/settings", "POST", { defaultAgentBackend: "pi" });
	assert.equal(result.status, 200);
	assert.deepEqual(plain(calls.update), [{ defaultAgentBackend: "pi", defaultAgentBackendManual: true }]);
});

test("empty body and invalid JSON are rejected with 400", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const empty = await call(routes, "/api/settings", "POST", {});
	assert.equal(empty.status, 400);
	assert.equal(empty.body.code, "webError.invalidRequest");
	const invalid = await call(routes, "/api/settings", "POST", undefined, { invalidJson: true });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.code, "webError.invalidRequest");
	assert.deepEqual(plain(calls.update), []);
});

test("update failures surface as 500 and do not fake success", async () => {
	const { deps } = stubDeps({
		update: async () => {
			throw new Error("disk full");
		},
	});
	const routes = new WebSettingsRoutes(deps);
	const result = await call(routes, "/api/settings", "POST", { theme: "light" });
	assert.equal(result.status, 500);
	assert.equal(result.body.code, "webError.internal");
});

test("other paths and methods are not handled as settings writes", async () => {
	const { deps } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	const other = await call(routes, "/api/state", "GET");
	assert.equal(other.handled, false);
	const wrongMethod = await call(routes, "/api/settings", "PUT");
	assert.equal(wrongMethod.status, 405);
});

test("projection narrows non pi/dsh backends and flags them as desktop-only", () => {
	const projected = toSafeWebSettings(hostSettings({ defaultAgentBackend: "acp", expandInterimDuringStream: undefined }));
	assert.equal(projected.defaultAgentBackend, "pi");
	// 兜底显示 pi 必须带「这是桌面专属后端」的标记：否则面板会把 pi 当成真实默认值。
	assert.equal(projected.defaultAgentBackendDesktopOnly, true);
	assert.equal(projected.expandInterimDuringStream, true);

	for (const backend of ["pi", "dsh"]) {
		assert.equal(toSafeWebSettings(hostSettings({ defaultAgentBackend: backend })).defaultAgentBackendDesktopOnly, false);
	}
});

test("parseSafeWebSettingsPatch keeps null overrides and rejects non-object bodies", () => {
	const patch = parseSafeWebSettingsPatch({ chatFontSize: null, theme: "schedule" });
	assert.deepEqual(plain(patch), { chatFontSize: null, theme: "schedule" });
	assert.throws(() => parseSafeWebSettingsPatch([{ theme: "light" }]), WebSettingsValidationError);
	assert.throws(() => parseSafeWebSettingsPatch(null), WebSettingsValidationError);
});

test("prototype-chain keys are rejected as unknown settings (no whitelist bypass)", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	// `WRITABLE_SETTINGS[key]` 不加 hasOwn 时会命中原型链：constructor/toString 会被当成
	// 合法归一化函数接受并写进设置，__proto__/hasOwnProperty 则把 400 抬成 500。
	for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"]) {
		const result = await call(routes, "/api/settings", "POST", { [key]: "attacker" });
		assert.equal(result.status, 400, `${key} must be rejected as unknown setting`);
		assert.equal(result.body.code, "webError.settings.unknownKey", `${key} should map to unknownKey`);
		assert.equal(result.body.field, key);
	}
	assert.deepEqual(plain(calls.update), []);
});

test("oversized bodies are rejected with 413 without writing", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebSettingsRoutes(deps);
	// 32KB 逻辑上限：填充字段必然超过，路由应在解析前拒绝。
	const oversized = { theme: "light", padding: "x".repeat(40 * 1024) };
	const result = await call(routes, "/api/settings", "POST", oversized);
	assert.equal(result.status, 413);
	assert.equal(result.body.code, "webError.bodyTooLarge");
	assert.deepEqual(plain(calls.update), []);
});
