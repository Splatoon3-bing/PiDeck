/**
 * WebFileEditor — Web 端的项目内文本编辑器（全屏预览的编辑态）。
 *
 * 安全/正确性边界：
 * - 只在项目内相对路径上启用（父组件已排除项目外/二进制/超大/截断文件）；
 * - 保存带 expectedMtimeMs；磁盘被外部改动时服务端回 409，先让用户选择
 *   「重新加载」或「仍然覆盖」，不静默丢别人的改动；
 * - Ctrl/Cmd+S 保存；有未保存内容时关页/刷新由 beforeunload 拦一次。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebFileWriteError, writeProjectFile } from "./webApi";

export function WebFileEditor(props: { projectId: string; path: string; initialContent: string; initialMtimeMs?: number; onSaved: (content: string, mtimeMs: number) => void; onCancel: () => void; onReload: () => void }) {
	const [content, setContent] = useState(props.initialContent);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [conflict, setConflict] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dirty = content !== props.initialContent;

	// 外部重新加载（父组件拿到新内容）时同步编辑器基线。
	useEffect(() => {
		setContent(props.initialContent);
		setConflict(false);
		setError(null);
	}, [props.initialContent]);

	useEffect(() => {
		if (!dirty) return;
		const handler = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	const save = async (force = false) => {
		if (saving) return;
		setSaving(true);
		setError(null);
		try {
			const result = await writeProjectFile(props.projectId, props.path, content, { expectedMtimeMs: props.initialMtimeMs, force });
			setSaved(true);
			setConflict(false);
			window.setTimeout(() => setSaved(false), 1600);
			props.onSaved(content, result.mtimeMs);
		} catch (saveError) {
			if (saveError instanceof WebFileWriteError && saveError.code === "webError.fileChanged") {
				setConflict(true);
			} else {
				setError(saveError instanceof Error ? saveError.message : String(saveError));
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-2 py-1.5">
				<span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
					{props.path}
					{dirty ? <span className="ml-1.5 text-warning">●</span> : null}
				</span>
				{saved ? <span className="shrink-0 text-micro text-success">{t("web.fileSaved")}</span> : null}
				<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-caption" onClick={props.onCancel}>
					{t("web.fileCancelEdit")}
				</Button>
				<Button type="button" size="sm" className="h-7 shrink-0 gap-1 px-2.5 text-caption" disabled={saving || !dirty} onClick={() => void save()}>
					{saving ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <Save className="size-3.5" aria-hidden="true" />}
					{saving ? t("web.fileSaving") : t("web.fileSave")}
				</Button>
			</div>

			{conflict ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-caption text-warning" role="alert">
					<span className="min-w-0 flex-1">{t("web.fileChangedOnDisk")}</span>
					<Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2 text-caption" onClick={props.onReload}>
						<RotateCcw className="size-3.5" aria-hidden="true" />
						{t("web.fileReload")}
					</Button>
					<Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2 text-caption" onClick={() => void save(true)}>
						{t("web.fileOverwrite")}
					</Button>
				</div>
			) : null}
			{error ? (
				<div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-caption text-danger" role="alert">
					{error}
				</div>
			) : null}

			<Textarea
				value={content}
				onChange={(event) => setContent(event.target.value)}
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
						event.preventDefault();
						void save();
					}
					if (event.key === "Escape" && !dirty) props.onCancel();
				}}
				className={cn("min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-caption leading-relaxed shadow-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0")}
				aria-label={t("web.fileSave")}
				spellCheck={false}
				autoFocus
			/>
		</div>
	);
}
