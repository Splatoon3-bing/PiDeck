/**
 * Web 命令面板纯函数（过滤 / 排序 / 循环索引 / 分组）。
 *
 * 这些逻辑决定「键盘能不能用」：命中顺序错→回车执行了另一条命令；
 * 索引不回绕→最后一条之后按 ↓ 卡住。全部按纯函数断言。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { filterWebCommands, groupWebCommands, flattenGroupedCommands, moveCommandIndex, splitCommandQuery } = loadTsCommonJs("src/renderer/src/web/webCommands.ts");

/** vm 加载的模块返回另一个 realm 的数组/对象：deepStrictEqual 会连原型一起比，统一 JSON 归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const command = (id, group, title, keywords) => ({ id, group, title, keywords, run: () => undefined });

const COMMANDS = [
	command("app.settings", "app", "设置", "settings 外观"),
	command("app.theme", "app", "切换明暗主题", "theme 主题"),
	command("workspace.git", "workspace", "打开 Git 面板", "git 分支"),
	command("workspace.files", "workspace", "打开文件面板", "files 文件"),
	command("session.new", "session", "新建会话", "new session"),
];

test("empty query returns every command in its original order", () => {
	assert.deepEqual(plain(filterWebCommands(COMMANDS, "").map((entry) => entry.id)), plain(COMMANDS.map((entry) => entry.id)));
	assert.deepEqual(plain(splitCommandQuery("   ")), []);
});

test("multi-term queries are AND-matched against title and keywords", () => {
	assert.deepEqual(plain(filterWebCommands(COMMANDS, "打开 git").map((entry) => entry.id)), ["workspace.git"]);
	assert.deepEqual(plain(filterWebCommands(COMMANDS, "打开").map((entry) => entry.id)), ["workspace.git", "workspace.files"]);
	assert.deepEqual(plain(filterWebCommands(COMMANDS, "nothing-matches")), []);
});

test("title prefix matches rank before keyword-only matches", () => {
	// 「面板」作为标题子串命中两个 workspace 命令；「设置」用 keywords 命中 app.settings
	const ranking = filterWebCommands([command("a", "app", "打开面板", "settings"), command("b", "app", "设置", "panel")], "设置");
	// 只有 b 的标题以「设置」开头，因此在最前
	assert.deepEqual(plain(ranking.map((entry) => entry.id)), ["b"]);
	const byCommon = filterWebCommands(COMMANDS, "面板");
	assert.deepEqual(plain(byCommon.map((entry) => entry.id)), ["workspace.git", "workspace.files"]);
});

test("case-insensitive matching covers latin keywords", () => {
	assert.deepEqual(plain(filterWebCommands(COMMANDS, "GIT").map((entry) => entry.id)), ["workspace.git"]);
});

test("moveCommandIndex wraps in both directions and handles empty lists", () => {
	assert.equal(moveCommandIndex(0, 1, 3), 1);
	assert.equal(moveCommandIndex(2, 1, 3), 0);
	assert.equal(moveCommandIndex(0, -1, 3), 2);
	assert.equal(moveCommandIndex(-1, 1, 3), 0);
	assert.equal(moveCommandIndex(-1, -1, 3), 2);
	assert.equal(moveCommandIndex(0, 1, 0), -1);
});

test("grouping follows the fixed group order and keeps flattened order identical", () => {
	const groups = groupWebCommands(COMMANDS);
	assert.deepEqual(plain(groups.map((entry) => entry.group)), ["session", "workspace", "app"]);
	assert.deepEqual(plain(groups.map((entry) => entry.commands.map((item) => item.id))), [["session.new"], ["workspace.git", "workspace.files"], ["app.settings", "app.theme"]]);
	assert.deepEqual(plain(flattenGroupedCommands(groups).map((entry) => entry.id)), ["session.new", "workspace.git", "workspace.files", "app.settings", "app.theme"]);
});
