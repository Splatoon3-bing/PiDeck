/**
 * WebModelSelector — 模型选择（Composer 工具行驻留）。
 *
 * 交互：pill 触发器常驻（当前模型名 truncate），与思考 pill 并排；
 * 窄屏底部弹层（大触控行）、桌面锚定触发器的局部面板（WebPickerSurface）。
 *
 * 列表信息层级（2026-11 视觉返工）：每行两行式——首行模型名 + 能力徽标（推理/视觉，带语义色），
 * 次行 provider · id + 上下文窗口。行高 60px、行间 4px、分组标题留 14px 上间距：
 * 40+ 模型滚动时靠留白和分组断开，不再是一整片灰字。
 * 「最近使用」置顶（含当前模型），存 localStorage，不参与设置同步。
 *
 * provider 分组 + 本地过滤（触屏无 kbd 交互，不用 Command）；刷新绕缓存重拉；
 * 列表按窗口切片渲染（模型表动辄 300+ 条）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, RefreshCw, Search } from "lucide-react";
import type { AvailableModel, SessionModelPreference } from "../../../shared/types";
import { resolveModelDisplayName } from "../../../shared/modelDisplayName";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebPickerSurface } from "./WebPickerSurface";
import { buildModelGroups, formatContextWindow, modelCapabilityChips, modelKey, pushRecentModel, readRecentModels, writeRecentModels } from "./webModelPicker";

// 生图 / 生视频分类与桌面端共用同一套纯函数（各自的独立配置文件，不在 pi 目录里）。
import { buildImageGenModelGroups, buildVideoGenModelGroups, type MediaModelGroup } from "../components/session/sessionPickerOptions";
import type { WebMediaModels } from "../../../main/web/WebMediaModels";

/** 弹层行的扁平表示：分组标题与模型行混排，便于按窗口切片渲染。 */
type ModelSheetRow =
	| { kind: "group"; key: string; label: string }
	| { kind: "model"; key: string; item: AvailableModel }
	| { kind: "mediaGroup"; key: string; label: string; hint?: string }
	| { kind: "media"; key: string; providerId: string; providerLabel: string; modelId: string; capabilities: MediaModelGroup["models"][number]["capabilities"]; selectable: boolean };

/** 首屏渲染的行数（含分组标题）；模型表动辄 300+ 条，一次全渲染会造出上万像素的滚动容器。 */
const MODEL_ROW_WINDOW = 40;
/** 每次增量追加的行数。 */
const MODEL_ROW_STEP = 40;

/** 能力徽标配色：推理走思考身份色（靛紫），视觉走主题强调色，两个都在暗色下自带提亮档。 */
const CAPABILITY_CHIP_CLASS = {
	reasoning: "bg-[color-mix(in_srgb,var(--color-thinking)_14%,transparent)] text-[var(--color-thinking)]",
	vision: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)]",
	// 「不支持思考」是一条限制说明，用中性灰，不抢视觉。
	noThinking: "bg-muted text-muted-foreground",
} as const;

