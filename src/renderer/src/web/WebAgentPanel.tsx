/** Web 智能体：预设编辑、会话绑定与例外四的一次性试跑；不接收/提交任意 systemPrompt 调用。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, Pencil, Plus, Send, Square, Trash2 } from "lucide-react";
import type { AgentInvokeEventPayload, AgentProfile } from "../../../shared/types/agentProfile";
import type { WebAgentSnapshot } from "../../../main/web/WebAgentRoutes";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Input } from "@/components/ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { t } from "@/i18n";
import { bindWebAgent, cancelWebAgent, deleteWebAgent, fetchWebAgents, getWebToken, invokeWebAgent, saveWebAgent } from "./webApi";

type Model = { provider: string; modelId: string } | null;
type Draft = { id?: string; name: string; description: string; systemPrompt: string; category: AgentProfile["category"]; backend: "default" | "pi" | "dsh" };
const emptyDraft = (): Draft => ({ name: "", description: "", systemPrompt: "", category: "general", backend: "default" });

export function WebAgentPanel(props: { active: boolean; sessionId: string | null; model: Model }) {
	const [snapshot, setSnapshot] = useState<WebAgentSnapshot | null>(null);
	const [query, setQuery] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [deleting, setDeleting] = useState<AgentProfile | null>(null);
	const [error, setError] = useState("");
	const [text, setText] = useState("");
	const [output, setOutput] = useState("");
	const [running, setRunning] = useState<string | null>(null);
	const [invokingId, setInvokingId] = useState("");
	const streamRef = useRef<EventSource | null>(null);
	const load = useCallback(async () => {
		try {
			setSnapshot(await fetchWebAgents());
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);
	useEffect(() => {
		if (props.active) void load();
	}, [props.active, load]);
	useEffect(
		() => () => {
			streamRef.current?.close();
			if (running) void cancelWebAgent(running);
		},
		[running],
	);

	const agents = snapshot?.agents.filter((agent) => `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase())) ?? [];
	const run = async (action: () => Promise<unknown>) => {
		setError("");
		try {
			await action();
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const invoke = async (agent: AgentProfile) => {
		if (!props.model || !text.trim()) return;
		setError("");
		setOutput("");
		setInvokingId(agent.id);
		try {
			const { runId } = await invokeWebAgent({ agentId: agent.id, text, model: props.model, action: "chat" });
			setRunning(runId);
			const source = new EventSource(`/api/agents/invoke/events?runId=${encodeURIComponent(runId)}${getWebToken() ? `&token=${encodeURIComponent(getWebToken() ?? "")}` : ""}`);
			streamRef.current = source;
			source.onmessage = (message) => {
				const event = JSON.parse(message.data) as AgentInvokeEventPayload;
				if (event.phase === "delta" || event.phase === "done") setOutput((current) => (event.phase === "done" ? event.text : current + event.text));
				if (event.phase === "error") setError(event.errorKind);
				if (event.phase !== "delta" && event.phase !== "started") {
					source.close();
					setRunning(null);
				}
			};
			source.onerror = () => {
				source.close();
				setRunning(null);
				setError(t("web.agentInvokeDisconnected"));
			};
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	const bound = props.sessionId ? snapshot?.sessionAgentBindings[props.sessionId] : undefined;
	return (
		<div className="flex flex-col gap-2" data-testid="web-agents-panel">
			<div className="flex gap-1.5">
				<Input aria-label={t("web.agentSearch")} value={query} placeholder={t("web.agentSearch")} onChange={(event) => setQuery(event.target.value)} />
				<Button size="sm" variant="outline" onClick={() => setDraft(emptyDraft())}>
					<Plus className="size-3.5" />
					{t("web.agentNew")}
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-micro text-danger">
					{error}
				</p>
			) : null}
			<ul className="flex flex-col gap-1.5">
				{agents.map((agent) => (
					<li key={agent.id} className="rounded-md border border-border-subtle p-2">
						<div className="flex items-center gap-1.5">
							<Bot className="size-4 shrink-0" />
							<span className="min-w-0 flex-1 truncate text-caption font-medium">
								{agent.icon} {agent.name}
							</span>
							{bound === agent.id ? <span className="text-micro text-primary">{t("web.agentBound")}</span> : null}
						</div>
						<p className="mt-1 line-clamp-2 text-micro text-text-tertiary">{agent.description}</p>
						<div className="mt-1 flex flex-wrap gap-1">
							<Button size="sm" variant="ghost" onClick={() => setDraft({ id: agent.id, name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, category: agent.category, backend: agent.backend ?? "default" })}>
								<Pencil className="size-3" />
								{t("web.agentEdit")}
							</Button>
							{props.sessionId ? (
								<Button size="sm" variant="ghost" onClick={() => void run(() => bindWebAgent(props.sessionId!, bound === agent.id ? null : agent.id))}>
									{bound === agent.id ? t("web.agentUnbind") : t("web.agentBind")}
								</Button>
							) : null}
							{!agent.builtin ? (
								<Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(agent)}>
									<Trash2 className="size-3" />
									{t("web.agentDelete")}
								</Button>
							) : null}
						</div>
					</li>
				))}
			</ul>
			<section className="rounded-md border border-border-subtle p-2">
				<p className="text-micro text-text-tertiary">{props.model ? t("web.agentInvokeHint") : t("web.agentNoModel")}</p>
				<Textarea aria-label={t("web.agentInvokeInput")} className="mt-1 min-h-16" value={text} onChange={(event) => setText(event.target.value)} />
				<div className="mt-1 flex gap-1">
					<Button
						size="sm"
						disabled={!props.model || !text.trim() || running !== null}
						onClick={() => {
							const agent = agents.find((item) => item.id === (invokingId || bound)) ?? agents[0];
							if (agent) void invoke(agent);
						}}
					>
						<Send className="size-3" />
						{t("web.agentInvoke")}
					</Button>
					{running ? (
						<Button size="sm" variant="outline" onClick={() => void cancelWebAgent(running)}>
							<Square className="size-3" />
							{t("web.agentCancel")}
						</Button>
					) : null}
					{running ? <Loader2 className="size-4 animate-pideck-spin" /> : null}
				</div>
				{output ? <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-caption">{output}</pre> : null}
			</section>
			<Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
				<DialogContent className="max-h-[85dvh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{draft?.id ? t("web.agentEdit") : t("web.agentNew")}</DialogTitle>
					</DialogHeader>
					{draft ? (
						<div className="flex flex-col gap-2">
							<Input aria-label={t("web.agentName")} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
							<Input aria-label={t("web.agentDescription")} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
							<Textarea aria-label={t("web.agentSystemPrompt")} className="min-h-32" value={draft.systemPrompt} onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })} />
							<Select value={draft.category} onValueChange={(category) => setDraft({ ...draft, category: category as Draft["category"] })}>
								<SelectTrigger aria-label={t("web.agentCategory")}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(["general", "translation", "writing", "coding", "analysis"] as const).map((category) => (
										<SelectItem key={category} value={category}>
											{t(`agentMarket.category.${category}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select value={draft.backend} onValueChange={(backend) => setDraft({ ...draft, backend: backend as Draft["backend"] })}>
								<SelectTrigger aria-label={t("web.agentBackend")}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">{t("web.agentBackendDefault")}</SelectItem>
									<SelectItem value="pi">Pi</SelectItem>
									<SelectItem value="dsh">DSH</SelectItem>
								</SelectContent>
							</Select>
						</div>
					) : null}
					<DialogFooter>
						<Button variant="ghost" onClick={() => setDraft(null)}>
							{t("common.cancel")}
						</Button>
						<Button
							disabled={!draft?.name.trim() || !draft.systemPrompt.trim()}
							onClick={() => {
								if (!draft) return;
								const { id, backend, ...input } = draft;
								void run(() => saveWebAgent({ ...input, ...(backend === "default" ? { backend: null } : { backend }) }, id)).then(() => setDraft(null));
							}}
						>
							{t("common.save")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.agentDeleteTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.agentDeleteBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (deleting) void run(() => deleteWebAgent(deleting.id));
								setDeleting(null);
							}}
						>
							{t("web.agentDelete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
