/**
 * Web 模型选择器的产品规则：分组、最近使用、能力徽标、上下文写法。
 *
 * 钉住四件事（都是容易在后续改版里静默回退的）：
 *   1. 当前模型必在「最近使用」首位（打开弹层第一眼要能确认现在是谁）；
 *   2. 最近使用去重、置顶、上限 5，坏数据不炸（localStorage 可能被写坏）；
 *   3. 能力徽标只认后端上报，不按模型名猜；
 *   4. 上下文窗口写法稳定（200000 → 200K，1000000 → 1M）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildModelGroups, formatContextWindow, modelCapabilityChips, modelKey, pushRecentModel, readRecentModels, writeRecentModels, RECENT_MODEL_LIMIT } = loadTsCommonJs("src/renderer/src/web/webModelPicker.ts");

/**
 * 生产模块经 vm 沙箱加载，返回的数组/对象来自另一个 realm：
 * assert.deepEqual 走 deepStrictEqual 会比较原型，跨 realm 直接报「same structure but not reference-equal」。
 * 断言前统一转成本 realm 的普通值。
 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function model(overrides = {}) {
	return { id: "m1", provider: "alpha", ...overrides };
}

function fakeStorage(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => store.set(key, value),
	};
}

test("模型键包含 provider：不同供应商的同名模型不互相串位", () => {
	assert.equal(modelKey({ provider: "a", id: "x" }), "a::x");
	assert.notEqual(modelKey({ provider: "a", id: "x" }), modelKey({ provider: "b", id: "x" }));
});

test("上下文窗口紧凑写法", () => {
	assert.equal(formatContextWindow(200_000), "200K");
	assert.equal(formatContextWindow(128_000), "128K");
	assert.equal(formatContextWindow(1_000_000), "1M");
	assert.equal(formatContextWindow(1_500_000), "1.5M");
	assert.equal(formatContextWindow(800), "800");
	assert.equal(formatContextWindow(undefined), undefined);
	assert.equal(formatContextWindow(0), undefined);
	assert.equal(formatContextWindow(Number.NaN), undefined);
});

// 沙箱与宿主原型不同，deepStrictEqual 会误报，统一走 JSON 比较。
const asJson = (value) => JSON.stringify(value);

test("能力徽标只认后端上报：思考最高档 / 不支持思考 / 视觉", () => {
	const labels = { reasoning: "推理", vision: "视觉", thinking: (level) => `思考 ${level}`, noThinking: "不支持思考" };
	const kinds = (input) => plain(modelCapabilityChips(input, labels)).map((chip) => chip.kind);
	const labelsOf = (input) => plain(modelCapabilityChips(input, labels)).map((chip) => chip.label);
	assert.equal(asJson(kinds(model())), "[]", "没有任何能力声明时不加徽标（不按名字猜）");
	assert.equal(asJson(kinds(model({ reasoning: true }))), asJson(["reasoning"]));
	// 档位是权威能力：写出最高档，而不是含糊的「推理」
	assert.equal(asJson(labelsOf(model({ thinkingLevels: ["off", "low", "high"] }))), asJson(["思考 high"]));
	assert.equal(asJson(labelsOf(model({ thinkingLevels: ["off", "minimal", "max"] }))), asJson(["思考 max"]));
	// 后端明确只接受 off = 不支持思考（不是「推理」也不是空徽标）
	assert.equal(asJson(labelsOf(model({ thinkingLevels: ["off"] }))), asJson(["不支持思考"]));
	assert.equal(asJson(labelsOf(model({ thinkingLevels: [] }))), asJson(["不支持思考"]));
	assert.equal(asJson(kinds(model({ images: true }))), asJson(["vision"]));
	assert.equal(asJson(kinds(model({ input: ["text", "image"] }))), asJson(["vision"]));
	assert.equal(asJson(kinds(model({ thinkingLevels: ["high"], images: true }))), asJson(["reasoning", "vision"]), "两个徽标顺序固定：思考在前");
});

test("分组顺序：最近使用置顶，当前模型强制在首位，其后是各供应商", () => {
	const models = [model({ id: "a1" }), model({ id: "a2" }), model({ id: "b1", provider: "beta" })];
	const groups = plain(buildModelGroups(models, ["beta::b1"], "alpha::a2", "最近使用"));
	assert.equal(groups[0].key, "recent");
	assert.deepEqual(
		groups[0].models.map((item) => modelKey(item)),
		["alpha::a2", "beta::b1"],
		"当前模型排第一，其后是最近使用（不含当前）",
	);
	assert.deepEqual(
		groups.slice(1).map((group) => group.key),
		["provider:alpha", "provider:beta"],
	);
	assert.deepEqual(
		groups[1].models.map((item) => item.id),
		["a1", "a2"],
		"供应商分组保持目录顺序，当前模型不被移出原分组",
	);
});

test("最近使用：去重、置顶、上限 5；当前模型不在列表时不硬塞", () => {
	assert.deepEqual(plain(pushRecentModel(["a::1", "a::2"], "a::2")), ["a::2", "a::1"]);
	assert.deepEqual(plain(pushRecentModel(["a::1", "a::2", "a::3", "a::4", "a::5"], "a::6")), ["a::6", "a::1", "a::2", "a::3", "a::4"]);
	assert.equal(pushRecentModel([], "a::1").length, 1);

	const groups = plain(buildModelGroups([model({ id: "a1" })], ["gone::x"], null, "最近使用"));
	assert.deepEqual(
		groups.map((group) => group.key),
		["provider:alpha"],
		"最近使用里只有已消失的模型时，不显示空分组",
	);
	// 过滤后的结果集里没有最近使用的模型（搜索命中别处）：同样不显示该分组
	const filtered = plain(buildModelGroups([model({ id: "a1" })], ["alpha::a2"], null, "最近使用"));
	assert.equal(
		filtered.some((group) => group.key === "recent"),
		false,
	);
});

test("最近使用存储：损坏数据当作空，写入失败不抛", () => {
	assert.deepEqual(plain(readRecentModels(fakeStorage({ "pideck:web-recent-models": JSON.stringify(["alpha::a1"]) }))), ["alpha::a1"]);
	assert.deepEqual(plain(readRecentModels(fakeStorage({ "pideck:web-recent-models": "{not json" }))), []);
	assert.deepEqual(plain(readRecentModels(fakeStorage({ "pideck:web-recent-models": JSON.stringify({ a: 1 }) }))), []);
	assert.deepEqual(plain(readRecentModels(fakeStorage({ "pideck:web-recent-models": JSON.stringify(["nokey", 42]) }))), [], "非法条目被剔除");
	assert.deepEqual(plain(readRecentModels(undefined)), [], "没有 storage（SSR / 隐私模式）时返回空");

	const failing = {
		getItem: () => null,
		setItem: () => {
			throw new Error("quota");
		},
	};
	assert.doesNotThrow(() => writeRecentModels(failing, ["alpha::a1"]), "写入失败不能影响选模型");

	const target = fakeStorage();
	writeRecentModels(
		target,
		Array.from({ length: 8 }, (_, index) => `alpha::m${index}`),
	);
	assert.equal(readRecentModels(target).length, RECENT_MODEL_LIMIT);
});
