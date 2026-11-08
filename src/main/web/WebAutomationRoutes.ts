/**
 * Web 自动化路由（T8 S1）：/api/automations
 *
 * 复用既有 `AutomationStore` / `AutomationRunCoordinator`，Web 层只做：
 * 白名单入参校验（`WebAutomationProjection`）、项目归属校验、安全投影、审计、错误映射。
 *
 * 路由面（详见 .ai/sdd/specs/001-web-parity/t8-automation-web-slice.md）：
 *   GET  /api/automations           列表（tasks + 最近 runs，可 ?taskId=&limit=）
 *   POST /api/automations/create    创建
 *   POST /api/automations/update    编辑（patch）
 *   POST /api/automations/delete    删除
 *   POST /api/automations/run       手动运行（busy → 409）
 *   POST /api/automations/abort     中止运行
 *   POST /api/automations/clear-runs 清理终态历史
 *   GET  /api/automations/preview-cron  cron 预览
 *
 * 不开放：全局设置写入、模型/思考档位编辑、运行日志实时流（见切片文档 §1）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutomationCronPreview, AutomationRun, AutomationTask, CreateAutomationTaskInput, Project, UpdateAutomationTaskInput } from "../../shared/types";
import type { AutomationStore } from "../automation/AutomationStore";
import type { AutomationRunCoordinator } from "../automation/AutomationRunCoordinator";
import { previewAutomationCron } from "../automation/automationCron";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WebBodyTooLargeError, WebInvalidJsonError, WEB_CORS_HEADERS } from "./WebHttpResponders";
import { isWebAutomationValidationError, parseWebAutomationCreateBody, parseWebAutomationUpdateBody, toWebAutomationRun, toWebAutomationSnapshot, toWebAutomationTask } from "./WebAutomationProjection";

const MAX_AUTOMATION_BODY_BYTES = 256 * 1024;

export type WebAutomationRoutesDeps = {
	store: () => AutomationStore | null;
	runs: () => AutomationRunCoordinator | null;
	projects: { get: (projectId: string) => Project | undefined };
	/** 审计出口（测试可注入）。 */
	log?: (message: string, details: Record<string, unknown>) => void;
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, code: string, message: string, field?: string): void {
	sendJson(response, status, { code, message, ...(field ? { field } : {}) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 协调器/Store 的错误 → 可读 HTTP（不把内部堆栈透给浏览器）。 */
function mapAutomationError(error: unknown): { status: number; code: string; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	if (message === "Automation task not found" || message === "Automation run not found") return { status: 404, code: "webError.automationNotFound", message: "automation not found" };
	if (/already (running|active)|task-already-running|single-flight/i.test(message)) return { status: 409, code: "webError.automationBusy", message: "task already has an active run" };
	return { status: 400, code: "webError.automationFailed", message };
}

export class WebAutomationRoutes {
	constructor(private readonly deps: WebAutomationRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/automations" && !url.pathname.startsWith("/api/automations/")) return false;
		try {
			if (url.pathname === "/api/automations" && request.method === "GET") return this.list(url, response);
			if (url.pathname === "/api/automations/create" && request.method === "POST") return await this.create(request, response);
			if (url.pathname === "/api/automations/update" && request.method === "POST") return await this.update(request, response);
			if (url.pathname === "/api/automations/delete" && request.method === "POST") return await this.remove(request, response);
			if (url.pathname === "/api/automations/run" && request.method === "POST") return await this.run(request, response);
			if (url.pathname === "/api/automations/abort" && request.method === "POST") return await this.abort(request, response);
			if (url.pathname === "/api/automations/clear-runs" && request.method === "POST") return await this.clearRuns(request, response);
			if (url.pathname === "/api/automations/preview-cron" && request.method === "GET") return this.previewCron(url, response);
			sendError(response, 405, "webError.methodNotAllowed", "method not allowed");
			return true;
		} catch (error) {
			const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
			if (name === "WebBodyTooLargeError") {
				sendError(response, 413, "webError.bodyTooLarge", "payload too large");
				return true;
			}
			if (name === "WebInvalidJsonError") {
				sendError(response, 400, "webError.invalidJson", "invalid JSON body");
				return true;
			}
			if (isWebAutomationValidationError(error)) {
				sendError(response, 400, "webError.invalidAutomation", error.message, error.field);
				return true;
			}
			const mapped = mapAutomationError(error);
			this.log("request.failed", { status: mapped.status, code: mapped.code });
			sendError(response, mapped.status, mapped.code, mapped.message);
			return true;
		}
	}

	private list(url: URL, response: ServerResponse): boolean {
		const store = this.deps.store();
		if (!store) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const taskId = url.searchParams.get("taskId")?.trim() || undefined;
		const limitRaw = Number(url.searchParams.get("limit") ?? "");
		const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.trunc(limitRaw)) : 50;
		const snapshot = store.getSnapshot();
		sendJson(response, 200, toWebAutomationSnapshot(snapshot, { taskId, limit }));
		return true;
	}

	private async create(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const store = this.deps.store();
		if (!store) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const body = await this.readBody(request);
		const input = parseWebAutomationCreateBody(body);
		this.assertProject(input.projectId);
		const task = await store.createTask(input);
		this.log("create", { taskId: task.id, projectId: task.projectId });
		sendJson(response, 200, { task: toWebAutomationTask(task) });
		return true;
	}

	private async update(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const store = this.deps.store();
		if (!store) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const body = await this.readBody(request);
		const { taskId, patch } = parseWebAutomationUpdateBody(body);
		if (patch.projectId) this.assertProject(patch.projectId);
		const task: AutomationTask = await store.updateTask(taskId, patch as UpdateAutomationTaskInput);
		this.log("update", { taskId: task.id, projectId: task.projectId });
		sendJson(response, 200, { task: toWebAutomationTask(task) });
		return true;
	}

	private async remove(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const store = this.deps.store();
		if (!store) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const body = await this.readBody(request);
		const taskId = this.requireTaskId(body);
		const removed = await store.deleteTask(taskId);
		if (!removed) {
			sendError(response, 404, "webError.automationNotFound", "automation not found");
			return true;
		}
		this.log("delete", { taskId });
		sendJson(response, 200, { ok: true });
		return true;
	}

	private async run(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const coordinator = this.deps.runs();
		if (!coordinator) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const body = await this.readBody(request);
		const taskId = this.requireTaskId(body);
		const run = await coordinator.runNow(taskId);
		this.log("run", { taskId, runId: run.id });
		sendJson(response, 200, { run: toWebAutomationRun(run) });
		return true;
	}

	private async abort(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const coordinator = this.deps.runs();
		if (!coordinator) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		const body = await this.readBody(request);
		const runId = typeof body.runId === "string" ? body.runId.trim() : "";
		if (!runId || runId.length > 128) {
			sendError(response, 400, "webError.invalidAutomation", "runId is required", "runId");
			return true;
		}
		const aborted = await coordinator.abortRun(runId);
		if (!aborted) {
			sendError(response, 409, "webError.automationNotActive", "run is not active");
			return true;
		}
		this.log("abort", { runId });
		sendJson(response, 200, { ok: true });
		return true;
	}

	private async clearRuns(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const store = this.deps.store();
		if (!store) {
			sendError(response, 503, "webError.automationUnavailable", "automation is not available");
			return true;
		}
		// 读掉 body（校验是有界 JSON），clear-runs 本身无入参。
		await this.readBody(request);
		const removed = await store.clearTerminalRuns();
		this.log("clear-runs", { removed });
		sendJson(response, 200, { removed });
		return true;
	}

	private previewCron(url: URL, response: ServerResponse): boolean {
		const expression = url.searchParams.get("expression")?.trim() ?? "";
		if (!expression) {
			sendError(response, 400, "webError.invalidAutomation", "expression is required", "expression");
			return true;
		}
		let preview: AutomationCronPreview;
		try {
			const nextRuns = previewAutomationCron(expression, new Date(), 5).map((date) => date.getTime());
			preview = { valid: true, nextRuns };
		} catch (error) {
			preview = { valid: false, error: error instanceof Error ? error.message : "invalid cron expression" };
		}
		sendJson(response, 200, preview);
		return true;
	}

	private requireTaskId(body: Record<string, unknown>): string {
		const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
		if (!taskId || taskId.length > 128) throw Object.assign(new Error("taskId is required"), { name: "WebAutomationValidationError", field: "taskId" });
		return taskId;
	}

	/** 项目归属：必须存在且不是 chat（与桌面自动化一致）。 */
	private assertProject(projectId: string): void {
		const project = this.deps.projects.get(projectId);
		if (!project) throw Object.assign(new Error("project not found"), { name: "WebAutomationValidationError", field: "projectId" });
		if (project.kind === "chat") throw Object.assign(new Error("automation requires a project"), { name: "WebAutomationValidationError", field: "projectId" });
	}

	private readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
		return readJson<Record<string, unknown>>(request, MAX_AUTOMATION_BODY_BYTES).then((parsed) => (isPlainObject(parsed) ? parsed : {}));
	}

	private log(message: string, details: Record<string, unknown>): void {
		if (this.deps.log) this.deps.log(message, details);
		else void getAppLogger()?.info("web-automation", message, details);
	}
}
