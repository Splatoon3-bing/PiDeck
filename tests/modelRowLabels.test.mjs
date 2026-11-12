import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { modelRowName, modelRowIdentity, resolveModelThinkingSupport, highestThinkingLevel, buildImageGenModelGroups, buildVideoGenModelGroups } = loadTsCommonJs("src/renderer/src/components/session/sessionPickerOptions.ts");

/**
 * 模型选择器行文案的回归测试（2026-11 改两行式）。
 *
 * 行拆成两行：首行名称（渠道别名 / 中文名，可读性）+ 能力徽标，次行 `provider · id`（唯一身份）。
 * 为什么 id 必须进正文：本机 models.json 里 `cn:hy4free` 与 `cn:hy4std` 的 name 都是「Hy4」，
 * 旧单行 `provider/名称` 下两行完全一样，用户搜到的那行仍显示别名 → 结论是「我要的模型没有」。
 */
test("名称：自定义 name 优先，空白/缺失回落 id", () => {
	assert.equal(modelRowName({ id: "gpt-4o", name: "通义千问 Max" }), "通义千问 Max");
	assert.equal(modelRowName({ id: "gpt-4o" }), "gpt-4o");
	assert.equal(modelRowName({ id: "gpt-4o", name: "   " }), "gpt-4o");
	assert.equal(modelRowName({ id: "gpt-4o", name: " GPT-4o " }), "GPT-4o");
});

test("身份行：`provider · id`，重名模型可区分", () => {
	assert.equal(modelRowIdentity({ provider: "wbgw", id: "cn:hy4free" }), "wbgw · cn:hy4free");
	assert.notEqual(modelRowIdentity({ provider: "wbgw", id: "cn:hy4free" }), modelRowIdentity({ provider: "wbgw", id: "cn:hy4std" }));
});

// 沙箱（vm）里创建的对象与宿主原型不同，deepStrictEqual 会误报；统一用 JSON 比较。
const asJson = (value) => JSON.stringify(value);

test("思考能力：只接受 off（或 reasoning=false）判定为不支持，未探测不臆断", () => {
	assert.equal(asJson(resolveModelThinkingSupport({ thinkingLevels: ["off", "minimal", "low", "medium", "high"] })), asJson({ kind: "supported", maxLevel: "high" }));
	assert.equal(asJson(resolveModelThinkingSupport({ thinkingLevels: ["off", "minimal", "high", "xhigh", "max"] })), asJson({ kind: "supported", maxLevel: "max" }));
	assert.equal(asJson(resolveModelThinkingSupport({ thinkingLevels: ["off"] })), asJson({ kind: "unsupported" }));
	assert.equal(asJson(resolveModelThinkingSupport({ thinkingLevels: [] })), asJson({ kind: "unsupported" }));
	assert.equal(asJson(resolveModelThinkingSupport({ reasoning: false })), asJson({ kind: "unsupported" }));
	// 未探测（旧 pi / probe 未就绪）：保持 unknown，调用方走全量兼容档位。
	assert.equal(asJson(resolveModelThinkingSupport({ reasoning: true })), asJson({ kind: "unknown" }));
	assert.equal(asJson(resolveModelThinkingSupport({})), asJson({ kind: "unknown" }));
	// 展示顺序跟着后端走，最高档按规范顺序取（后端顺序打乱也不影响判定）。
	assert.equal(highestThinkingLevel(["high", "off", "max"]), "max");
});

test("生图/生视频分类：按供应商分组，标注只写配置里的事实", () => {
	const imageGroups = buildImageGenModelGroups({
		providers: [
			{ id: "wb2api", name: "wb2api", models: ["hunyuan-image-alpha", "hunyuan-image-alpha-edit", "hunyuan-image-alpha", ""], referenceMode: "edits" },
			{ id: "empty", name: "空供应商", models: [] },
		],
	});
	assert.equal(imageGroups.length, 1, "没有模型的供应商不占一个分组");
	assert.equal(imageGroups[0].id, "imagegen:wb2api");
	assert.equal(imageGroups[0].providerLabel, "wb2api");
	assert.equal(asJson(imageGroups[0].models.map((model) => model.id)), asJson(["hunyuan-image-alpha", "hunyuan-image-alpha-edit"]), "去重并丢弃空 id");
	// 「可带参考图」是供应商级声明：不能给每行都标「改图」——同网关下只有 -edit 模型能改图。
	assert.equal(imageGroups[0].supportsReferenceImage, true);
	assert.equal(asJson(imageGroups[0].models[0].capabilities), asJson(["textToImage"]));

	const videoGroups = buildVideoGenModelGroups({ providers: [{ id: "wb2api", name: "", models: ["minimax-video-h3", "kling-video-v3"] }] });
	assert.equal(videoGroups[0].id, "videogen:wb2api");
	assert.equal(videoGroups[0].providerLabel, "wb2api", "name 缺失时回落 id");
	assert.equal(asJson(videoGroups[0].models[0].capabilities), asJson(["textToVideo"]));
	assert.equal(asJson(buildImageGenModelGroups(undefined)), "[]");
	assert.equal(asJson(buildVideoGenModelGroups(undefined)), "[]");
});

test("Web 选择器同样用保存名称显示，identity 信息在弹层行内可见", () => {
	// WebHeader 第三批瘦身把模型选择迁到 WebModelSheet：pill 只显示保存名称（provider 在弹层内呈现），
	// identity（item.id）从旧版的 title tooltip 改为行内 caption ——信息仍可见，形式随 UI 迁移。
	const source = readFileSync("src/renderer/src/web/WebModelSheet.tsx", "utf8");
	assert.match(source, /resolveModelDisplayName\(model\.modelName,\s*model\.modelId\)/);
	assert.match(source, /const pillLabel\s*=\s*selectedName \?\? t\("web\.model"\);/);
	// 窗口化后模型行拆成独立组件 ModelRow(props)，不再闭包捕获 item
	assert.match(source, /const name = resolveModelDisplayName\(props\.item\.name, props\.item\.id\);/);
	// 2026-11 视觉返工：行改成两行式——首行名称（+ 能力徽标），次行 `provider · id` 与上下文窗口。
	// identity 仍在行内可见，只是从「与名称同行」换到次行，避免长名称与 id 挤成一团。
	assert.match(source, /\{name\}/, "行首仍必须渲染保存名称");
	assert.match(source, /\{props\.item\.provider\} · \{props\.item\.id\}/, "provider 与 id 同行可见");
});
