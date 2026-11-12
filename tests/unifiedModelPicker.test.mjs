import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 统一模型选择器在 dev 真机上暴露的三条链路回归（2026-11）。
 *
 * 这三条都属于「纯逻辑单测覆盖不到、只有窗口里点一遍才会暴露」的装配问题，
 * 因此用源码契约锁定，避免后续重构再次漏掉其中一环：
 * 1. 启动时必须把 videogen.json 读进 atom，否则生视频模型分类恒为空；
 * 2. cmdk 过滤掉整个分组时，自定义分组标题也要跟着隐藏；
 * 3. 引导页（无 catalog record）选媒体模型后，composer mode 必须跟着本地后端走，
 *    否则底栏隐掉 LLM chip 却不显示媒体参数栏。
 */

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const picker = readFileSync("src/renderer/src/components/ui-shadcn/command-picker.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");

test("App 启动同时加载生图与生视频配置到各自 atom", () => {
	assert.match(app, /videoGenConfigAtom/, "必须引入 videoGenConfigAtom");
	assert.match(app, /const setVideoGenConfig = useSetAtom\(videoGenConfigAtom\)/);
	assert.match(app, /api\.imagegen\s*\.getConfig\(\)\s*\.then\(setImageGenConfig\)/);
	assert.match(app, /api\.videogen\s*\.getConfig\(\)\s*\.then\(setVideoGenConfig\)/);
});

test("搜索过滤掉整组时，CommandPickerGroup 的外层标题一起隐藏", () => {
	// cmdk 只给内建 CommandGroup 加 hidden；我们的标题是外层自定义 <button>，
	// 不跟着 :has([cmdk-group][hidden]) 隐藏就会留下「wbgw 19 模型」这类空标题。
	assert.match(picker, /\[&:has\(\[cmdk-group\]\[hidden\]\)\]:hidden/);
});

test("引导页选媒体后端时 mode 由 guideMediaBackend 推导，不再依赖 catalog record", () => {
	assert.match(controller, /const guideMediaBackend = isGuideBootstrapSession && \(guideBackend === "imagegen" \|\| guideBackend === "videogen"\)/);
	assert.match(controller, /hasImageGenHistory \|\| guideMediaBackend === "imagegen"/);
	assert.match(controller, /isVideoGenBackend \|\| guideMediaBackend === "videogen"/);
	// 生图不再留第二份 guideBackend 特判：mode 是引导页媒体后端的唯一真值源。
	assert.match(controller, /const imageGenComposer = mode === "imagegen";/);
	assert.doesNotMatch(controller, /imageGenComposer = mode === "imagegen" \|\|/);
});

test("统一模型选择器把媒体分类接到 composer 的 mediaModelPicker", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const host = readFileSync("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8");
	assert.match(area, /mediaCatalog=\{composer\.delivery\.mediaModelPicker\}/);
	assert.match(host, /mediaCatalog=\{\s*props\.mediaCatalog/);
	assert.match(controller, /mediaModelPicker:/);
});
