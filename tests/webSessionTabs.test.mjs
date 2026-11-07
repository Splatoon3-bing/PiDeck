/**
 * Web 会话标签纯逻辑：打开/关闭/裁剪/持久化解析。
 * 这些规则决定「关掉当前标签后落到哪」与「轮询时会不会白白重渲染」，
 * 必须能离开 React 单测。
 *
 * 注：模块经 vm 加载，返回的数组/对象来自另一个 realm；跨 realm 的
 * `deepStrictEqual` 会连原型一起比，这里统一 JSON 归一化后断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { addWebTab, closeWebTab, parseStoredWebTabs, pruneWebTabs, shouldShowWebTabs, webTabTitle, MAX_WEB_TABS, WEB_TABS_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/web/webSessionTabs.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

test("parseStoredWebTabs tolerates bad data, dedupes, and caps the list", () => {
	assert.deepEqual(plain(parseStoredWebTabs(null)), []);
	assert.deepEqual(plain(parseStoredWebTabs("not json")), []);
	assert.deepEqual(plain(parseStoredWebTabs('{"a":1}')), []);
	assert.deepEqual(plain(parseStoredWebTabs('["a","a","",1,"b"]')), ["a", "b"]);
	const many = Array.from({ length: MAX_WEB_TABS + 5 }, (_, index) => `s${index}`);
	assert.equal(parseStoredWebTabs(JSON.stringify(many)).length, MAX_WEB_TABS);
	assert.equal(WEB_TABS_STORAGE_KEY, "pideck-web-tabs");
});

test("addWebTab appends once and drops the oldest beyond the cap", () => {
	const base = ["a", "b"];
	assert.deepEqual(plain(addWebTab(base, "c")), ["a", "b", "c"]);
	assert.deepEqual(plain(addWebTab(base, "a")), ["a", "b"]);
	assert.deepEqual(plain(addWebTab([], "a")), ["a"]);
	const full = Array.from({ length: MAX_WEB_TABS }, (_, index) => `s${index}`);
	const next = addWebTab(full, "new");
	assert.equal(next.length, MAX_WEB_TABS);
	assert.equal(next[0], "s1");
	assert.equal(next[next.length - 1], "new");
});

test("closeWebTab activates the right neighbor, then the left, then clears", () => {
	assert.deepEqual(plain(closeWebTab(["a", "b", "c"], "b", "b")), { ids: ["a", "c"], nextActiveId: "c" });
	assert.deepEqual(plain(closeWebTab(["a", "b"], "b", "b")), { ids: ["a"], nextActiveId: "a" });
	assert.deepEqual(plain(closeWebTab(["a"], "a", "a")), { ids: [], nextActiveId: "" });
	// 关的不是当前：激活项不动
	assert.deepEqual(plain(closeWebTab(["a", "b", "c"], "b", "a")), { ids: ["a", "c"], nextActiveId: "a" });
	// 不在列表里：原样返回
	assert.deepEqual(plain(closeWebTab(["a"], "x", "a")), { ids: ["a"], nextActiveId: "a" });
});

test("pruneWebTabs removes stale ids, keeps the active id, and preserves identity when unchanged", () => {
	const ids = ["a", "b", "c"];
	const known = new Set(["a", "c"]);
	// b 失效、a 是当前激活：裁剪为 a/c
	assert.deepEqual(plain(pruneWebTabs(ids, known, "a")), ["a", "c"]);
	// 当前激活项即使暂时不在目录里也保留（新建会话窗口期）
	assert.deepEqual(plain(pruneWebTabs(ids, known, "b")), ["a", "b", "c"]);
	// 未变化时返回同一引用：轮询 setState 不会触发整树重渲染
	const stable = ["a", "c"];
	assert.equal(pruneWebTabs(stable, new Set(["a", "c"]), "a"), stable);
});

test("tab bar visibility and title fallback", () => {
	assert.equal(shouldShowWebTabs([]), false);
	assert.equal(shouldShowWebTabs(["a"]), false);
	assert.equal(shouldShowWebTabs(["a", "b"]), true);
	assert.equal(webTabTitle("  hi  ", "untitled"), "hi");
	assert.equal(webTabTitle("   ", "untitled"), "untitled");
	assert.equal(webTabTitle(undefined, "untitled"), "untitled");
});
