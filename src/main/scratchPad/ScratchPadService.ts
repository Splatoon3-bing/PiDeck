/**
 * ScratchPadService — 草稿本的唯一存储实现（桌面 IPC 与 Web 路由共用）。
 *
 * 边界（不可放宽）：
 * - 所有读写删都限制在 `<userData>/drafts`（项目草稿在 `drafts/projects/<projectId>/`）；
 * - 渲染层/浏览器传入的绝对路径必须经过 `resolveDraftPath` 边界校验；
 * - Web 端不接收宿主绝对路径，只接收 (scope, id)，由本服务解析成受管路径；
 * - 删除走系统回收站（可恢复），回收站不可用时抛错，不硬删。
 *
 * 抽成服务的理由：Web 与 IPC 若各写一份目录/作用域/迁移逻辑，边界迟早分叉
 *（历史上正是「各写一份路径校验」导致越界读写）。本文件是唯一一处。
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { DraftMeta, ScratchPadData, ScratchPadScope } from "../../shared/types";
import { trashPath as defaultTrashPath } from "../fs/trash";

export type ScratchPadLogger = {
	info: (namespace: string, message: string, details?: unknown) => void;
	error: (namespace: string, message: string, details?: unknown) => void;
};

type ScratchPadServiceOptions = {
	/** `<userData>/drafts`；由宿主在构造时给出（服务层不读 electron app）。 */
	draftsDir: string;
	/** 旧的 `<userData>/scratch-pad.md` 路径：首次访问时迁移进 drafts。 */
	legacyDraftPath?: string;
	logger?: ScratchPadLogger;
	/** 测试/复用注入；缺省走系统回收站。 */
	trash?: (targetPath: string, context: { source: string }) => Promise<void>;
};

/** 作用域 id 只用于目录名：限制为字母数字与 `_-`，杜绝 `..` / 分隔符把草稿写到 drafts 之外。 */
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** 草稿 id 来自文件名（去 .md）：不允许路径分隔符、控制字符与点前缀。 */
const DRAFT_ID_PATTERN = /^[^/\\\u0000-\u001f]{1,200}$/;

/** 把作用域解析成实际目录；缺省/global = drafts 根目录。 */
function resolveScopeDir(draftsDir: string, scope?: ScratchPadScope): { dir: string; scope: "global" | "project" } {
	if (!scope || scope.kind === "global") return { dir: draftsDir, scope: "global" };
	if (scope.kind !== "project" || typeof scope.projectId !== "string" || !SCOPE_ID_PATTERN.test(scope.projectId)) {
		throw new Error("Invalid scratch pad scope");
	}
	return { dir: join(draftsDir, "projects", scope.projectId), scope: "project" };
}

