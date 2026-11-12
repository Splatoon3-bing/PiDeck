import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 生视频模型能力目录 + 参数纠正。
 *
 * 背景：`resolution / aspect_ratio / seconds` 的合法域是**按模型**的，不是按协议族。
 * 实测同一网关（wb2api）里 kling-video-v3 只认 720P/1080P/4K，minimax-video-h3 只认
 * 768P/2K；网关对这两个字段不做校验、原样透传上游，于是「切模型后沿用上一个模型的
 * 默认值」= 给上游发它不认识的值。这里锁定的是：目录解析容错 + 只纠正用户明确选过的维度。
 */

const { parseVideoModelCatalog, clampVideoGenParams, findVideoModelCapability } = loadTsCommonJs("src/shared/videoModelCatalog.ts");
const { fetchVideoModelCatalog } = loadTsCommonJs("src/main/videogen/videoModelCatalog.ts");

/** 真实 wb2api 目录的裁剪版（字段名与 video_generation 块同源）。 */
const liveCatalogPayload = {
	data: [
		{
			id: "kling-video-v3",
			object: "model",
			name: "Kling-Video-V3",
			video_generation: { resolutions: ["720P", "1080P", "4K"], defaultResolution: "720P", aspectRatios: ["16:9", "9:16", "1:1"], defaultAspectRatio: "16:9", minSeconds: 3, maxSeconds: 15, defaultSeconds: 5 },
		},
		{
			id: "minimax-video-h3",
			object: "model",
			name: "MiniMax-H3",
			video_generation: { resolutions: ["768P", "2K"], defaultResolution: "768P", aspectRatios: ["adaptive", "21:9", "16:9"], defaultAspectRatio: "adaptive", minSeconds: 4, maxSeconds: 15, defaultSeconds: 5 },
		},
	],
};

test("parseVideoModelCatalog：解析真实目录形状（分辨率/画幅/时长区间）", () => {
	const catalog = parseVideoModelCatalog(liveCatalogPayload);
	assert.equal(catalog.length, 2);
	const kling = findVideoModelCapability(catalog, "kling-video-v3");
	assert.deepEqual([...kling.resolutions], ["720P", "1080P", "4K"]);
	assert.equal(kling.defaultResolution, "720P");
	assert.deepEqual([...kling.aspectRatios], ["16:9", "9:16", "1:1"]);
	assert.equal(kling.minSeconds, 3);
	assert.equal(kling.maxSeconds, 15);
	assert.equal(kling.defaultSeconds, 5);
});

test("parseVideoModelCatalog：脏数据不炸（缺能力块/非对象/无 id 一律跳过）", () => {
	// 沙箱返回的是跨 realm 数组，比较前摊回宿主数组
	assert.deepEqual([...parseVideoModelCatalog(null)], []);
	assert.deepEqual([...parseVideoModelCatalog({ data: "nope" })], []);
	const catalog = parseVideoModelCatalog({
		data: [
			{ id: "", video_generation: {} },
			{ object: "model" },
			"junk",
			null,
			// 没有 video_generation：能力未声明，但模型本身可用
			{ id: "m-plain" },
			// 能力块字段错类型：只保留可解析的部分
			{ id: "m-partial", video_generation: { resolutions: "768P", aspectRatios: [1, "16:9"], minSeconds: -1 } },
		],
	});
	assert.deepEqual([...catalog.map((item) => item.id)], ["m-plain", "m-partial"]);
	const plain = findVideoModelCapability(catalog, "m-plain");
	assert.deepEqual([...plain.resolutions], []);
	const partial = findVideoModelCapability(catalog, "m-partial");
	assert.deepEqual([...partial.aspectRatios], ["16:9"]);
	assert.equal(partial.minSeconds, undefined);
});

test("clampVideoGenParams：切换模型时把上个模型的默认值纠正到合法域", () => {
	const kling = findVideoModelCapability(parseVideoModelCatalog(liveCatalogPayload), "kling-video-v3");
	// minimax 的默认值（768P / adaptive）对 kling 都不合法 → 换成 kling 的默认值
	const clamped = clampVideoGenParams({ resolution: "768P", ratio: "adaptive", duration: "5" }, kling);
	assert.equal(clamped.params.resolution, "720P");
	assert.equal(clamped.params.ratio, "16:9");
	assert.equal(clamped.params.duration, "5");
	assert.deepEqual([...clamped.changed], ["resolution", "ratio"]);
});

