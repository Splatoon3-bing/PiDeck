/**
 * WebNotesPanel — Web 工作区抽屉的草稿本（与桌面 ScratchPad 同一份存储）。
 *
 * 与桌面语义一致：
 * - 作用域：有项目时用 project（列表含本项目 + 全局草稿），否则 global；
 * - 自动保存：输入后 1.2s 落盘，失焦/Ctrl+S 立即保存；没有草稿时首次输入才懒创建；
 * - 最后一份草稿不允许删除（与桌面一致，避免把草稿本清空成无入口状态）。
 *
 * 预览走 MarkdownStream（与消息正文同一渲染器），不在 Web 端另造 Markdown 管线。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, FilePlus, Loader2, Pencil, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { createScratchPadDraft, deleteScratchPadDraft, listScratchPadDrafts, loadScratchPadDraft, saveScratchPadDraft, type WebScratchPadDraft, type WebScratchPadScope } from "./webApi";

const AUTOSAVE_DELAY = 1200;

/**
 * 草稿唯一键：同一秒创建的项目草稿与全局草稿 id 可能相同（文件名按秒命名），
 * 只用 id 会在「项目列表合并全局草稿」时选中/删除错误的草稿。scope 前缀消歧。
 */
function draftKey(draft: WebScratchPadDraft): string {
	return `${draft.scope}/${draft.id}`;
}

