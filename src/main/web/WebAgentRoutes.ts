/**
 * Web 智能体：AgentProfileStore 的白名单投影与例外四的一次性调用适配。
 * 不接受 systemPrompt；所有角色设定由 AgentInvokeService 按 agentId 在主进程解析。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	AGENT_INVOKE_INSTRUCTION_MAX_CHARS,
	AGENT_PROFILE_CATEGORIES,
	AGENT_PROFILE_BACKENDS,
	AGENT_PROFILE_DESCRIPTION_MAX_CHARS,
	AGENT_PROFILE_ICON_MAX_CHARS,
	AGENT_PROFILE_NAME_MAX_CHARS,
	AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS,
	type AgentInvokeEventPayload,
	type AgentInvokeInput,
	type AgentModelRef,
	type AgentProfile,
	type AgentProfileSnapshot,
} from "../../shared/types/agentProfile";
import type { AgentProfileStore } from "../agents/AgentProfileStore";
import type { AgentProfilePatch } from "../agents/agentProfileNormalize";
import type { AgentInvokeService } from "../agents/AgentInvokeService";
import { parseAgentInvokeInput } from "../ipc/agentInvokeIpc";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WEB_CORS_HEADERS } from "./WebHttpResponders";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_CHARS = 200;
const EDIT_FIELDS = new Set(["name", "description", "icon", "systemPrompt", "category", "model", "backend"]);

export type WebAgentSnapshot = Pick<AgentProfileSnapshot, "revision" | "agents" | "agentOrder"> & { sessionAgentBindings: Record<string, string> };
type InvokeRun = { events: AgentInvokeEventPayload[]; bytes: number; closed: boolean; listeners: Set<() => void>; cleanup?: ReturnType<typeof setTimeout> };

export type WebAgentRoutesDeps = {
	store: () => AgentProfileStore | null;
	invoke: () => AgentInvokeService | null;
	hasSession: (sessionId: string) => boolean;
	log?: (message: string, details: Record<string, unknown>) => void;
};

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(body));
}
function error(response: ServerResponse, status: number, code: string, message: string, field?: string): void {
	json(response, status, { code, message, ...(field ? { field } : {}) });
}
function invalid(message: string, field?: string): Error {
	return Object.assign(new Error(message), { name: "WebAgentValidationError", field });
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("object body is required");
	return value as Record<string, unknown>;
}
function id(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_CHARS || /[\p{Cc}\u2028\u2029]/u.test(value)) throw invalid(`${field} is invalid`, field);
	return value.trim();
}
function exactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid(`unknown field: ${key}`, key);
}
function requiredText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw invalid(`${field} is invalid`, field);
	return value.trim();
}
function optionalText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || value.length > max) throw invalid(`${field} is invalid`, field);
	return value.trim();
}
function model(value: unknown): AgentModelRef | null {
	if (value === null) return null;
	const input = record(value);
	exactFields(input, new Set(["provider", "modelId"]));
	if (typeof input.provider !== "string" || typeof input.modelId !== "string" || input.provider.length > 200 || input.modelId.length > 200 || /[\p{Cc}\u2028\u2029]/u.test(input.provider + input.modelId)) throw invalid("model is invalid", "model");
	return input.provider && input.modelId ? { provider: input.provider, modelId: input.modelId } : null;
}
function editFields(value: unknown, creating: true): AgentProfilePatch & Pick<AgentProfile, "name" | "systemPrompt"> & { model?: AgentModelRef; backend?: AgentProfile["backend"] };
function editFields(value: unknown, creating: false): AgentProfilePatch;
function editFields(value: unknown, creating: boolean): AgentProfilePatch {
	const input = record(value);
	exactFields(input, EDIT_FIELDS);
	const patch: AgentProfilePatch = {};
	if (creating || Object.hasOwn(input, "name")) patch.name = requiredText(input.name, "name", AGENT_PROFILE_NAME_MAX_CHARS);
	if (creating || Object.hasOwn(input, "systemPrompt")) patch.systemPrompt = requiredText(input.systemPrompt, "systemPrompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS);
	if (Object.hasOwn(input, "description")) patch.description = optionalText(input.description, "description", AGENT_PROFILE_DESCRIPTION_MAX_CHARS);
	if (Object.hasOwn(input, "icon")) patch.icon = optionalText(input.icon, "icon", AGENT_PROFILE_ICON_MAX_CHARS);
	if (Object.hasOwn(input, "category")) {
		if (typeof input.category !== "string" || !AGENT_PROFILE_CATEGORIES.includes(input.category as (typeof AGENT_PROFILE_CATEGORIES)[number])) throw invalid("category is invalid", "category");
		patch.category = input.category as AgentProfile["category"];
	}
	if (Object.hasOwn(input, "model")) patch.model = model(input.model);
	if (Object.hasOwn(input, "backend")) {
		if (input.backend !== null && (typeof input.backend !== "string" || !AGENT_PROFILE_BACKENDS.includes(input.backend as (typeof AGENT_PROFILE_BACKENDS)[number]))) throw invalid("backend is invalid", "backend");
		patch.backend = input.backend as AgentProfilePatch["backend"];
	}
	if (creating) {
		if (patch.model === null) delete patch.model;
		if (patch.backend === null) delete patch.backend;
	}
	return patch;
}
function snapshot(store: AgentProfileStore): WebAgentSnapshot {
	const value = store.getSnapshot();
	return { revision: value.revision, agents: value.agents, agentOrder: value.agentOrder, sessionAgentBindings: value.settings.sessionAgentBindings };
}

export class WebAgentRoutes {
	private readonly runs = new Map<string, InvokeRun>();
	constructor(private readonly deps: WebAgentRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/agents" && !url.pathname.startsWith("/api/agents/")) return false;
		try {
			if (url.pathname === "/api/agents" && request.method === "GET") {
				const store = this.requireStore();
				json(response, 200, snapshot(store));
				return true;
			}
			if (url.pathname === "/api/agents/invoke/events" && request.method === "GET") return this.events(url, request, response);
			if (request.method !== "POST") {
				error(response, 405, "webError.methodNotAllowed", "method not allowed");
				return true;
			}
			const body = record(await readJson(request, MAX_BODY_BYTES));
			switch (url.pathname) {
				case "/api/agents/create": {
					exactFields(body, EDIT_FIELDS);
					const agent = await this.requireStore().create(editFields(body, true));
					this.log("create", { agentId: agent.id });
					json(response, 200, { agent });
					return true;
				}
				case "/api/agents/update": {
					exactFields(body, new Set(["agentId", "patch"]));
					const agent = await this.requireStore().update(id(body.agentId, "agentId"), editFields(body.patch, false));
					this.log("update", { agentId: agent.id });
					json(response, 200, { agent });
					return true;
				}
				case "/api/agents/delete":
				case "/api/agents/duplicate":
				case "/api/agents/reset-builtin": {
					exactFields(body, new Set(["agentId"]));
					const agentId = id(body.agentId, "agentId");
					if (url.pathname.endsWith("delete")) {
						const deleted = await this.requireStore().delete(agentId);
						if (!deleted) throw Object.assign(new Error("custom agent not found"), { name: "WebAgentNotFoundError" });
						this.log("delete", { agentId });
						json(response, 200, { ok: true });
					} else {
						const agent = url.pathname.endsWith("duplicate") ? await this.requireStore().duplicate(agentId) : await this.requireStore().resetBuiltin(agentId);
						this.log(url.pathname.endsWith("duplicate") ? "duplicate" : "reset-builtin", { agentId });
						json(response, 200, { agent });
					}
					return true;
				}
				case "/api/agents/bind-session": {
					exactFields(body, new Set(["sessionId", "agentId"]));
					const sessionId = id(body.sessionId, "sessionId");
					if (!this.deps.hasSession(sessionId)) throw Object.assign(new Error("session not found"), { name: "WebAgentNotFoundError" });
					const settings = await this.requireStore().bindSession({ sessionId, agentId: body.agentId === null ? null : id(body.agentId, "agentId") });
					this.log("bind-session", { sessionId, bound: body.agentId !== null });
					json(response, 200, { sessionAgentBindings: settings.sessionAgentBindings });
					return true;
				}
				case "/api/agents/invoke": {
					exactFields(body, new Set(["agentId", "text", "instruction", "action", "targetLanguage", "model"]));
					const service = this.deps.invoke();
					if (!service) throw Object.assign(new Error("agent invoke unavailable"), { name: "WebAgentUnavailableError" });
					const runIdHolder = { value: "" };
					const run: InvokeRun = { events: [], bytes: 0, closed: false, listeners: new Set() };
					const emit = (event: AgentInvokeEventPayload) => {
						if (run.closed) return;
						// 终态必须送达，不能在容量边界静默丢掉：关闭输出并清掉已缓冲增量，
						// 让重连仍能确定地收到 aborted/error/done，而不是无限等待。
						if (run.events.length >= 512 || run.bytes >= 2 * 1024 * 1024) {
							if (event.phase === "started" || event.phase === "delta") return;
							run.events = [];
							run.bytes = 0;
						}
						run.events.push(event);
						run.bytes += JSON.stringify(event).length;
						if (event.phase !== "started" && event.phase !== "delta") {
							run.closed = true;
							run.cleanup = setTimeout(() => this.runs.delete(event.runId), 5 * 60 * 1000);
							run.cleanup.unref?.();
						}
						for (const listener of run.listeners) listener();
					};
					const result = await service.invoke(parseAgentInvokeInput(body) as AgentInvokeInput, {
						onDelta: (text) => emit({ runId: runIdHolder.value, phase: "delta", text }),
						onDone: (text) => emit({ runId: runIdHolder.value, phase: "done", text }),
						onAborted: () => emit({ runId: runIdHolder.value, phase: "aborted" }),
						onError: (errorKind, message) => emit({ runId: runIdHolder.value, phase: "error", errorKind, message }),
					});
					if (!result.ok) {
						error(response, 400, "webError.agentInvokeFailed", result.errorKind);
						return true;
					}
					runIdHolder.value = result.runId;
					this.runs.set(result.runId, run);
					emit({ runId: result.runId, phase: "started" });
					this.log("invoke", { runId: result.runId });
					json(response, 200, { runId: result.runId });
					return true;
				}
				case "/api/agents/invoke/cancel": {
					exactFields(body, new Set(["runId"]));
					const runId = id(body.runId, "runId");
					const run = this.runs.get(runId);
					if (!run || run.closed) throw Object.assign(new Error("run not active"), { name: "WebAgentNotFoundError" });
					this.deps.invoke()?.cancel();
					this.log("cancel", { runId });
					json(response, 200, { ok: true });
					return true;
				}
				default:
					error(response, 404, "webError.apiNotFound", "API not found");
					return true;
			}
		} catch (caught) {
			const name = caught instanceof Error ? caught.name : "";
			if (name === "WebBodyTooLargeError") error(response, 413, "webError.bodyTooLarge", "payload too large");
			else if (name === "WebInvalidJsonError") error(response, 400, "webError.invalidJson", "invalid JSON body");
			else if (name === "WebAgentValidationError") error(response, 400, "webError.invalidAgent", caught instanceof Error ? caught.message : "invalid agent", (caught as { field?: string }).field);
			else if (name === "WebAgentNotFoundError") error(response, 404, "webError.agentNotFound", "agent, session or active run not found");
			else if (name === "WebAgentUnavailableError") error(response, 503, "webError.agentUnavailable", "agent service unavailable");
			else error(response, 400, "webError.invalidAgent", "agent operation rejected");
			return true;
		}
	}

	private events(url: URL, request: IncomingMessage, response: ServerResponse): boolean {
		const runId = id(url.searchParams.get("runId"), "runId");
		const run = this.runs.get(runId);
		if (!run) throw Object.assign(new Error("run not found"), { name: "WebAgentNotFoundError" });
		response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", ...WEB_CORS_HEADERS });
		let cursor = 0;
		const flush = () => {
			while (cursor < run.events.length) response.write(`data: ${JSON.stringify(run.events[cursor++])}\n\n`);
			if (run.closed) response.end();
		};
		run.listeners.add(flush);
		request.on("close", () => run.listeners.delete(flush));
		flush();
		return true;
	}

	private requireStore(): AgentProfileStore {
		const store = this.deps.store();
		if (!store) throw Object.assign(new Error("agent store unavailable"), { name: "WebAgentUnavailableError" });
		return store;
	}
	private log(message: string, details: Record<string, unknown>): void {
		if (this.deps.log) this.deps.log(message, details);
		else void getAppLogger()?.info("web-agents", message, details);
	}
}
