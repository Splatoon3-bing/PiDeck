import { useEffect, useMemo, useState } from "react";
import { decodeVideoGenSelection, encodeVideoGenSelection, VIDEO_GEN_DURATION_PRESETS, VIDEO_GEN_RATIO_PRESETS, VIDEO_GEN_RESOLUTION_PRESETS, type VideoGenConfigFile, type VideoGenProtocolFamily } from "../../../../shared/videoGenConfig";
import { clampVideoGenParams, findVideoModelCapability, type VideoModelCapability } from "../../../../shared/videoModelCatalog";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui-shadcn/select";

/**
 * 生视频模式底栏：供应商+模型合并下拉（与生图同构）+ 分辨率/时长/画幅三个参数下拉。
 *
 * 参数预设按当前供应商的协议族取（minimax 大写 P / seedance 小写 p 等），并保留
 * 「默认」项（不传参，用供应商 defaults 或上游默认值）；预设之外的自定义值一期不开放——
 * 各家模型支持矩阵差异大，开放自定义容易提交出 4xx，等真实需求再放（报告 §5 待确认项）。
 */
/**
 * 视频模型能力目录（每个供应商拉一次，会话内缓存）。
 *
 * 为什么需要：分辨率/画幅/时长是「按模型」的合法域，不是按协议族——同一网关里
 * kling-video-v3 只认 720P/1080P/4K，minimax-video-h3 只认 768P/2K。切模型后沿用
 * 上一个模型的默认值会发出上游不认识的值（网关不校验、原样透传，可能直接失败）。
 * 目录拉不到（老协议族 / 离线）就退回协议族预设，行为与旧版一致，不阻塞使用。
 */
