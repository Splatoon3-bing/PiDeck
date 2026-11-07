/**
 * Web 路由装配（registerWebRoutes.ts）
 *
 * 为什么单独一个模块：`main/index.ts` 是合并热点，Phase 1A/1B 往它里面塞了 ~90 行
 * 「把主进程服务接进 Web 路由」的胶水，触发巨文件纪律（存量巨文件不得净增长）。
 * 这里只做装配，不引入新的领域逻辑：
 * - workspace 路由：项目/Git/文件/草稿本/资产/安全等级 → `WebWorkspaceRoutes`；
 * - 设置路由：白名单投影 + 明暗重放 + 窗口广播 → `createWebSettingsRoutes`。
 *
 * 所有能力都来自主进程既有实例（与桌面 IPC 同源），Web 层只做投影与边界校验。
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppSettings, Project, TerminalAgentTarget, TerminalTarget } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { TerminalSessionManager } from "../terminal/TerminalSessionManager";
import { parseTerminalTarget } from "../terminal/terminalTarget";
import { createProjectFileReadBoundary, resolveProjectFileWritePath } from "../files/projectFileAccess";
import { writeTextFileGuarded } from "../files/textFileWrite";
import type { FileSystemService } from "../fs/FileSystemService";
import type { GitService } from "../git/GitService";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { XuePromptManager } from "../prompts/XuePromptManager";
import type { ScratchPadService } from "../scratchPad/ScratchPadService";
import type { SecurityConfig } from "../../shared/types/security";
import { evaluateUserReadAccess } from "../security/policy";
import type { SkillManager } from "../skills/SkillManager";
import type { WebServiceManager } from "./WebServiceManager";
import { WebTerminalRoutes } from "./WebTerminalRoutes";
import { WebWorkspaceRoutes } from "./WebWorkspaceRoutes";
import { createWebSettingsRoutes } from "./WebSettingsRoutes";

export type WebRoutesRegistration = {
	/** Web 服务实例：写三个注入点（workspaceRoutes / settingsRoutes / terminalRoutes）。 */
	target: Pick<WebServiceManager, "workspaceRoutes" | "settingsRoutes" | "terminalRoutes">;
	projects: { list: () => Project[]; get: (projectId: string) => Project | undefined };
	git: GitService;
	files: FileSystemService;
	/**
	 * 延迟读取：`scratchPadService` 是模块级 `let`，在启动编排的另一个阶段才赋值；
	 * 装配可能早于赋值，值传递会把 undefined 固化成运行时错误（`reading 'create'`）。
	 */
	scratchPad: () => ScratchPadService;
	security: { getConfig: () => SecurityConfig };
	/** 提示词库只在 SQLite 库可用时注入（缺库时路由返回 503，前端隐藏入口）。 */
	prompts?: XuePromptManager;
	skills: SkillManager;
	extensions: ExtensionManager;
	settings: { get: () => AppSettings; update: (patch: Partial<AppSettings>) => Promise<AppSettings> };
	/** 明暗偏好重放（决定原生标题栏/窗体配色，只在 theme 真正被写入时调用）。 */
	onThemeApplied: (settings: AppSettings) => void;
	/**
	 * Web 终端（S1 骨架）：开关/令牌一律用 getter，改设置不需要重启服务。
	 * S1 不注入 `createTerminal`，create 帧回 webError.terminalNotReady（不开 PTY）。
	 */
	terminal: {
		enabled: () => boolean;
		requiresAuth: () => boolean;
		token: () => string;
		/** agent 目标 → cwd（与桌面终端同一合成网关语义）。 */
		getAgentCwd: (agentId: string) => string;
		/** agent 目标归属校验（复用 SessionRuntimeCoordinator，防打到旧 runtime）。 */
		validateAgentTarget: (target: TerminalAgentTarget) => boolean;
	};
};

