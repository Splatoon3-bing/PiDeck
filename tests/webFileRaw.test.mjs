import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `/api/file-raw`：Web 端媒体字节出口。
 *
 * 背景（用户反馈）：Web 文件预览把图片/视频/PDF 一律当「二进制文件，不支持预览」，
 * 正文里的本地图片也加载不出来（桌面走 `pideck-file://`，浏览器没有这个协议）。
 * 字节必须由服务端 HTTP 路由下发，`<img>`/`<video>` 才能渲染——因此这条路由除了
 * Content-Type 之外，还必须支持单段 Range（视频拖进度）与越界 416。
 *
 * 这里锁定的是成熟静态文件服务的语义（express `send` / tornado StaticFileHandler）：
 * 200 全量 / 206 单段 / 416 越界 / 多段或非法 Range 退回全量 200。
 */

const { WebWorkspaceRoutes, parseSingleByteRange } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);

/** 可被 pipeline 写入的假响应：收集字节 + 记录 writeHead。 */
function createResponse() {
	const chunks = [];
	const response = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			callback();
		},
	});
	response.status = 0;
	response.headers = {};
	response.writeHead = (status, headers) => {
		response.status = status;
		response.headers = headers ?? {};
	};
	response.body = () => Buffer.concat(chunks);
	return response;
}

async function withProjectFixture(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-file-raw-"));
	try {
		await writeFile(join(root, "a.png"), PNG_BYTES);
		await writeFile(join(root, "notes.txt"), "hello");
		const routes = new WebWorkspaceRoutes({ listProjects: () => [{ id: "p1", name: "demo", path: root }] });
		await run({ root, routes });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function request(range) {
	return { method: "GET", headers: range === undefined ? {} : { range } };
}

test("parseSingleByteRange：单段/开区间/后缀/越界/多段语义", () => {
	// 沙箱返回的对象跨 realm（原型不同，deepStrictEqual 会判不等），逐字段断言
	const span = (header, size) => {
		const value = parseSingleByteRange(header, size);
		return value === null ? null : value === undefined ? undefined : [value.start, value.end];
	};
	assert.deepEqual(span("bytes=0-3", 10), [0, 3]);
	assert.deepEqual(span("bytes=5-", 10), [5, 9]);
	assert.deepEqual(span("bytes=-3", 10), [7, 9]);
	// 结束位置超过文件长度时夹到最后一个字节
	assert.deepEqual(span("bytes=2-99", 10), [2, 9]);
	// 起始位置越界 → 416（null）；多段/非 bytes 单位/语法非法 → 忽略 Range（undefined）
	assert.equal(span("bytes=10-12", 10), null);
	assert.equal(span("bytes=0-1,4-5", 10), undefined);
	assert.equal(span("items=0-1", 10), undefined);
	assert.equal(span("bytes=abc", 10), undefined);
	assert.equal(span(undefined, 10), undefined);
});

test("无 Range：200 全量 + 媒体 Content-Type + 可缓存声明", async () => {
	await withProjectFixture(async ({ routes }) => {
		const response = createResponse();
		const handled = await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=a.png"), request(), response);
		assert.equal(handled, true);
		assert.equal(response.status, 200);
		assert.equal(response.headers["content-type"], "image/png");
		assert.equal(response.headers["accept-ranges"], "bytes");
		assert.equal(response.headers["content-length"], String(PNG_BYTES.byteLength));
		assert.equal(response.headers["x-content-type-options"], "nosniff");
		assert.equal(response.body().toString("binary"), PNG_BYTES.toString("binary"));
	});
});

test("单段 Range：206 + Content-Range（视频拖进度的前提）", async () => {
	await withProjectFixture(async ({ routes }) => {
		const response = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=a.png"), request("bytes=2-5"), response);
		assert.equal(response.status, 206);
		assert.equal(response.headers["content-range"], `bytes 2-5/${PNG_BYTES.byteLength}`);
		assert.equal(response.headers["content-length"], "4");
		assert.equal(response.body().toString("binary"), PNG_BYTES.subarray(2, 6).toString("binary"));
	});
});

test("越界 Range：416 + 总长；多段 Range 退回 200 全量", async () => {
	await withProjectFixture(async ({ routes }) => {
		const unsatisfiable = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=a.png"), request("bytes=999-1000"), unsatisfiable);
		assert.equal(unsatisfiable.status, 416);
		assert.equal(unsatisfiable.headers["content-range"], `bytes */${PNG_BYTES.byteLength}`);

		const multi = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=a.png"), request("bytes=0-1,4-5"), multi);
		assert.equal(multi.status, 200);
		assert.equal(multi.body().toString("binary"), PNG_BYTES.toString("binary"));
	});
});

test("路径边界与错误分流：越界 403、缺失 404、未知项目 404、非媒体按 octet-stream", async () => {
	await withProjectFixture(async ({ routes }) => {
		const escape = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=../secret.png"), request(), escape);
		assert.equal(escape.status, 403);
		assert.equal(JSON.parse(String(escape.body())).code, "webError.fileOutsideProject");

		const missing = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=nope.png"), request(), missing);
		assert.equal(missing.status, 404);

		const unknownProject = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=none&path=a.png"), request(), unknownProject);
		assert.equal(unknownProject.status, 404);
		assert.equal(JSON.parse(String(unknownProject.body())).code, "webError.projectNotFound");

		const plain = createResponse();
		await routes.handle(new URL("http://web.local/api/file-raw?projectId=p1&path=notes.txt"), request(), plain);
		assert.equal(plain.status, 200);
		assert.equal(plain.headers["content-type"], "application/octet-stream");
		assert.equal(String(plain.body()), "hello");
	});
});
