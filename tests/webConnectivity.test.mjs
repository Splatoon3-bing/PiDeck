import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveConnectionPhase } = loadTsCommonJs("src/renderer/src/web/webConnectivity.ts");

test("设备离线优先于服务端可达性：离线就是 offline", () => {
	assert.equal(resolveConnectionPhase(true, false), "offline");
	assert.equal(resolveConnectionPhase(false, false), "offline");
});

test("设备在线时按服务端可达性区分 online / connecting", () => {
	assert.equal(resolveConnectionPhase(true, true), "online");
	assert.equal(resolveConnectionPhase(false, true), "connecting");
});
