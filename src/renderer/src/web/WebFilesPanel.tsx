/**
 * WebFilesPanel — Web 工作区抽屉的文件面板。
 *
 * 只读导航 + 项目内文件管理（新建/重命名/删除）。文件内容/编辑交给全屏
 * `WebFilePreview`；删除由主进程走系统回收站，Web 端不做硬删。
 *
 * 边界由后端再次校验：这里只做名称空值/忙碌态，真正的路径逃逸、同名、
 * 项目根删除都在 `WebWorkspaceRoutes` 拒绝。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronRight, FileText, Folder, FolderPlus, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebFileOperationError, createProjectEntry, deleteProjectEntry, fetchFileList, renameProjectEntry } from "./webApi";
import type { WebFileNodeLite } from "./webTypes";

type CreateDraft = { kind: "file" | "directory"; name: string };
type RenameDraft = { path: string; name: string; newName: string };
type DeleteTarget = { path: string; name: string; type: "file" | "directory" };

export function WebFilesPanel(props: { projectId: string; active: boolean; onOpenFile: (path: string) => void }) {
	const [dir, setDir] = useState("");
	const [nodes, setNodes] = useState<WebFileNodeLite[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
	const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

	const load = useCallback(
		async (nextDir: string) => {
			setLoading(true);
			setError(null);
			try {
				setNodes(await fetchFileList(props.projectId, nextDir || undefined));
			} catch (loadError) {
				setNodes([]);
				setError(loadError instanceof Error ? loadError.message : String(loadError));
			} finally {
				setLoading(false);
			}
		},
		[props.projectId],
	);

	useEffect(() => {
		if (props.active) void load(dir);
	}, [props.active, dir, load]);

	// 切换项目时回到根目录，避免把上一个项目的相对路径带进来。
	useEffect(() => {
		setDir("");
		setFilter("");
		setActionError(null);
	}, [props.projectId]);

	const crumbs = useMemo(() => (dir ? dir.split("/").filter(Boolean) : []), [dir]);
	const visible = useMemo(() => {
		const keyword = filter.trim().toLowerCase();
		if (!keyword) return nodes;
		return nodes.filter((node) => node.name.toLowerCase().includes(keyword));
	}, [filter, nodes]);

	const childPath = (name: string) => (dir ? `${dir}/${name}` : name);

	const entryErrorText = (actionFailure: unknown): string => {
		if (actionFailure instanceof WebFileOperationError) {
			if (actionFailure.code === "webError.fileExists") return t("web.fileExists");
			if (actionFailure.code === "webError.invalidRequest") return t("web.fileNameInvalid");
		}
		return actionFailure instanceof Error ? actionFailure.message : String(actionFailure);
	};

	const runAction = async (action: () => Promise<void>) => {
		setBusy(true);
		setActionError(null);
		try {
			await action();
		} catch (actionFailure) {
			setActionError(entryErrorText(actionFailure));
		} finally {
			setBusy(false);
		}
	};

	const submitCreate = () => {
		const draft = createDraft;
		const name = draft?.name.trim() ?? "";
		if (!draft || !name) return;
		void runAction(async () => {
			await createProjectEntry(props.projectId, dir, name, draft.kind);
			setCreateDraft(null);
			if (draft.kind === "directory") setDir(childPath(name));
			else await load(dir);
		});
	};

	const submitRename = () => {
		const draft = renameDraft;
		const newName = draft?.newName.trim() ?? "";
		if (!draft || !newName) return;
		void runAction(async () => {
			await renameProjectEntry(props.projectId, draft.path, newName);
			setRenameDraft(null);
			await load(dir);
		});
	};

	const confirmDelete = () => {
		const target = deleteTarget;
		if (!target) return;
		void runAction(async () => {
			await deleteProjectEntry(props.projectId, target.path);
			setDeleteTarget(null);
			// 删掉的是当前目录或它的祖先：回到根目录；否则原地刷新。
			if (dir === target.path || dir.startsWith(`${target.path}/`)) setDir("");
			else await load(dir);
		});
	};

	const overlayError = actionError ?? error;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-w-0 items-center gap-0.5 text-caption">
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" disabled={!dir} onClick={() => setDir(crumbs.slice(0, -1).join("/"))} aria-label={t("web.filesUp")} title={t("web.filesUp")}>
					<ArrowUp className="size-3.5" aria-hidden="true" />
				</Button>
				<button type="button" className="shrink-0 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setDir("")}>
					{t("web.filesTab")}
				</button>
				{crumbs.map((crumb, index) => (
					<span key={`${crumb}-${index}`} className="flex min-w-0 items-center gap-0.5">
						<ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
						<button type="button" className="max-w-28 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>
							{crumb}
						</button>
					</span>
				))}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" variant="ghost" size="icon" className="ml-auto size-7 shrink-0 text-muted-foreground" aria-label={t("web.fileActions")} title={t("web.fileActions")} disabled={busy} data-testid="web-files-add">
							<Plus className="size-3.5" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem onClick={() => setCreateDraft({ kind: "file", name: "" })}>
							<FileText className="size-4" aria-hidden="true" />
							{t("drawer.newFile")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => setCreateDraft({ kind: "directory", name: "" })}>
							<FolderPlus className="size-4" aria-hidden="true" />
							{t("drawer.newFolder")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => void load(dir)} aria-label={t("web.refresh")} title={t("web.refresh")} disabled={loading || busy}>
					<RefreshCw className={cn("size-3.5", loading && "animate-pideck-spin")} aria-hidden="true" />
				</Button>
			</div>

			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("web.filesFilter")} className="h-8 pl-8 text-caption" aria-label={t("web.filesFilter")} />
			</div>

			{overlayError ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-caption text-danger" role="alert">
					{overlayError}
				</div>
			) : null}

			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-caption text-muted-foreground">
					<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
				</div>
			) : visible.length === 0 ? (
				<div className="px-1 py-6 text-center text-caption text-muted-foreground">{filter.trim() ? t("web.filesNoMatch") : t("web.filesEmpty")}</div>
			) : (
				<ul className="flex flex-col gap-0.5">
					{visible.map((node) => (
						<li key={node.relativePath}>
							<div className="group/entry flex min-h-8 items-center gap-0.5 rounded-md transition-colors hover:bg-muted/60">
								<button type="button" className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-caption disabled:opacity-60" disabled={busy} onClick={() => (node.type === "directory" ? setDir(node.relativePath) : props.onOpenFile(node.relativePath))} title={node.relativePath}>
									{node.type === "directory" ? <Folder className="size-3.5 shrink-0 text-primary/70" aria-hidden="true" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
									<span className="min-w-0 flex-1 truncate text-foreground">{node.name}</span>
									{node.type === "directory" ? <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" /> : null}
								</button>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="mr-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/entry:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-40"
											aria-label={t("web.fileActions")}
											title={t("web.fileActions")}
											disabled={busy}
											data-testid="web-file-row-menu"
										>
											<MoreHorizontal className="size-3.5" aria-hidden="true" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-40">
										<DropdownMenuItem onClick={() => setRenameDraft({ path: node.relativePath, name: node.name, newName: node.name })}>
											<Pencil className="size-4" aria-hidden="true" />
											{t("common.rename")}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget({ path: node.relativePath, name: node.name, type: node.type })}>
											<Trash2 className="size-4" aria-hidden="true" />
											{t("common.delete")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</li>
					))}
				</ul>
			)}

			<Dialog open={createDraft != null} onOpenChange={(open) => (!open ? setCreateDraft(null) : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{createDraft?.kind === "directory" ? t("drawer.newFolder") : t("drawer.newFile")}</DialogTitle>
					</DialogHeader>
					<Input
						value={createDraft?.name ?? ""}
						onChange={(event) => setCreateDraft((current) => (current ? { ...current, name: event.target.value } : current))}
						placeholder={t("web.fileNamePlaceholder")}
						aria-label={t("web.fileName")}
						autoFocus
						disabled={busy}
						onKeyDown={(event) => (event.key === "Enter" ? submitCreate() : undefined)}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setCreateDraft(null)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={busy || !createDraft?.name.trim()} onClick={submitCreate}>
							{busy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{busy ? t("web.creating") : t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={renameDraft != null} onOpenChange={(open) => (!open ? setRenameDraft(null) : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("common.rename")}</DialogTitle>
					</DialogHeader>
					<Input
						value={renameDraft?.newName ?? ""}
						onChange={(event) => setRenameDraft((current) => (current ? { ...current, newName: event.target.value } : current))}
						placeholder={t("web.fileNamePlaceholder")}
						aria-label={t("web.fileName")}
						autoFocus
						disabled={busy}
						onKeyDown={(event) => (event.key === "Enter" ? submitRename() : undefined)}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setRenameDraft(null)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={busy || !renameDraft?.newName.trim()} onClick={submitRename}>
							{busy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{busy ? t("web.renaming") : t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={deleteTarget != null} onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.deleteEntryTitle", { name: deleteTarget?.name ?? "" })}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.deleteEntryBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction className="bg-danger text-danger-foreground hover:bg-danger/90" disabled={busy} onClick={confirmDelete}>
							{busy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{busy ? t("web.deleting") : t("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
