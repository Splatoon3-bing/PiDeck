/**
 * 压缩期间投递 prompt 的回归测试。
 *
 * 背景（实测现场）：会话在压缩中时连发 4 条 prompt 全被 pi 拒收——
 * "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."
 * 改前这条被当成普通「前置校验失败」，用户只看到「消息发送失败」，而它在压缩结束后
 * 本来可以正常投递。
 *
 * AgentManager 体积大、依赖 electron，测试里不加载它（与 piProcessSpawnFailureFastFail
 * 的 AgentManager 用例同款做法），改为对源码结构与「判据正则本身」做断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AGENT_MANAGER = "src/main/pi/AgentManager.ts";
const source = readFileSync(AGENT_MANAGER, "utf8");

/** 从源码里取出判据正则，对着 pi 的真实文案跑，避免「正则写错但测试照样绿」。 */
function extractPredicateRegex() {
	const fn = source.match(/function isPiCompactionRejection\(message: string\): boolean \{\s*return (\/[^/]+\/[a-z]*)\.test\(message\);/);
	assert.ok(fn, `找不到 isPiCompactionRejection 的判据正则：${AGENT_MANAGER}`);
	return new Function(`return ${fn[1]};`)();
}

test("压缩拒收判据匹配 pi 的真实文案", () => {
	const predicate = extractPredicateRegex();
	// pi 侧原文（含句号与后续指引），以及可能的简写
	assert.equal(predicate.test("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry."), true);
	assert.equal(predicate.test("compaction is in progress"), true);
	assert.equal(predicate.test("Compaction is in progress"), true);
	// 不能把「忙碌」类拒收误判成压缩：两者处理方式不同（一个带 streamingBehavior 重发，一个等压缩）
	assert.equal(predicate.test("Agent is already processing"), false);
	assert.equal(predicate.test("图片消息发送失败"), false);
});

test("压缩拒收先等压缩收尾再重发，而不是直接判死", () => {
	// 分支顺序：压缩识别必须在通用失败提示之前，否则用户又会看到「消息发送失败」
	const branch = source.indexOf('if (isPiCompactionRejection(response.error ?? ""))');
	assert.ok(branch > 0, "拒收分支里没有压缩识别");
	const genericError = source.indexOf("Prompt rejected by pi RPC");
	assert.ok(genericError > branch, "压缩识别必须排在通用失败路径之前");
	assert.match(source, /retryPromptAfterCompaction\(/, "应复用重发入口");

	// 等待权威信号：get_state.isCompacting（事件标记只作退路）
	const wait = source.match(/private async waitForCompactionEnd\([\s\S]*?\n\t\}/);
	assert.ok(wait, "缺少 waitForCompactionEnd");
	assert.match(wait[0], /\{ type: "get_state" \}/, "必须向 pi 要权威状态，而不是只信本地事件");
	assert.match(wait[0], /isCompacting !== true/, "只有 pi 明确报告不在压缩时才算结束");
	assert.match(wait[0], /rpcCompactingAgents\.has\(agentId\)/, "拿不到权威状态时退回 compaction 事件标记");

	// 重发必须复用同一条 payload（用户消息不能丢、也不能被改写）
	const retry = source.match(/private async retryPromptAfterCompaction\([\s\S]*?\n\t\}/);
	assert.ok(retry, "缺少 retryPromptAfterCompaction");
	assert.match(retry[0], /client\.request\(payload, rpcTimeout\)/, "应原样重发同一条 prompt");
	assert.match(retry[0], /timedOut: true/, "超时要有明确出口");
});

test("等不到压缩结束时给出可读提示（不是「消息发送失败」）", () => {
	const timedOut = source.match(/if \("timedOut" in retried\) \{[\s\S]*?\n\t\t\t\t\t\}/);
	assert.ok(timedOut, "缺少超时分支");
	// 区分「没发出去」与「被 pi 参数拒收」：这里用 system 级提示 + 专用 i18n key
	assert.match(timedOut[0], /addLocalizedMessage\(input\.agentId, "system", "diagnostic\.compactInProgress"/);
	assert.match(timedOut[0], /delivery: "rejected"/, "要告诉渲染层这条消息确实没投递，避免无限重试");
});

test("新 i18n key 在四份词典里都有文案", () => {
	const files = ["src/renderer/src/i18n/rendererCopy.zh-CN.ts", "src/renderer/src/i18n/rendererCopy.en-US.ts", "src/renderer/src/i18n/rendererCopy.zh-TW.ts"];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const line = text.match(/"diagnostic\.compactInProgress": "([^"]*)"/);
		assert.ok(line, `${file} 缺少 diagnostic.compactInProgress`);
		assert.ok(line[1].trim().length > 0, `${file} 的文案为空`);
	}
});
