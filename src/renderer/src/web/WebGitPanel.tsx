/**
 * WebGitPanel — Web 工作区抽屉的 Git 面板（与桌面 GitDrawer 相同的只读 + 最小写入面）。
 *
 * 能力边界（刻意收窄，不追求全对齐）：
 * - 只读：分支、变更分组、文件 diff、最近提交；
 * - 写入：stage / unstage / commit。discard / reset / push / pull 不在 Web 暴露——
 *   前两者不可逆，后两者是联网 + 凭据动作，误触代价远高于补齐入口的收益。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Download, GitBranch, Loader2, Minus, Plus, RefreshCw } from "lucide-react";
import type { CommitEntry, GitBranchInfo, GitResourceGroups } from "../../../shared/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import { Input } from "@/components/ui-shadcn/input";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebGitOperationError, checkoutGitBranch, commitGit, fetchGitDiff, fetchGitLog, fetchGitRemote, fetchGitStatus, stageGitFiles, unstageGitFiles } from "./webApi";

type GroupKey = "merge" | "index" | "workingTree" | "untracked";
type DiffPayload = { originalContent: string; modifiedContent: string } | null;

const GROUP_ORDER: Array<{ key: GroupKey; label: () => string; writable: boolean }> = [
	{ key: "merge", label: () => t("git.mergeChanges"), writable: false },
	{ key: "index", label: () => t("git.stagedChanges"), writable: false },
	{ key: "workingTree", label: () => t("git.changes"), writable: true },
	{ key: "untracked", label: () => t("web.gitUntracked"), writable: true },
];

function commitDateLabel(authorDate: number): string {
	if (!Number.isFinite(authorDate) || authorDate <= 0) return "";
	return new Date(authorDate).toLocaleDateString();
}

export function WebGitPanel(props: { projectId: string; active: boolean; onChanged?: () => void }) {
	const [loading, setLoading] = useState(false);
	const [branch, setBranch] = useState<GitBranchInfo | null>(null);
	const [groups, setGroups] = useState<GitResourceGroups | null>(null);
	const [commits, setCommits] = useState<CommitEntry[]>([]);
	const [noRepo, setNoRepo] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busyPaths, setBusyPaths] = useState<ReadonlySet<string>>(new Set());
	const [commitMessage, setCommitMessage] = useState("");
	const [committing, setCommitting] = useState(false);
	const [diff, setDiff] = useState<{ group: GroupKey; path: string; loading: boolean; data: DiffPayload } | null>(null);
	const [branchBusy, setBranchBusy] = useState(false);
	const [branchError, setBranchError] = useState<string | null>(null);
	const [pendingCheckout, setPendingCheckout] = useState<{ branch: string; create: boolean } | null>(null);
	const [newBranchOpen, setNewBranchOpen] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const status = await fetchGitStatus(props.projectId);
			if (!status.repo) {
				setNoRepo(true);
				setBranch(null);
				setGroups(null);
				setCommits([]);
				return;
			}
			setNoRepo(false);
			setBranch(status.branch);
			setGroups(status.groups);
			setCommits(await fetchGitLog(props.projectId, 12));
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	}, [props.projectId]);

	useEffect(() => {
		if (props.active) void load();
	}, [props.active, load]);

	const totalChanges = useMemo(() => (groups ? groups.merge.length + groups.index.length + groups.workingTree.length + groups.untracked.length : 0), [groups]);

	const runMutation = async (key: string, action: () => Promise<void>, doneNotice: string) => {
		if (busyPaths.has(key)) return;
		setBusyPaths((current) => new Set(current).add(key));
		setError(null);
		setNotice(null);
		try {
			await action();
			setDiff(null);
			setNotice(doneNotice);
			await load();
			props.onChanged?.();
		} catch (mutationError) {
			setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
		} finally {
			setBusyPaths((current) => {
				const next = new Set(current);
				next.delete(key);
				return next;
			});
		}
	};

	const stage = (paths: string[]) => runMutation(`stage:${paths.join("|")}`, () => stageGitFiles(props.projectId, paths), t("git.stage"));
	const unstage = (paths: string[]) => runMutation(`unstage:${paths.join("|")}`, () => unstageGitFiles(props.projectId, paths), t("git.unstage"));

	const submitCommit = async () => {
		const message = commitMessage.trim();
		if (!message || committing || !groups || groups.index.length === 0) return;
		setCommitting(true);
		setError(null);
		setNotice(null);
		try {
			await commitGit(props.projectId, message);
			setCommitMessage("");
			setDiff(null);
			setNotice(t("web.gitCommitDone"));
			await load();
			props.onChanged?.();
		} catch (commitError) {
			setError(commitError instanceof Error ? commitError.message : String(commitError));
		} finally {
			setCommitting(false);
		}
	};

	/** 切换/新建分支：脏工作区回 409，弹二次确认后带 force 重试。 */
	const runCheckout = async (branchName: string, create: boolean, force = false) => {
		if (branchBusy) return;
		setBranchBusy(true);
		setBranchError(null);
		setNotice(null);
		try {
			const info = await checkoutGitBranch(props.projectId, branchName, { create, force });
			setBranch(info);
			setPendingCheckout(null);
			setNewBranchOpen(false);
			setNewBranchName("");
			setNotice(create ? t("web.gitBranchCreated") : t("web.gitBranchSwitched"));
			await load();
		} catch (checkoutError) {
			if (checkoutError instanceof WebGitOperationError && checkoutError.code === "webError.gitDirtyWorktree") {
				setPendingCheckout({ branch: branchName, create });
			} else if (checkoutError instanceof WebGitOperationError && checkoutError.code === "webError.gitBranchNotFound") {
				setBranchError(t("web.gitBranchNotFound"));
			} else if (checkoutError instanceof WebGitOperationError && checkoutError.code === "webError.invalidRequest") {
				setBranchError(t("web.gitInvalidBranch"));
			} else {
				setBranchError(checkoutError instanceof Error ? checkoutError.message : String(checkoutError));
			}
		} finally {
			setBranchBusy(false);
		}
	};

	const runFetch = async () => {
		if (branchBusy) return;
		setBranchBusy(true);
		setBranchError(null);
		setNotice(null);
		try {
			await fetchGitRemote(props.projectId);
			setNotice(t("web.gitFetchDone"));
			await load();
		} catch (fetchError) {
			setBranchError(fetchError instanceof Error ? fetchError.message : String(fetchError));
		} finally {
			setBranchBusy(false);
		}
	};

	const openDiff = async (group: GroupKey, path: string) => {
		if (diff?.path === path && diff.group === group) {
			setDiff(null);
			return;
		}
		setDiff({ group, path, loading: true, data: null });
		try {
			const data = await fetchGitDiff(props.projectId, group, path);
			setDiff({ group, path, loading: false, data });
		} catch {
			setDiff({ group, path, loading: false, data: null });
		}
	};

	if (loading && !groups && !noRepo) {
		return (
			<div className="flex items-center justify-center gap-2 py-10 text-caption text-muted-foreground">
				<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
			</div>
		);
	}
	if (noRepo) return <div className="py-10 text-center text-caption text-muted-foreground">{t("web.gitNoRepo")}</div>;

	return (
		<div className="flex flex-col gap-3">
			<div className="flex min-w-0 items-center gap-1.5 text-caption text-foreground">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button type="button" className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-60" aria-label={t("web.gitSwitchBranch")} title={t("web.gitSwitchBranch")} disabled={branchBusy || !branch}>
							<GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="min-w-0 max-w-40 truncate font-medium">{branch?.current ?? "—"}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
						{(branch?.branches ?? []).map((name) => (
							<DropdownMenuItem key={name} onSelect={() => void runCheckout(name, false)}>
								{name === branch?.current ? <Check className="size-4" aria-hidden="true" /> : <span className="size-4" aria-hidden="true" />}
								<span className="truncate">{name}</span>
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => {
								setNewBranchName("");
								setNewBranchOpen(true);
							}}
						>
							<Plus className="size-4" aria-hidden="true" />
							{t("web.gitNewBranch")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<span className="shrink-0 text-muted-foreground">· {t("web.gitChanges", { count: totalChanges })}</span>
				<Button type="button" variant="ghost" size="icon" className="ml-auto size-7 shrink-0 text-muted-foreground" onClick={() => void runFetch()} aria-label={t("web.gitFetch")} title={t("web.gitFetch")} disabled={loading || branchBusy}>
					<Download className={cn("size-3.5", branchBusy && "animate-pulse")} aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={() => void load()} aria-label={t("web.gitRefresh")} title={t("web.gitRefresh")} disabled={loading}>
					<RefreshCw className={cn("size-3.5", loading && "animate-pideck-spin")} aria-hidden="true" />
				</Button>
			</div>

			{error || branchError ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-caption text-danger" role="alert">
					{branchError ?? error}
				</div>
			) : null}
			{notice ? (
				<div className="flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-caption text-success" role="status">
					<Check className="size-3.5 shrink-0" aria-hidden="true" />
					{notice}
				</div>
			) : null}

			{/* 提交区：暂存区为空时明确告诉用户先点 +，不把按钮禁用当成“坏了” */}
			<section className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2">
				<Textarea
					value={commitMessage}
					onChange={(event) => setCommitMessage(event.target.value)}
					onKeyDown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
							event.preventDefault();
							void submitCommit();
						}
					}}
					placeholder={t("git.commitPlaceholder", { branch: branch?.current ?? "HEAD" })}
					className="min-h-16 resize-none text-caption"
					aria-label={t("git.commit")}
					spellCheck={false}
				/>
				<div className="flex items-center gap-1.5">
					{groups && groups.index.length === 0 ? <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{t("git.stageBeforeCommit")}</span> : <span className="min-w-0 flex-1 text-micro text-muted-foreground">{t("web.gitStagedCount", { count: groups?.index.length ?? 0 })}</span>}
					<Button type="button" size="sm" className="h-8 shrink-0 gap-1 px-2.5 text-caption" disabled={committing || !commitMessage.trim() || !groups || groups.index.length === 0} onClick={() => void submitCommit()}>
						{committing ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
						{committing ? t("git.committing") : t("git.commit")}
					</Button>
				</div>
			</section>

			{groups && totalChanges === 0 ? <div className="py-4 text-center text-caption text-muted-foreground">{t("web.gitClean")}</div> : null}

			{groups
				? GROUP_ORDER.map(({ key, label, writable }) => {
						const resources = groups[key];
						if (resources.length === 0) return null;
						const stageAllPaths = key === "workingTree" ? [...groups.workingTree, ...groups.untracked].map((resource) => resource.path) : resources.map((resource) => resource.path);
						return (
							<section key={key}>
								<div className="mb-1.5 flex items-center gap-1.5">
									<h4 className="min-w-0 flex-1 truncate text-caption font-medium text-foreground">
										{label()} <span className="text-muted-foreground">({resources.length})</span>
									</h4>
									{writable ? (
										<Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" disabled={busyPaths.has(`stage:${stageAllPaths.join("|")}`)} onClick={() => void stage(stageAllPaths)} aria-label={t("git.stageAll")} title={t("git.stageAll")}>
											<Plus className="size-3.5" aria-hidden="true" />
										</Button>
									) : key === "index" ? (
										<Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground" disabled={busyPaths.has(`unstage:${stageAllPaths.join("|")}`)} onClick={() => void unstage(stageAllPaths)} aria-label={t("git.unstageAll")} title={t("git.unstageAll")}>
											<Minus className="size-3.5" aria-hidden="true" />
										</Button>
									) : null}
								</div>
								<ul className="flex flex-col gap-0.5">
									{resources.slice(0, 80).map((resource) => {
										const busyKey = `${writable ? "stage" : "unstage"}:${resource.path}`;
										const busy = busyPaths.has(busyKey);
										return (
											<li key={`${resource.path}:${resource.letter}`}>
												<div className={cn("flex items-center gap-1 rounded-md transition-colors hover:bg-muted/60", diff?.path === resource.path && diff.group === key && "bg-muted")}>
													<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-caption" onClick={() => void openDiff(key, resource.path)}>
														<code className={cn("w-4 shrink-0 text-center text-micro font-semibold", resource.letter === "D" ? "text-danger" : resource.letter === "A" ? "text-success" : "text-warning")}>{resource.letter}</code>
														<span className="min-w-0 flex-1 truncate text-foreground">{resource.path.split(/[\\/]/).pop()}</span>
														<span className="max-w-28 shrink-0 truncate text-micro text-muted-foreground">{resource.path}</span>
													</button>
													<button
														type="button"
														className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
														disabled={busy}
														aria-label={writable ? t("git.stage") : t("git.unstage")}
														title={writable ? t("git.stage") : t("git.unstage")}
														onClick={() => (writable ? void stage([resource.path]) : void unstage([resource.path]))}
													>
														{busy ? <Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" /> : writable ? <Plus className="size-3.5" aria-hidden="true" /> : <Minus className="size-3.5" aria-hidden="true" />}
													</button>
												</div>
												{diff?.path === resource.path && diff.group === key ? (
													<div className="mt-1 grid gap-1.5 rounded-md border border-border bg-card p-2">
														{diff.loading ? (
															<div className="flex items-center gap-1.5 text-micro text-muted-foreground">
																<Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" />
															</div>
														) : diff.data ? (
															<>
																<div>
																	<div className="mb-0.5 text-micro text-muted-foreground">{t("web.diffOriginal")}</div>
																	<pre className="max-h-56 overflow-auto rounded bg-muted/50 p-1.5 text-micro leading-relaxed whitespace-pre-wrap">{diff.data.originalContent || "—"}</pre>
																</div>
																<div>
																	<div className="mb-0.5 text-micro text-muted-foreground">{t("web.diffModified")}</div>
																	<pre className="max-h-56 overflow-auto rounded bg-muted/50 p-1.5 text-micro leading-relaxed whitespace-pre-wrap">{diff.data.modifiedContent || "—"}</pre>
																</div>
															</>
														) : (
															<div className="text-micro text-muted-foreground">{t("web.diffUnavailableHint")}</div>
														)}
													</div>
												) : null}
											</li>
										);
									})}
								</ul>
							</section>
						);
					})
				: null}

			{commits.length > 0 ? (
				<section>
					<h4 className="mb-1.5 text-caption font-medium text-foreground">{t("web.gitHistory")}</h4>
					<ul className="flex flex-col gap-1">
						{commits.map((commit) => (
							<li key={commit.hash} className="rounded-md border border-border bg-card px-2 py-1.5">
								<div className="flex items-baseline gap-1.5">
									<code className="shrink-0 text-micro text-primary">{commit.shortHash}</code>
									<span className="min-w-0 flex-1 truncate text-caption text-foreground">{commit.message}</span>
								</div>
								<div className="text-micro text-muted-foreground">
									{commit.authorName} · {commitDateLabel(commit.authorDate)}
								</div>
							</li>
						))}
					</ul>
				</section>
			) : null}

			<Dialog open={newBranchOpen} onOpenChange={(open) => (!open ? setNewBranchOpen(false) : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("web.gitNewBranch")}</DialogTitle>
					</DialogHeader>
					<Input
						value={newBranchName}
						onChange={(event) => setNewBranchName(event.target.value)}
						placeholder={t("web.gitBranchPlaceholder")}
						aria-label={t("web.gitBranchName")}
						autoFocus
						disabled={branchBusy}
						onKeyDown={(event) => {
							if (event.key === "Enter" && newBranchName.trim()) void runCheckout(newBranchName.trim(), true);
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" disabled={branchBusy} onClick={() => setNewBranchOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={branchBusy || !newBranchName.trim()} onClick={() => void runCheckout(newBranchName.trim(), true)}>
							{branchBusy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={pendingCheckout != null} onOpenChange={(open) => (!open ? setPendingCheckout(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.gitDirtyTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.gitDirtyBody", { branch: pendingCheckout?.branch ?? "" })}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={branchBusy}>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							className="bg-danger text-danger-foreground hover:bg-danger/90"
							disabled={branchBusy}
							onClick={() => {
								const pending = pendingCheckout;
								setPendingCheckout(null);
								if (pending) void runCheckout(pending.branch, pending.create, true);
							}}
						>
							{branchBusy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{t("web.gitDirtyConfirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
