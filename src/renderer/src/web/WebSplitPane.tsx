/**
 * WebSplitPane — 分屏右侧的只读预览（T7b）
 *
 * - 只读：最近消息文本 + 会话状态；不做第二份 useChat（避免双流式/双排队的复杂度）；
 * - 每 5s 刷新一次（页面不可见时跳过），并随 sessionId 变化重新加载；
 * - 顶部可「切到这一栏」（提升为主会话，分屏自动关闭）或直接关闭分屏。
 */
import { useEffect, useState } from "react";
import { ArrowLeftRight, Loader2, X } from "lucide-react";
import type { AgentBackend, SessionMessagePage } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { chatMessagesToUiMessages, fetchMessagePage } from "./webApi";
import { uiMessageText } from "./webMessageParts";

const POLL_MS = 5000;
const MAX_RENDERED = 40;

function backendLabel(backend: AgentBackend | undefined): string {
	if (backend === "dsh") return "DSH";
	if (backend === "acp") return "ACP";
	if (backend === "imagegen") return t("web.backendImagegen");
	if (backend === "videogen") return t("web.backendVideogen");
	return "Pi";
}

export function WebSplitPane(props: { session: { id: string; title?: string; backend?: AgentBackend }; onClose: () => void; onPromote: () => void }) {
	const [page, setPage] = useState<SessionMessagePage | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let disposed = false;
		const load = async () => {
			if (document.hidden) return;
			setLoading((current) => current || page === null);
			try {
				const next = await fetchMessagePage(props.session.id);
				if (!disposed) {
					setPage(next);
					setError(null);
				}
			} catch (loadError) {
				if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
			} finally {
				if (!disposed) setLoading(false);
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), POLL_MS);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
		// page 只用于 loading 初值，不进依赖，避免每次刷新重建定时器
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.session.id]);

	const messages = page ? chatMessagesToUiMessages(page.messages).slice(-MAX_RENDERED) : [];

	return (
		<aside className="flex h-full w-[clamp(18rem,28vw,24rem)] shrink-0 flex-col overflow-hidden border-l border-border bg-background" aria-label={t("web.splitAria")} data-testid="web-split-pane">
			<div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2.5">
				<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground" title={props.session.title ?? props.session.id}>
					{props.session.title ?? props.session.id}
				</span>
				<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-micro text-text-tertiary">{backendLabel(props.session.backend)}</span>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={t("web.splitPromote")} title={t("web.splitPromote")} onClick={props.onPromote}>
					<ArrowLeftRight className="size-3.5" aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label={t("web.splitClose")} title={t("web.splitClose")} onClick={props.onClose}>
					<X className="size-3.5" aria-hidden="true" />
				</Button>
			</div>

			<p className="shrink-0 border-b border-border-subtle px-2.5 py-1 text-micro text-text-tertiary">{t("web.splitReadOnly")}</p>

			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
				{error ? <div className="rounded border border-danger/30 bg-danger/10 px-2 py-1 text-micro text-danger">{error}</div> : null}
				{loading && messages.length === 0 ? (
					<div className="flex items-center justify-center py-6 text-caption text-text-tertiary">
						<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
					</div>
				) : null}
				{messages.length === 0 && !loading ? <p className="py-6 text-center text-caption text-text-tertiary">{t("web.splitEmpty")}</p> : null}
				<ul className="flex flex-col gap-2">
					{messages.map((message) => {
						const text = uiMessageText(message).trim();
						if (!text) return null;
						const isUser = message.role === "user";
						return (
							<li key={message.id} className={cn("rounded-md border px-2 py-1.5 text-caption", isUser ? "border-primary/20 bg-primary-soft/60" : "border-border-subtle bg-bg-panel")}>
								<div className="mb-0.5 text-micro font-medium text-text-tertiary">{isUser ? t("web.splitRoleUser") : t("web.splitRoleAssistant")}</div>
								<div className="whitespace-pre-wrap break-words text-foreground">{text}</div>
							</li>
						);
					})}
				</ul>
			</div>
		</aside>
	);
}
