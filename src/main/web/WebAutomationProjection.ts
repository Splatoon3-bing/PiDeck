/**
 * 自动化 → Web 安全投影 + 写入白名单（T8 S1）
 *
 * 白名单与设置路由同一纪律：只有这里登记的键可写，未知键 400（`Object.hasOwn`，
 * 防 constructor/toString 等原型链键绕过）；值在路由层先做类型/范围预检，再交给
 * `AutomationStore` 的归一化（cron/预算/长度）做第二道。
 *
 * 投影只做「少给」：task.prompt 截断、run 去掉内部身份、error/events 截断。
 */
import type { AutomationBudget, AutomationRun, AutomationRunEvent, AutomationRunEventType, AutomationSchedule, AutomationSettings, AutomationSnapshot, AutomationTaskMode, AutomationTaskSummary, CreateAutomationTaskInput, UpdateAutomationTaskInput, WebAutomationRun, WebAutomationTask } from "../../shared/types";

const MAX_PROMPT_CHARS = 100_000;
const MAX_PROJECTED_PROMPT_CHARS = 20_000;
const MAX_RUN_ERROR_CHARS = 2 * 1024;
const MAX_EVENT_MESSAGE_CHARS = 512;
const MAX_PROJECTED_EVENTS = 50;

export class WebAutomationValidationError extends Error {
	readonly field: string;
	constructor(field: string, message: string) {
		super(message);
		this.name = "WebAutomationValidationError";
		this.field = field;
	}
}

/** 跨 realm 判定：只认 name+field（与 WebSettingsValidationError 同理由）。 */
export function isWebAutomationValidationError(error: unknown): error is WebAutomationValidationError {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; field?: unknown };
	return candidate.name === "WebAutomationValidationError" && typeof candidate.field === "string";
}

function fail(field: string, message: string): never {
	throw new WebAutomationValidationError(field, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!Object.hasOwn(value, key) || !allowed.includes(key)) fail(key, `unknown ${label} field: ${key}`);
	}
}

function parseSchedule(raw: unknown): AutomationSchedule {
	if (!isPlainObject(raw)) fail("schedule", "schedule must be an object");
	if (raw.type === "manual") return { type: "manual" };
	if (raw.type === "cron" && typeof raw.expression === "string" && raw.expression.trim().length > 0 && raw.expression.length <= 128) {
		return { type: "cron", expression: raw.expression.trim() };
	}
	return fail("schedule", "schedule must be {type:'manual'} or {type:'cron',expression}");
}

const BACKENDS = new Set(["pi", "dsh", "acp"]);
const MODES = new Set(["normal", "plan", "goal"]);
const BUDGET_KEYS = ["timeoutMs", "maxTokens", "maxCostUsd", "maxSteps"] as const;

function parseBudget(raw: unknown): Partial<AutomationBudget> | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) fail("budget", "budget must be an object");
	requireKeys(raw, BUDGET_KEYS, "budget");
	const budget: Record<string, number | null> = {};
	for (const key of BUDGET_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (value === null) {
			budget[key] = null;
			continue;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(key, `${key} must be a non-negative number or null`);
		budget[key] = key === "maxCostUsd" ? value : Math.floor(value);
	}
	return budget as Partial<AutomationBudget>;
}

function parseName(raw: unknown): string {
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!name || name.length > 200) fail("name", "name must be 1-200 characters");
	return name;
}

function parseProjectId(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim() || raw.length > 256) fail("projectId", "projectId is required");
	return raw;
}

function parsePrompt(raw: unknown): string {
	const prompt = typeof raw === "string" ? raw : "";
	if (!prompt.trim()) fail("prompt", "prompt is required");
	if (prompt.length > MAX_PROMPT_CHARS) fail("prompt", `prompt must be <= ${MAX_PROMPT_CHARS} characters`);
	return prompt;
}

function parseEnabled(raw: unknown): boolean {
	if (typeof raw !== "boolean") fail("enabled", "enabled must be a boolean");
	return raw;
}

function parseBackend(raw: unknown): Exclude<CreateAutomationTaskInput["backend"], undefined> {
	if (typeof raw !== "string" || !BACKENDS.has(raw)) fail("backend", "backend must be pi, dsh or acp");
	return raw as Exclude<CreateAutomationTaskInput["backend"], undefined>;
}

