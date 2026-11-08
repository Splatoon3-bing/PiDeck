/**
 * composer 上方的常驻横幅（传输/命令错误 + 待答提示）。
 *
 * 从 WebChatApp 拆出：这是纯展示块，却占着组合根近 25 行 JSX。
 * 语义不变（2026-10 评审 P1）：错误与「Agent 正等你回答」原本只出现在时间线尾部，
 * 用户回读历史时看不见，composer 又可能已隐藏，所以必须在 composer 上方常驻一条。
 */
import { X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";

export function WebComposerBanner(props: {
	/** 当前错误文案（null = 不显示错误行） */
	error: string | null;
	/** 传输层错误才给「重新加载消息」（命令错误没有通用重试） */
	onRetryMessages?: () => void;
	onDismissError: () => void;
	/** 待答请求且用户已滚离底部时显示「跳到最新」 */
	pendingHidden?: boolean;
	onJumpToLatest: () => void;
}) {
	return (
		<div className="composer-above flex shrink-0 flex-col gap-1 border-t border-border/60 bg-background px-3 py-1.5">
			{props.error ? (
				<div className="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1 text-caption text-danger" role="alert">
					<span className="min-w-0 flex-1 leading-5">{props.error}</span>
					{props.onRetryMessages ? (
						<Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-caption text-danger hover:bg-danger/10 hover:text-danger" onClick={props.onRetryMessages}>
							{t("web.refreshMessages")}
						</Button>
					) : null}
					<button type="button" className="flex size-7 shrink-0 items-center justify-center rounded text-danger transition-colors hover:bg-danger/10" aria-label={t("common.close")} onClick={props.onDismissError}>
						<X className="size-3.5" aria-hidden="true" />
					</button>
				</div>
			) : null}
			{props.pendingHidden ? (
				<button type="button" className="flex w-full items-center gap-2 rounded-md border border-border bg-primary/10 px-2.5 py-1.5 text-caption text-primary transition-colors hover:bg-primary/15" role="status" onClick={props.onJumpToLatest}>
					<span className="min-w-0 flex-1 truncate text-left">{t("web.askWaitingBanner")}</span>
					<span className="shrink-0 font-medium">{t("web.scrollToBottom")}</span>
				</button>
			) : null}
		</div>
	);
}

/**
 * 令牌失效横幅：服务端轮换 token 后所有请求 401 且不会自愈，必须提示用户回桌面端重新扫码。
 * 与 composer 横幅同一个「页头常驻提示」家族，放在一起避免组合根再挂一段 JSX。
 */
export function WebAuthExpiredBanner() {
	return (
		<div className="flex items-center justify-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive">
			<span>{t("web.authExpired")}</span>
			<Button variant="outline" size="sm" className="h-6 px-2 text-micro" onClick={() => window.location.reload()}>
				{t("web.authExpiredRetry")}
			</Button>
		</div>
	);
}
