/**
 * WebAutomationPanel — 工作区抽屉的「自动化」面板（T8 S2）
 *
 * 只做展示与编辑：所有读写走 /api/automations（白名单投影 + 项目归属校验 + busy/404 映射），
 * 调度与运行完全复用主进程 AutomationStore / AutomationRunCoordinator。
 * 运行是真实会话（会消耗额度），必须二次确认；历史只展示最近 20 条并按项目过滤。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import type { AutomationRunStatus, WebAutomationRun, WebAutomationSnapshot, WebAutomationTask } from "../../../shared/types";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { Switch } from "@/components/ui-shadcn/switch";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebAutomationError, abortWebAutomation, clearWebAutomationRuns, createWebAutomation, deleteWebAutomation, fetchAutomationSnapshot, previewWebAutomationCron, runWebAutomation, updateWebAutomation } from "./webApi";

const POLL_MS = 8000;
const MAX_HISTORY = 20;
const ACTIVE_STATUSES: ReadonlySet<AutomationRunStatus> = new Set(["queued", "starting", "running"]);

type Draft = {
	id?: string;
	name: string;
	prompt: string;
	scheduleType: "manual" | "cron";
	cron: string;
	backend: "pi" | "dsh" | "acp";
	mode: "normal" | "plan" | "goal";
	enabled: boolean;
};

function emptyDraft(): Draft {
	return { name: "", prompt: "", scheduleType: "manual", cron: "", backend: "pi", mode: "normal", enabled: true };
}

function draftFromTask(task: WebAutomationTask): Draft {
	return {
		id: task.id,
		name: task.name,
		prompt: task.prompt,
		scheduleType: task.schedule.type === "cron" ? "cron" : "manual",
		cron: task.schedule.type === "cron" ? task.schedule.expression : "",
		backend: task.backend === "dsh" ? "dsh" : task.backend === "acp" ? "acp" : "pi",
		mode: task.mode === "plan" ? "plan" : task.mode === "goal" ? "goal" : "normal",
		enabled: task.enabled,
	};
}

function scheduleLabel(task: WebAutomationTask): string {
	if (task.schedule.type === "manual") return t("web.automationScheduleManual");
	return task.schedule.expression;
}

function formatTime(value: number | undefined): string {
	if (!value) return "—";
	return new Date(value).toLocaleString();
}

function statusLabel(status: AutomationRunStatus): string {
	const key = `web.automationStatus_${status}` as const;
	return t(key);
}

function errorMessage(error: unknown): string {
	if (error instanceof WebAutomationError) {
		if (error.code === "webError.automationBusy") return t("web.automationBusy");
		if (error.code === "webError.automationNotFound") return t("web.automationNotFound");
		if (error.code === "webError.invalidAutomation") return error.field ? `${error.message} (${error.field})` : error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export function WebAutomationPanel(props: { projectId: string; active: boolean }) {
	const [snapshot, setSnapshot] = useState<WebAutomationSnapshot | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const [runTarget, setRunTarget] = useState<WebAutomationTask | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<WebAutomationTask | null>(null);
	const [cronPreview, setCronPreview] = useState<{ valid: boolean; next?: number; error?: string } | null>(null);
	const previewSeq = useRef(0);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const next = await fetchAutomationSnapshot();
			setSnapshot(next);
			setError(null);
		} catch (loadError) {
			setError(errorMessage(loadError));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!props.active) return;
		void load();
		const timer = window.setInterval(() => {
			if (!document.hidden) void load();
		}, POLL_MS);
		return () => window.clearInterval(timer);
	}, [props.active, load]);

	// cron 预览（防抖）：输入过程中不每键打后端。
	useEffect(() => {
		if (!draft || draft.scheduleType !== "cron" || !draft.cron.trim()) {
			setCronPreview(null);
			return;
		}
		const seq = ++previewSeq.current;
		const timer = window.setTimeout(() => {
			void previewWebAutomationCron(draft.cron.trim())
				.then((result) => {
					if (previewSeq.current !== seq) return;
					setCronPreview(result.valid ? { valid: true, next: result.nextRuns[0] } : { valid: false, error: result.error });
				})
				.catch(() => {
					if (previewSeq.current === seq) setCronPreview(null);
				});
		}, 300);
		return () => window.clearTimeout(timer);
	}, [draft]);

	const tasks = snapshot ? snapshot.tasks.filter((task) => task.projectId === props.projectId) : [];
	const runs = snapshot ? snapshot.runs.filter((run) => run.projectId === props.projectId).slice(0, MAX_HISTORY) : [];
	const activeRunFor = (taskId: string) => runs.find((run) => run.taskId === taskId && ACTIVE_STATUSES.has(run.status));

	const runAction = async (task: WebAutomationTask, key: string, action: () => Promise<unknown>) => {
		setBusyKey(key);
		setError(null);
		try {
			await action();
			await load();
		} catch (actionError) {
			setError(errorMessage(actionError));
		} finally {
			setBusyKey(null);
		}
	};

	const saveDraft = async () => {
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			const base = {
				name: draft.name.trim(),
				prompt: draft.prompt,
				schedule: draft.scheduleType === "cron" ? { type: "cron" as const, expression: draft.cron.trim() } : { type: "manual" as const },
				enabled: draft.enabled,
				backend: draft.backend,
				mode: draft.mode,
			};
			if (draft.id) await updateWebAutomation(draft.id, base);
			else await createWebAutomation({ ...base, projectId: props.projectId });
			setDraft(null);
			await load();
		} catch (saveError) {
			setError(errorMessage(saveError));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-col gap-2" data-testid="web-automation-panel">
			<div className="flex items-center gap-1.5">
				<span className="min-w-0 flex-1 truncate text-caption text-text-tertiary">{t("web.automationHint")}</span>
				{loading ? <Loader2 className="size-3.5 animate-pideck-spin text-text-tertiary" aria-hidden="true" /> : null}
				<Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1 px-2 text-caption" onClick={() => setDraft(emptyDraft())}>
					<Plus className="size-3.5" aria-hidden="true" />
					{t("web.automationNew")}
				</Button>
			</div>

			{error ? (
				<div className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-micro text-danger" role="alert">
					{error}
				</div>
			) : null}

			<ul className="flex flex-col gap-1.5" data-testid="web-automation-list">
				{tasks.length === 0 && !loading ? <li className="py-6 text-center text-caption text-text-tertiary">{t("web.automationEmpty")}</li> : null}
				{tasks.map((task) => {
					const running = activeRunFor(task.id);
					return (
						<li key={task.id} className="rounded-md border border-border-subtle bg-bg-panel px-2 py-1.5">
							<div className="flex items-center gap-1.5">
								<CalendarClock className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate text-caption font-medium text-foreground" title={task.name}>
									{task.name}
								</span>
								<Switch checked={task.enabled} aria-label={t("web.automationEnabled")} disabled={busyKey === `toggle:${task.id}`} onCheckedChange={(checked) => void runAction(task, `toggle:${task.id}`, () => updateWebAutomation(task.id, { enabled: checked }))} />
							</div>
							<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-text-tertiary">
								<span>{scheduleLabel(task)}</span>
								<span>
									{t("web.automationNextRun")}: {formatTime(task.nextRunAt)}
								</span>
								{task.mode && task.mode !== "normal" ? <span>{t(task.mode === "plan" ? "web.automationModePlan" : "web.automationModeGoal")}</span> : null}
							</div>
							<div className="mt-1 flex items-center gap-1">
								{running ? (
									<Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-2 text-micro" disabled={busyKey === `abort:${running.id}`} onClick={() => void runAction(task, `abort:${running.id}`, () => abortWebAutomation(running.id))}>
										<Square className="size-3" aria-hidden="true" />
										{t("web.automationAbort")}
									</Button>
								) : (
									<Button type="button" size="sm" variant="outline" className="h-6 gap-1 px-2 text-micro" disabled={busyKey === `run:${task.id}`} onClick={() => setRunTarget(task)}>
										<Play className="size-3" aria-hidden="true" />
										{t("web.automationRun")}
									</Button>
								)}
								<Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-micro" onClick={() => setDraft(draftFromTask(task))}>
									<Pencil className="size-3" aria-hidden="true" />
									{t("web.automationEdit")}
								</Button>
								<Button type="button" size="sm" variant="ghost" className="ml-auto h-6 gap-1 px-2 text-micro text-danger" onClick={() => setDeleteTarget(task)}>
									<Trash2 className="size-3" aria-hidden="true" />
									{t("web.automationDelete")}
								</Button>
							</div>
						</li>
					);
				})}
			</ul>

			<section className="min-h-0 flex-1 overflow-y-auto">
				<div className="flex items-center gap-1.5">
					<h4 className="min-w-0 flex-1 text-micro font-medium tracking-wide text-text-tertiary uppercase">{t("web.automationHistory")}</h4>
					<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-micro" disabled={busyKey === "clear"} onClick={() => void runAction(tasks[0] ?? ({ id: "" } as WebAutomationTask), "clear", () => clearWebAutomationRuns())}>
						{t("web.automationClearHistory")}
					</Button>
				</div>
				<ul className="mt-1 flex flex-col gap-1">
					{runs.length === 0 ? <li className="py-3 text-center text-micro text-text-tertiary">{t("web.automationNoRuns")}</li> : null}
					{runs.map((run) => (
						<li key={run.id} className="flex items-center gap-1.5 rounded border border-border-subtle px-2 py-1 text-micro">
							<span className={cn("shrink-0 rounded px-1 py-0.5", run.status === "succeeded" ? "bg-success-soft text-success" : run.status === "failed" ? "bg-danger/10 text-danger" : ACTIVE_STATUSES.has(run.status) ? "bg-primary-soft text-primary" : "bg-muted text-text-tertiary")}>{statusLabel(run.status)}</span>
							<span className="min-w-0 flex-1 truncate">{run.taskName}</span>
							<span className="shrink-0 text-text-tertiary">{formatTime(run.updatedAt)}</span>
						</li>
					))}
				</ul>
			</section>

			<Dialog open={draft !== null} onOpenChange={(open) => (!open ? setDraft(null) : undefined)}>
				<DialogContent className="flex max-h-[85dvh] flex-col gap-2 sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{draft?.id ? t("web.automationEdit") : t("web.automationNew")}</DialogTitle>
					</DialogHeader>
					{draft ? (
						<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
							<label className="text-micro text-text-tertiary" htmlFor="automation-name">
								{t("web.automationName")}
							</label>
							<Input id="automation-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
							<label className="text-micro text-text-tertiary" htmlFor="automation-prompt">
								{t("web.automationPrompt")}
							</label>
							<Textarea id="automation-prompt" className="min-h-24" value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
							<div className="flex items-center gap-2">
								<Select value={draft.scheduleType} onValueChange={(value) => setDraft({ ...draft, scheduleType: value as Draft["scheduleType"] })}>
									<SelectTrigger className="h-8 w-40 text-caption" aria-label={t("web.automationSchedule")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="manual">{t("web.automationScheduleManual")}</SelectItem>
										<SelectItem value="cron">{t("web.automationScheduleCron")}</SelectItem>
									</SelectContent>
								</Select>
								{draft.scheduleType === "cron" ? <Input className="h-8 flex-1 font-mono text-xs" value={draft.cron} placeholder="0 9 * * *" onChange={(event) => setDraft({ ...draft, cron: event.target.value })} /> : null}
							</div>
							{draft.scheduleType === "cron" && cronPreview ? <p className={cn("text-micro", cronPreview.valid ? "text-text-tertiary" : "text-danger")}>{cronPreview.valid ? `${t("web.automationNextRun")}: ${formatTime(cronPreview.next)}` : cronPreview.error}</p> : null}
							<div className="flex flex-wrap items-center gap-2">
								<Select value={draft.backend} onValueChange={(value) => setDraft({ ...draft, backend: value as Draft["backend"] })}>
									<SelectTrigger className="h-8 w-28 text-caption" aria-label={t("web.automationBackend")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="pi">Pi</SelectItem>
										<SelectItem value="dsh">DSH</SelectItem>
										<SelectItem value="acp">ACP</SelectItem>
									</SelectContent>
								</Select>
								<Select value={draft.mode} onValueChange={(value) => setDraft({ ...draft, mode: value as Draft["mode"] })}>
									<SelectTrigger className="h-8 w-32 text-caption" aria-label={t("web.automationMode")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="normal">{t("web.automationModeNormal")}</SelectItem>
										<SelectItem value="plan">{t("web.automationModePlan")}</SelectItem>
										<SelectItem value="goal">{t("web.automationModeGoal")}</SelectItem>
									</SelectContent>
								</Select>
								<label className="ml-auto flex items-center gap-1.5 text-caption">
									<Switch checked={draft.enabled} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} />
									{t("web.automationEnabled")}
								</label>
							</div>
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={saving || !draft?.name.trim() || !draft?.prompt.trim() || (draft?.scheduleType === "cron" && !draft.cron.trim())} onClick={() => void saveDraft()}>
							{saving ? <Loader2 className="mr-1 size-3.5 animate-pideck-spin" aria-hidden="true" /> : null}
							{t("common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={runTarget !== null} onOpenChange={(open) => (!open ? setRunTarget(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.automationRunConfirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.automationRunConfirmBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const target = runTarget;
								setRunTarget(null);
								if (target) void runAction(target, `run:${target.id}`, () => runWebAutomation(target.id));
							}}
						>
							{t("web.automationRun")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={deleteTarget !== null} onOpenChange={(open) => (!open ? setDeleteTarget(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.automationDeleteConfirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.automationDeleteConfirmBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							className="bg-danger text-danger-foreground hover:bg-danger/90"
							onClick={() => {
								const target = deleteTarget;
								setDeleteTarget(null);
								if (target) void runAction(target, `delete:${target.id}`, () => deleteWebAutomation(target.id));
							}}
						>
							{t("web.automationDelete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
