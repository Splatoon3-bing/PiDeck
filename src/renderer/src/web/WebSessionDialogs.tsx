/**
 * WebSessionDialogs — 会话重命名 / 删除确认（从 WebChatApp 抽出，控组合根行数）。
 *
 * 状态与动作仍由组合根持有（renameDraft/deleteConfirmId + confirm 回调），
 * 这里只做弹层渲染，避免同一段 Dialog/AlertDialog 结构继续堆在组合根里。
 */
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";

export function WebSessionDialogs(props: { renameDraft: { sessionId: string; title: string } | null; renameValue: string; onRenameValueChange: (value: string) => void; onCancelRename: () => void; onConfirmRename: () => void; deleteConfirmId: string | null; onCancelDelete: () => void; onConfirmDelete: () => void }) {
	return (
		<>
			<Dialog open={props.renameDraft != null} onOpenChange={(open) => (!open ? props.onCancelRename() : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("web.renameTitle")}</DialogTitle>
					</DialogHeader>
					<Input value={props.renameValue} onChange={(event) => props.onRenameValueChange(event.target.value)} placeholder={t("web.renamePlaceholder")} onKeyDown={(event) => (event.key === "Enter" ? props.onConfirmRename() : undefined)} />
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" onClick={props.onCancelRename}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={!props.renameValue.trim()} onClick={props.onConfirmRename}>
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<AlertDialog open={props.deleteConfirmId != null} onOpenChange={(open) => (!open ? props.onCancelDelete() : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.deleteSessionConfirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.deleteSessionConfirmBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction className="bg-danger text-danger-foreground hover:bg-danger/90" onClick={props.onConfirmDelete}>
							{t("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
