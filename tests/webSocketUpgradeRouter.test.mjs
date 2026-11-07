/**
 * WebSocket upgrade 分发（T6 S1）：/api/terminal 优先于 dev HMR 代理，未装配时销毁。
 * 纯函数，覆盖三条路径与优先级。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveUpgradeTarget } = loadTsCommonJs("src/main/web/WebSocketUpgradeRouter.ts");

test("/api/terminal：装配了终端路由 → terminal；未装配 → destroy（不回落到 dev 代理）", () => {
	assert.equal(resolveUpgradeTarget({ pathname: "/api/terminal", hasTerminalRoutes: true, devProxyEnabled: false }), "terminal");
	assert.equal(resolveUpgradeTarget({ pathname: "/api/terminal", hasTerminalRoutes: true, devProxyEnabled: true }), "terminal");
	assert.equal(resolveUpgradeTarget({ pathname: "/api/terminal", hasTerminalRoutes: false, devProxyEnabled: true }), "destroy");
});

test("其它路径：dev 模式走 HMR 代理，生产模式销毁", () => {
	assert.equal(resolveUpgradeTarget({ pathname: "/", hasTerminalRoutes: true, devProxyEnabled: true }), "dev-proxy");
	assert.equal(resolveUpgradeTarget({ pathname: "/@vite/client", hasTerminalRoutes: true, devProxyEnabled: true }), "dev-proxy");
	assert.equal(resolveUpgradeTarget({ pathname: "/", hasTerminalRoutes: true, devProxyEnabled: false }), "destroy");
});
