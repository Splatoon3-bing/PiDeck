import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { visibleWebProjects, visibleWebSessions, isWebVisibleProject } = loadTsCommonJs("src/main/web/WebProjectProjection.ts");

const local = { id: "p1", name: "Local", path: "/tmp/project", lastOpenedAt: 1 };
const wsl = { id: "p2", name: "WSL", path: "\\\\wsl$\\Ubuntu\\work", lastOpenedAt: 2, environment: "wsl" };
const chat = { id: "chat", name: "Chat", path: "/tmp/chat", kind: "chat", lastOpenedAt: 3 };
const remote = { id: "r1", name: "Remote", locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/app" }, lastOpenedAt: 4 };

test("远程（无本机路径）项目不进 Web 投影，其余本地/WSL/chat 保留", () => {
	assert.equal(isWebVisibleProject(remote), false);
	assert.deepEqual(
		visibleWebProjects([local, wsl, chat, remote]).map((project) => project.id),
		["p1", "p2", "chat"],
	);
});

test("会话跟随项目可见性，避免指向被过滤项目的死链", () => {
	const sessions = [
		{ id: "s1", projectId: "p1" },
		{ id: "s2", projectId: "r1" },
	];
	assert.deepEqual(
		visibleWebSessions(sessions, [local, remote]).map((session) => session.id),
		["s1"],
	);
});