function ModelRow(props: { item: AvailableModel; active: boolean; onSelect: () => void }) {
	const name = resolveModelDisplayName(props.item.name, props.item.id);
	const chips = modelCapabilityChips(props.item, {
		reasoning: t("web.modelCapabilityReasoning"),
		vision: t("web.modelCapabilityVision"),
		thinking: (level) => t("app.modelCapabilityThinking", { level }),
		noThinking: t("app.modelCapabilityThinkingUnsupported"),
	});
	const context = formatContextWindow(props.item.contextWindow);
	return (
		<button
			type="button"
			data-testid="web-model-row"
			data-active={props.active ? "true" : undefined}
			aria-pressed={props.active}
			className={cn("group relative flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 pointer-coarse:min-h-14", props.active && "bg-muted/40")}
			onClick={props.onSelect}
		>
			{/* 选中态用左侧主色竖条：比整行铺色更克制，也不和 hover 抢视觉 */}
			<span aria-hidden="true" className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity", props.active ? "opacity-100" : "opacity-0")} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className={cn("min-w-0 truncate text-sm font-medium", props.active ? "text-primary" : "text-foreground")}>{name}</span>
					{chips.map((chip) => (
						<span key={chip.kind} className={cn("shrink-0 rounded px-1 py-px text-micro leading-4 font-medium", CAPABILITY_CHIP_CLASS[chip.kind])}>
							{chip.label}
						</span>
					))}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
					<span className="min-w-0 truncate">
						{props.item.provider} · {props.item.id}
					</span>
					{context ? <span className="shrink-0 font-mono tabular-nums text-muted-foreground/80">{context}</span> : null}
				</span>
			</span>
			{props.active ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
		</button>
	);
}

/** 把分组结果摊平成可切片的单行列表（组序由 buildModelGroups 决定，组内保持原序）。 */
/** 媒体模型行（生图可点、生视频只读）：两行式，副行是供应商名与能力标注。 */
function MediaRow(props: { row: Extract<ModelSheetRow, { kind: "media" }>; onSelect: () => void }) {
	const labels = props.row.capabilities.map((capability) => (capability === "textToVideo" ? t("app.mediaCapabilityTextToVideo") : t("app.mediaCapabilityTextToImage")));
	return (
		<button
			type="button"
			data-testid="web-media-model-row"
			data-selectable={props.row.selectable ? "true" : undefined}
			aria-disabled={props.row.selectable ? undefined : true}
			className={cn(
				"group relative flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors pointer-coarse:min-h-14",
				props.row.selectable ? "hover:bg-muted/60 focus-visible:bg-muted/60" : "cursor-default opacity-60",
			)}
			onClick={props.onSelect}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">{props.row.modelId}</span>
					{labels.map((label) => (
						<span key={label} className="shrink-0 rounded bg-[color-mix(in_srgb,var(--color-brand-green)_14%,transparent)] px-1 py-px text-micro leading-4 font-medium text-[var(--color-brand-green)]">
							{label}
						</span>
					))}
				</span>
				<span className="min-w-0 truncate text-micro text-muted-foreground">{props.row.providerLabel}</span>
			</span>
		</button>
	);
}

function flattenModelRows(groups: ReturnType<typeof buildModelGroups>): ModelSheetRow[] {
	const rows: ModelSheetRow[] = [];
	for (const group of groups) {
		rows.push({ kind: "group", key: `group:${group.key}`, label: group.label });
		for (const item of group.models) rows.push({ kind: "model", key: `${group.key}::${modelKey(item)}`, item });
	}
	return rows;
}

export function WebModelSelector(props: {
	model?: SessionModelPreference;
	models: AvailableModel[];
	refreshing?: boolean;
	onRefresh?: () => void;
	onChange: (model: AvailableModel) => void;
	/** 生图 / 生视频模型目录（独立配置文件）：作为独立分类列出，未加载时不展示这两类。 */
	mediaModels?: WebMediaModels | null;
	/** 选中生图模型：写回生图配置并切到生图后端（Web 端生视频仍不开放，只展示）。 */
	onPickImageModel?: (providerId: string, modelId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [rendered, setRendered] = useState(MODEL_ROW_WINDOW);
	const [recentKeys, setRecentKeys] = useState<string[]>(() => readRecentModels(typeof window === "undefined" ? undefined : window.localStorage));
	const sentinelRef = useRef<HTMLButtonElement | null>(null);
	const { model, models, onChange } = props;
	const currentKey = model ? modelKey({ provider: model.provider, id: model.modelId }) : null;
	const selectedName = model ? resolveModelDisplayName(model.modelName, model.modelId) : undefined;
	// pill 只显示模型名（provider 在弹层行内呈现），窄屏不挤
	const pillLabel = selectedName ?? t("web.model");

	// 弹层打开时按 query 过滤后按「最近使用 → provider」分组
	const groups = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		const filtered = keyword ? models.filter((item) => `${item.provider} ${item.name ?? ""} ${item.id}`.toLowerCase().includes(keyword)) : models;
		return buildModelGroups(filtered, recentKeys, currentKey, t("web.recentModels"));
	}, [models, query, recentKeys, currentKey]);

	const languageRows = useMemo(() => flattenModelRows(groups), [groups]);
	// 生图 / 生视频分类：与语言模型同一份过滤口径（按 query 过滤模型名/供应商），
	// 分类标题在搜索时保留——它们是「这些模型属于哪类」的唯一线索。
	const mediaRows = useMemo<ModelSheetRow[]>(() => {
		const keyword = query.trim().toLowerCase();
		const match = (text: string) => !keyword || text.toLowerCase().includes(keyword);
		const out: ModelSheetRow[] = [];
		const imageGroups = buildImageGenModelGroups(props.mediaModels?.imageGen);
		if (imageGroups.length > 0) {
			out.push({ kind: "group", key: "section:image", label: t("app.modelCategoryImageGen") });
			for (const group of imageGroups) {
				const models = group.models.filter((item) => match(`${item.id} ${group.providerLabel}`));
				if (models.length === 0) continue;
				out.push({ kind: "mediaGroup", key: `mediagroup:${group.id}`, label: group.providerLabel, ...(group.supportsReferenceImage ? { hint: t("app.mediaCapabilityReferenceImage") } : {}) });
				for (const item of models) {
					out.push({ kind: "media", key: `media:${group.id}:${item.id}`, providerId: group.providerId, providerLabel: group.providerLabel, modelId: item.id, capabilities: item.capabilities, selectable: Boolean(props.onPickImageModel) });
				}
			}
		}
		const videoGroups = buildVideoGenModelGroups(props.mediaModels?.videoGen);
		if (videoGroups.length > 0) {
			out.push({ kind: "group", key: "section:video", label: t("app.modelCategoryVideoGen") });
			for (const group of videoGroups) {
				const models = group.models.filter((item) => match(`${item.id} ${group.providerLabel}`));
				if (models.length === 0) continue;
				// 生视频只读：Web 端没有提交链路（长任务 + 事件流不在 Web 开放），如实标注而不是给一个点了没反应的入口。
				out.push({ kind: "mediaGroup", key: `mediagroup:${group.id}`, label: group.providerLabel, hint: t("web.mediaVideoUnsupported") });
				for (const item of models) {
					out.push({ kind: "media", key: `media:${group.id}:${item.id}`, providerId: group.providerId, providerLabel: group.providerLabel, modelId: item.id, capabilities: item.capabilities, selectable: false });
				}
			}
		}
		return out;
	}, [props.mediaModels, props.onPickImageModel, query]);
	const rows = useMemo(() => [...languageRows, ...mediaRows], [languageRows, mediaRows]);
	// 搜索词变化回到首屏窗口：结果集变小，保留旧窗口没有意义。
	useEffect(() => setRendered(MODEL_ROW_WINDOW), [query]);
	const visibleRows = rows.slice(0, Math.min(rendered, rows.length));
	const hiddenCount = rows.length - visibleRows.length;
	// 滚动到哨兵就补一页；哨兵同时是「更多」按钮，IntersectionObserver 不可用时仍可手动加载。
	useEffect(() => {
		if (hiddenCount <= 0) return;
		const sentinel = sentinelRef.current;
		if (!sentinel || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setRendered((current) => Math.min(rows.length, current + MODEL_ROW_STEP));
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hiddenCount, rows.length]);

	const select = (item: AvailableModel) => {
		const next = pushRecentModel(recentKeys, modelKey(item));
		setRecentKeys(next);
		writeRecentModels(typeof window === "undefined" ? undefined : window.localStorage, next);
		onChange(item);
		setOpen(false);
	};

	return (
		<WebPickerSurface
			open={open}
			onOpenChange={setOpen}
			title={t("web.modelSheetTitle")}
			className="w-[30rem]"
			trigger={
				<Button
					type="button"
					variant="ghost"
					className="h-8 max-w-[30vw] shrink-0 justify-start gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:h-9 sm:max-w-[220px]"
					aria-label={t("web.model")}
					title={selectedName ? `${selectedName} · ${model?.provider ?? ""}/${model?.modelId ?? ""}` : t("web.model")}
					onClick={() => {
						setQuery("");
						setRendered(MODEL_ROW_WINDOW);
					}}
				>
					<span className="min-w-0 truncate">{pillLabel}</span>
					<ChevronsUpDown className="size-4 shrink-0" aria-hidden="true" />
				</Button>
			}
		>
			{/* 搜索 + 刷新：轻量内嵌搜索（不强聚焦环），左右内边距与行对齐 */}
			<div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
				<div className="relative min-w-0 flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("web.modelSearch")} className="h-9 border-transparent bg-muted/50 pl-8 text-sm shadow-none focus-visible:border-border/80 focus-visible:ring-0" aria-label={t("web.modelSearch")} />
				</div>
				{props.onRefresh ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-9"
						aria-label={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
						title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
						disabled={props.refreshing}
						onClick={() => props.onRefresh?.()}
					>
						<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
					</Button>
				) : null}
			</div>
			{/* scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
				{rows.length === 0 ? <div className="px-3 py-8 text-center text-sm text-muted-foreground">{t("web.modelEmpty")}</div> : null}
				{visibleRows.map((row) => {
					if (row.kind === "group") {
						return (
							<div key={row.key} className="px-3 pt-3 pb-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase first:pt-1">
								{row.label}
							</div>
						);
					}
					if (row.kind === "mediaGroup") {
						return (
							<div key={row.key} className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
								<span className="min-w-0 truncate text-caption font-medium text-muted-foreground">{row.label}</span>
								<span className="min-w-4 flex-1" />
								{row.hint ? <span className="shrink-0 text-micro text-muted-foreground/80">{row.hint}</span> : null}
							</div>
						);
					}
					if (row.kind === "media") {
						return <MediaRow key={row.key} row={row} onSelect={() => { if (!row.selectable) return; props.onPickImageModel?.(row.providerId, row.modelId); setOpen(false); }} />;
					}
					return <ModelRow key={row.key} item={row.item} active={modelKey(row.item) === currentKey} onSelect={() => select(row.item)} />;
				})}
				{hiddenCount > 0 ? (
					<button ref={sentinelRef} type="button" className="mt-1 flex h-10 w-full items-center justify-center rounded-lg text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground" onClick={() => setRendered((current) => Math.min(rows.length, current + MODEL_ROW_STEP))}>
						{t("web.moreSessions", { count: hiddenCount })}
					</button>
				) : null}
				<div className="h-[max(env(safe-area-inset-bottom),0.75rem)]" />
			</div>
		</WebPickerSurface>
	);
}
