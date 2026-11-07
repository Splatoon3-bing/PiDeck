/**
 * Web 端「前端已重新构建」判定、ETag 承载与服务端构建指纹（纯函数 / 真实文件行为）。
 *
 * 关键场景：桌面端重新构建后，web.html 引用的 bundle 文件名（含 content hash）全变，
 * 旧页面一刷新就是 404。所以服务端下发构建指纹，前端只提示「更新」，由用户点击重载。
 * 覆盖三件容易回退的事：
 *   1. 判定保守（无基线 / 无当前指纹都不提示）；
 *   2. 指纹必须进 /api/state 的 ETag，否则重建后客户端拿 304，按钮永远不亮；
 *   3. 服务端指纹随 web.html 内容变化，dev 代理模式不参与。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { hasNewerBuild, recordLoadedBuildId } = loadTsCommonJs("src/renderer/src/web/webBuildUpdate.ts");
const { stateEtag } = loadTsCommonJs("src/main/web/WebStateEtag.ts");
const { WebStaticAssets } = loadTsCommonJs("src/main/web/WebStaticAssets.ts");

test("无基线或服务端无指纹时不提示更新（dev / 首个快照未到）", () => {
	assert.equal(hasNewerBuild(null, "abc"), false, "尚未记录本页版本时不能误报");
	assert.equal(hasNewerBuild(undefined, "abc"), false);
	assert.equal(hasNewerBuild("abc", null), false, "服务端未下发指纹（dev 代理模式）不提示");
	assert.equal(hasNewerBuild("abc", ""), false);
	assert.equal(hasNewerBuild("", "abc"), false, "空串不是有效基线");
});

test("指纹变化才提示更新；相同不提示", () => {
	assert.equal(hasNewerBuild("build-a", "build-a"), false);
	assert.equal(hasNewerBuild("build-a", "build-b"), true);
});

test("基线只记录一次：后续指纹变化不能改写基线（否则按钮亮一帧就灭）", () => {
	const baseline = recordLoadedBuildId(null, "build-a");
	assert.equal(baseline, "build-a");
	assert.equal(recordLoadedBuildId(baseline, "build-b"), "build-a", "基线固定为页面加载时的版本");
	assert.equal(recordLoadedBuildId(null, null), null, "没有指纹时保持无基线");
	assert.equal(recordLoadedBuildId(null, ""), null, "空串不算基线");
});

test("构建指纹进 ETag：重建（只改指纹）必须让缓存失效", () => {
	const base = { projects: [{ id: "p1", name: "PiDeck", path: "/repo" }], sessions: [], runtimes: [], pendingUiRequests: [] };
	assert.notEqual(stateEtag({ ...base, buildId: "build-b" }), stateEtag({ ...base, buildId: "build-a" }), "指纹变化必须换 ETag，否则客户端 304 永远看不到更新按钮");
	assert.equal(stateEtag({ ...base }), stateEtag({ ...base, buildId: undefined }), "缺省指纹与未下发等价");
});

test("服务端指纹取自 web.html 内容，重建即变；dev 代理模式不参与", () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-buildid-"));
	try {
		const assets = new WebStaticAssets({ rendererRoot: root });
		assert.equal(assets.buildId(), "", "构建产物缺失时为空串");
		writeFileSync(join(root, "web.html"), '<script type="module" src="/assets/web-AAA.js"></script>');
		const first = assets.buildId();
		assert.match(first, /^[0-9a-f]{12}$/);
		assert.equal(assets.buildId(), first, "内容未变要命中缓存");
		writeFileSync(join(root, "web.html"), '<script type="module" src="/assets/web-BBB.js"></script>');
		assert.notEqual(assets.buildId(), first, "bundle 名变化即视为新构建");

		const devAssets = new WebStaticAssets({ rendererRoot: root, devRendererUrl: "http://127.0.0.1:5173" });
		assert.equal(devAssets.buildId(), "", "dev 模式资源来自 vite，不做构建指纹检测");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
