/**
 * 分屏（只读 peek）选择规则与持久化（T7b）。
 *
 * 纯函数：左邻优先、右邻兜底、单标签不分屏、找不到当前标签时取第一个其它会话。
 * 持久化：写入/读取/清除（用 vm 注入假 window.localStorage）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const store = new Map();
const fakeWindow = {
	localStorage: {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => store.set(key, String(value)),
		removeItem: (key) => store.delete(key),
	},
};

const { pickSplitPartner, readStoredSplitSession, storeSplitSession, WEB_SPLIT_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/web/webSplitView.ts", { globals: { window: fakeWindow } });

test("pickSplitPartner：左邻优先，右邻兜底，单标签不分屏", () => {
	assert.equal(pickSplitPartner(["a", "b", "c"], "b"), "a");
	assert.equal(pickSplitPartner(["a", "b", "c"], "c"), "b");
	assert.equal(pickSplitPartner(["a", "b"], "a"), "b");
	assert.equal(pickSplitPartner(["a"], "a"), null);
	assert.equal(pickSplitPartner([], "a"), null);
	// 当前标签不在列表里（被删/刷新竞态）：取第一个其它会话
	assert.equal(pickSplitPartner(["a", "b"], "zzz"), "a");
});

test("分屏会话持久化：写入 / 读取 / 清除，坏值回落 null", () => {
	assert.equal(readStoredSplitSession(), null);
	storeSplitSession("session-1");
	assert.equal(readStoredSplitSession(), "session-1");
	assert.equal(store.get(WEB_SPLIT_STORAGE_KEY), "session-1");
	storeSplitSession(null);
	assert.equal(readStoredSplitSession(), null);
	assert.equal(store.has(WEB_SPLIT_STORAGE_KEY), false);
	// 空串按「没有」处理，避免刷新后 splitSessionId="" 触发无意义查询
	store.set(WEB_SPLIT_STORAGE_KEY, "");
	assert.equal(readStoredSplitSession(), null);
});
