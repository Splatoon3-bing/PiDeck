import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { parseAgentTodoItems, parseTodoWidgetItems, sessionTodoSnapshotToItems } from "../src/renderer/src/components/session/agentTodoParser.ts";

const nodeRequire = createRequire(import.meta.url);
const parserPath = "src/renderer/src/components/session/agentTodoParser.ts";

/**
 * 「任务列表状态没更新」回归：数据源归一化与解析口径。
 *
 * 三个已确认缺陷：
 * - 多源拼平解析：两个 widget 源的同名任务共用 seenTitles 消歧表 → React key 复用，
 *   状态互相顶掉（完成后又变回未完成）；
 * - 前缀无差别剥离：parser 无条件剥 `#id` 与 `1. `，把用户正文也吃掉；
 * - coherent 但 widgets 被清空时不回落快照：任务条直接消失/停在旧帧。
 */

const stripPath = "src/renderer/src/components/session/SessionTodoStrip.tsx";

/** SessionTodoStrip.tsx 只做模块顶层定义，纯函数（todoWidgetsToItems）可在空 stub 下加载。 */
function loadStrip() {
	const source = readFileSync(stripPath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: stripPath,
	}).outputText;
	const module = { exports: {} };
	// 相对导入必须拿到真实模块：SessionTodoStrip 的纯函数依赖 agentTodoParser，
	// 其余（react/jotai/lucide/UI 组件）只在组件函数体内使用，空 stub 足够。
	const parser = nodeRequire(`../${parserPath}`);
	const localRequire = (specifier) => (specifier.includes("agentTodoParser") ? parser : {});
	vm.runInNewContext(output, { module, exports: module.exports, require: localRequire, console }, { filename: stripPath });
	return module.exports;
}

test("跨源同名任务不再共用 React key，状态各自保留", () => {
	const { todoWidgetsToItems } = loadStrip();
	const items = todoWidgetsToItems([
		{ key: "pi-deck-todo", lines: ["☐ #1 修复登录"] },
		{ key: "pi-deck-plan-todos", lines: ["☑ 1. 修复登录"] },
	]);
	assert.equal(items.length, 2);
	const [todoItem, planItem] = [...items];
	// 状态没有被对方顶掉：两条都还在，且各自保留自己的状态
	assert.equal(todoItem.status, "pending");
	assert.equal(planItem.status, "completed");
	// id 带来源前缀 → key 不可能相同
	assert.notEqual(todoItem.id, planItem.id);
	assert.match(todoItem.id, /^pi-deck-todo:/);
	assert.match(planItem.id, /^pi-deck-plan-todos:/);
});

test("同源重复正文仍按出现序号消歧（既有稳定性不变）", () => {
	const items = [...parseTodoWidgetItems({ key: "pi-deck-todo", lines: ["☐ #1 写文档", "☐ #2 写文档"] })];
	assert.equal(items.length, 2);
	assert.notEqual(items[0].id, items[1].id);
	assert.equal(items[0].title, "写文档");
	assert.equal(items[1].title, "写文档");
});

test("pi-deck-todo 只剥自己的 #id，正文里的步骤号前缀保留", () => {
	const [item] = [...parseTodoWidgetItems({ key: "pi-deck-todo", lines: ["☐ #7 1. 修复登录页"] })];
	// `#7` 是扩展生成的前缀；`1. ` 是用户正文，剥掉会让同一任务在不同路径下文本分叉
	assert.equal(item.title, "1. 修复登录页");
	assert.equal(item.status, "pending");
});

test("pi-deck-plan-todos 只剥自己的步骤号，正文里的 # 前缀保留", () => {
	const [item] = [...parseTodoWidgetItems({ key: "pi-deck-plan-todos", lines: ["◐ 12. #42 回归单"] })];
	assert.equal(item.title, "#42 回归单");
	assert.equal(item.status, "in-progress");
});

test("PiDeck 自生成行（dsh-todos / snapshot）不剥任何正文前缀", () => {
	const [dshItem] = [...parseTodoWidgetItems({ key: "dsh-todos", lines: ["☐ 2024 数据迁移"] })];
	assert.equal(dshItem.title, "2024 数据迁移");
	const [snapshotItem] = [...parseTodoWidgetItems({ key: "snapshot", lines: ["☑ #9 发布会 #2 复盘"] })];
	assert.equal(snapshotItem.title, "#9 发布会 #2 复盘");
	assert.equal(snapshotItem.status, "completed");
});

test("历史快照直接走结构化转换，正文前缀不被行式 parser 吃掉", () => {
	const items = [
		...sessionTodoSnapshotToItems({
			planId: 4,
			todos: [
				{ id: 1, text: "1. 设计 schema", status: "pending" },
				{ id: 2, text: "#7 修复分页", status: "completed" },
			],
		}),
	];
	assert.deepEqual(
		items.map((item) => [item.title, item.status]),
		[
			["1. 设计 schema", "pending"],
			["#7 修复分页", "completed"],
		],
	);
});

test("不知道来源的第三方 widget 仍走宽松口径（向后兼容不变）", () => {
	const items = [...parseAgentTodoItems(["☐ #1 1. 设计 schema", "☑ 3. 发布"])];
	assert.equal(items[0].title, "设计 schema");
	assert.equal(items[1].title, "发布");
});

test("coherent 但 widget 被清空时回落会话快照，而不是当成没有计划", () => {
	const strip = readFileSync(stripPath, "utf8");
	// 快照拉取的触发条件必须包含「活会话缺 todo widget」
	assert.match(strip, /const hasTodoWidget = Boolean\(widgets\["pi-deck-todo"\]\?\.length \|\| widgets\["pi-deck-plan-todos"\]\?\.length\)/);
	assert.match(strip, /useSessionTodoSnapshot\(sessionId, !coherent \|\| !hasTodoWidget\)/);
	// widget 分支为空时必须回落，不能直接返回空数组
	assert.match(strip, /if \(result\.length > 0\) return result;[\s\S]{0,400}?sessionTodoSnapshotToItems\(todoSnapshot\)/);
});

test("dismiss 指纹仍按原始 widget 行计算（元数据参与，不受解析口径影响）", () => {
	const { widgetLinesSignature } = loadStrip();
	const withMetadata = ["[[pid:todo-plan:branch-a:7]]", "☐ #1 修复登录"];
	const otherPlan = ["[[pid:todo-plan:branch-a:8]]", "☐ #1 修复登录"];
	// 任务文本相同但计划身份不同 → 指纹不同（新计划不会被旧 dismiss 记录隐藏）
	assert.notEqual(widgetLinesSignature(withMetadata), widgetLinesSignature(otherPlan));
});