export function registerWebRoutes(deps: WebRoutesRegistration): void {
	const { git, files, skills, extensions } = deps;
	deps.target.workspaceRoutes = new WebWorkspaceRoutes({
		listProjects: () => deps.projects.list(),
		git: {
			isGitRepo: (cwd) => git.isGitRepo(cwd),
			getBranches: (cwd) => git.getBranches(cwd),
			getStatus: (cwd) => git.getStatus(cwd),
			getWorkspaceFileDiff: (cwd, group, filePath, maxBytes) => git.getWorkspaceFileDiff(cwd, group, filePath, maxBytes),
			getCommitLog: (cwd, options) => git.getCommitLog(cwd, options),
			// 写操作只开 stage/unstage/commit：discard/reset/push 属于不可逆或联网动作，
			// Web 端不提供（避免浏览器误触丢工作区改动）。
			stageFiles: (cwd, paths) => git.stageFiles(cwd, paths),
			unstageFiles: (cwd, paths) => git.unstageFiles(cwd, paths),
			commit: (cwd, message) => git.commit(cwd, message),
			checkout: (cwd, branch) => git.checkout(cwd, branch),
			createBranch: (cwd, branch) => git.createBranch(cwd, branch),
			fetch: (cwd) => git.fetch(cwd),
		},
		files: {
			listTree: (root, maxDepth, directory) => files.listTree(root, maxDepth, directory),
			// 文件管理（新建/改名/删除）：与桌面 filesIpc 同一实现，删除走回收站。
			// 路由层已把目标解析成 realpath（symlink 不能把写/删带出项目根）。
			create: (parentDir, name, type) => files.create(parentDir, name, type),
			rename: (targetPath, newName) => files.rename(targetPath, newName),
			delete: (targetPath, recursive) => files.delete(targetPath, recursive),
			// Web 编辑器：只改项目内已存在的文本文件。边界（realpath/symlink）与原子替换
			// 复用桌面写入链路，不在 Web 路由里另写一套。
			writeFile: async (root, relativePath, content, options) => {
				const target = resolve(root, relativePath);
				const boundary = await createProjectFileReadBoundary(root);
				const canonical = await resolveProjectFileWritePath(boundary, target);
				const info = await stat(canonical).catch(() => null);
				if (!info?.isFile()) throw new Error("target file does not exist");
				if (!options?.force && typeof options?.expectedMtimeMs === "number" && Math.abs(info.mtimeMs - options.expectedMtimeMs) > 1) {
					const error = new Error("file has changed on disk") as Error & { code?: string };
					error.code = "FILE_CHANGED";
					throw error;
				}
				await writeTextFileGuarded(canonical, content);
				return { mtimeMs: (await stat(canonical)).mtimeMs };
			},
		},
		// 草稿本（桌面 IPC 与 Web 共用同一实例）：Web 不传绝对路径，只传 (scope, id)。
		scratchPad: {
			list: async (scope) =>
				(await deps.scratchPad().list(scope)).map((draft) => ({
					id: draft.id,
					name: draft.name,
					createdAt: draft.createdAt,
					updatedAt: draft.updatedAt,
					scope: draft.scope,
				})),
			create: async (scope) => {
				const draft = await deps.scratchPad().create(scope);
				return { id: draft.id, name: draft.name, createdAt: draft.createdAt, updatedAt: draft.updatedAt, scope: draft.scope };
			},
			load: async (scope, id, projectId) => {
				const draftPath = deps.scratchPad().resolveDraftPathById(scope, id, projectId);
				const data = await deps.scratchPad().load(draftPath);
				return { content: data.content, lastEditedAt: data.lastEditedAt };
			},
			save: async (scope, id, content, projectId) => {
				const draftPath = deps.scratchPad().resolveDraftPathById(scope, id, projectId);
				await deps.scratchPad().save(draftPath, content);
				return { mtimeMs: (await stat(draftPath)).mtimeMs };
			},
			delete: async (scope, id, projectId) => {
				await deps.scratchPad().delete(deps.scratchPad().resolveDraftPathById(scope, id, projectId));
			},
		},
		// Web 端预览项目外文件时的用户意图门：与桌面端「项目外文件链接」同一套安全等级规则
		// （denyDirs > 敏感文件 > 目录边界），ask 由 Web 端弹「只读查看」确认后再带 confirm=1 重请求。
		userReadAccess: (input) => evaluateUserReadAccess(deps.security.getConfig(), input),
		prompts: deps.prompts
			? {
					list: (opts) => deps.prompts!.list(opts),
					detail: (slug, category) => deps.prompts!.detail(slug, category),
				}
			: undefined,
		// 技能/扩展资产面板：与桌面设置页同源；列表脱敏在路由层做。
		assets: {
			listSkills: () => skills.list(),
			toggleSkill: (skillPath, enabled) => skills.toggle(skillPath, enabled),
			listExtensions: () => extensions.list(),
			setExtensionEnabled: (source, enabled, scope, path, projectId) => extensions.toggleFromUi(source, enabled, scope, path, projectId),
		},
	});
	// 设置路由：白名单投影/写入 + 明暗重放 + 窗口广播，装配细节在 createWebSettingsRoutes。
	deps.target.settingsRoutes = createWebSettingsRoutes({ settings: deps.settings, onThemeApplied: deps.onThemeApplied });
	// Web 终端：独立 TerminalSessionManager 实例（C14）——不共享桌面 tab 表，emit 只回灌给本服务的连接，
	// 避免「桌面终端输出广播到 Web」或跨端串台。复用 launcher/回放/合批与 ProjectStore/runtime 校验。
	let terminalRoutes: WebTerminalRoutes | null = null;
	const terminalManager = new TerminalSessionManager(
		deps.terminal.getAgentCwd,
		(channel, payload) => {
			if (channel === ipcChannels.terminalData) terminalRoutes?.dispatchTerminalEvent("data", payload);
			else if (channel === ipcChannels.terminalExit) terminalRoutes?.dispatchTerminalEvent("exit", payload);
		},
		{ get: deps.projects.get },
		// WSL 终端的身份只来自项目档案（与桌面一致，不读旧全局开关）。
		() => ({}),
	);
	const resolveTarget = (raw: unknown): TerminalTarget => {
		const target = parseTerminalTarget(raw);
		if (target.kind === "project") {
			const project = deps.projects.get(target.projectId);
			if (!project) throw new Error("PROJECT_NOT_FOUND");
			if (project.kind === "chat") throw new Error("TERMINAL_PROJECT_UNSUPPORTED");
			return target;
		}
		if (!deps.terminal.validateAgentTarget(target)) throw new Error("SESSION_RUNTIME_CHANGED");
		return target;
	};
	terminalRoutes = new WebTerminalRoutes({
		enabled: deps.terminal.enabled,
		requiresAuth: deps.terminal.requiresAuth,
		token: deps.terminal.token,
		resolveTarget,
		terminal: {
			create: (input) => terminalManager.create(input.target, input.shell),
			input: (tabId, data) => terminalManager.input(tabId, data),
			resize: (tabId, cols, rows) => terminalManager.resize(tabId, cols, rows),
			close: (tabId) => terminalManager.close(tabId),
		},
	});
	deps.target.terminalRoutes = terminalRoutes;
}
