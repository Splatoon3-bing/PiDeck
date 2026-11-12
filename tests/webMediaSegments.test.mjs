import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * Web 回合分组：媒体段（图片/视频/音频 file part）。
 *
 * 背景（用户反馈）：生图会话在 Web 端「生成成功但什么都看不到」——
 * 生图的 assistant 消息正文是空串，产物只在 `images` 字段（映射成 AI SDK file part），
 * 而分组只收 text/reasoning/tool，重建出的回合里没有产物段。
 *
 * 覆盖点：
 * - file part → media 段（src / mediaType 正确，非媒体 file part 不误收）；
 * - 媒体不参与「末段」判定：产物之前的正文仍提升为 finalText（不降级成中间回复）;
 * - 媒体段在流式/非流式下都不影响 liveTextId 语义。
 */

const load = createTsSandbox();
const { groupTimelineEntries, mediaSegmentFromFilePart } = load("src/renderer/src/web/webTimelineGrouping.ts");

const user = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id, parts) => ({ id, role: "assistant", parts });
const text = (value) => ({ type: "text", text: value });
const imageFile = (url, mediaType = "image/png") => ({ type: "file", mediaType, url });
const videoFile = (url, mediaType = "video/mp4") => ({ type: "file", mediaType, url });
const turnOf = (entries, index) => entries.filter((entry) => entry.kind === "turn")[index]?.turn;

test("生图回合：只有 file part 时也产出媒体段（正文为空不再等于空白回合）", () => {
	const blobUrl = "/api/imagegen/blob/abc123?token=t";
	const entries = groupTimelineEntries([user("u1", "画一只猫"), assistant("a1", [imageFile(blobUrl)])]);
	const turn = turnOf(entries, 0);
	const media = turn.segments.filter((segment) => segment.kind === "media");
	assert.equal(media.length, 1);
	assert.equal(media[0].src, blobUrl);
	assert.equal(media[0].mediaType, "image/png");
	assert.equal(turn.finalText, "");
});

test("媒体不参与末段判定：产物之前的正文仍提升为 finalText", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [text("这是最终回答"), imageFile("/api/file-raw?a=1")])]);
	const turn = turnOf(entries, 0);
	assert.equal(turn.finalText, "这是最终回答");
	// 提升后从过程组剔除，只剩媒体段
	// 跨 vm realm 的数组原型不同，deepEqual 前先摊回宿主数组
	assert.deepEqual([...turn.segments.map((segment) => segment.kind)], ["media"]);
});

test("视频/音频 file part 同样收成媒体段（生视频内联播放的前提）", () => {
	const entries = groupTimelineEntries([user("u1", "生成视频"), assistant("a1", [videoFile("/api/videogen/blob/x.mp4"), { type: "file", mediaType: "audio/mpeg", url: "/api/file-raw?y=1" }])]);
	const kinds = turnOf(entries, 0).segments.map((segment) => (segment.kind === "media" ? segment.mediaType : segment.kind));
	assert.deepEqual([...kinds], ["video/mp4", "audio/mpeg"]);
});

test("非媒体 file part 不当媒体渲染（附件/文档仍走原路径，不产生空 src）", () => {
	const segment = mediaSegmentFromFilePart({ type: "file", mediaType: "application/pdf", url: "/api/file-raw?z=1" }, "id");
	assert.equal(segment, null);
	// 没有地址的媒体 part 也放弃（宁可什么都不渲染，也不产出空 src 白图）
	assert.equal(mediaSegmentFromFilePart({ type: "file", mediaType: "image/png" }, "id"), null);
	// data URL 也能识别 MIME（用户消息里的参考图）
	assert.equal(mediaSegmentFromFilePart({ type: "file", data: "data:image/jpeg;base64,AAA", url: "" }, "id").mediaType, "image/jpeg");
});

test("流式中媒体段不改变 liveTextId 语义（末段正文仍挂容器外打字机）", () => {
	const entries = groupTimelineEntries([user("u1", "hi"), assistant("a1", [text("正在打字"), imageFile("/api/file-raw?a=2")])], { isStreaming: true });
	const turn = turnOf(entries, 0);
	assert.equal(turn.finalText, "");
	assert.ok(turn.liveTextId, "末段正文（媒体之前）仍应是 liveTextId");
	assert.equal(turn.segments.filter((segment) => segment.kind === "media").length, 1);
});