/** 生成以当前时间命名的默认文件名：YYYY-MM-DD HH-mm-ss.md */
function generateDraftName(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}.md`;
}

export class ScratchPadService {
	private readonly draftsDir: string;
	private readonly legacyDraftPath: string | undefined;
	private readonly logger: ScratchPadLogger | undefined;
	private readonly trash: (targetPath: string, context: { source: string }) => Promise<void>;
	private migrated = false;

	constructor(options: ScratchPadServiceOptions) {
		this.draftsDir = resolve(options.draftsDir);
		this.legacyDraftPath = options.legacyDraftPath ? resolve(options.legacyDraftPath) : undefined;
		this.logger = options.logger;
		this.trash = options.trash ?? defaultTrashPath;
	}

	/** 确保 drafts 目录存在；旧 scratch-pad.md 只迁移一次（可重入：迁移后源文件删除）。 */
	async ensureDir(): Promise<void> {
		await mkdir(this.draftsDir, { recursive: true }).catch(() => undefined);
		if (this.migrated) return;
		this.migrated = true;
		if (!this.legacyDraftPath) return;
		try {
			const legacyStat = await stat(this.legacyDraftPath);
			if (legacyStat.size > 0) {
				const ts = new Date(legacyStat.mtimeMs);
				const name = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}-${String(ts.getMinutes()).padStart(2, "0")}-${String(ts.getSeconds()).padStart(2, "0")}.md`;
				await copyFile(this.legacyDraftPath, join(this.draftsDir, name));
			}
			await rm(this.legacyDraftPath);
		} catch {
			// 旧文件不存在/已迁移：忽略
		}
	}

	/** 列出某个目录下的 .md 草稿，按更新时间降序；目录不存在时返回空表。 */
	private async listDraftsIn(dir: string, scope: "global" | "project"): Promise<DraftMeta[]> {
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return [];
		}
		const drafts = await Promise.all(
			files
				.filter((file) => file.endsWith(".md"))
				.map(async (file) => {
					const fullPath = join(dir, file);
					try {
						const fileStat = await stat(fullPath);
						return {
							id: file.replace(/\.md$/, ""),
							name: file.replace(/\.md$/, ""),
							path: fullPath,
							createdAt: fileStat.birthtimeMs,
							updatedAt: fileStat.mtimeMs,
							scope,
						};
					} catch {
						return null;
					}
				}),
		);
		return drafts.filter((draft): draft is DraftMeta => draft !== null);
	}

	/**
	 * 列出草稿：
	 * - global：只返回全局草稿；
	 * - project：本项目草稿 + 全局草稿（可编辑），绝不含其他项目草稿。
	 */
	async list(scope?: ScratchPadScope): Promise<DraftMeta[]> {
		const resolved = resolveScopeDir(this.draftsDir, scope);
		await this.ensureDir();
		const globalDrafts = await this.listDraftsIn(this.draftsDir, "global");
		const scopedDrafts = resolved.scope === "project" ? await this.listDraftsIn(resolved.dir, "project") : [];
		return [...scopedDrafts, ...globalDrafts].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 创建新草稿（默认当前时间命名），落点由 scope 决定。 */
	async create(scope?: ScratchPadScope): Promise<DraftMeta> {
		const resolved = resolveScopeDir(this.draftsDir, scope);
		await mkdir(resolved.dir, { recursive: true });
		const name = generateDraftName();
		// 同一秒内重复创建会让 wx 失败；追加序号保证可重入而不是覆盖已有草稿。
		let fullPath = join(resolved.dir, name);
		for (let index = 1; index < 10; index += 1) {
			try {
				await writeFile(fullPath, "", { encoding: "utf8", flag: "wx" });
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST" || index === 9) throw error;
				fullPath = join(resolved.dir, name.replace(/\.md$/, `-${index}.md`));
			}
		}
		const fileStat = await stat(fullPath);
		this.logger?.info("scratchPad", "draft created", { path: fullPath, scope: resolved.scope });
		return {
			id: basename(fullPath).replace(/\.md$/, ""),
			name: basename(fullPath).replace(/\.md$/, ""),
			path: fullPath,
			createdAt: fileStat.birthtimeMs,
			updatedAt: fileStat.mtimeMs,
			scope: resolved.scope,
		};
	}

	/** 边界校验：绝对路径必须落在 drafts 内（IPC 的路径来源）。 */
	resolveDraftPath(rawPath: unknown): string {
		if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("Invalid draft path");
		const resolved = resolve(rawPath);
		const draftsRoot = resolve(this.draftsDir);
		if (resolved !== draftsRoot && !resolved.startsWith(draftsRoot + sep)) {
			throw new Error("Draft path must stay inside the drafts directory");
		}
		return resolved;
	}

	/**
	 * Web 端入口：只用 (scope, id) 定位，不接受宿主路径。
	 * scope 是草稿实际所在作用域（global/project），projectId 参与目录解析。
	 */
	resolveDraftPathById(scope: "global" | "project", id: string, projectId?: string): string {
		if (typeof id !== "string" || !DRAFT_ID_PATTERN.test(id) || id === "." || id === "..") {
			throw new Error("Invalid draft id");
		}
		const dir = scope === "project" ? resolveScopeDir(this.draftsDir, { kind: "project", projectId: projectId ?? "" }).dir : this.draftsDir;
		const target = resolve(dir, `${id}.md`);
		if (!target.startsWith(resolve(dir) + sep)) throw new Error("Invalid draft id");
		return target;
	}

	/** 删除指定草稿（回收站；越界路径不会到达 trash）。 */
	async delete(draftPath: string): Promise<void> {
		const safePath = this.resolveDraftPath(draftPath);
		try {
			await this.trash(safePath, { source: "scratchPad:delete" });
			this.logger?.info("scratchPad", "draft deleted", { path: safePath });
		} catch (error) {
			this.logger?.error("scratchPad", "Draft delete failed", {
				path: draftPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/** 加载指定草稿内容（不存在时返回空内容，与历史行为一致）。 */
	async load(draftPath?: string): Promise<ScratchPadData> {
		if (!draftPath) return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		const safePath = this.resolveDraftPath(draftPath);
		try {
			const content = await readFile(safePath, "utf8");
			const fileStat = await stat(safePath);
			return { content, lastEditedAt: fileStat.mtimeMs, cursorPosition: 0 };
		} catch {
			return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		}
	}

	/** 保存内容到指定草稿（路径必须已在 drafts 内）。 */
	async save(draftPath: string, content: string, cursorPosition = 0): Promise<void> {
		await this.ensureDir();
		const safePath = this.resolveDraftPath(draftPath);
		await writeFile(safePath, content, "utf8");
		this.logger?.info("scratchPad", "saved", { path: safePath, bytes: Buffer.byteLength(content, "utf8"), cursorPosition });
	}
}
