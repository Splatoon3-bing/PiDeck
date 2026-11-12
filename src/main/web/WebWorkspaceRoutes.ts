/**
 * Web 工作区只读路由（P1-P3 增强扩展）：
 * - GET /api/git/status|diff|log —— Git 抽屉数据（只读，写操作仍回桌面端）
 * - GET /api/files、GET /api/file-content —— 文件抽屉（项目内文件沙箱限制在项目根内 + 有界读取）
 *   与项目外文件预览（绝对路径 / `~/x` 按安全等级求值后只读读取，见 fileContent）
 * - GET /api/file-raw —— 媒体字节出口（图片/视频/PDF 内联展示，支持单段 Range，见 fileRaw）
 * - GET /api/prompts、GET /api/prompts/:slug —— 中文提示词精选（XuePromptManager）
 *
 * 独立模块承载（WebServiceManager 已超 1600 行），经 WebServiceManager.handleRequest
 * 在 /api/* 404 兜底前分发；所有路由只读，不引入新的写通道。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { open, readFile, stat } from "node:fs/promises";
import { mediaMimeTypeByPath } from "../../shared/mediaMime";
import type { CommitEntry, FileTreeNode, GitBranchInfo, PiExtensionListResult, PiExtensionSummary, PiSkillListResult, PiSkillSummary, Project, ScratchPadScope, YaoPromptDetailResult, YaoPromptListResult } from "../../shared/types";
// GitService 是本地实现：它返回的是「文件系统绑定」形状（绝对路径，没有渲染层的 ProjectFileTarget），
// 由 gitIpc 在 IPC 边界装饰成 shared 的 GitResource/Target。Web 路由同样直接吃本地形状——
// 这里不能声明成 GitResourceGroups，否则类型在说谎（运行时根本没有 target/displayPath）。
import type { LocalGitResourceGroups, LocalGitWorkspaceFileDiff } from "../git/localGitTypes";
import { assertProjectFileReadPath, createProjectFileReadBoundary, FILE_OUTSIDE_PROJECT_ERROR, resolveProjectFileWritePath } from "../files/projectFileAccess";
import { INVALID_PROJECT_FILE_TARGET, resolveLocalProjectFileTarget } from "../files/projectFileTarget";
import { isPathInsideProject } from "../fs/FileSystemService";
import type { UserReadAccessVerdict } from "../security/policy";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WebBodyTooLargeError, WebInvalidJsonError, WEB_CORS_HEADERS } from "./WebHttpResponders";
// 同文件的 Range 解析调用点（fileRaw）用这份 import；对外仍按原路径 re-export（见下方 export）
import { parseSingleByteRange } from "./byteRange";

export type WebWorkspaceRoutesDeps = {
	/** projectId → 项目根解析（沿用 WebServiceManager 同源数据，避免第二套项目表）。 */
	listProjects: () => Project[];
	/** Git 只读能力（GitService 注入；缺省时 git 路由返回 503）。 */
	git?: {
		isGitRepo: (cwd: string) => Promise<boolean>;
		getBranches: (cwd: string) => Promise<GitBranchInfo>;
		getStatus: (cwd: string) => Promise<LocalGitResourceGroups>;
		getWorkspaceFileDiff: (cwd: string, group: "merge" | "index" | "workingTree" | "untracked", filePath: string, maxBytes: number) => Promise<LocalGitWorkspaceFileDiff | null>;
		getCommitLog: (cwd: string, options?: { maxEntries?: number }) => Promise<CommitEntry[]>;
		/** 写操作：只开 stage/unstage/commit（discard/reset/push 不在 Web 暴露）。 */
		stageFiles?: (cwd: string, paths: string[]) => Promise<void>;
		unstageFiles?: (cwd: string, paths: string[]) => Promise<void>;
		commit?: (cwd: string, message: string) => Promise<void>;
		/** 分支：列表/切换/新建/fetch（push/pull 留到独立评审）。 */
		checkout?: (cwd: string, branch: string) => Promise<GitBranchInfo>;
		createBranch?: (cwd: string, branch: string) => Promise<GitBranchInfo>;
		fetch?: (cwd: string) => Promise<void>;
	};
	/** 文件树能力（FileSystemService 注入；缺省时 files 路由返回 503）。 */
	files?: {
		listTree: (root: string, maxDepth?: number, directory?: string) => Promise<FileTreeNode[]>;
		/** 项目内文件管理：与桌面 filesIpc 同一实现（删除走回收站）。缺省时写路由 503。 */
		create?: (parentDir: string, name: string, type: "file" | "directory") => Promise<string>;
		rename?: (targetPath: string, newName: string) => Promise<string>;
		delete?: (targetPath: string, recursive?: boolean) => Promise<void>;
		/**
		 * 写入项目内文本文件（实现侧负责 realpath/symlink 边界与原子替换）。
		 * expectedMtimeMs 提供时由实现侧做「文件是否被外部改动」的冲突校验；force 跳过。
		 * Web 端只允许相对路径，且不新建文件——避免把浏览器变成任意写盘通道。
		 */
		writeFile?: (root: string, relativePath: string, content: string, options?: { expectedMtimeMs?: number; force?: boolean }) => Promise<{ mtimeMs: number }>;
	};
	/** 草稿本能力（ScratchPadService 注入；缺省时 scratchpad 路由返回 503）。 */
	scratchPad?: {
		list: (scope: ScratchPadScope) => Promise<WebScratchPadDraft[]>;
		create: (scope: ScratchPadScope) => Promise<WebScratchPadDraft>;
		load: (scope: WebScratchPadScope, id: string, projectId?: string) => Promise<{ content: string; lastEditedAt: number }>;
		save: (scope: WebScratchPadScope, id: string, content: string, projectId?: string) => Promise<{ mtimeMs: number }>;
		delete: (scope: WebScratchPadScope, id: string, projectId?: string) => Promise<void>;
	};
	/** 提示词库（XuePromptManager 注入；缺省时 prompts 路由返回 503）。 */
	prompts?: {
		list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number }) => Promise<YaoPromptListResult>;
		detail: (slug: string, category: string) => Promise<YaoPromptDetailResult | null>;
	};
	/** 技能/扩展资产面板（SkillManager / ExtensionManager 注入；缺省时对应路由返回 503）。 */
	assets?: {
		listSkills: () => Promise<PiSkillListResult>;
		toggleSkill: (skillPath: string, enabled: boolean) => Promise<PiSkillSummary>;
		listExtensions: () => Promise<PiExtensionListResult>;
		setExtensionEnabled: (source: string, enabled: boolean, scope: PiExtensionSummary["scope"], path?: string, projectId?: string) => Promise<void>;
	};
	/**
	 * 项目外文件预览的用户意图门（安全策略求值，主进程注入 evaluateUserReadAccess）。
	 * 未注入时按「需确认」处理：确认后仍可预览（不至于因装配漏了就整条功能不可用），
	 * 但不会静默放行项目外路径。
	 */
	userReadAccess?: (input: { filePath: string; cwd: string; projectRoot: string; sessionId?: string }) => UserReadAccessVerdict;
};

