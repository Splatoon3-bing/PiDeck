/**
 * Web 写路由限速（固定窗口，按鉴权主体/IP 分桶）。
 *
 * 为什么单测：限速是 `/api/*` 写方法的兜底闸门，逻辑虽小但一旦算错会把正常操作
 * 全打成 429（或永不触发）。这里用假时钟覆盖窗口滚动、桶隔离与 Retry-After 下界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebWriteRateLimiter, DEFAULT_WEB_WRITE_RATE_LIMIT, WEB_WRITE_METHODS } = loadTsCommonJs("src/main/web/WebRateLimit.ts");

function fakeClock(start = 1_000_000) {
	let current = start;
	return { now: () => current, advance: (ms) => (current += ms) };
}

test("写方法集合覆盖 POST/PUT/PATCH/DELETE，不包含读方法", () => {
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(WEB_WRITE_METHODS.has(method), true, method);
	for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(WEB_WRITE_METHODS.has(method), false, method);
});

test("窗口内放行到上限，超出后拒绝并给出 Retry-After", () => {
	const clock = fakeClock();
	const limiter = new WebWriteRateLimiter({ limit: 3, windowMs: 60_000 }, clock.now);
	for (let i = 0; i < 3; i += 1) assert.equal(limiter.take("token-a").allowed, true);

	const denied = limiter.take("token-a");
	assert.equal(denied.allowed, false);
	assert.ok(denied.retryAfterMs >= 1000, "retryAfter 至少 1s，避免同窗口高频重试");
	assert.ok(denied.retryAfterMs <= 60_000);

	// 窗口滚动后恢复
	clock.advance(60_000);
	assert.equal(limiter.take("token-a").allowed, true);
});

test("不同 token/IP 各自独立计数，互不挤占", () => {
	const clock = fakeClock();
	const limiter = new WebWriteRateLimiter({ limit: 2, windowMs: 60_000 }, clock.now);
	assert.equal(limiter.take("a").allowed, true);
	assert.equal(limiter.take("a").allowed, true);
	assert.equal(limiter.take("a").allowed, false);
	// b 没被 a 的桶拖累
	assert.equal(limiter.take("b").allowed, true);
	assert.equal(limiter.take("b").allowed, true);
	assert.equal(limiter.take("b").allowed, false);
});

test("默认阈值足够日常 Web 使用（草稿自动保存 + 消息 + Git）", () => {
	assert.equal(DEFAULT_WEB_WRITE_RATE_LIMIT.windowMs, 60_000);
	assert.ok(DEFAULT_WEB_WRITE_RATE_LIMIT.limit >= 120, "默认阈值过低会误伤草稿自动保存/连续操作");

	const clock = fakeClock();
	const limiter = new WebWriteRateLimiter(DEFAULT_WEB_WRITE_RATE_LIMIT, clock.now);
	// 1 分钟内 1.2s 一次草稿自动保存 = 50 次，再叠 20 条消息 + Git 操作，仍应放行
	for (let i = 0; i < 120; i += 1) assert.equal(limiter.take("daily").allowed, true, `write #${i} unexpected 429`);
});
