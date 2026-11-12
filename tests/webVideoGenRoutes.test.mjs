import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebVideoGenRoutes } = loadTsCommonJs("src/main/web/WebVideoGenRoutes.ts");
const { VideoBlobStore } = loadTsCommonJs("src/main/videogen/VideoBlobStore.ts");

const REF = `${"a".repeat(64)}.mp4`;
const CONTENT = Buffer.from("0123456789");

/** 响应桩：写头 + 收集 pipeline 写出的字节（真 Writable，pipeline 才能接管）。 */
function response() {
	const chunks = [];
	const res = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			callback();
		},
	});
	res.status = 0;
	res.headers = {};
	res.writeHead = (status, headers) => {
		res.status = status;
		res.headers = headers ?? {};
	};
	res.finished = new Promise((resolve) => res.on("finish", resolve));
	res.body = () => Buffer.concat(chunks);
	return res;
}

function request({ method = "GET", headers = {} } = {}) {
	const req = Readable.from([]);
	req.method = method;
	req.headers = headers;
	return req;
}

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "pideck-video-"));
	await writeFile(join(dir, REF), CONTENT);
	const blobs = new VideoBlobStore({ getBlobsPath: () => dir });
	const routes = new WebVideoGenRoutes({ resolveBlobPath: (ref) => blobs.resolvePath(ref) });
	const call = async (path, options) => {
		const res = response();
		const url = new URL(`http://localhost${path}`);
		const handled = await routes.handle(url, request(options), res);
		if (handled) await Promise.race([res.finished, new Promise((resolve) => setTimeout(resolve, 500))]);
		return { handled, status: res.status, headers: res.headers, body: res.body() };
	};
	return { call };
}

test("整段 GET：内容寻址的长缓存 + 视频 mime + Range 能力声明", async () => {
	const { call } = await fixture();
	const ok = await call(`/api/videogen/blob/${REF}`);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers["content-type"], "video/mp4");
	assert.equal(ok.headers["accept-ranges"], "bytes");
	assert.equal(ok.headers["cache-control"], "private, max-age=31536000, immutable");
	assert.equal(ok.headers["x-content-type-options"], "nosniff");
	assert.equal(ok.headers["content-length"], "10");
	assert.equal(ok.body.toString(), "0123456789");
});

test("单段 Range：206 + Content-Range（拖进度依赖这条）", async () => {
	const { call } = await fixture();
	const mid = await call(`/api/videogen/blob/${REF}`, { headers: { range: "bytes=2-4" } });
	assert.equal(mid.status, 206);
	assert.equal(mid.headers["content-range"], "bytes 2-4/10");
	assert.equal(mid.headers["content-length"], "3");
	assert.equal(mid.body.toString(), "234");

	const open = await call(`/api/videogen/blob/${REF}`, { headers: { range: "bytes=8-" } });
	assert.equal(open.status, 206);
	assert.equal(open.body.toString(), "89");

	// 越界 → 416，且 Content-Range 用 `bytes */size` 形态
	const outside = await call(`/api/videogen/blob/${REF}`, { headers: { range: "bytes=99-100" } });
	assert.equal(outside.status, 416);
	assert.equal(outside.headers["content-range"], "bytes */10");

	// 多段 Range：规范允许忽略，回 200 全量
	const multi = await call(`/api/videogen/blob/${REF}`, { headers: { range: "bytes=0-1,4-5" } });
	assert.equal(multi.status, 200);
	assert.equal(multi.body.length, 10);
});

test("HEAD 只回头不下发字节", async () => {
	const { call } = await fixture();
	const head = await call(`/api/videogen/blob/${REF}`, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(head.body.length, 0);
});

test("白名单：非法/越界 ref 一律 404（不给探测口）", async () => {
	const { call } = await fixture();
	assert.equal((await call("/api/videogen/blob/..%2Fsecret.mp4")).status, 404);
	assert.equal((await call("/api/videogen/blob/nothex.mp4")).status, 404);
	assert.equal((await call(`/api/videogen/blob/${"b".repeat(64)}.mp4`)).status, 404);
	assert.equal((await call("/api/videogen/blob/")).status, 404);
	// 坏的百分号编码不能把路由炸成 500
	assert.equal((await call("/api/videogen/blob/%E0%A4%A")).status, 404);
});

test("只读：非 GET/HEAD 回 405，非 videogen 路径不接管", async () => {
	const { call } = await fixture();
	assert.equal((await call(`/api/videogen/blob/${REF}`, { method: "POST" })).status, 405);
	assert.equal((await call("/api/imagegen/blob/ref1")).handled, false);
	assert.equal((await call("/api/settings")).handled, false);
});
