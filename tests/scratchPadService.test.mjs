/**
 * ScratchPadService：桌面 IPC 与 Web 路由共用的草稿存储边界。
 *
 * 重点验证 Web 入口的 (scope,id) 解析不会变成任意文件通道：
 * - 项目作用域隔离（看不到别的项目）；
 * - id 不接受路径分隔符 / `..`；
 * - 删除只把 drafts 内路径交给回收站；
 * - 旧 scratch-pad.md 迁移可重入。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ScratchPadService } = loadTsCommonJs("src/main/scratchPad/ScratchPadService.ts", {
	stubs: { "../fs/trash": { trashPath: async () => undefined } },
});

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pideck-scratch-service-"));
	const trashed = [];
	const service = new ScratchPadService({
		draftsDir: join(root, "drafts"),
		legacyDraftPath: join(root, "scratch-pad.md"),
		trash: async (path, context) => {
			trashed.push({ path, context });
		},
	});
	return { root, service, trashed };
}

test("global and project scopes isolate drafts, project list includes global", async () => {
	const { root, service } = setup();
	const globalDraft = await service.create({ kind: "global" });
	await service.save(globalDraft.path, "global body");
	assert.equal((await service.load(globalDraft.path)).content, "global body");

	const projectA = await service.create({ kind: "project", projectId: "project-a" });
	const projectB = await service.create({ kind: "project", projectId: "project-b" });
	await service.save(projectA.path, "A");

	// 同一秒创建的项目/全局草稿文件名可能相同：唯一身份必须带 scope（Web 端同款规则）。
	const key = (draft) => `${draft.scope}/${draft.id}`;
	const listA = await service.list({ kind: "project", projectId: "project-a" });
	assert.deepEqual(Array.from(listA, key).sort(), [key(globalDraft), key(projectA)].sort());
	assert.equal(listA.find((draft) => draft.scope === "project" && draft.id === projectA.id)?.scope, "project");
	assert.equal(listA.find((draft) => draft.scope === "global" && draft.id === globalDraft.id)?.scope, "global");
	assert.equal(
		listA.some((draft) => draft.path === projectB.path),
		false,
	);

	const globalList = await service.list({ kind: "global" });
	assert.deepEqual(Array.from(globalList, key), [key(globalDraft)]);
	rmSync(root, { recursive: true, force: true });
});

test("scope ids reject traversal and path separators", async () => {
	const { root, service } = setup();
	for (const projectId of ["../escape", "a/b", "a\\b", "", ".", "a".repeat(129)]) {
		await assert.rejects(() => service.list({ kind: "project", projectId }), /Invalid scratch pad scope/);
		await assert.rejects(() => service.create({ kind: "project", projectId }), /Invalid scratch pad scope/);
	}
	rmSync(root, { recursive: true, force: true });
});

test("resolveDraftPathById rejects ids that escape the managed directory", async () => {
	const { root, service } = setup();
	const draft = await service.create({ kind: "project", projectId: "project-a" });
	assert.equal(service.resolveDraftPathById("project", draft.id, "project-a"), draft.path);
	for (const id of ["../escape", "a/b", "a\\b", "..", "", ".", "x".repeat(201)]) {
		assert.throws(() => service.resolveDraftPathById("project", id, "project-a"), /Invalid draft id/);
	}
	// 项目 id 非法时同样拒绝，不会退回全局目录
	assert.throws(() => service.resolveDraftPathById("project", draft.id, "../escape"), /Invalid scratch pad scope/);
	rmSync(root, { recursive: true, force: true });
});

test("absolute paths outside drafts are rejected before read/write/delete", async () => {
	const { root, service, trashed } = setup();
	const secret = join(root, "secret.txt");
	writeFileSync(secret, "top secret");
	await assert.rejects(() => service.load(secret), /Invalid draft path|drafts directory/);
	await assert.rejects(() => service.save(secret, "evil", 0), /Invalid draft path|drafts directory/);
	await assert.rejects(() => service.delete(secret), /Invalid draft path|drafts directory/);
	assert.deepEqual(trashed, []);
	assert.equal(existsSync(secret), true);
	rmSync(root, { recursive: true, force: true });
});

test("legacy scratch-pad.md migrates once and is idempotent", async () => {
	const { root, service } = setup();
	writeFileSync(join(root, "scratch-pad.md"), "legacy notes");
	await service.list({ kind: "global" });
	const drafts = await service.list({ kind: "global" });
	assert.equal(drafts.length, 1);
	assert.equal((await service.load(drafts[0].path)).content, "legacy notes");
	assert.equal(existsSync(join(root, "scratch-pad.md")), false);
	// 再跑一次（模拟重启后同一目录）不应凭空多出第二份
	await service.list({ kind: "global" });
	assert.equal((await service.list({ kind: "global" })).length, 1);
	rmSync(root, { recursive: true, force: true });
});