function useVideoModelCatalog(providerId: string | undefined, protocol: VideoGenProtocolFamily): VideoModelCapability[] {
	const [catalog, setCatalog] = useState<VideoModelCapability[]>([]);
	useEffect(() => {
		if (!providerId || protocol !== "openai-videos") {
			setCatalog([]);
			return;
		}
		let alive = true;
		void desktopApi.videogen
			.listModels(providerId)
			.then((result) => {
				if (alive && result.ok) setCatalog(result.models);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, [providerId, protocol]);
	return catalog;
}

/** 时长候选：能力表声明了区间就按区间列（3..15），否则用固定预设。 */
function durationOptionsOf(capability: VideoModelCapability | undefined): readonly string[] {
	const lower = capability?.minSeconds;
	const upper = capability?.maxSeconds;
	if (lower === undefined || upper === undefined || upper < lower || upper - lower > 60) return VIDEO_GEN_DURATION_PRESETS;
	return Array.from({ length: upper - lower + 1 }, (_, index) => String(lower + index));
}

export function ComposerVideoGenOptions(props: {
	config: VideoGenConfigFile;
	providerId: string;
	modelId: string;
	resolution?: string;
	duration?: string;
	ratio?: string;
	disabled?: boolean;
	onSelectionChange: (providerId: string, modelId: string) => void;
	onParamChange: (key: "resolution" | "duration" | "ratio", value: string | undefined) => void;
}) {
	const providers = props.config.providers;
	const provider = providers.find((item) => item.id === props.providerId);
	const models = provider?.models.filter(Boolean) ?? [];
	const modelValue = provider && models.includes(props.modelId) ? props.modelId : "";
	const selectionValue = provider && modelValue ? encodeVideoGenSelection(provider.id, modelValue) : "";
	const providerLabel = provider?.name.trim() || provider?.id || "";
	const triggerLabel = provider && modelValue ? `${providerLabel} / ${modelValue}` : "";
	const protocol: VideoGenProtocolFamily = provider?.protocol ?? "minimax-v2";
	// 显示值：activeParams → 供应商 defaults（与提交侧同一回退链，展示与请求永远一致）
	const resolution = props.resolution ?? provider?.defaults?.resolution;
	const duration = props.duration ?? provider?.defaults?.duration;
	const ratio = props.ratio ?? provider?.defaults?.ratio;

	// 按模型能力纠正参数：切模型 / 能力表刚到 / 供应商默认值本身不合法时，夹回合法域。
	// 这些值来自 provider.defaults 时也要纠正——供应商级默认是上一个模型的，不保证通用。
	const catalog = useVideoModelCatalog(provider?.id, protocol);
	const capability = findVideoModelCapability(catalog, modelValue);
	const clampedKey = `${modelValue}\u0000${resolution ?? ""}\u0000${duration ?? ""}\u0000${ratio ?? ""}`;
	useEffect(() => {
		if (!capability) return;
		const clamped = clampVideoGenParams({ resolution, duration, ratio }, capability);
		if (clamped.changed.length === 0) return;
		for (const key of clamped.changed) props.onParamChange(key, clamped.params[key]);
		// clampedKey 覆盖四个输入值：参数被纠正后重跑一次即稳定（changed 为空）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [clampedKey, capability]);

	const resolutionOptions = capability && capability.resolutions.length > 0 ? capability.resolutions : VIDEO_GEN_RESOLUTION_PRESETS[protocol];
	const ratioOptions = capability && capability.aspectRatios.length > 0 ? capability.aspectRatios : VIDEO_GEN_RATIO_PRESETS[protocol];
	const durationOptions = useMemo(() => durationOptionsOf(capability), [capability]);

	if (providers.length === 0) {
		return <span className="truncate px-1.5 text-micro text-muted-foreground">{t("videogen.notConfiguredHint")}</span>;
	}

	return (
		<div className="inline-flex h-7 min-w-0 shrink-0 items-center gap-0.5">
			<Select
				value={selectionValue || undefined}
				disabled={props.disabled}
				onValueChange={(value) => {
					const next = decodeVideoGenSelection(value);
					if (!next) return;
					props.onSelectionChange(next.providerId, next.modelId);
				}}
			>
				<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[16rem] gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60" title={t("videogen.providerModel")} aria-label={t("videogen.providerModel")}>
					<SelectValue placeholder={t("videogen.providerModel")}>
						<span className="min-w-0 truncate">{triggerLabel || t("videogen.providerModel")}</span>
					</SelectValue>
				</SelectTrigger>
				<SelectContent align="start" className="min-w-[16rem]">
					{providers.map((item) => {
						const itemModels = item.models.filter(Boolean);
						if (itemModels.length === 0) return null;
						const groupLabel = item.name.trim() || item.id;
						return (
							<SelectGroup key={item.id}>
								<SelectLabel>{groupLabel}</SelectLabel>
								{itemModels.map((modelId) => (
									<SelectItem key={encodeVideoGenSelection(item.id, modelId)} value={encodeVideoGenSelection(item.id, modelId)}>
										{modelId}
									</SelectItem>
								))}
							</SelectGroup>
						);
					})}
				</SelectContent>
			</Select>
			{/* 分辨率/时长/画幅：预设来自协议族；选「默认」= 不传该参数 */}
			<ParamSelect label={resolution ?? t("videogen.paramDefault")} title={t("videogen.paramResolution")} disabled={props.disabled} value={resolution} options={resolutionOptions} onChange={(value) => props.onParamChange("resolution", value)} />
			<ParamSelect label={duration ? `${duration}s` : t("videogen.paramDefault")} title={t("videogen.paramDuration")} disabled={props.disabled} value={duration} options={durationOptions} onChange={(value) => props.onParamChange("duration", value)} />
			<ParamSelect label={ratio ?? t("videogen.paramDefault")} title={t("videogen.paramRatio")} disabled={props.disabled} value={ratio} options={ratioOptions} onChange={(value) => props.onParamChange("ratio", value)} />
		</div>
	);
}

/** 单参数下拉：value 为空时高亮「默认」；选中「默认」回传 undefined（提交侧省略该字段）。 */
function ParamSelect(props: { label: string; title: string; value?: string; options: readonly string[]; disabled?: boolean; onChange: (value: string | undefined) => void }) {
	return (
		<Select value={props.value ?? ""} disabled={props.disabled} onValueChange={(value) => props.onChange(value || undefined)}>
			<SelectTrigger size="sm" className="composer-bar-btn h-7 max-w-[7.5rem] gap-1 rounded-md border-transparent bg-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60" title={props.title} aria-label={props.title}>
				<span className="min-w-0 truncate">{props.label}</span>
			</SelectTrigger>
			<SelectContent align="start">
				<SelectItem value="">{t("videogen.paramDefault")}</SelectItem>
				{props.options.map((option) => (
					<SelectItem key={option} value={option}>
						{option}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