export function WebNotesPanel(props: { projectId?: string; active: boolean }) {
	const scope: WebScratchPadScope = props.projectId ? "project" : "global";
	const [drafts, setDrafts] = useState<WebScratchPadDraft[]>([]);
	const [currentKey, setCurrentKey] = useState<string | null>(null);
	const [content, setContent] = useState("");
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<WebScratchPadDraft | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contentRef = useRef(content);
	contentRef.current = content;
	const currentDraftRef = useRef<WebScratchPadDraft | null>(null);
	// 卸载（切面板/关抽屉）时把未落盘内容补写一次：自动保存定时器会被清理，
	// 否则「打完字立刻切走」会丢最后 1.2s 的输入。
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const projectIdRef = useRef(props.projectId);
	projectIdRef.current = props.projectId;
	const currentDraft = useMemo(() => drafts.find((draft) => draftKey(draft) === currentKey) ?? null, [currentKey, drafts]);
	currentDraftRef.current = currentDraft;

	const loadDraft = useCallback(
		async (draft: WebScratchPadDraft) => {
			setLoading(true);
			setError(null);
			try {
				const data = await loadScratchPadDraft(draft.scope, draft.id, props.projectId);
				setCurrentKey(draftKey(draft));
				setContent(data.content);
				setDirty(false);
				setSavedAt(data.lastEditedAt || null);
			} catch (loadError) {
				setError(loadError instanceof Error ? loadError.message : String(loadError));
			} finally {
				setLoading(false);
			}
		},
		[props.projectId],
	);

	const refresh = useCallback(
		async (preferredKey?: string | null) => {
			setLoading(true);
			setError(null);
			try {
				const list = await listScratchPadDrafts(scope, props.projectId);
				setDrafts(list);
				const wanted = preferredKey ? list.find((draft) => draftKey(draft) === preferredKey) : undefined;
				// 项目作用域优先打开本项目草稿；否则取最近更新的一份。
				const preferred = wanted ?? (scope === "project" ? list.find((draft) => draft.scope === "project") : undefined) ?? list[0];
				if (!preferred) {
					setCurrentKey(null);
					setContent("");
					setDirty(false);
					setSavedAt(null);
					return;
				}
				await loadDraft(preferred);
			} catch (loadError) {
				setError(loadError instanceof Error ? loadError.message : String(loadError));
			} finally {
				setLoading(false);
			}
		},
		[loadDraft, props.projectId, scope],
	);

	useEffect(() => {
		if (!props.active) return;
		void refresh();
	}, [props.active, refresh]);

	// 卸载清扫：有未保存内容时 fire-and-forget 写回；没有草稿且已有输入则先懒创建。
	useEffect(
		() => () => {
			if (!dirtyRef.current) return;
			const value = contentRef.current;
			const draft = currentDraftRef.current;
			const projectId = projectIdRef.current;
			if (draft) {
				void saveScratchPadDraft(draft.scope, draft.id, value, projectId).catch(() => undefined);
				return;
			}
			if (!value) return;
			void createScratchPadDraft(scopeRef.current, projectId)
				.then((draft) => saveScratchPadDraft(draft.scope, draft.id, value, projectId))
				.catch(() => undefined);
		},
		[],
	);

	// 切项目时清掉旧草稿状态（refresh 会装新作用域的第一份）。
	useEffect(() => {
		setDrafts([]);
		setCurrentKey(null);
		setContent("");
		setDirty(false);
	}, [props.projectId]);

	useEffect(() => {
		if (!dirty) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			void saveNow();
		}, AUTOSAVE_DELAY);
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
		// saveNow 用 ref 读最新内容，不随每键重建定时器
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dirty, content]);

	const ensureDraft = useCallback(async (): Promise<WebScratchPadDraft | null> => {
		if (currentDraft) return currentDraft;
		if (!contentRef.current) return null;
		try {
			const created = await createScratchPadDraft(scope, props.projectId);
			setDrafts((current) => [created, ...current]);
			setCurrentKey(draftKey(created));
			return created;
		} catch (createError) {
			setError(createError instanceof Error ? createError.message : String(createError));
			return null;
		}
	}, [currentDraft, props.projectId, scope]);

	const saveNow = useCallback(async () => {
		if (saveTimerRef.current) {
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
		}
		const value = contentRef.current;
		const draft = currentDraft ?? (await ensureDraft());
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			const result = await saveScratchPadDraft(draft.scope, draft.id, value, props.projectId);
			setSavedAt(result.mtimeMs);
			setDirty(false);
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
		} finally {
			setSaving(false);
		}
	}, [currentDraft, ensureDraft, props.projectId]);

	const changeContent = (value: string) => {
		setContent(value);
		setDirty(true);
	};

	const createDraft = async () => {
		setError(null);
		try {
			if (dirty) await saveNow();
			const created = await createScratchPadDraft(scope, props.projectId);
			setDrafts((current) => [created, ...current]);
			setCurrentKey(draftKey(created));
			setContent("");
			setDirty(false);
			setSavedAt(created.updatedAt);
			setMode("edit");
		} catch (createError) {
			setError(createError instanceof Error ? createError.message : String(createError));
		}
	};

	const confirmDelete = async () => {
		const draft = pendingDelete;
		setPendingDelete(null);
		if (!draft) return;
		try {
			await deleteScratchPadDraft(draft.scope, draft.id, props.projectId);
			const remaining = drafts.filter((item) => draftKey(item) !== draftKey(draft));
			setDrafts(remaining);
			if (draftKey(draft) === currentKey) {
				if (remaining[0]) await loadDraft(remaining[0]);
				else {
					setCurrentKey(null);
					setContent("");
				}
			}
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	};

	const download = () => {
		const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${currentDraft?.name ?? "scratch-pad"}.md`;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		URL.revokeObjectURL(url);
	};

	const onEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void saveNow();
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-2">
			<div className="flex shrink-0 flex-wrap items-center gap-1.5">
				<Select
					value={currentKey ?? ""}
					onValueChange={(value) => {
						const next = drafts.find((draft) => draftKey(draft) === value);
						if (next) {
							void (async () => {
								if (dirty) await saveNow();
								await loadDraft(next);
							})();
						}
					}}
					disabled={drafts.length === 0}
				>
					<SelectTrigger className="h-8 min-w-0 flex-1 text-caption" aria-label={t("web.notesDraft")}>
						<SelectValue placeholder={t("web.notesNoDraft")} />
					</SelectTrigger>
					<SelectContent align="start">
						{drafts.map((draft) => (
							<SelectItem key={draftKey(draft)} value={draftKey(draft)}>
								{draft.name}
								{draft.scope === "global" ? ` · ${t("web.notesGlobal")}` : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" onClick={() => void createDraft()} aria-label={t("scratchPad.newDraft")} title={t("scratchPad.newDraft")}>
					<FilePlus className="size-4" aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" onClick={download} aria-label={t("scratchPad.export")} title={t("scratchPad.export")} disabled={!content}>
					<Download className="size-4" aria-hidden="true" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-8 shrink-0 text-muted-foreground hover:text-danger"
					onClick={() => (currentDraft ? setPendingDelete(currentDraft) : undefined)}
					aria-label={t("scratchPad.deleteDraft")}
					title={t("scratchPad.deleteDraft")}
					disabled={!currentDraft || drafts.length <= 1}
				>
					<Trash2 className="size-4" aria-hidden="true" />
				</Button>
				<div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
					<button type="button" className={cn("flex size-7 items-center justify-center rounded", mode === "edit" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")} aria-label={t("scratchPad.edit")} title={t("scratchPad.edit")} onClick={() => setMode("edit")}>
						<Pencil className="size-3.5" aria-hidden="true" />
					</button>
					<button type="button" className={cn("flex size-7 items-center justify-center rounded", mode === "preview" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")} aria-label={t("scratchPad.preview")} title={t("scratchPad.preview")} onClick={() => setMode("preview")}>
						<Eye className="size-3.5" aria-hidden="true" />
					</button>
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-1.5 text-micro text-muted-foreground" role="status">
				{saving ? <Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" /> : null}
				<span>{saving ? t("web.notesSaving") : dirty ? t("web.notesUnsaved") : savedAt ? t("web.notesSaved") : t("web.notesHint")}</span>
				{error ? (
					<span className="min-w-0 truncate text-danger" role="alert">
						{error}
					</span>
				) : null}
			</div>

			{loading ? (
				<div className="flex flex-1 items-center justify-center">
					<Loader2 className="size-4 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
				</div>
			) : mode === "edit" ? (
				<Textarea
					value={content}
					onChange={(event) => changeContent(event.target.value)}
					onBlur={() => void saveNow()}
					onKeyDown={onEditorKeyDown}
					placeholder={t("scratchPad.placeholder")}
					className="min-h-0 flex-1 resize-none rounded-md border-border font-mono text-caption leading-relaxed [field-sizing:fixed] focus-visible:border-border focus-visible:ring-0"
					aria-label={t("scratchPad.edit")}
					spellCheck={false}
				/>
			) : (
				/* scroll-ok: text —— Markdown 整篇交给 MarkdownStream，虚拟化会破坏标题/代码块语义。 */
				<div className="markdown-body min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card p-3 text-caption">
					{content.trim() ? <MarkdownStream text={content} onOpenExternal={(url: string) => window.open(url, "_blank", "noopener")} /> : <div className="py-8 text-center text-muted-foreground">{t("scratchPad.empty")}</div>}
				</div>
			)}

			<AlertDialog open={pendingDelete != null} onOpenChange={(open) => (!open ? setPendingDelete(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.notesDeleteTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.notesDeleteBody", { name: pendingDelete?.name ?? "" })}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction className="bg-danger text-danger-foreground hover:bg-danger/90" onClick={() => void confirmDelete()}>
							{t("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