function parseMode(raw: unknown): AutomationTaskMode {
	if (typeof raw !== "string" || !MODES.has(raw)) fail("mode", "mode must be normal, plan or goal");
	return raw as AutomationTaskMode;
}

/** patch 语义：只归一化出现过的键（未传字段由 Store 保持原值）。 */
function parsePatch(raw: Record<string, unknown>): UpdateAutomationTaskInput {
	const patch: UpdateAutomationTaskInput = {};
	if ("name" in raw) patch.name = parseName(raw.name);
	if ("projectId" in raw) patch.projectId = parseProjectId(raw.projectId);
	if ("prompt" in raw) patch.prompt = parsePrompt(raw.prompt);
	if ("schedule" in raw) patch.schedule = parseSchedule(raw.schedule);
	if ("enabled" in raw) patch.enabled = parseEnabled(raw.enabled);
	if ("backend" in raw) patch.backend = parseBackend(raw.backend);
	if ("mode" in raw) patch.mode = parseMode(raw.mode);
	if ("budget" in raw) patch.budget = parseBudget(raw.budget) ?? {};
	return patch;
}

const CREATE_KEYS = ["name", "projectId", "prompt", "schedule", "enabled", "backend", "mode", "budget"] as const;
const UPDATE_KEYS = CREATE_KEYS;

/** 创建入参：只接受 v1 白名单字段；未知键 400（不部分写入）。 */
export function parseWebAutomationCreateBody(body: unknown): CreateAutomationTaskInput {
	if (!isPlainObject(body)) fail("body", "body must be an object");
	requireKeys(body, CREATE_KEYS, "automation");
	const input = parsePatch(body);
	if (!input.name || !input.projectId || !input.prompt || !input.schedule) fail("body", "name, projectId, prompt and schedule are required");
	return input as CreateAutomationTaskInput;
}

/** 更新入参：patch 语义（未传字段保持原值），字段集与创建一致。 */
export function parseWebAutomationUpdateBody(body: unknown): { taskId: string; patch: UpdateAutomationTaskInput } {
	if (!isPlainObject(body)) fail("body", "body must be an object");
	requireKeys(body, ["taskId", "patch"], "automation");
	if (typeof body.taskId !== "string" || !body.taskId.trim() || body.taskId.length > 128) fail("taskId", "taskId is required");
	if (!isPlainObject(body.patch)) fail("patch", "patch must be an object");
	requireKeys(body.patch, UPDATE_KEYS, "automation patch");
	return { taskId: body.taskId, patch: parsePatch(body.patch) };
}

function truncate(text: string | undefined, limit: number): string | undefined {
	if (typeof text !== "string") return undefined;
	return text.length > limit ? text.slice(0, limit) : text;
}

export function toWebAutomationTask(task: AutomationTaskSummary): WebAutomationTask {
	if (task.prompt.length <= MAX_PROJECTED_PROMPT_CHARS) return task;
	return { ...task, prompt: task.prompt.slice(0, MAX_PROJECTED_PROMPT_CHARS), promptTruncated: true };
}

function toWebAutomationRunEvent(event: AutomationRunEvent): WebAutomationRun["events"][number] {
	const message = truncate(event.message, MAX_EVENT_MESSAGE_CHARS);
	return { id: event.id, type: event.type as AutomationRunEventType, at: event.at, ...(message ? { message } : {}) };
}

export function toWebAutomationRun(run: AutomationRun): WebAutomationRun {
	const { agentId: _agentId, runtimeGeneration: _generation, events, error, ...rest } = run;
	const trimmedError = truncate(error, MAX_RUN_ERROR_CHARS);
	return {
		...rest,
		...(trimmedError ? { error: trimmedError } : {}),
		events: events.slice(-MAX_PROJECTED_EVENTS).map(toWebAutomationRunEvent),
	};
}

export function toWebAutomationSnapshot(input: Pick<AutomationSnapshot, "revision" | "settings" | "tasks" | "runs">, options: { taskId?: string; limit?: number } = {}): { revision: number; settings: AutomationSettings; tasks: WebAutomationTask[]; runs: WebAutomationRun[] } {
	const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
	const runs = input.runs
		.filter((run) => (options.taskId ? run.taskId === options.taskId : true))
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, limit)
		.map(toWebAutomationRun);
	return {
		revision: input.revision,
		settings: input.settings,
		tasks: input.tasks.map(toWebAutomationTask),
		runs,
	};
}
