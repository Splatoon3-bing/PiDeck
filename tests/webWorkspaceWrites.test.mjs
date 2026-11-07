/**
 * Web 工作区写路由（文件保存 / Git stage-unstage-commit / 草稿本）。
 *
 * 这些入口让浏览器第一次获得写能力，因此逐条验证边界：
 * - 只接受项目内相对路径，拒绝绝对路径与 `..`；
 * - 内容大小有硬上限；
 * - 草稿本只收 (scope,id)，不接受宿主绝对路径；
 * - 对应能力未装配时回 503，而不是静默成功。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebWorkspaceRoutes } = loadTsCommonJs("src/main/web/WebWorkspaceRoutes.ts");
const ROOT = "/tmp/pideck-web-workspace-writes";

/** vm 加载的模块返回另一个 realm 的对象；deepStrictEqual 会连原型一起比，统一 JSON 归一化。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeResponse() {
	const res = {
		status: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(payload) {
			if (payload !== undefined) this.body = String(payload);
		},
	};
	return res;
}

function fakeRequest(body) {
	const request = new EventEmitter();
	request.method = "POST";
	request.destroy = () => undefined;
	process.nextTick(() => {
		request.emit("data", Buffer.from(JSON.stringify(body)));
		request.emit("end");
	});
	return request;
}

async function call(routes, path, method = "GET", body) {
	const res = fakeResponse();
	const request = method === "POST" ? fakeRequest(body) : { method };
	const handled = await routes.handle(new URL(`http://localhost${path}`), request, res);
	return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

function stubDeps(overrides = {}) {
	const calls = { write: [], create: [], rename: [], delete: [], stage: [], unstage: [], commit: [], checkout: [], createBranch: [], fetch: [], spList: [], spCreate: [], spLoad: [], spSave: [], spDelete: [] };
	const deps = {
		listProjects: () => [{ id: "p1", name: "P", path: ROOT }],
		files: {
			listTree: async () => [],
			writeFile: async (root, relativePath, content, options) => {
				calls.write.push({ root, relativePath, content, options });
				return { mtimeMs: 123 };
			},
			create: async (parentDir, name, type) => {
				calls.create.push({ parentDir, name, type });
				return `${parentDir}/${name}`;
			},
			rename: async (targetPath, newName) => {
				calls.rename.push({ targetPath, newName });
				return `${targetPath}->${newName}`;
			},
			delete: async (targetPath, recursive) => {
				calls.delete.push({ targetPath, recursive });
			},
		},
		git: {
			isGitRepo: async () => true,
			getBranches: async () => ({ current: "main", branches: ["main", "dev"] }),
			getStatus: async () => ({ merge: [], index: [], workingTree: [], untracked: [] }),
			stageFiles: async (cwd, paths) => calls.stage.push({ cwd, paths }),
			unstageFiles: async (cwd, paths) => calls.unstage.push({ cwd, paths }),
			commit: async (cwd, message) => calls.commit.push({ cwd, message }),
			checkout: async (cwd, branch) => {
				calls.checkout.push({ cwd, branch });
				return { current: branch, branches: ["main", "dev", branch] };
			},
			createBranch: async (cwd, branch) => {
				calls.createBranch.push({ cwd, branch });
				return { current: branch, branches: ["main", "dev", branch] };
			},
			fetch: async (cwd) => calls.fetch.push({ cwd }),
		},
		scratchPad: {
			list: async (scope) => {
				calls.spList.push(scope);
				return [{ id: "d1", name: "D", createdAt: 1, updatedAt: 2, scope: "global" }];
			},
			create: async (scope) => {
				calls.spCreate.push(scope);
				return { id: "d2", name: "D2", createdAt: 1, updatedAt: 1, scope: scope.kind === "project" ? "project" : "global" };
			},
			load: async (scope, id, projectId) => {
				calls.spLoad.push({ scope, id, projectId });
				return { content: "body", lastEditedAt: 9 };
			},
			save: async (scope, id, content, projectId) => {
				calls.spSave.push({ scope, id, content, projectId });
				return { mtimeMs: 77 };
			},
			delete: async (scope, id, projectId) => {
				calls.spDelete.push({ scope, id, projectId });
			},
		},
		...overrides,
	};
	return { calls, deps };
}

test("file write forwards relative path/content and conflict hint", async () => {
	const { calls, deps } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	const result = await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "src/a.ts", content: "hello", expectedMtimeMs: 5 });
	assert.equal(result.status, 200);
	assert.equal(result.body.mtimeMs, 123);
	assert.deepEqual(plain(calls.write), [{ root: ROOT, relativePath: "src/a.ts", content: "hello", options: { expectedMtimeMs: 5, force: false } }]);
});

test("file write rejects absolute paths, traversal, unknown projects, and oversized content", async () => {
	const { calls, deps } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "/etc/passwd", content: "x" })).status, 400);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "../escape.txt", content: "x" })).status, 400);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "a/../../escape.txt", content: "x" })).status, 400);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "nope", path: "a.ts", content: "x" })).status, 404);
	const huge = "x".repeat(2 * 1024 * 1024 + 1);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "a.ts", content: huge })).status, 413);
	assert.deepEqual(plain(calls.write), []);
});

test("file write returns 503 when the write capability is not wired", async () => {
	const { deps } = stubDeps({ files: { listTree: async () => [] } });
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/file-content", "POST", { projectId: "p1", path: "a.ts", content: "x" })).status, 503);
});

test("git stage/unstage validate paths and forward to the git service", async () => {
	const { calls, deps } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/git/stage", "POST", { projectId: "p1", paths: ["src/a.ts", "b.ts"] })).status, 200);
	assert.deepEqual(plain(calls.stage), [{ cwd: ROOT, paths: ["src/a.ts", "b.ts"] }]);
	assert.equal((await call(routes, "/api/git/unstage", "POST", { projectId: "p1", paths: ["src/a.ts"] })).status, 200);
	assert.deepEqual(plain(calls.unstage), [{ cwd: ROOT, paths: ["src/a.ts"] }]);

	assert.equal((await call(routes, "/api/git/stage", "POST", { projectId: "p1", paths: [] })).status, 400);
	assert.equal((await call(routes, "/api/git/stage", "POST", { projectId: "p1", paths: ["../escape"] })).status, 400);
	assert.equal((await call(routes, "/api/git/stage", "POST", { projectId: "p1", paths: ["/etc/passwd"] })).status, 400);
	assert.equal((await call(routes, "/api/git/stage", "POST", { projectId: "nope", paths: ["a.ts"] })).status, 404);
});

test("git commit requires a bounded message and forwards it", async () => {
	const { calls, deps } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/git/commit", "POST", { projectId: "p1", message: "   " })).status, 400);
	assert.equal((await call(routes, "/api/git/commit", "POST", { projectId: "p1", message: "x".repeat(5001) })).status, 400);
	assert.equal((await call(routes, "/api/git/commit", "POST", { projectId: "p1", message: "feat: web alignment" })).status, 200);
	assert.deepEqual(plain(calls.commit), [{ cwd: ROOT, message: "feat: web alignment" }]);
	assert.equal((await call(routes, "/api/git/commit", "POST", { projectId: "nope", message: "x" })).status, 404);
});

test("scratch pad routes resolve scope and pass only (scope,id), never host paths", async () => {
	const { calls, deps } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);

	const globalList = await call(routes, "/api/scratchpad");
	assert.equal(globalList.status, 200);
	assert.equal(globalList.body.drafts.length, 1);
	assert.deepEqual(plain(calls.spList), [{ kind: "global" }]);

	assert.equal((await call(routes, "/api/scratchpad?scope=project&projectId=p1")).status, 200);
	assert.deepEqual(plain(calls.spList[1]), { kind: "project", projectId: "p1" });

	assert.equal((await call(routes, "/api/scratchpad?scope=project")).status, 400);
	assert.equal((await call(routes, "/api/scratchpad?scope=project&projectId=nope")).status, 404);

	const created = await call(routes, "/api/scratchpad/create", "POST", { scope: "project", projectId: "p1" });
	assert.equal(created.status, 200);
	assert.equal(created.body.draft.scope, "project");
	assert.deepEqual(plain(calls.spCreate), [{ kind: "project", projectId: "p1" }]);

	const id = encodeURIComponent("2026-01-01 10-00-00");
	const loaded = await call(routes, `/api/scratchpad/${id}?scope=global`);
	assert.equal(loaded.status, 200);
	assert.equal(loaded.body.content, "body");
	assert.deepEqual(plain(calls.spLoad), [{ scope: "global", id: "2026-01-01 10-00-00" }]);
	assert.equal(calls.spLoad[0].projectId, undefined);

	const saved = await call(routes, `/api/scratchpad/${id}/save`, "POST", { scope: "global", content: "next" });
	assert.equal(saved.status, 200);
	assert.equal(saved.body.mtimeMs, 77);
	assert.deepEqual(plain(calls.spSave), [{ scope: "global", id: "2026-01-01 10-00-00", content: "next" }]);
	assert.equal(calls.spSave[0].projectId, undefined);

	const tooLarge = await call(routes, `/api/scratchpad/${id}/save`, "POST", { scope: "global", content: "x".repeat(1024 * 1024 + 1) });
	assert.equal(tooLarge.status, 413);

	const deleted = await call(routes, `/api/scratchpad/${id}?scope=global`, "DELETE");
	assert.equal(deleted.status, 200);
	assert.deepEqual(plain(calls.spDelete), [{ scope: "global", id: "2026-01-01 10-00-00" }]);
	assert.equal(calls.spDelete[0].projectId, undefined);
});

test("scratch pad routes return 503 when the capability is missing", async () => {
	const { deps } = stubDeps({ scratchPad: undefined });
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/scratchpad")).status, 503);
	assert.equal((await call(routes, "/api/scratchpad/create", "POST", { scope: "global" })).status, 503);
	assert.equal((await call(routes, "/api/scratchpad/d1?scope=global")).status, 503);
	assert.equal((await call(routes, "/api/scratchpad/d1/save", "POST", { scope: "global", content: "x" })).status, 503);
	assert.equal((await call(routes, "/api/scratchpad/d1?scope=global", "DELETE")).status, 503);
});

async function makeFileProject() {
	const root = await mkdtemp(join(tmpdir(), "pideck-web-files-"));
	await writeFile(join(root, "existing.txt"), "x");
	await writeFile(join(root, "other.txt"), "y");
	await mkdir(join(root, "sub"));
	// 路由会先过 realpath 边界（与桌面 LocalProjectFileBackend 同源），断言用 canonical 根。
	return await realpath(root);
}

function fileRoutes(root) {
	const { deps, calls } = stubDeps();
	deps.listProjects = () => [{ id: "p1", name: "P", path: root }];
	return { routes: new WebWorkspaceRoutes(deps), calls };
}

test("file create creates files and directories under the project root", async () => {
	const root = await makeFileProject();
	const { routes, calls } = fileRoutes(root);
	const file = await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "", name: "new.txt", kind: "file" });
	assert.equal(file.status, 200);
	assert.deepEqual(plain(calls.create), [{ parentDir: root, name: "new.txt", type: "file" }]);
	const dir = await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "sub", name: "nested", kind: "directory" });
	assert.equal(dir.status, 200);
	assert.deepEqual(plain(calls.create[1]), { parentDir: join(root, "sub"), name: "nested", type: "directory" });
	await rm(root, { recursive: true, force: true });
});

test("file create rejects duplicates, invalid names, traversal, and unknown projects", async () => {
	const root = await makeFileProject();
	const { routes, calls } = fileRoutes(root);
	assert.equal((await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "", name: "existing.txt", kind: "file" })).status, 409);
	for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "con", "trailing."]) {
		const result = await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "", name, kind: "file" });
		assert.equal(result.status, 400, `name ${JSON.stringify(name)} must be rejected`);
	}
	assert.equal((await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "/tmp", name: "x", kind: "file" })).status, 400);
	assert.equal((await call(routes, "/api/files/create", "POST", { projectId: "nope", dir: "", name: "x", kind: "file" })).status, 404);
	assert.deepEqual(calls.create, []);
	await rm(root, { recursive: true, force: true });
});

test("file create returns 503 when the capability is not wired", async () => {
	const { deps } = stubDeps({ files: { listTree: async () => [] } });
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "", name: "x", kind: "file" })).status, 503);
});

test("file rename renames within the parent and rejects collisions/root", async () => {
	const root = await makeFileProject();
	const { routes, calls } = fileRoutes(root);
	const ok = await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "existing.txt", newName: "renamed.txt" });
	assert.equal(ok.status, 200);
	assert.deepEqual(plain(calls.rename), [{ targetPath: join(root, "existing.txt"), newName: "renamed.txt" }]);
	assert.equal((await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "existing.txt", newName: "other.txt" })).status, 409);
	assert.equal((await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "", newName: "root.txt" })).status, 400);
	assert.equal((await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "missing.txt", newName: "x.txt" })).status, 404);
	assert.equal((await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "existing.txt", newName: "../escape.txt" })).status, 400);
	await rm(root, { recursive: true, force: true });
});

test("file delete trashes entries and rejects the project root", async () => {
	const root = await makeFileProject();
	const { routes, calls } = fileRoutes(root);
	const file = await call(routes, "/api/files/delete", "POST", { projectId: "p1", path: "existing.txt" });
	assert.equal(file.status, 200);
	assert.deepEqual(plain(calls.delete), [{ targetPath: join(root, "existing.txt"), recursive: false }]);
	const dir = await call(routes, "/api/files/delete", "POST", { projectId: "p1", path: "sub" });
	assert.equal(dir.status, 200);
	assert.deepEqual(plain(calls.delete[1]), { targetPath: join(root, "sub"), recursive: true });
	assert.equal((await call(routes, "/api/files/delete", "POST", { projectId: "p1", path: "" })).status, 400);
	assert.equal((await call(routes, "/api/files/delete", "POST", { projectId: "p1", path: "missing.txt" })).status, 404);
	await rm(root, { recursive: true, force: true });
});

test("file mutations refuse to follow a project symlink that points outside the root", async () => {
	const root = await makeFileProject();
	const outside = await realpath(await mkdtemp(join(tmpdir(), "pideck-web-outside-")));
	await writeFile(join(outside, "victim.txt"), "secret");
	await symlink(outside, join(root, "link"), "dir");
	const { routes, calls } = fileRoutes(root);

	// 桌面 LocalProjectFileBackend 走 resolveProjectFileWritePath：symlink 目录指向根外 → FILE_OUTSIDE_PROJECT。
	// Web 不能比桌面更宽，否则新建/改名/回收站删除都可能落到项目根外。
	const created = await call(routes, "/api/files/create", "POST", { projectId: "p1", dir: "link", name: "pwned.txt", kind: "file" });
	assert.equal(created.status, 403);
	assert.equal(created.body.code, "webError.fileOutsideProject");

	const renamed = await call(routes, "/api/files/rename", "POST", { projectId: "p1", path: "link/victim.txt", newName: "moved.txt" });
	assert.equal(renamed.status, 403);
	assert.equal(renamed.body.code, "webError.fileOutsideProject");

	const deleted = await call(routes, "/api/files/delete", "POST", { projectId: "p1", path: "link/victim.txt" });
	assert.equal(deleted.status, 403);
	assert.equal(deleted.body.code, "webError.fileOutsideProject");

	assert.deepEqual(plain(calls.create), []);
	assert.deepEqual(plain(calls.rename), []);
	assert.deepEqual(plain(calls.delete), []);
	await rm(outside, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

test("oversized and malformed write bodies map to 413/400 instead of 500", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	// 默认 64KB 逻辑上限：超限回 413（不是 500），且不进入 git 能力。
	const oversized = await call(routes, "/api/git/commit", "POST", { projectId: "p1", message: "x".repeat(80 * 1024) });
	assert.equal(oversized.status, 413);
	assert.equal(oversized.body.code, "webError.bodyTooLarge");
	assert.deepEqual(plain(calls.commit), []);

	const malformed = await rawPost(routes, "/api/git/commit", "{not json");
	assert.equal(malformed.status, 400);
	assert.equal(malformed.body.code, "webError.invalidJson");
});

async function rawPost(routes, path, rawBody) {
	const request = new EventEmitter();
	request.method = "POST";
	request.destroy = () => undefined;
	process.nextTick(() => {
		request.emit("data", Buffer.from(rawBody));
		request.emit("end");
	});
	const res = fakeResponse();
	await routes.handle(new URL(`http://localhost${path}`), request, res);
	return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test("git branches route reports repo state and forwards checkout/create/fetch", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	const { deps: deps2 } = stubDeps();
	deps2.git = { ...deps2.git, isGitRepo: async () => false };
	const noRepo = new WebWorkspaceRoutes(deps2);

	const branches = await call(routes, "/api/git/branches?projectId=p1");
	assert.equal(branches.status, 200);
	assert.equal(branches.body.repo, true);
	assert.equal(branches.body.current, "main");
	assert.deepEqual(plain(branches.body.branches), ["main", "dev"]);
	assert.equal((await call(noRepo, "/api/git/branches?projectId=p1")).body.repo, false);

	const checkout = await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch: "dev" });
	assert.equal(checkout.status, 200);
	assert.equal(checkout.body.current, "dev");
	assert.deepEqual(plain(calls.checkout), [{ cwd: ROOT, branch: "dev" }]);

	const created = await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch: "feature/web", create: true });
	assert.equal(created.status, 200);
	assert.deepEqual(plain(calls.createBranch), [{ cwd: ROOT, branch: "feature/web" }]);

	const fetched = await call(routes, "/api/git/fetch", "POST", { projectId: "p1" });
	assert.equal(fetched.status, 200);
	assert.deepEqual(plain(calls.fetch), [{ cwd: ROOT }]);
	// 当前分支重复切换不触发 checkout（没有实际动作）
	assert.equal((await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch: "main" })).status, 200);
	assert.equal(calls.checkout.length, 1);
});

test("git checkout rejects invalid/unknown branches and dirty worktrees unless forced", async () => {
	const { deps, calls } = stubDeps();
	const routes = new WebWorkspaceRoutes(deps);
	for (const branch of ["-x", "a..b", "a b", "a~b", ".hidden", "feature/", "a\\b"]) {
		const result = await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch });
		assert.equal(result.status, 400, `branch ${JSON.stringify(branch)} must be rejected`);
	}
	assert.equal((await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch: "nope" })).body.code, "webError.gitBranchNotFound");

	const dirtyDeps = stubDeps();
	dirtyDeps.deps.git = { ...dirtyDeps.deps.git, getStatus: async () => ({ merge: [], index: [], workingTree: [{ path: "a.ts", letter: "M" }], untracked: [] }) };
	const dirtyRoutes = new WebWorkspaceRoutes(dirtyDeps.deps);
	const blocked = await call(dirtyRoutes, "/api/git/checkout", "POST", { projectId: "p1", branch: "dev" });
	assert.equal(blocked.status, 409);
	assert.equal(blocked.body.code, "webError.gitDirtyWorktree");
	const forced = await call(dirtyRoutes, "/api/git/checkout", "POST", { projectId: "p1", branch: "dev", force: true });
	assert.equal(forced.status, 200);
	assert.deepEqual(plain(dirtyDeps.calls.checkout), [{ cwd: ROOT, branch: "dev" }]);
	assert.deepEqual(calls.checkout, []);
	await Promise.resolve();
});

test("git branch/fetch routes 503 when the capability is not wired", async () => {
	const { deps } = stubDeps({ git: {} });
	const routes = new WebWorkspaceRoutes(deps);
	assert.equal((await call(routes, "/api/git/checkout", "POST", { projectId: "p1", branch: "dev" })).status, 503);
	assert.equal((await call(routes, "/api/git/fetch", "POST", { projectId: "p1" })).status, 503);
});
