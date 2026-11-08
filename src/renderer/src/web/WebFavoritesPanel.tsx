import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, Star, Trash2 } from "lucide-react";
import type { FavoriteEntry } from "../../../shared/types/favorites";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { t } from "@/i18n";
import { addWebSessionFavorite, deleteWebFavorite, fetchWebFavorites } from "./webApi";
import { copyTextToClipboard } from "./webClipboard";

export function WebFavoritesPanel(props: { active: boolean; sessionId: string | null; hasSession: (sessionId: string) => boolean; onOpenSession: (sessionId: string) => void }) {
	const [entries, setEntries] = useState<FavoriteEntry[]>([]);
	const [query, setQuery] = useState("");
	const [error, setError] = useState("");
	const [deleting, setDeleting] = useState<FavoriteEntry | null>(null);
	const load = useCallback(async () => {
		try {
			setEntries(await fetchWebFavorites());
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);
	useEffect(() => {
		if (props.active) void load();
	}, [props.active, load]);
	const remove = async () => {
		if (!deleting) return;
		try {
			await deleteWebFavorite(deleting.id);
			setDeleting(null);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const filtered = entries.filter((entry) => `${entry.text} ${entry.sessionTitle ?? ""}`.toLowerCase().includes(query.toLowerCase()));
	return (
		<div className="flex flex-col gap-2" data-testid="web-favorites-panel">
			<div className="flex gap-1.5">
				<Input aria-label={t("favorites.searchPlaceholder")} placeholder={t("favorites.searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
				{props.sessionId ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							void addWebSessionFavorite(props.sessionId!)
								.then(load)
								.catch((cause) => setError(String(cause)))
						}
					>
						<Star className="size-3.5" />
						{t("favorites.saveSession")}
					</Button>
				) : null}
			</div>
			{error ? (
				<p role="alert" className="text-micro text-danger">
					{error}
				</p>
			) : null}
			{filtered.length === 0 ? <p className="py-6 text-center text-caption text-text-tertiary">{t("favorites.emptyTitle")}</p> : null}
			<ul className="flex flex-col gap-1.5">
				{filtered.map((entry) => (
					<li key={entry.id} className="rounded-md border border-border-subtle p-2">
						<div className="flex items-center gap-1.5">
							<span className="min-w-0 flex-1 truncate text-caption font-medium">{entry.sessionTitle ?? t("favorites.sourceUnknown")}</span>
							<span className="text-micro text-text-tertiary">{t(`favorites.kind${entry.kind[0].toUpperCase()}${entry.kind.slice(1)}` as "favorites.kindSession")}</span>
						</div>
						{entry.text ? <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-caption text-text-secondary">{entry.text}</p> : null}
						<div className="mt-1 flex gap-1">
							{entry.text ? (
								<Button size="sm" variant="ghost" onClick={() => void copyTextToClipboard(entry.text)}>
									<Copy className="size-3" />
									{t("favorites.copy")}
								</Button>
							) : null}
							{entry.sessionId && props.hasSession(entry.sessionId) ? (
								<Button size="sm" variant="ghost" onClick={() => props.onOpenSession(entry.sessionId!)}>
									<ExternalLink className="size-3" />
									{t("favorites.openSession")}
								</Button>
							) : null}
							<Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(entry)}>
								<Trash2 className="size-3" />
								{t("favorites.delete")}
							</Button>
						</div>
					</li>
				))}
			</ul>
			<AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("favorites.deleteTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("favorites.deleteBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction onClick={() => void remove()}>{t("favorites.delete")}</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
