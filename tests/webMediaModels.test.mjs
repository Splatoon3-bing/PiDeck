import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toWebMediaModels } = loadTsCommonJs("src/main/web/WebMediaModels.ts");

/**
 * Web 媒体模型投影的安全边界（桌面端模型选择器的 Web 对齐）。
 *
 * 这两类模型的配置里带 apiKey / baseUrl / extraParams / defaults，
 * `/api/media-models` 是**未登录也能被 token 链外尝试**的读接口（实际仍走 /api/* 鉴权），
 * 投影一旦把凭据字段带出去就是泄漏面。这里逐项断言「只出 id/name/models/referenceMode」。
 */

const imageGen = {
	providers: [
		{ id: "wb2api", name: "wb2api", baseUrl: "http://100.66.1.2:7863/v1", apiKey: "SECRET-IMAGE-KEY", models: ["hunyuan-image-alpha", "hunyuan-image-alpha-edit", "hunyuan-image-alpha"], extraParams: { size: true, output_format: false, watermark: false }, referenceMode: "edits", apiStyle: "openai" },
		{ id: "empty", name: "空", baseUrl: "http://x", apiKey: "SECRET-EMPTY", models: [] },
	],
	activeProviderId: "wb2api",
	activeModel: "hunyuan-image-alpha",
};

const videoGen = {
	providers: [{ id: "wb2api", name: "wb2api", baseUrl: "http://100.66.1.2:7863", apiKey: "SECRET-VIDEO-KEY", protocol: "openai-videos", models: ["minimax-video-h3", "kling-video-v3"], defaults: { resolution: "768P" }, priceNote: "5s≈72 credits" }],
	activeProviderId: "wb2api",
	activeModel: "kling-video-v3",
	activeParams: { resolution: "768P" },
	costConfirm: true,
};

test("投影逐项剥掉凭据字段", () => {
	const projected = toWebMediaModels(imageGen, videoGen);
	const serialized = JSON.stringify(projected);
	for (const secret of ["SECRET-IMAGE-KEY", "SECRET-VIDEO-KEY", "SECRET-EMPTY", "100.66.1.2", "72 credits"]) {
		assert.equal(serialized.includes(secret), false, `投影里不允许出现 ${secret}`);
	}
	const imageProvider = projected.imageGen.providers[0];
	assert.equal(JSON.stringify(Object.keys(imageProvider).sort()), JSON.stringify(["id", "models", "name", "referenceMode"]));
	const videoProvider = projected.videoGen.providers[0];
	assert.equal(JSON.stringify(Object.keys(videoProvider).sort()), JSON.stringify(["id", "models", "name"]));
});

test("投影保留选择器需要的字段：模型去重、referenceMode 缺省 none、active 选择透传", () => {
	const projected = toWebMediaModels(imageGen, videoGen);
	assert.equal(projected.imageGen.providers[0].referenceMode, "edits");
	assert.equal(JSON.stringify(projected.imageGen.providers[0].models), JSON.stringify(["hunyuan-image-alpha", "hunyuan-image-alpha-edit"]), "重复模型只留一条");
	assert.equal(projected.imageGen.activeProviderId, "wb2api");
	assert.equal(projected.imageGen.activeModel, "hunyuan-image-alpha");
	assert.equal(projected.videoGen.activeModel, "kling-video-v3");
	assert.equal(projected.imageGen.configured, true);
	assert.equal(projected.videoGen.configured, true);

	const missingReferenceMode = toWebMediaModels(
		{ providers: [{ id: "p", name: "P", models: ["m"], baseUrl: "", apiKey: "" }], activeProviderId: "", activeModel: "" },
		{ providers: [], activeProviderId: "", activeModel: "", activeParams: {}, costConfirm: true },
	);
	assert.equal(missingReferenceMode.imageGen.providers[0].referenceMode, "none", "旧配置无 referenceMode 时按不支持参考图理解");
});

test("没有模型的供应商不参与 configured 判定", () => {
	const projected = toWebMediaModels({ providers: [{ id: "empty", name: "空", baseUrl: "", apiKey: "", models: ["  ", ""] }], activeProviderId: "", activeModel: "" }, { providers: [], activeProviderId: "", activeModel: "", activeParams: {}, costConfirm: true });
	assert.equal(projected.imageGen.configured, false);
	assert.equal(JSON.stringify(projected.imageGen.providers[0].models), "[]", "空白模型名不当作有效模型");
	assert.equal(projected.videoGen.configured, false);
});