export type WebScratchPadScope = "global" | "project";

/** Web 端草稿元信息：不暴露宿主绝对路径（path 是主进程内部概念）。 */
export type WebScratchPadDraft = { id: string; name: string; createdAt: number; updatedAt: number; scope: WebScratchPadScope };

/** 文件内容读取上限：2MB 以内完整返回（Web 端轻量预览的边界）。 */
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
/** Web 端可保存的文本上限（与读取上限一致；超出请回桌面/终端处理）。 */
const MAX_FILE_WRITE_BYTES = 2 * 1024 * 1024;
/** 草稿保存上限：草稿本是随手记，1MB 足够，避免浏览器当大文件编辑器。 */
const MAX_SCRATCHPAD_BYTES = 1024 * 1024;
/** 单次提交消息上限。 */
const MAX_COMMIT_MESSAGE_CHARS = 5000;
/** 单次 stage/unstage 文件数上限。 */
const MAX_GIT_PATHS = 500;
/** 超过上限时不再空手而归：有界读前 512KB 给截断预览（移动端定位问题够用，也避免大文件整读的内存峰值）。 */
const TRUNCATED_PREVIEW_BYTES = 512 * 1024;
/** 单次 diff 上限：1MB（原 256KB 对合并冲突/大重构文件偏紧，超限时 GitService 返回 null 会让用户深以为文件丢了）。 */
const MAX_DIFF_BYTES = 1024 * 1024;
/** 提示词列表单页上限。 */
const MAX_PROMPT_PAGE_SIZE = 50;
/**
 * 二进制扩展名黑名单：命中直接按二进制拒绝（不看内容，快速且准确）。
 * 白名单外其余类型（含无扩展名的 Makefile/Dockerfile/LICENSE 与生僻文本格式如 .gradle/.cmake）
 * 改走 NUL 字节启发判定——常见二进制格式（图片/音视频/压缩包）内容里基本都含 NUL，双保险。
 */
const BINARY_EXTENSION_DENYLIST = new Set([
	// 图片
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".ico",
	".tif",
	".tiff",
	".avif",
	".heic",
	// 音频
	".mp3",
	".wav",
	".flac",
	".aac",
	".ogg",
	".m4a",
	".wma",
	// 视频
	".mp4",
	".mkv",
	".avi",
	".mov",
	".webm",
	".flv",
	".wmv",
	".m4v",
	// 压缩包/磁盘镜像
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".bz2",
	".xz",
	".zst",
	".br",
	".iso",
	".img",
	".dmg",
	// 可执行/库/字节码
	".exe",
	".dll",
	".so",
	".dylib",
	".bin",
	".msi",
	".deb",
	".rpm",
	".apk",
	".ipa",
	".jar",
	".war",
	".class",
	".wasm",
	".node",
	".pyc",
	".pyo",
	".o",
	".a",
	".lib",
	// 文档/字体/数据库
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".odt",
	".ttf",
	".otf",
	".woff",
	".woff2",
	".eot",
	".sqlite",
	".db",
]);

function sendJson(response: ServerResponse, status: number, body: unknown) {
	const payload = JSON.stringify(body);
	// workspace 路由自己写头，容易和主路由的 CORS 约定脱节：漏了 Access-Control-Allow-Origin
	// 时预检照过、200 照回，浏览器却把响应整包丢掉（Failed to fetch，issue #435）。
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...WEB_CORS_HEADERS,
	});
	response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>) {
	sendJson(response, status, { code, message, ...details });
}

/**
 * 写操作审计（脱敏）：只记操作类型/项目/目标路径/结果与错误码。
 * NFR-008：Web 端第一次能改主机状态，日志里必须能回答「谁在什么时候删了哪个路径」。
 * 不记正文、不记 Git stderr 原文、不记凭据。
 */
function logWebWrite(namespace: "web-files" | "web-git", op: string, details: Record<string, unknown>): void {
	void getAppLogger()?.info(namespace, `Web ${op}`, details);
}

/** 请求体哨兵：由 WebHttpResponders 抛出，这里按 name 判定（测试/多 realm 下 instanceof 不可靠）。 */
function bodyErrorName(error: unknown): "tooLarge" | "invalidJson" | null {
	if (typeof error !== "object" || error === null) return null;
	const name = (error as { name?: unknown }).name;
	if (name === "WebBodyTooLargeError") return "tooLarge";
	if (name === "WebInvalidJsonError") return "invalidJson";
	return null;
}

/** `~/x` / `~\\x` 按当前用户家目录展开（消息里的配置/临时文件路径大多写成 ~ 形式）。 */
function expandHomePath(path: string): string {
	if (!path.startsWith("~")) return path;
	const rest = path.slice(1);
	if (!rest.startsWith("/") && !rest.startsWith("\\")) return path;
	return join(homedir(), rest.slice(1));
}

/** 单段 Range 解析已迁到叶子模块（视频 blob 出口也用它，见 byteRange.ts）；此处 re-export 保持既有调用点与测试不变。 */
export { parseSingleByteRange } from "./byteRange";

/**
 * 文件/目录名校验：只允许纯文件名。
 * 桌面 `FileSystemService` 也有同源校验；Web 路由先挡一道，避免把非法名
 * 一路带到 fs 才失败（错误码也更可读）。
 */
function assertEntryName(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("INVALID_FILE_NAME");
	const name = raw.trim();
	if (!name || name.length > 255 || name === "." || name === "..") throw new Error("INVALID_FILE_NAME");
	if (/[\\/\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) throw new Error("INVALID_FILE_NAME");
	// Windows 设备名：即使当前在 Linux 部署，Web 端也可能连线到 Windows 宿主。
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) throw new Error("INVALID_FILE_NAME");
	return name;
}

