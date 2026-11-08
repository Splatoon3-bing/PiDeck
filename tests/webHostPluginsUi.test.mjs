/**
 * T14 宿主插件的 Web 渲染层入口：只读安全投影。
 *
 * 边界（安全评审见 .ai/sdd/specs/001-web-parity/t14-host-plugin-security-review.md）：
 * - 面板只展示 `id/name/version/description/enabled/requiresConsent/permissions`；
 * - 不提供开关/安装/授权/执行入口（那些只在桌面端）；
 * - 服务端 503（未装配目录）只让该 tab 显示不可用，不影响技能/扩展面板。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const dialog = readFileSync("src/renderer/src/web/WebSkillsExtensionsDialog.tsx", "utf8");
const zhCn = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUs = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const zhTw = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");

function hostPluginsSection() {
	const start = dialog.indexOf('<TabsContent value="hostPlugins"');
	const end = dialog.indexOf("</TabsContent>", start);
	assert.ok(start >= 0 && end > start, "host plugins tab must render a TabsContent section");
	return dialog.slice(start, end);
}

test("宿主插件 tab：只展示安全投影字段", () => {
	assert.match(dialog, /<TabsTrigger value="hostPlugins">\{t\("web\.tabHostPlugins"\)\}<\/TabsTrigger>/);
	const section = hostPluginsSection();
	for (const field of ["plugin.name", "plugin.version", "plugin.description", "plugin.enabled", "plugin.requiresConsent", "plugin.permissions"]) {
		assert.ok(section.includes(field), `host plugin tab must render ${field}`);
	}
	// 不可用/空列表也必须有明确文案，而不是静默空白。
	assert.match(section, /web\.hostPluginsUnavailable/);
	assert.match(section, /web\.hostPluginsEmpty/);
	assert.match(section, /web\.hostPluginsReadOnlyHint/);
});

test("宿主插件 tab 只读：没有开关、安装、授权或执行动作", () => {
	const section = hostPluginsSection();
	assert.doesNotMatch(section, /<Switch\b/, "host plugins are read-only on web");
	assert.doesNotMatch(section, /onCheckedChange|onClick=\{\(\)\s*=>\s*(?:void\s+)?(?:toggle|install|consent|execute)/, "host plugin tab must not expose write actions");
});

test("503 只降级宿主插件 tab，不影响技能/扩展面板", () => {
	// listWebHostPlugins 对 503 返回 null（而不是抛错把整面板打入 error 相位）。
	assert.match(dialog, /listWebHostPlugins\(\)\.catch\(\(\) => null\)/);
	assert.match(dialog, /hostPlugins: WebHostPluginSummary\[\] \| null/);
});

test("宿主插件文案三语齐全（zh-TW 为生成物）", () => {
	for (const key of ["web.tabHostPlugins", "web.hostPluginsEmpty", "web.hostPluginsUnavailable", "web.hostPluginsReadOnlyHint", "web.hostPluginConsentRequired", "web.hostPluginPermissions"]) {
		assert.ok(zhCn.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(enUs.includes(`"${key}"`), `en-US missing ${key}`);
		assert.ok(zhTw.includes(`"${key}"`), `zh-TW missing ${key}`);
	}
});

test("Web API：503 视为不可用（null），200 返回只读投影", async () => {
	// webApi 在 vm 沙箱里求值，沙箱没有默认 fetch；用可变委托注入（而非全局打补丁）。
	let respond = async () => ({ status: 503, ok: false, json: async () => ({}) });
	const { listWebHostPlugins } = loadTsCommonJs("src/renderer/src/web/webApi.ts", { globals: { fetch: (input, init) => respond(input, init) } });

	assert.equal(await listWebHostPlugins(), null);

	const plugins = [{ id: "example.plugin", name: "Example", version: "1.2.3", enabled: true, requiresConsent: false, permissions: [] }];
	respond = async () => ({ status: 200, ok: true, json: async () => ({ plugins }) });
	const result = await listWebHostPlugins();
	assert.deepEqual(JSON.parse(JSON.stringify(result)), plugins);

	respond = async () => ({ status: 405, ok: false, json: async () => ({}) });
	await assert.rejects(listWebHostPlugins(), /host plugins 405/);
});
