/**
 * WebGitBranchBar — Git 面板顶栏：当前分支下拉（切换/新建）+ fetch + 刷新 + 变更计数。
 *
 * 从 `WebGitPanel` 拆出来（422 行 → 目标 <400）：这里只有分支相关 UI，
 * 状态仍由父级持有（脏工作区 409 的二次确认与错误提示在父级，避免两处状态分叉）。
 */
import { Check, ChevronDown, Download, GitBranch, Loader2, Plus, RefreshCw } from "lucide-react";
import type { GitBranchInfo } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function WebGitBranchBar(props: {
	branch: GitBranchInfo | null;
	changes: number;
	busy: boolean;
	loading: boolean;
	newBranchOpen: boolean;
	newBranchName: string;
	onNewBranchOpenChange: (open: boolean) => void;
	onNewBranchNameChange: (name: string) => void;
	onCheckout: (branch: string, create: boolean) => void;
	onFetch: () => void;
	onRefresh: () => void;
}) {
	return (
		<>
			<div className="flex min-w-0 items-center gap-1.5 text-caption text-foreground">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button type="button" className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/60 disabled:opacity-60" aria-label={t("web.gitSwitchBranch")} title={t("web.gitSwitchBranch")} disabled={props.busy || !props.branch}>
							<GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="min-w-0 max-w-40 truncate font-medium">{props.branch?.current ?? "—"}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
						{(props.branch?.branches ?? []).map((name) => (
							<DropdownMenuItem key={name} onSelect={() => props.onCheckout(name, false)}>
								{name === props.branch?.current ? <Check className="size-4" aria-hidden="true" /> : <span className="size-4" aria-hidden="true" />}
								<span className="truncate">{name}</span>
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => {
								props.onNewBranchNameChange("");
								props.onNewBranchOpenChange(true);
							}}
						>
							<Plus className="size-4" aria-hidden="true" />
							{t("web.gitNewBranch")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<span className="shrink-0 text-muted-foreground">· {t("web.gitChanges", { count: props.changes })}</span>
				<Button type="button" variant="ghost" size="icon" className="ml-auto size-7 shrink-0 text-muted-foreground" onClick={props.onFetch} aria-label={t("web.gitFetch")} title={t("web.gitFetch")} disabled={props.loading || props.busy}>
					<Download className={cn("size-3.5", props.busy && "animate-pulse")} aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" onClick={props.onRefresh} aria-label={t("web.gitRefresh")} title={t("web.gitRefresh")} disabled={props.loading}>
					<RefreshCw className={cn("size-3.5", props.loading && "animate-pideck-spin")} aria-hidden="true" />
				</Button>
			</div>

			<Dialog open={props.newBranchOpen} onOpenChange={(open) => (!open ? props.onNewBranchOpenChange(false) : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("web.gitNewBranch")}</DialogTitle>
					</DialogHeader>
					<Input
						value={props.newBranchName}
						onChange={(event) => props.onNewBranchNameChange(event.target.value)}
						placeholder={t("web.gitBranchPlaceholder")}
						aria-label={t("web.gitBranchName")}
						autoFocus
						disabled={props.busy}
						onKeyDown={(event) => {
							if (event.key === "Enter" && props.newBranchName.trim()) props.onCheckout(props.newBranchName.trim(), true);
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" disabled={props.busy} onClick={() => props.onNewBranchOpenChange(false)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={props.busy || !props.newBranchName.trim()} onClick={() => props.onCheckout(props.newBranchName.trim(), true)}>
							{props.busy ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
