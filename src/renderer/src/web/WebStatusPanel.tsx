/**
 * WebStatusPanel — 工作区抽屉的「状态」面板（T7a）
 *
 * 只做汇总展示：后端 / runtime 状态 / 上下文用量 + 子代理与 todo（复用 WebSessionStrips）。
 * 数据来源与桌面同源（/api/state 里的 runtimes + /api/runtime/:id/context-usage + 会话活动接口），
 * 不引入第二个全局状态库；页面不可见时不轮询（手机后台省流量）。
 */
import { useEffect, useState } from "react";
import { Activity, Cpu, Gauge } from "lucide-react";
import type { AgentBackend } from "../../../shared/types";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { fetchRuntimeContextUsage } from "./webApi";
import { WebSessionStrips } from "./WebSessionStrips";
import type { WebContextUsage, WebRuntime } from "./webTypes";

const POLL_MS = 5000;

function runtimeLabel(status: string | undefined): string {
	if (status === "running") return t("app.statusRunning");
	if (status === "starting") return t("app.statusStarting");
	if (status === "error") return t("app.statusError");
	return t("app.statusIdle");
}

function backendLabel(backend: AgentBackend | undefined): string {
	if (backend === "dsh") return "DSH";
	if (backend === "acp") return "ACP";
	if (backend === "imagegen") return t("web.backendImagegen");
	if (backend === "videogen") return t("web.backendVideogen");
	return "Pi";
}

export function WebStatusPanel(props: { sessionId: string | null; runtime?: WebRuntime; backend?: AgentBackend; active: boolean }) {
	const [usage, setUsage] = useState<WebContextUsage | undefined>(undefined);
	const runtimeGeneration = props.runtime?.runtimeGeneration;

	useEffect(() => {
		if (!props.active || !props.sessionId) return;
		if (!props.runtime || typeof runtimeGeneration !== "number") {
			setUsage(undefined);
			return;
		}
		let disposed = false;
		const target = { sessionId: props.sessionId, agentId: props.runtime.agentId, runtimeGeneration };
		const load = async () => {
			if (document.hidden) return;
			try {
				const next = await fetchRuntimeContextUsage(props.sessionId ?? "", target);
				if (!disposed) setUsage(next);
			} catch {
				// 运行态刚销毁/切换中：保留上一次数据，不覆盖成空
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), POLL_MS);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, [props.active, props.sessionId, props.runtime, runtimeGeneration]);

	const percent = typeof usage?.contextPercent === "number" ? Math.max(0, Math.min(100, Math.round(usage.contextPercent))) : null;
	const tokens = typeof usage?.contextTokens === "number" ? usage.contextTokens : null;
	const windowSize = typeof usage?.contextWindow === "number" ? usage.contextWindow : null;

	return (
		<div className="flex min-h-0 flex-col gap-2" data-testid="web-status-panel">
			<section className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
				<div className="flex items-center gap-1.5 text-caption font-medium text-foreground">
					<Activity className="size-3.5 text-text-tertiary" aria-hidden="true" />
					{t("web.statusTitle")}
				</div>
				<dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
					<dt className="text-text-tertiary">{t("web.statusBackend")}</dt>
					<dd className="text-foreground">{backendLabel(props.backend)}</dd>
					<dt className="text-text-tertiary">{t("web.statusRuntime")}</dt>
					<dd className={cn("text-foreground", props.runtime?.status === "running" && "text-success", props.runtime?.status === "error" && "text-danger")}>{runtimeLabel(props.runtime?.status)}</dd>
				</dl>
			</section>

			<section className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
				<div className="flex items-center gap-1.5 text-caption font-medium text-foreground">
					<Gauge className="size-3.5 text-text-tertiary" aria-hidden="true" />
					{t("web.statusContext")}
				</div>
				{percent === null ? (
					<p className="mt-1.5 text-caption text-text-tertiary">{props.runtime ? t("web.statusContextUnavailable") : t("web.statusNoRuntime")}</p>
				) : (
					<>
						<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
							<div className={cn("h-full rounded-full", percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warning" : "bg-primary")} style={{ width: `${percent}%` }} />
						</div>
						<div className="mt-1 flex items-center justify-between text-micro text-text-tertiary">
							<span>
								{tokens ?? 0} / {windowSize ?? 0} tokens · {percent}%
							</span>
							{typeof usage?.inputTokens === "number" || typeof usage?.outputTokens === "number" ? (
								<span className="flex items-center gap-1">
									<Cpu className="size-3" aria-hidden="true" />
									{usage?.inputTokens ?? 0}↑ {usage?.outputTokens ?? 0}↓
								</span>
							) : null}
						</div>
					</>
				)}
			</section>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<WebSessionStrips sessionId={props.sessionId} />
			</div>
		</div>
	);
}