/** Git 分支名校验（在 GitService 的 check-ref-format 之前先给可读的 400）。 */
function assertBranchName(raw: unknown): string {
	if (typeof raw !== "string") throw new Error("INVALID_BRANCH_NAME");
	const name = raw.trim();
	if (!name || name.length > 255 || name.startsWith("-")) throw new Error("INVALID_BRANCH_NAME");
	if (/[\u0000-\u001f ~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name === "@") throw new Error("INVALID_BRANCH_NAME");
	if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock") || name.split("/").some((segment) => !segment || segment.startsWith("."))) throw new Error("INVALID_BRANCH_NAME");
	return name;
}

/** 工作区变更总数（用于切换分支前的脏检查）。 */
function countGitChanges(groups: { merge: unknown[]; index: unknown[]; workingTree: unknown[]; untracked: unknown[] }): number {
	return groups.merge.length + groups.index.length + groups.workingTree.length + groups.untracked.length;
}

export class WebWorkspaceRoutes {
	constructor(private readonly deps: WebWorkspaceRoutesDeps) {}

	/** 命中已知路由并完成响应时返回 true；未命中返回 false 交给上层 404。 */
	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!url.pathname.startsWith("/api/")) return false;
		try {
			if (url.pathname === "/api/git/status") return await this.gitStatus(url, response);
			if (url.pathname === "/api/git/branches" && request.method === "GET") return await this.gitBranches(url, response);
			if (url.pathname === "/api/git/checkout" && request.method === "POST") return await this.gitCheckout(request, response);
			if (url.pathname === "/api/git/fetch" && request.method === "POST") return await this.gitFetch(request, response);
			if (url.pathname === "/api/git/diff") return await this.gitDiff(url, response);
			if (url.pathname === "/api/git/log") return await this.gitLog(url, response);
			if (url.pathname === "/api/files") return await this.listFiles(url, response);
			if (url.pathname === "/api/files/create" && request.method === "POST") return await this.createEntry(request, response);
			if (url.pathname === "/api/files/rename" && request.method === "POST") return await this.renameEntry(request, response);
			if (url.pathname === "/api/files/delete" && request.method === "POST") return await this.deleteEntry(request, response);
			if (url.pathname === "/api/file-content" && request.method === "GET") return await this.fileContent(url, response);
			if (url.pathname === "/api/file-raw" && (request.method === "GET" || request.method === "HEAD")) return await this.fileRaw(url, request, response);
			if (url.pathname === "/api/file-content" && request.method === "POST") return await this.writeFileContent(request, response);
			if (url.pathname === "/api/git/stage" && request.method === "POST") return await this.gitStage(request, response);
			if (url.pathname === "/api/git/unstage" && request.method === "POST") return await this.gitUnstage(request, response);
			if (url.pathname === "/api/git/commit" && request.method === "POST") return await this.gitCommit(request, response);
			if (url.pathname === "/api/scratchpad" && request.method === "GET") return await this.scratchPadList(url, response);
			if (url.pathname === "/api/scratchpad/create" && request.method === "POST") return await this.scratchPadCreate(request, response);
			const scratchPadMatch = url.pathname.match(/^\/api\/scratchpad\/([^/]+)$/);
			if (scratchPadMatch && request.method === "GET") return await this.scratchPadLoad(scratchPadMatch[1], url, response);
			if (scratchPadMatch && request.method === "DELETE") return await this.scratchPadDelete(scratchPadMatch[1], url, response);
			const scratchPadSaveMatch = url.pathname.match(/^\/api\/scratchpad\/([^/]+)\/save$/);
			if (scratchPadSaveMatch && request.method === "POST") return await this.scratchPadSave(scratchPadSaveMatch[1], request, response);
			if (url.pathname === "/api/prompts") return await this.listPrompts(url, response);
			const promptDetailMatch = url.pathname.match(/^\/api\/prompts\/([^/]+)$/);
			if (promptDetailMatch) return await this.promptDetail(promptDetailMatch[1], url, response);
			if (url.pathname === "/api/skills" && request.method === "GET") return await this.listSkills(response);
			if (url.pathname === "/api/skills/toggle" && request.method === "POST") return await this.toggleSkill(request, response);
			if (url.pathname === "/api/extensions" && request.method === "GET") return await this.listExtensions(response);
			if (url.pathname === "/api/extensions/toggle" && request.method === "POST") return await this.toggleExtension(request, response);
			return false;
		} catch (error) {
			// 请求体超限/非法 JSON 是客户端错误：不能降级成 500（与 WebServiceManager 的统一映射同码）。
			const bodyError = bodyErrorName(error);
			if (bodyError === "tooLarge") {
				sendError(response, 413, "webError.bodyTooLarge", "payload too large");
				return true;
			}
			if (bodyError === "invalidJson") {
				sendError(response, 400, "webError.invalidJson", "Request body is not valid JSON");
				return true;
			}
			const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "workspace route failed";
			sendError(response, 500, "webError.internal", message);
			return true;
		}
	}

	/** projectId → 项目根；未知项目返回 undefined（调用方回 404）。 */
	private projectRoot(projectId: string | null): string | undefined {
		if (!projectId) return undefined;
		return this.deps.listProjects().find((project) => project.id === projectId)?.path;
	}

	private async gitStatus(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const repo = await this.deps.git.isGitRepo(root);
		if (!repo) {
			sendJson(response, 200, { repo: false });
			return true;
		}
		const [branch, groups] = await Promise.all([this.deps.git.getBranches(root), this.deps.git.getStatus(root)]);
		sendJson(response, 200, { repo: true, branch, groups });
		return true;
	}

	/** 分支列表（与 status 同源，单独入口给分支下拉刷新用）。 */
	private async gitBranches(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const repo = await this.deps.git.isGitRepo(root);
		if (!repo) {
			sendJson(response, 200, { repo: false });
			return true;
		}
		const branch = await this.deps.git.getBranches(root);
		sendJson(response, 200, { repo: true, ...branch });
		return true;
	}

	/**
	 * 切换/新建并切换分支。
	 * 脏工作区默认 409（由前端二次确认后带 force=true 重试）——git checkout 在冲突时
	 * 会拒绝，但“静默带走未提交改动”更隐蔽，先让用户明确选择。
	 */
	private async gitCheckout(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git?.checkout || !this.deps.git.createBranch) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		try {
			const branchName = assertBranchName(body.branch);
			const create = body.create === true;
			const force = body.force === true;
			if (!(await this.deps.git.isGitRepo(root))) {
				sendError(response, 400, "webError.gitNoRepo", "project is not a git repository");
				return true;
			}
			const before = await this.deps.git.getBranches(root);
			// 已经是当前分支：不触发脏检查（没有实际切换动作）。
			if (!create && before.current === branchName) {
				sendJson(response, 200, { ok: true, ...before });
				return true;
			}
			if (!create && !before.branches.includes(branchName)) {
				sendError(response, 400, "webError.gitBranchNotFound", "branch not found");
				return true;
			}
			const changes = countGitChanges(await this.deps.git.getStatus(root));
			if (changes > 0 && !force) {
				sendError(response, 409, "webError.gitDirtyWorktree", `worktree has ${changes} uncommitted change(s)`);
				return true;
			}
			const info = create ? await this.deps.git.createBranch(root, branchName) : await this.deps.git.checkout(root, branchName);
			logWebWrite("web-git", create ? "branch.create" : "branch.checkout", { projectId, branch: branchName, forced: force, status: 200 });
			sendJson(response, 200, { ok: true, ...info });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logWebWrite("web-git", "branch.checkout.failed", { projectId, branch: typeof body.branch === "string" ? body.branch : "", status: 400 });
			if (message === "INVALID_BRANCH_NAME") sendError(response, 400, "webError.invalidRequest", message);
			else sendError(response, 400, "webError.gitCheckoutFailed", message);
		}
		return true;
	}

	/** fetch 远端（不合并、不改工作区）；push/pull 不在 Web 暴露。 */
	private async gitFetch(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git?.fetch) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		try {
			if (!(await this.deps.git.isGitRepo(root))) {
				sendError(response, 400, "webError.gitNoRepo", "project is not a git repository");
				return true;
			}
			await this.deps.git.fetch(root);
			logWebWrite("web-git", "fetch", { projectId, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			logWebWrite("web-git", "fetch.failed", { projectId, status: 400 });
			sendError(response, 400, "webError.gitFetchFailed", error instanceof Error ? error.message : "fetch failed");
		}
		return true;
	}

	private async gitDiff(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const group = url.searchParams.get("group");
		const filePath = url.searchParams.get("path") ?? "";
		if ((group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") || !filePath) {
			sendError(response, 400, "webError.invalidRequest", "group and path are required");
			return true;
		}
		// filePath 必须是仓库内相对路径，拒绝绝对路径与目录穿越
		if (filePath.startsWith("/") || filePath.includes("..")) {
			sendError(response, 400, "webError.invalidRequest", "path must be a relative path inside the repository");
			return true;
		}
		const diff = await this.deps.git.getWorkspaceFileDiff(root, group, filePath, MAX_DIFF_BYTES);
		sendJson(response, 200, { diff });
		return true;
	}

	private async gitLog(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const limitRaw = url.searchParams.get("limit");
		// Number(null) === 0：参数缺失时必须回默认 20，否则 limit 被钳成 1
		const parsedLimit = limitRaw === null ? Number.NaN : Number(limitRaw);
		const maxEntries = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, Math.trunc(parsedLimit))) : 20;
		const commits = await this.deps.git.getCommitLog(root, { maxEntries });
		sendJson(response, 200, { commits });
		return true;
	}

	private async listFiles(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files) {
			sendError(response, 503, "webError.filesUnavailable", "file service is not available");
			return true;
		}
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		// dir：项目内相对路径；空 = 根。listTree 的 directory 参数要求绝对路径。
		const dir = url.searchParams.get("dir") ?? "";
		if (dir.includes("..")) {
			sendError(response, 400, "webError.invalidRequest", "dir must be a relative path inside the project");
			return true;
		}
		// maxDepth=0：只列一层（Web 抽屉按需逐层展开），节点带 hasChildren 供展开箭头
		const nodes = await this.deps.files.listTree(root, 0, dir ? join(root, dir) : undefined);
		// FileTreeNode.path 是绝对路径 —— 对外剥离，只保留 name/relativePath/type/hasChildren
		const safeNodes = nodes.map((node) => ({
			name: node.name,
			relativePath: node.relativePath,
			type: node.type,
			hasChildren: node.hasChildren,
		}));
		sendJson(response, 200, { nodes: safeNodes });
		return true;
	}

	/** 文件管理错误 → 结构化 HTTP 响应（路径/名称/不存在/已存在/权限）。同时记一条审计。 */
	private sendEntryError(response: ServerResponse, error: unknown, op: "create" | "rename" | "delete", context: { projectId: string; path: string }): void {
		const message = error instanceof Error ? error.message : String(error);
		const log = (status: number, code: string) => logWebWrite("web-files", op, { ...context, status, code });
		if (message === INVALID_PROJECT_FILE_TARGET || message === "INVALID_FILE_NAME") {
			log(400, "webError.invalidRequest");
			sendError(response, 400, "webError.invalidRequest", message);
			return;
		}
		if (message === FILE_OUTSIDE_PROJECT_ERROR) {
			log(403, "webError.fileOutsideProject");
			sendError(response, 403, "webError.fileOutsideProject", "path escapes project root");
			return;
		}
		const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
		if (code === "ENOENT") {
			log(404, "webError.fileNotFound");
			sendError(response, 404, "webError.fileNotFound", "file or directory not found");
			return;
		}
		if (code === "EEXIST") {
			log(409, "webError.fileExists");
			sendError(response, 409, "webError.fileExists", "target already exists");
			return;
		}
		if (code === "EACCES" || code === "EPERM") {
			log(403, "webError.fileAccessDenied");
			sendError(response, 403, "webError.fileAccessDenied", "permission denied");
			return;
		}
		log(400, "webError.fileOperationFailed");
		sendError(response, 400, "webError.fileOperationFailed", message);
	}

	/** 新建文件/目录（项目内相对路径；同名拒绝，不覆盖）。 */
	private async createEntry(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files?.create) {
			sendError(response, 503, "webError.filesUnavailable", "file service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const kind = body.kind === "directory" ? "directory" : body.kind === "file" ? "file" : null;
		if (!kind) {
			sendError(response, 400, "webError.invalidRequest", "kind must be file or directory");
			return true;
		}
		const dir = typeof body.dir === "string" ? body.dir : "";
		try {
			const lexicalParent = resolveLocalProjectFileTarget(root, dir);
			const parentInfo = await stat(lexicalParent).catch(() => null);
			if (!parentInfo?.isDirectory()) {
				sendError(response, 404, "webError.fileNotFound", "parent directory not found");
				return true;
			}
			const name = assertEntryName(body.name);
			// realpath 边界：项目内的 symlink 目录可以指向项目外，只做词法 resolve + startsWith
			// 会把「新建文件」变成越界写盘（桌面 LocalProjectFileBackend 走同一条 resolveProjectFileWritePath）。
			const boundary = await createProjectFileReadBoundary(root);
			const target = await resolveProjectFileWritePath(boundary, join(lexicalParent, name));
			if (await stat(target).catch(() => null)) {
				sendError(response, 409, "webError.fileExists", "target already exists");
				return true;
			}
			await this.deps.files.create(dirname(target), basename(target), kind);
			logWebWrite("web-files", "create", { projectId, dir, name, kind, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			this.sendEntryError(response, error, "create", { projectId: projectId ?? "", path: dir });
		}
		return true;
	}

	/** 重命名（只改父目录内的纯文件名；目标已存在时拒绝，不覆盖）。 */
	private async renameEntry(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files?.rename) {
			sendError(response, 503, "webError.filesUnavailable", "file service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const relativePath = typeof body.path === "string" ? body.path : "";
		try {
			const boundary = await createProjectFileReadBoundary(root);
			const source = await resolveProjectFileWritePath(boundary, resolveLocalProjectFileTarget(root, relativePath));
			if (source === boundary.canonicalRoot || source === resolve(root)) {
				sendError(response, 400, "webError.invalidRequest", "cannot rename the project root");
				return true;
			}
			const name = assertEntryName(body.newName);
			const target = await resolveProjectFileWritePath(boundary, join(dirname(source), name));
			if (!(await stat(source).catch(() => null))) {
				sendError(response, 404, "webError.fileNotFound", "file or directory not found");
				return true;
			}
			if (await stat(target).catch(() => null)) {
				sendError(response, 409, "webError.fileExists", "target already exists");
				return true;
			}
			await this.deps.files.rename(source, name);
			logWebWrite("web-files", "rename", { projectId, path: relativePath, newName: name, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			this.sendEntryError(response, error, "rename", { projectId: projectId ?? "", path: relativePath });
		}
		return true;
	}

	/** 删除（走系统回收站；拒绝删除项目根）。 */
	private async deleteEntry(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files?.delete) {
			sendError(response, 503, "webError.filesUnavailable", "file service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const relativePath = typeof body.path === "string" ? body.path : "";
		try {
			const boundary = await createProjectFileReadBoundary(root);
			const target = await resolveProjectFileWritePath(boundary, resolveLocalProjectFileTarget(root, relativePath));
			if (target === boundary.canonicalRoot || target === resolve(root)) {
				sendError(response, 400, "webError.invalidRequest", "cannot delete the project root");
				return true;
			}
			const info = await stat(target).catch(() => null);
			if (!info) {
				sendError(response, 404, "webError.fileNotFound", "file or directory not found");
				return true;
			}
			await this.deps.files.delete(target, info.isDirectory());
			logWebWrite("web-files", "delete", { projectId, path: relativePath, recursive: info.isDirectory(), status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			this.sendEntryError(response, error, "delete", { projectId: projectId ?? "", path: relativePath });
		}
		return true;
	}

	/**
	 * 读路径求值（`/api/file-content` 与 `/api/file-raw` 共用同一道门）。
	 *
	 * 路径分流（Web 端不要求文件必须在项目内）：
	 * - 项目内（相对路径或绝对路径）→ 原有项目根沙箱（含符号链接逃逸检查）；
	 * - 项目外且是相对路径（`..` 逃逸）→ 仍 403，不把 Web 变成任意目录进目录浏览；
	 * - 项目外绝对路径 / `~/x` → 安全等级求值（allow 直读 / ask 需确认 / deny 拒绝）。
	 * 错误分流：越界 → 403；文件不存在（ENOENT）→ 404，不能一律笼统当 403。
	 */
	private async resolveReadableFile(url: URL): Promise<{ absolute: string } | { failure: { status: number; code: string; message: string; details?: Record<string, unknown> } }> {
		const root = this.projectRoot(url.searchParams.get("projectId"));
		if (!root) return { failure: { status: 404, code: "webError.projectNotFound", message: "project not found" } };
		const rawTarget = url.searchParams.get("path") ?? "";
		if (!rawTarget) return { failure: { status: 400, code: "webError.invalidRequest", message: "path is required" } };
		const target = expandHomePath(rawTarget);
		const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(root, target);
		if (isPathInsideProject(root, absoluteTarget)) {
			try {
				return { absolute: await assertProjectFileReadPath(root, absoluteTarget) };
			} catch (error) {
				// vm/跨模块场景下 instanceof Error 不可靠（错误可能来自另一个 realm），用 message 判别
				const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "";
				if (message === FILE_OUTSIDE_PROJECT_ERROR) return { failure: { status: 403, code: "webError.fileOutsideProject", message: "path escapes project root" } };
				const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
				if (missing) return { failure: { status: 404, code: "webError.fileNotFound", message: "file not found" } };
				throw error;
			}
		}
		if (!isAbsolute(target)) return { failure: { status: 403, code: "webError.fileOutsideProject", message: "path escapes project root" } };
		// 确认后的读仍然是同一条路由：`confirm=1` 只能把 ask 降为放行，deny 永远不降级
		const verdict = this.deps.userReadAccess?.({ filePath: absoluteTarget, cwd: root, projectRoot: root, sessionId: url.searchParams.get("sessionId") ?? undefined }) ?? { access: "ask" as const, reason: "policy-unavailable" as const };
		if (verdict.access === "deny") return { failure: { status: 403, code: "webError.fileAccessDenied", message: "security policy denies this path", details: { reason: verdict.reason } } };
		if (verdict.access === "ask" && url.searchParams.get("confirm") !== "1") return { failure: { status: 403, code: "webError.fileAccessNeedsConfirm", message: "confirmation required to read this path", details: { reason: verdict.reason } } };
		return { absolute: absoluteTarget };
	}

	private async fileContent(url: URL, response: ServerResponse): Promise<boolean> {
		const resolved = await this.resolveReadableFile(url);
		if ("failure" in resolved) {
			sendError(response, resolved.failure.status, resolved.failure.code, resolved.failure.message, resolved.failure.details);
			return true;
		}
		const { absolute } = resolved;
		const info = await stat(absolute).catch(() => null);
		if (!info?.isFile()) {
			sendError(response, 404, "webError.fileNotFound", "file not found");
			return true;
		}

		if (info.size > MAX_FILE_CONTENT_BYTES) {
			// 超限不再空手而归：从文件句柄有界读前 512KB 给截断预览（不整读大文件，防内存峰值）；
			// 截断样本里含 NUL 同样按二进制拒绝（大文件极可能是日志外的二进制类型）。
			const handle = await open(absolute, "r").catch(() => null);
			if (!handle) {
				sendJson(response, 200, { tooLarge: true, size: info.size });
				return true;
			}
			try {
				const buffer = Buffer.alloc(TRUNCATED_PREVIEW_BYTES);
				const { bytesRead } = await handle.read(buffer, 0, TRUNCATED_PREVIEW_BYTES, 0);
				const bounded = buffer.subarray(0, bytesRead);
				if (bounded.includes(0)) {
					sendJson(response, 200, { binary: true, size: info.size });
				} else {
					sendJson(response, 200, { truncated: true, content: bounded.toString("utf8"), size: info.size });
				}
			} finally {
				await handle.close();
			}
			return true;
		}
		// 二进制判定：明确二进制扩展名黑名单直接拒；其余（含无扩展名与生僻文本格式）走 NUL 字节启发，
		// 避免把 png/exe 当 UTF-8 吐给浏览器，同时不再误拒 Makefile/Dockerfile/LICENSE/.gradle 等。
		const dot = absolute.lastIndexOf(".");
		const ext = dot >= 0 ? absolute.slice(dot).toLowerCase() : "";
		const buffer = await readFile(absolute);
		if (BINARY_EXTENSION_DENYLIST.has(ext) || buffer.includes(0)) {
			sendJson(response, 200, { binary: true, size: info.size });
			return true;
		}
		sendJson(response, 200, { content: buffer.toString("utf8"), size: info.size, mtimeMs: info.mtimeMs });
		return true;
	}

	/**
	 * 写入项目内文本文件（Web 编辑器）。边界是三道：
	 * 1) 路由层只接受相对路径、拒绝 `..` 与绝对路径、限制 2MB；
	 * 2) 能力层做 realpath/symlink 校验并以原子替换写盘；
	 * 3) expectedMtimeMs 不匹配时回 409，避免静默覆盖外部改动（用户可选 force）。
	 */
	/**
	 * 媒体字节出口：`GET /api/file-raw?projectId&path[&confirm=1]`
	 *
	 * 为什么需要它：Web 端要内联展示本地图片/视频/PDF，而 `<img>`/`<video>`/`<iframe>`
	 * 只能发普通 GET（带不上 Authorization），字节只能由服务端下发；令牌走 `?token=`
	 * （与 `/api/imagegen/blob` 同一条链，由 WebTokenAuth 统一校验）。
	 *
	 * 响应语义对齐成熟实现（express 的 `send` / tornado 的 StaticFileHandler）：
	 * - `Accept-Ranges: bytes`；单段 `Range` → 206 + `Content-Range`（音视频拖进度必需）；
	 * - 多段 Range / 非 bytes 单位 → 忽略 Range 回 200 全量（HTTP 规范允许）；
	 * - 区间越界 → 416，并在 `Content-Range` 里回 `bytes *` 加 `/<size>`（星号表示请求区间不可满足）；
	 * - `Content-Type` 按扩展名（shared/mediaMime 与桌面自定义协议共用一份表），
	 *   未知按 `application/octet-stream`（配合 nosniff 浏览器不会瞎猜）。
	 *
	 * 读路径与 `/api/file-content` 共用 `resolveReadableFile`：同一道项目沙箱 +
	 * 安全等级门，不因为「这是图片」就放宽。
	 */
	private async fileRaw(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const resolved = await this.resolveReadableFile(url);
		if ("failure" in resolved) {
			sendError(response, resolved.failure.status, resolved.failure.code, resolved.failure.message, resolved.failure.details);
			return true;
		}
		const { absolute } = resolved;
		const info = await stat(absolute).catch(() => null);
		if (!info?.isFile()) {
			sendError(response, 404, "webError.fileNotFound", "file not found");
			return true;
		}
		const size = info.size;
		const range = parseSingleByteRange(request.headers.range, size);
		if (range === null) {
			response.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes", ...WEB_CORS_HEADERS });
			response.end();
			return true;
		}
		response.writeHead(range ? 206 : 200, {
			"content-type": mediaMimeTypeByPath(absolute) ?? "application/octet-stream",
			"accept-ranges": "bytes",
			"x-content-type-options": "nosniff",
			// 同一路径的内容会被编辑器/agent 改写，不做长缓存；但也别让大图每次刷新都重下。
			"cache-control": "private, max-age=60",
			"content-length": String(range ? range.end - range.start + 1 : size),
			...WEB_CORS_HEADERS,
			...(range ? { "content-range": `bytes ${range.start}-${range.end}/${size}` } : {}),
		});
		if (request.method === "HEAD" || size === 0) {
			response.end();
			return true;
		}
		// 流式回传：媒体文件动辄几十 MB，绝不能用 readFile 整读进主进程内存。
		// 客户端中断（拖进度/关页面）是常态，pipeline 的 EPIPE 无需再写响应。
		await pipeline(createReadStream(absolute, range ? { start: range.start, end: range.end } : undefined), response).catch(() => undefined);
		return true;
	}

	private async writeFileContent(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.files?.writeFile) {
			sendError(response, 503, "webError.filesUnavailable", "file write is not available");
			return true;
		}
		const body = await this.readJsonBody(request, MAX_FILE_WRITE_BYTES + 64 * 1024);
		const projectId = typeof body.projectId === "string" ? body.projectId : "";
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const relativePath = typeof body.path === "string" ? body.path : "";
		const content = typeof body.content === "string" ? body.content : null;
		if (!relativePath.trim() || content === null) {
			sendError(response, 400, "webError.invalidRequest", "path (string) and content (string) are required");
			return true;
		}
		if (relativePath.length > 32_768 || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
			sendError(response, 400, "webError.invalidRequest", "path must be a relative path inside the project");
			return true;
		}
		if (Buffer.byteLength(content, "utf8") > MAX_FILE_WRITE_BYTES) {
			sendError(response, 413, "webError.fileTooLarge", "content exceeds the 2MB write limit");
			return true;
		}
		const expectedMtimeMs = typeof body.expectedMtimeMs === "number" && Number.isFinite(body.expectedMtimeMs) ? body.expectedMtimeMs : undefined;
		const force = body.force === true;
		try {
			const result = await this.deps.files.writeFile(root, relativePath, content, { expectedMtimeMs, force });
			sendJson(response, 200, { ok: true, mtimeMs: result.mtimeMs });
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
			if (code === "FILE_CHANGED") {
				sendError(response, 409, "webError.fileChanged", "file has changed on disk");
				return true;
			}
			const message = error instanceof Error ? error.message : String(error);
			if (message === "FILE_OUTSIDE_PROJECT") {
				sendError(response, 403, "webError.fileOutsideProject", "path escapes project root");
				return true;
			}
			sendError(response, 400, "webError.fileWriteFailed", message);
		}
		return true;
	}

	/** stage/unstage 共用的入参校验：项目存在、paths 为仓库内相对路径。 */
	private readGitPaths(body: Record<string, unknown>): { root: string; paths: string[] } | { error: string; status: number; code: string } {
		if (!this.deps.git?.stageFiles || !this.deps.git?.unstageFiles) {
			return { error: "git service is not available", status: 503, code: "webError.gitUnavailable" };
		}
		const root = this.projectRoot(typeof body.projectId === "string" ? body.projectId : null);
		if (!root) return { error: "project not found", status: 404, code: "webError.projectNotFound" };
		const raw = body.paths;
		if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GIT_PATHS) {
			return { error: "paths must be a non-empty array", status: 400, code: "webError.invalidRequest" };
		}
		const paths: string[] = [];
		for (const entry of raw) {
			if (typeof entry !== "string" || !entry.trim() || entry.length > 32_768 || isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
				return { error: "paths must be relative paths inside the repository", status: 400, code: "webError.invalidRequest" };
			}
			paths.push(entry);
		}
		return { root, paths };
	}

	private async gitStage(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = await this.readJsonBody(request);
		const parsed = this.readGitPaths(body);
		if ("error" in parsed) {
			sendError(response, parsed.status, parsed.code, parsed.error);
			return true;
		}
		if (!this.deps.git?.stageFiles) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		try {
			await this.deps.git.stageFiles(parsed.root, parsed.paths);
			logWebWrite("web-git", "stage", { projectId: typeof body.projectId === "string" ? body.projectId : "", fileCount: parsed.paths.length, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			logWebWrite("web-git", "stage.failed", { projectId: typeof body.projectId === "string" ? body.projectId : "", status: 400 });
			sendError(response, 400, "webError.gitStageFailed", error instanceof Error ? error.message : "stage failed");
		}
		return true;
	}

	private async gitUnstage(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = await this.readJsonBody(request);
		const parsed = this.readGitPaths(body);
		if ("error" in parsed) {
			sendError(response, parsed.status, parsed.code, parsed.error);
			return true;
		}
		if (!this.deps.git?.unstageFiles) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		try {
			await this.deps.git.unstageFiles(parsed.root, parsed.paths);
			logWebWrite("web-git", "unstage", { projectId: typeof body.projectId === "string" ? body.projectId : "", fileCount: parsed.paths.length, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			logWebWrite("web-git", "unstage.failed", { projectId: typeof body.projectId === "string" ? body.projectId : "", status: 400 });
			sendError(response, 400, "webError.gitUnstageFailed", error instanceof Error ? error.message : "unstage failed");
		}
		return true;
	}

	private async gitCommit(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.git?.commit) {
			sendError(response, 503, "webError.gitUnavailable", "git service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		const projectId = typeof body.projectId === "string" ? body.projectId : null;
		const root = this.projectRoot(projectId);
		if (!root) {
			sendError(response, 404, "webError.projectNotFound", "project not found");
			return true;
		}
		const message = typeof body.message === "string" ? body.message.trim() : "";
		if (!message || message.length > MAX_COMMIT_MESSAGE_CHARS) {
			sendError(response, 400, "webError.invalidRequest", `commit message must be 1-${MAX_COMMIT_MESSAGE_CHARS} characters`);
			return true;
		}
		try {
			await this.deps.git.commit(root, message);
			// 只记消息长度，不记正文（提交信息可能含隐私）。
			logWebWrite("web-git", "commit", { projectId, messageLength: message.length, status: 200 });
			sendJson(response, 200, { ok: true });
		} catch (error) {
			logWebWrite("web-git", "commit.failed", { projectId, messageLength: message.length, status: 400 });
			sendError(response, 400, "webError.gitCommitFailed", error instanceof Error ? error.message : "commit failed");
		}
		return true;
	}

	/** 解析草稿作用域查询/请求体；项目作用域必须带有效 projectId。 */
	private readScratchPadScope(source: { get?: (key: string) => string | null; body?: Record<string, unknown> }): ScratchPadScope {
		const kind = source.get ? source.get("scope") : source.body?.scope;
		if (kind === "project") {
			const projectId = source.get ? source.get("projectId") : typeof source.body?.projectId === "string" ? source.body.projectId : "";
			if (!projectId) throw new Error("projectId is required for project scope");
			if (!this.projectRoot(projectId)) throw new Error("project not found");
			return { kind: "project", projectId };
		}
		return { kind: "global" };
	}

	private scratchPadDraft(scope: ScratchPadScope): WebScratchPadScope {
		return scope.kind === "project" ? "project" : "global";
	}

	private async scratchPadList(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.scratchPad) {
			sendError(response, 503, "webError.scratchPadUnavailable", "scratch pad is not available");
			return true;
		}
		try {
			const scope = this.readScratchPadScope({ get: (key) => url.searchParams.get(key) });
			sendJson(response, 200, { drafts: await this.deps.scratchPad.list(scope) });
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid scope";
			sendError(response, message === "project not found" ? 404 : 400, "webError.invalidRequest", message);
		}
		return true;
	}

	private async scratchPadCreate(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.scratchPad) {
			sendError(response, 503, "webError.scratchPadUnavailable", "scratch pad is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		try {
			const scope = this.readScratchPadScope({ body });
			sendJson(response, 200, { draft: await this.deps.scratchPad.create(scope) });
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid scope";
			sendError(response, message === "project not found" ? 404 : 400, "webError.invalidRequest", message);
		}
		return true;
	}

	private async scratchPadLoad(rawId: string, url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.scratchPad) {
			sendError(response, 503, "webError.scratchPadUnavailable", "scratch pad is not available");
			return true;
		}
		try {
			const scope = this.readScratchPadScope({ get: (key) => url.searchParams.get(key) });
			const data = await this.deps.scratchPad.load(this.scratchPadDraft(scope), decodeURIComponent(rawId), scope.kind === "project" ? scope.projectId : undefined);
			sendJson(response, 200, data);
		} catch (error) {
			const message = error instanceof Error ? error.message : "load failed";
			sendError(response, message === "project not found" ? 404 : 400, "webError.invalidRequest", message);
		}
		return true;
	}

	private async scratchPadSave(rawId: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.scratchPad) {
			sendError(response, 503, "webError.scratchPadUnavailable", "scratch pad is not available");
			return true;
		}
		const body = await this.readJsonBody(request, MAX_SCRATCHPAD_BYTES + 64 * 1024);
		const content = typeof body.content === "string" ? body.content : null;
		if (content === null) {
			sendError(response, 400, "webError.invalidRequest", "content (string) is required");
			return true;
		}
		if (Buffer.byteLength(content, "utf8") > MAX_SCRATCHPAD_BYTES) {
			sendError(response, 413, "webError.fileTooLarge", "draft exceeds the 1MB limit");
			return true;
		}
		try {
			const scope = this.readScratchPadScope({ body });
			const result = await this.deps.scratchPad.save(this.scratchPadDraft(scope), decodeURIComponent(rawId), content, scope.kind === "project" ? scope.projectId : undefined);
			sendJson(response, 200, { ok: true, mtimeMs: result.mtimeMs });
		} catch (error) {
			const message = error instanceof Error ? error.message : "save failed";
			sendError(response, message === "project not found" ? 404 : 400, "webError.invalidRequest", message);
		}
		return true;
	}

	private async scratchPadDelete(rawId: string, url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.scratchPad) {
			sendError(response, 503, "webError.scratchPadUnavailable", "scratch pad is not available");
			return true;
		}
		try {
			const scope = this.readScratchPadScope({ get: (key) => url.searchParams.get(key) });
			await this.deps.scratchPad.delete(this.scratchPadDraft(scope), decodeURIComponent(rawId), scope.kind === "project" ? scope.projectId : undefined);
			sendJson(response, 200, { ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "delete failed";
			sendError(response, message === "project not found" ? 404 : 400, "webError.invalidRequest", message);
		}
		return true;
	}

	private async listPrompts(url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.prompts) {
			sendError(response, 503, "webError.promptsUnavailable", "prompt library is not available");
			return true;
		}
		const search = url.searchParams.get("search")?.trim() || undefined;
		const category = url.searchParams.get("category")?.trim() || undefined;
		const pageRaw = Number(url.searchParams.get("page"));
		const pageSizeRaw = Number(url.searchParams.get("pageSize"));
		const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
		const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(MAX_PROMPT_PAGE_SIZE, Math.trunc(pageSizeRaw)) : 20;
		const result = await this.deps.prompts.list({ search, category, page, pageSize });
		// YaoPromptItem.path 是宿主机绝对路径 —— 对外剥离
		sendJson(response, 200, {
			categories: result.categories,
			prompts: result.prompts.map(({ path: _path, ...rest }) => rest),
			total: result.total,
			page,
			pageSize,
		});
		return true;
	}

	private async promptDetail(slug: string, url: URL, response: ServerResponse): Promise<boolean> {
		if (!this.deps.prompts) {
			sendError(response, 503, "webError.promptsUnavailable", "prompt library is not available");
			return true;
		}
		const category = url.searchParams.get("category")?.trim() ?? "";
		if (!category) {
			sendError(response, 400, "webError.invalidRequest", "category is required");
			return true;
		}
		const detail = await this.deps.prompts.detail(decodeURIComponent(slug), category);
		if (!detail) {
			sendError(response, 404, "webError.promptNotFound", "prompt not found");
			return true;
		}
		sendJson(response, 200, { detail: { title: detail.title, description: detail.description, promptContent: detail.promptContent } });
		return true;
	}

	// ── 技能/扩展资产面板（第二批：与桌面设置页同源的列表 + 开关）──

	private async listSkills(response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.skillsUnavailable", "skill service is not available");
			return true;
		}
		// PiSkillSummary.path/dir 是宿主机绝对路径 —— 对外剥离（与 prompts 同款脱敏策略）
		const result = await this.deps.assets.listSkills();
		sendJson(response, 200, {
			locations: result.locations.map(({ path: _path, ...rest }) => rest),
			skills: result.skills.map(({ path: _path, dir: _dir, ...rest }) => rest),
		});
		return true;
	}

	private async toggleSkill(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.skillsUnavailable", "skill service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		// 前端拿不到宿主绝对路径（脱敏），用 name + sourceId 定位：
		// SkillManager 的持久化本身按 name 写 disabledSkills，path 仅用于进程内定位。
		if (typeof body.name !== "string" || !body.name || typeof body.enabled !== "boolean") {
			sendError(response, 400, "webError.invalidRequest", "name (string) and enabled (boolean) are required");
			return true;
		}
		const sourceId = body.sourceId;
		if (sourceId !== "pi-global" && sourceId !== "agents-global" && sourceId !== "pideck-global" && sourceId !== "project-pi" && sourceId !== "project-agents") {
			sendError(response, 400, "webError.invalidRequest", "sourceId must be a valid skill location id");
			return true;
		}
		const result = await this.deps.assets.listSkills();
		const target = result.skills.find((skill) => skill.name === body.name && skill.sourceId === sourceId);
		if (!target) {
			sendError(response, 404, "webError.skillNotFound", "skill not found");
			return true;
		}
		const skill = await this.deps.assets.toggleSkill(target.path, body.enabled);
		const { path: _path, dir: _dir, ...rest } = skill;
		sendJson(response, 200, { skill: rest });
		return true;
	}

	private async listExtensions(response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.extensionsUnavailable", "extension service is not available");
			return true;
		}
		const result = await this.deps.assets.listExtensions();
		// path 是宿主机绝对路径，对外剥离（与 skills/prompts 同款脱敏策略）
		sendJson(response, 200, {
			extensions: result.extensions.map(({ path: _path, ...rest }) => rest),
			conflicts: result.conflicts ?? [],
		});
		return true;
	}

	private async toggleExtension(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (!this.deps.assets) {
			sendError(response, 503, "webError.extensionsUnavailable", "extension service is not available");
			return true;
		}
		const body = await this.readJsonBody(request);
		// scope 必须是合法枚举：user/project/unknown，其余拒绝（不猜默认）
		const scope = body.scope;
		if (typeof body.source !== "string" || !body.source || typeof body.enabled !== "boolean" || (scope !== "user" && scope !== "project" && scope !== "unknown")) {
			sendError(response, 400, "webError.invalidRequest", "source (string), enabled (boolean), scope (user|project|unknown) are required");
			return true;
		}
		// 项目作用域必须带 projectId：缺了会一路走到原生配置写入才失败（HTTP 500，前端只看到「失败」）。
		const projectId = typeof body.projectId === "string" && body.projectId.trim() && body.projectId.trim().length <= 256 ? body.projectId.trim() : undefined;
		if (scope === "project" && !projectId) {
			sendError(response, 400, "webError.invalidRequest", "projectId (string) is required when scope is project");
			return true;
		}
		// 扩展列表有意剥离宿主机路径，本地文件扩展由主进程按 source 反查真实路径；内置扩展的开关
		// 也由同一入口分流到 PiDeck 设置（见 ExtensionManager.toggleFromUi）。
		const path = typeof body.path === "string" && body.path.length <= 32_768 ? body.path : undefined;
		await this.deps.assets.setExtensionEnabled(body.source, body.enabled, scope, path, projectId);
		sendJson(response, 200, { ok: true });
		return true;
	}

	/** 读 POST JSON body（默认 64KB 上限；文件/草稿写入口显式放宽）。 */
	private readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
		// 超限/非法 JSON 抛出与 WebHttpResponders.readJson 同款哨兵错误（上层统一映射 413/400），
		// 不再把客户端错误降级成 500；超限后继续排空连接以便 413 能送达。
		return new Promise((resolvePromise, reject) => {
			const chunks: Buffer[] = [];
			let total = 0;
			let oversized = false;
			request.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxBytes) {
					oversized = true;
					return;
				}
				chunks.push(chunk);
			});
			request.on("end", () => {
				if (oversized) {
					reject(new WebBodyTooLargeError());
					return;
				}
				try {
					const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
					resolvePromise(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
				} catch {
					reject(new WebInvalidJsonError());
				}
			});
			request.on("error", reject);
		});
	}
}
