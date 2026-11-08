/**
 * Web 通知中心：公告（AnnouncementService 投影）+ toast 历史（NoticeHistoryStore）+ 反馈入口。
 *
 * 反馈不新增通道：走既有「新建会话」链路，创建后把整理好的说明预填进 composer，
 * 由用户自己确认发送（与桌面反馈弹窗同一语义：不自动提交外部系统）。
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, MessageSquareWarning, Megaphone, Trash2 } from "lucide-react";
import type { AnnouncementItem } from "../../../shared/types/announcement";
import type { NoticeHistoryFileEntry } from "../../../shared/types/noticeHistory";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { clearWebNotices, createSession, fetchWebAnnouncements, fetchWebNotices, markAllWebAnnouncementsRead, markWebAnnouncementRead } from "./webApi";

type Tab = "announcements" | "history" | "feedback";

function formatTime(value: number): string {
	return new Date(value).toLocaleString();
}

export function WebNoticeCenter(props: { open: boolean; onOpenChange: (open: boolean) => void; projectId?: string; appVersion?: string; onOpenSession: (sessionId: string) => void; onPrefill: (text: string) => void }) {
	const [tab, setTab] = useState<Tab>("announcements");
	const [items, setItems] = useState<AnnouncementItem[]>([]);
	const [readIds, setReadIds] = useState<string[]>([]);
	const [entries, setEntries] = useState<NoticeHistoryFileEntry[]>([]);
	const [confirmClear, setConfirmClear] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const [announcements, notices] = await Promise.all([fetchWebAnnouncements(), fetchWebNotices()]);
			setItems(announcements.items);
			setReadIds(announcements.readIds);
			setEntries(notices);
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);
	useEffect(() => {
		if (props.open) void load();
	}, [props.open, load]);

	const markRead = async (id: string) => {
		if (readIds.includes(id)) return;
		setReadIds((current) => [...current, id]);
		await markWebAnnouncementRead(id).catch(() => undefined);
	};

	const submitFeedback = async () => {
		if (!feedback.trim() || !props.projectId) return;
		setBusy(true);
		try {
			const sessionId = await createSession(props.projectId);
			props.onPrefill(`${feedback.trim()}\n\n---\nPiDeck ${props.appVersion ?? ""} · Web\n`);
			props.onOpenSession(sessionId);
			props.onOpenChange(false);
			setFeedback("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	const tabs: { id: Tab; label: string; icon: typeof Bell }[] = [
		{ id: "announcements", label: t("web.noticeTabAnnouncements"), icon: Megaphone },
		{ id: "history", label: t("web.noticeTabHistory"), icon: Bell },
		{ id: "feedback", label: t("web.noticeTabFeedback"), icon: MessageSquareWarning },
	];

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] flex-col gap-2 sm:max-w-lg" data-testid="web-notice-center">
				<DialogHeader>
					<DialogTitle>{t("web.noticeCenter")}</DialogTitle>
				</DialogHeader>
				<div className="flex shrink-0 gap-1" role="tablist" aria-label={t("web.noticeCenter")}>
					{tabs.map((entry) => {
						const Icon = entry.icon;
						const active = entry.id === tab;
						return (
							<button key={entry.id} type="button" role="tab" aria-selected={active} className={cn("flex h-8 flex-1 items-center justify-center gap-1 rounded-md text-caption transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")} onClick={() => setTab(entry.id)}>
								<Icon className="size-3.5" aria-hidden="true" />
								{entry.label}
							</button>
						);
					})}
				</div>
				{error ? (
					<p role="alert" className="text-micro text-danger">
						{error}
					</p>
				) : null}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{tab === "announcements" ? (
						items.length === 0 ? (
							<p className="py-6 text-center text-caption text-text-tertiary">{t("web.noticeEmptyAnnouncements")}</p>
						) : (
							<>
								<div className="mb-1 flex justify-end">
									<Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-micro" onClick={() => void markAllWebAnnouncementsRead().then(() => setReadIds(items.map((item) => item.id)))}>
										{t("web.noticeMarkAllRead")}
									</Button>
								</div>
								<ul className="flex flex-col gap-1.5">
									{items.map((item) => (
										<li key={item.id} className="rounded-md border border-border-subtle p-2">
											<button type="button" className="flex w-full items-center gap-1.5 text-left" onClick={() => void markRead(item.id)}>
												<span className={cn("shrink-0 rounded px-1 py-0.5 text-micro", item.level === "critical" ? "bg-danger/10 text-danger" : item.level === "warn" ? "bg-warning/10 text-warning" : "bg-muted text-text-tertiary")}>{t("web.noticeUnread")}</span>
												<span className="min-w-0 flex-1 truncate text-caption font-medium">{item.title}</span>
												{readIds.includes(item.id) ? <span className="shrink-0 text-micro text-text-tertiary">{t("web.noticeRead")}</span> : null}
											</button>
											<p className="mt-1 line-clamp-3 whitespace-pre-wrap text-micro text-text-secondary">{item.body}</p>
										</li>
									))}
								</ul>
							</>
						)
					) : null}
					{tab === "history" ? (
						entries.length === 0 ? (
							<p className="py-6 text-center text-caption text-text-tertiary">{t("web.noticeEmptyHistory")}</p>
						) : (
							<>
								<div className="mb-1 flex justify-end">
									<Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-2 text-micro text-danger" onClick={() => setConfirmClear(true)}>
										<Trash2 className="size-3" aria-hidden="true" />
										{t("web.noticeClear")}
									</Button>
								</div>
								<ul className="flex flex-col gap-1">
									{[...entries].reverse().map((entry) => (
										<li key={`${entry.timestamp}-${entry.title}`} className="rounded border border-border-subtle px-2 py-1">
											<div className="flex items-center gap-1.5">
												<span className="min-w-0 flex-1 truncate text-caption">{entry.title}</span>
												<span className="shrink-0 text-micro text-text-tertiary">{formatTime(entry.timestamp)}</span>
											</div>
											{entry.description ? <p className="mt-0.5 line-clamp-2 text-micro text-text-secondary">{entry.description}</p> : null}
										</li>
									))}
								</ul>
							</>
						)
					) : null}
					{tab === "feedback" ? (
						<div className="flex flex-col gap-2">
							<p className="text-micro text-text-tertiary">{t("web.feedbackHint")}</p>
							<Textarea className="min-h-32" aria-label={t("web.feedbackPlaceholder")} placeholder={t("web.feedbackPlaceholder")} value={feedback} onChange={(event) => setFeedback(event.target.value)} />
							<Button type="button" size="sm" disabled={busy || !feedback.trim() || !props.projectId} onClick={() => void submitFeedback()}>
								{t("web.feedbackCreate")}
							</Button>
						</div>
					) : null}
				</div>
				<AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("web.noticeClearTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("web.noticeClearBody")}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									void clearWebNotices()
										.then(() => setEntries([]))
										.catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
								}}
							>
								{t("web.noticeClear")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</DialogContent>
		</Dialog>
	);
}