test("clampVideoGenParams：值本来就合法时不动（幂等，避免纠正循环）", () => {
	const kling = findVideoModelCapability(parseVideoModelCatalog(liveCatalogPayload), "kling-video-v3");
	const once = clampVideoGenParams({ resolution: "1080P", ratio: "9:16", duration: "10" }, kling);
	assert.deepEqual([...once.changed], []);
	const twice = clampVideoGenParams({ resolution: "768P", ratio: "adaptive", duration: "5" }, kling);
	const again = clampVideoGenParams(twice.params, kling);
	assert.deepEqual([...again.changed], [], "纠正后的值再纠正必须收敛");
});

test("clampVideoGenParams：时长夹到 [min,max]，非数字原样保留", () => {
	const minimax = findVideoModelCapability(parseVideoModelCatalog(liveCatalogPayload), "minimax-video-h3");
	assert.equal(clampVideoGenParams({ duration: "2" }, minimax).params.duration, "4");
	assert.equal(clampVideoGenParams({ duration: "99" }, minimax).params.duration, "15");
	assert.equal(clampVideoGenParams({ duration: "8" }, minimax).params.duration, "8");
	// 非数字不猜（保留原文，交给上游/用户处理）
	assert.equal(clampVideoGenParams({ duration: "abc" }, minimax).params.duration, "abc");
});

test("clampVideoGenParams：undefined = 用上游默认，一律不填值", () => {
	const kling = findVideoModelCapability(parseVideoModelCatalog(liveCatalogPayload), "kling-video-v3");
	const clamped = clampVideoGenParams({ resolution: undefined, ratio: undefined, duration: undefined }, kling);
	assert.equal(clamped.params.resolution, undefined);
	assert.equal(clamped.params.ratio, undefined);
	assert.equal(clamped.params.duration, undefined);
	assert.deepEqual([...clamped.changed], []);
	// 没有能力表（老协议族 / 目录拉取失败）：完全不纠正
	assert.deepEqual([...clampVideoGenParams({ resolution: "768P" }, undefined).changed], []);
});

test("fetchVideoModelCatalog：只服务 openai-videos，带 Bearer 打 /v1/videos/models", async () => {
	const calls = [];
	const result = await fetchVideoModelCatalog({
		protocol: "openai-videos",
		baseUrl: "http://gw.example.com/",
		apiKey: " sk-1 ",
		fetchImpl: async (url, init) => {
			calls.push({ url, headers: init?.headers });
			return { ok: true, status: 200, json: async () => liveCatalogPayload };
		},
	});
	assert.equal(result.ok, true);
	assert.equal(calls[0].url, "http://gw.example.com/v1/videos/models");
	assert.equal(calls[0].headers.Authorization, "Bearer sk-1");
	assert.equal(result.models.length, 2);

	// 老协议族没有目录端点：直接 unsupported，不发请求
	let touched = false;
	const unsupported = await fetchVideoModelCatalog({
		protocol: "minimax-v2",
		baseUrl: "http://gw.example.com",
		apiKey: "sk",
		fetchImpl: async () => {
			touched = true;
			return { ok: true, status: 200, json: async () => ({ data: [] }) };
		},
	});
	assert.equal(unsupported.ok, false);
	assert.equal(unsupported.error, "unsupported");
	assert.equal(touched, false);
});

test("fetchVideoModelCatalog：缺凭据/网络错/HTTP 错都回结构化错误（不抛）", async () => {
	assert.equal((await fetchVideoModelCatalog({ protocol: "openai-videos", baseUrl: "", apiKey: "k" })).error, "notConfigured");
	assert.equal((await fetchVideoModelCatalog({ protocol: "openai-videos", baseUrl: "http://gw", apiKey: "" })).error, "notConfigured");
	const network = await fetchVideoModelCatalog({
		protocol: "openai-videos",
		baseUrl: "http://gw",
		apiKey: "k",
		fetchImpl: async () => {
			throw new Error("ECONNREFUSED");
		},
	});
	assert.equal(network.error, "network");
	const http = await fetchVideoModelCatalog({ protocol: "openai-videos", baseUrl: "http://gw", apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
	assert.equal(http.error, "http");
	// 空目录不是错误：有些网关不返回 data（能力未声明 → 调用方退回协议族预设）
	const empty = await fetchVideoModelCatalog({ protocol: "openai-videos", baseUrl: "http://gw", apiKey: "k", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
	assert.equal(empty.ok, true);
	assert.deepEqual([...empty.models], []);
});
