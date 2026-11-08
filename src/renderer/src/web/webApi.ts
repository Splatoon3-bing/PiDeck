/**
 * webApi — Web 端与主进程 WebServiceManager 的 HTTP 数据访问层。
 *
 * 覆盖范围（与桌面端对齐但收窄）：
 * - /api/state：项目/会话/运行态轮询
 * - /api/sessions（POST）：按项目新建会话
 * - /api/sessions/:id/messages/page：历史完整轮次分页（URL 保持兼容）
 * - 发送消息走 useChat（/api/chat 流式），不在此处重复实现
 */
import type { UIMessage } from "ai";
import type { AvailableModel, AgentBackend, ChatMessage, SessionCommandResult, SessionLaunchPreferences, SessionMessagePage, SessionRuntimeInfo, SessionRuntimeTarget, SessionSearchResult, SessionTargetedValue, SessionTodoSnapshot, UpdateSessionRecordInput } from "../../../shared/types";
import type { CommitEntry, GitBranchInfo, GitResourceGroups, ImageContent, PiExtensionSummary, PiSkillLocation, PiSkillSummary, PiSubagentEntry, YaoPromptCategory, ProviderUsageResult, UsageProbeBackend } from "../../../shared/types";
import type { AgentUiResponse } from "../../../shared/types";
import type { WebSecurityState } from "../../../shared/types";
import type { SafeWebSettings, WebWritableSettings } from "../../../shared/types";
import type { AutomationCronPreview, CreateAutomationTaskInput, UpdateAutomationTaskInput, WebAutomationRun, WebAutomationSnapshot, WebAutomationTask } from "../../../shared/types";
import type { WebContextUsage, WebFileNodeLite, WebState } from "./webTypes";
import type { AgentInvokeInput, AgentProfile } from "../../../shared/types/agentProfile";
import type { WebAgentSnapshot } from "../../../main/web/WebAgentRoutes";
import type { FavoriteEntry } from "../../../shared/types/favorites";

// Web 服务令牌：与 browserApi 同型（同一 localStorage key），从二维码/分享链接的 ?token= 读取一次并持久化。
// 之后所有请求统一带 Authorization: Bearer；环回绑定服务端不校验，无令牌时照常工作。
export const WEB_TOKEN_STORAGE_KEY = "pideck-web-token";
// Node 测试（loadTsCommonJs 无 window）不执行捕获；浏览器加载时从 ?token= 读取一次并持久化。
let webToken: string | null = null;
if (typeof window !== "undefined") {
	const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
	if (tokenFromUrl) window.localStorage.setItem(WEB_TOKEN_STORAGE_KEY, tokenFromUrl);
	webToken = window.localStorage.getItem(WEB_TOKEN_STORAGE_KEY);
}

/** 请求注入用的鉴权头；无令牌时返回空对象（环回绑定不校验，省略即可）。 */
export function getWebAuthHeaders(): Record<string, string> {
	return webToken ? { authorization: `Bearer ${webToken}` } : {};
}

/** 生图产物地址：`<img>` 不能带 Authorization，GET 走 `?token=`（与 SSE 同一套令牌链）。 */
export function webImageBlobUrl(ref: string): string {
	return `/api/imagegen/blob/${encodeURIComponent(ref)}${webToken ? `?token=${encodeURIComponent(webToken)}` : ""}`;
}

/** 当前令牌（SSE 类连接用：EventSource 无法携带 Authorization header，只能拼 query）。 */
export function getWebToken(): string | null {
	return webToken;
}

/** 统一出口：合并鉴权头后转发给 fetch；调用方原有 headers 优先。 */
let authFailureNotified = false;
function apiFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(input, {
		...init,
		headers: { ...getWebAuthHeaders(), ...init?.headers },
	}).then((res) => {
		// 401 兑底 UX：令牌轮换/失效时所有轮询都会 401，这里统一广播一次
		// 「需要重新扫码」事件（任意成功响应后复位，可再次触发）。
		if (res.status === 401) {
			if (!authFailureNotified && typeof window !== "undefined") {
				authFailureNotified = true;
				window.dispatchEvent(new CustomEvent("pideck-web-auth-failed"));
			}
		} else if (res.ok) {
			authFailureNotified = false;
		}
		return res;
	});
}

/**
 * 轮询 /api/state 拿项目/会话/运行态（低频兜底，主数据流走 useChat）。
 *
 * 条件请求：服务端给 ETag，未变化时回 304。返回 null 表示「和上次一样」，
 * 调用方直接保持现有 state（不 setState → 不重建会话数组、不触发下游重算）。
 * 载荷含全部会话投影（500+ 条约 228KB），这一步把空闲轮询的流量降到几十字节。
 */
let lastStateEtag: string | null = null;
export async function fetchState(): Promise<WebState | null> {
	const res = await apiFetch("/api/state", {
		headers: lastStateEtag ? { "if-none-match": lastStateEtag } : undefined,
	});
	if (res.status === 304) return null;
	if (!res.ok) throw new Error(`state ${res.status}`);
	const etag = res.headers.get("etag");
	lastStateEtag = etag ?? null;
	return (await res.json()) as WebState;
}

/** 从 Web 端注册一个本地项目路径，返回项目记录。 */
export async function createProject(path: string): Promise<WebState["projects"][number]> {
	const res = await apiFetch("/api/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	if (!res.ok) throw new Error(`create project ${res.status}`);
	const result = (await res.json()) as { project?: WebState["projects"][number] };
	if (!result.project) throw new Error("create project: missing project");
	return result.project;
}

/** 删除项目登记记录；不会删除项目目录或工作区文件。 */
export async function deleteProject(projectId: string): Promise<void> {
	const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete project ${res.status}`);
}

/** 读取 pi 当前可用模型，草稿会话也可以先选模型再发送第一条消息。
 * force：绕过服务端模型列表缓存（对应选择器刷新按钮）。 */
export async function fetchModels(force = false): Promise<AvailableModel[]> {
	const res = await apiFetch(force ? "/api/models?force=1" : "/api/models");
	if (!res.ok) throw new Error(`models ${res.status}`);
	const result = (await res.json()) as { models?: AvailableModel[] };
	return result.models ?? [];
}

/** 按项目新建会话（对应桌面端「新建 Agent」入口）。返回新会话 id。 */
/**
 * 新建会话草稿；preferences 携带启动前选择的模型/思考级别/后端（首页直发场景），
 * 无偏好时保持后端默认（pi 配置默认值）。backend 对应 CreateSessionDraftInput.backend。
 */
export async function createSession(projectId: string, preferences?: SessionLaunchPreferences & { backend?: AgentBackend; acpToolId?: string }): Promise<string> {
	const res = await apiFetch("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, ...preferences }),
	});
	if (!res.ok) throw new Error(`create session ${res.status}`);
	const result = (await res.json()) as { session?: { id?: string } };
	const id = result.session?.id;
	if (!id) throw new Error("create session: missing session id");
	return id;
}

/** 拉历史消息页（分页），供注入 useChat / 展示。 */
/** 更新尚未启动 runtime 的会话偏好；运行中的会话由 runtime 命令即时应用。 */
export async function updateSessionRecord(sessionId: string, patch: UpdateSessionRecordInput): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update session ${res.status}`);
}

async function callRuntimeCommand<T>(sessionId: string, target: SessionRuntimeTarget, action: string, body: Record<string, unknown> = {}): Promise<T> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, ...body }),
	});
	if (!res.ok) throw new Error(`runtime ${action} ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionTargetedValue<T>> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? `runtime ${action} failed`);
	}
	return result.value.value;
}

/** fork/clone 专用命令：服务端返回 SessionForkResult（单层 value，非 SessionTargetedValue 双层），
 * 不能用 callRuntimeCommand 解包（会拿到 undefined）。与桌面 preload sessionsRuntimeFork 同形。 */
export type WebForkResult = { cancelled?: boolean; text?: string; targetSessionId?: string; [key: string]: unknown };

async function callForkCommand(sessionId: string, target: SessionRuntimeTarget | null, action: string, body: Record<string, unknown> = {}): Promise<WebForkResult> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, ...body }),
	});
	if (!res.ok) throw new Error(`runtime ${action} ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<WebForkResult> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? `runtime ${action} failed`);
	}
	return result.value ?? {};
}

/** 运行中的模型切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeModel(target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "model", { provider, modelId, modelName });
}

/** 运行中的思考级别切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeThinking(target: SessionRuntimeTarget, level: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "thinking", { level });
}

/** 运行中的 DSH 权限切换走 runtime 命令，避免 `/permission` 进入普通消息流。 */
export function setRuntimePermission(target: SessionRuntimeTarget, preset: string): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "permission", { preset });
}

/**
 * Pi 会话安全等级切换（levelId=null 清除会话覆盖、跟随全局默认）。
 *
 * 与 DSH 权限预设是两套机制：这里写的是 SecurityStore（策略快照），由服务端校验
 * 会话/后端/等级后落盘，返回投影后的最新安全配置；不要用前端本地状态假装已切换。
 */
export async function setSessionSecurityLevel(sessionId: string, levelId: string | null): Promise<WebSecurityState> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/security-level`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ levelId }),
	});
	if (!res.ok) throw new Error(`security level ${res.status}`);
	const body = (await res.json()) as { security?: WebSecurityState };
	if (!body.security) throw new Error("security level: missing security");
	return body.security;
}

/** 手机/Web 端回答 ask_question / confirm / input。 */
export async function respondToUi(input: { sessionId: string; requestId: string; agentId: string; runtimeGeneration: number; response: AgentUiResponse }): Promise<void> {
	const res = await apiFetch("/api/ui-response", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) throw new Error(`ui-response ${res.status}`);
}

/**
 * 会话内全文检索（跨全会话，不限已加载历史）：与桌面端 Ctrl+Shift+F 同源。
 *
 * 返回 `null` 表示「检索源不可用」（索引未就绪 / 后端不支持），调用方应回退本地已加载
 * 搜索——这与桌面端 `sessions:search-in-session` 的 null 语义完全一致，绝不能把它当成
 * 「没有匹配」展示。命中 `messageId` 是会话 JSONL 行 id，与 Web UIMessage.id 同源。
 */
export async function fetchSessionSearch(sessionId: string, query: string): Promise<SessionSearchResult | null> {
	const trimmed = query.trim();
	if (!trimmed) return null;
	const params = new URLSearchParams({ q: trimmed });
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/search?${params.toString()}`);
	if (!res.ok) return null;
	const body = (await res.json()) as { result?: SessionSearchResult | null };
	return body.result ?? null;
}

export async function fetchMessagePage(sessionId: string, before?: number, pageSize?: number): Promise<SessionMessagePage> {
	const params = new URLSearchParams();
	if (before != null) params.set("before", String(before));
	if (pageSize != null) params.set("pageSize", String(pageSize));
	const qs = params.toString();
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${qs ? `?${qs}` : ""}`);
	if (!res.ok) throw new Error(`messages ${res.status}`);
	return (await res.json()) as SessionMessagePage;
}

/**
 * 历史 ChatMessage 列表 → useChat 的 UIMessage[]。
 * - text/thinking：同前（正文 + reasoning part）。
 * - P2：用户消息 images → file part（data URL），工具消息（role="tool"，meta 携带
 *   toolName/args/result/detailText）→ `tool-${name}` part（output-available/error），
 *   历史会话也能展开工具卡片；流式期间的实时工具由 SSE 构建，不与此重叠。
 */
export function chatMessagesToUiMessages(messages: ChatMessage[]): UIMessage[] {
	const result: UIMessage[] = [];
	for (const message of messages) {
		const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "assistant";
		const parts: UIMessage["parts"] = [];
		if (message.role === "tool") {
			const meta = message.meta as Record<string, unknown> | undefined;
			const toolName = typeof meta?.toolName === "string" && meta.toolName ? meta.toolName : "";
			if (toolName) {
				const isError = meta?.isError === true || message.text.startsWith("✗");
				let input: unknown = meta?.args;
				if (typeof input === "string" && input) {
					try {
						input = JSON.parse(input);
					} catch {
						// 已是截断的非 JSON 字符串时原样展示
					}
				}
				// 动态工具 part 名是运行期拼的（`tool-${name}`），ai SDK 静态类型覆盖不了；
				// 与 WebTimeline:151 对 SSE part 的同型转换保持一致。
				const toolPart = {
					type: `tool-${toolName}` as `tool-${string}`,
					toolCallId: `hist-${message.id}`,
					state: isError ? "output-error" : "output-available",
					input,
					output: meta?.result,
					errorText: isError ? (typeof meta?.detailText === "string" ? meta.detailText : message.text) : undefined,
				};
				parts.push(toolPart as unknown as UIMessage["parts"][number]);
			} else if (message.text) {
				parts.push({ type: "text", text: message.text });
			}
			// meta 携带 entryId/toolName 等，fork 化重发需要 metadata.entryId 解析 fork 锚点
			result.push({ id: message.id ?? `hist-${message.timestamp ?? Math.random()}`, role: "assistant", parts, metadata: message.meta as UIMessage["metadata"] });
			continue;
		}
		if (message.thinking) {
			parts.push({ type: "reasoning", text: message.thinking });
		}
		if (message.text) {
			parts.push({ type: "text", text: message.text });
		}
		// P2：历史用户图片 → file part（data URL）。超大数据防护：单张 >4MB 直接跳过
		// （页端已有界，这里只防异常大图拖垮渲染层）。
		if (Array.isArray(message.images)) {
			for (const image of message.images) {
				if (image?.type !== "image" || typeof image.mimeType !== "string") continue;
				// 生图历史只存 ref（base64 不进 JSONL）：展示走主进程 blob 路由，不把字节塞回消息对象。
				if (typeof image.data !== "string" || !image.data) {
					if (typeof image.ref === "string" && image.ref) parts.push({ type: "file", mediaType: image.mimeType, url: webImageBlobUrl(image.ref) } as unknown as UIMessage["parts"][number]);
					continue;
				}
				if (image.data.length > 4 * 1024 * 1024) continue;
				parts.push({ type: "file", mediaType: image.mimeType, data: `data:${image.mimeType};base64,${image.data}` } as unknown as UIMessage["parts"][number]);
			}
		}
		result.push({
			id: message.id ?? `hist-${message.timestamp ?? Math.random()}`,
			role,
			parts,
			// metadata 透传 meta（含 entryId）：fork 化重发/编辑的锚点解析依赖它
			metadata: message.meta as UIMessage["metadata"],
		});
	}
	return result;
}

// ── DSH 工具面板（S6.3：goals/subagents/skills，走 REST，与桌面 IPC 同源）──

export type WebDshSubagent = {
	id: string;
	label?: string;
	activity: "running" | "inactive";
	hasChildren: boolean;
	mode: "one-shot" | "continuable";
	kind: "child" | "diagnostic";
};

export type WebDshSkill = {
	name: string;
	description: string;
	whenToUse?: string;
	modelInvocable: boolean;
};

export type WebDshGoal = {
	refId: string;
	revision: number;
	objective: string;
	phase: "active" | "paused" | "blocked" | "complete";
	maxGoalRounds: number;
	roundsStarted: number;
};

async function getJson<T>(path: string, fallback: T): Promise<T> {
	const res = await apiFetch(path);
	if (!res.ok) return fallback;
	return (await res.json()) as T;
}

/** 会话的子代理目录（需活跃 runtime；无则返回空）。 */
export function fetchDshSubagents(sessionId: string): Promise<{ subagents: WebDshSubagent[] }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents`, { subagents: [] });
}

/** 子代理只读 transcript（分页）。 */
export function fetchDshSubagentHistory(sessionId: string, childSessionId: string): Promise<{ messages: Array<{ role: string; text: string }>; hasMore: boolean }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/subagents/${encodeURIComponent(childSessionId)}/history`, { messages: [], hasMore: false });
}

/** 会话技能目录（skill.list 只读）。 */
export function fetchDshSkills(sessionId: string): Promise<{ skills: WebDshSkill[] }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/skills`, { skills: [] });
}

/** 会话当前目标（runtime state 投影；无 runtime/无目标返回 null）。 */
export function fetchDshGoal(sessionId: string): Promise<{ goal: WebDshGoal | null }> {
	return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/dsh/goal`, { goal: null });
}

// ── DSH 插件（S6.5：动态 Cordis 插件，与桌面配置页同源）──────────────────

export type WebDshPluginPackage = {
	packageId: string;
	name: string;
	purpose: string;
	hasHostHalf: boolean;
	hasClientHalf: boolean;
};

export type WebDshPlugin = {
	pluginId: string;
	agentId: string;
	packages: WebDshPluginPackage[];
	currentPackageId?: string;
	nextPackageId?: string;
	activeRun?: { pluginRunId: string; packageId: string };
	status?: string;
	mode?: string;
	error?: string;
};

export type WebDshStaticPlugin = {
	entryId: string;
	moduleName: string;
	enabled: boolean;
	fiberPhase: string | null;
	/** 来源：user = $DSH_HOME/cordis.patch.yml 用户补丁层；缺省视为 builtin（旧 host 兼容）。 */
	origin?: "builtin" | "user";
};

/** 动态 + 静态插件清单（全局；install 需按会话归属）。 */
export function fetchDshPlugins(): Promise<{ dynamic: WebDshPlugin[]; static: WebDshStaticPlugin[] }> {
	return getJson("/api/dsh/plugins", { dynamic: [], static: [] });
}

/** 安装动态插件（define：定义源码包，不运行；hostCode 在 host 进程内执行——非安全边界）。 */
export async function installDshPlugin(input: { sessionId: string; idPrefix: string; name: string; purpose: string; hostCode: string }): Promise<unknown> {
	const res = await apiFetch("/api/dsh/plugins/install", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `install plugin ${res.status}`);
	}
	return (await res.json()) as unknown;
}

/** 动态插件生命周期（run/stop/uninstall；面板手势 requestId=null 无需审批）。 */
export async function dshPluginAction(pluginId: string, action: "run" | "stop" | "uninstall", input: { sessionId: string; packageId?: string }): Promise<unknown> {
	const res = await apiFetch(`/api/dsh/plugins/${encodeURIComponent(pluginId)}/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `plugin ${action} ${res.status}`);
	}
	return (await res.json()) as unknown;
}

// ── P0-P3 会话/运行时控制与工作区扩展 ──────────────────────────────────

/** P0：停止（优雅）当前 runtime。 */
export function stopRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "stop");
}

/** P0：打断（立即）当前 runtime——流式中停止按钮走这里，pi 会丢弃未完成回合。 */
export function abortRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "abort");
}

/** P1：重启会话进程（会话身份不变）。 */
export function restartRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "restart");
}

/** P1：压缩上下文（可选自定义 prompt）。 */
export function compactRuntime(sessionId: string, target: SessionRuntimeTarget, prompt?: string): Promise<unknown> {
	return callRuntimeCommand<unknown>(sessionId, target, "compact", prompt ? { prompt } : {});
}

/** P1：克隆会话（fork 标记；返回 WebForkResult，含 targetSessionId；切换由调用方决定）。 */
export function cloneRuntime(sessionId: string, target: SessionRuntimeTarget): Promise<WebForkResult> {
	return callForkCommand(sessionId, target, "clone");
}

/** P1：重命名会话（走 catalog update，不需要 runtime）。 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`rename session ${res.status}`);
}

/** P1：删除会话记录（含会话文件）。 */
export async function deleteSession(sessionId: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete session ${res.status}`);
}

/** P1：复制会话（浅拷贝生成新会话记录）。 */
export async function copySession(sessionId: string): Promise<string | undefined> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/copy`, { method: "POST" });
	if (!res.ok) throw new Error(`copy session ${res.status}`);
	const payload = (await res.json()) as { result?: { session?: { id?: string } } };
	return payload.result?.session?.id;
}

/** P1/P3：导出会话 HTML 并在浏览器端触发下载（GET 附件流，鉴权头由 fetch 携带）。 */
export async function downloadSessionHtml(sessionId: string): Promise<void> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/export-html`);
	if (!res.ok) throw new Error(`export html ${res.status}`);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `pideck-session-${sessionId.replace(/[^\w.-]+/g, "_")}.html`;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}

/** P1：编辑历史用户消息——pi 走 fork 化（见 WebChatApp runForkMutation），此处仅供 DSH（runtime 必须存活）。 */
export function editRuntimeMessage(sessionId: string, target: SessionRuntimeTarget, messageId: string, newText: string): Promise<void> {
	return callRuntimeCommand<void>(sessionId, target, "edit-message", { messageId, newText });
}

/** P1：删除单条历史消息（两端共用，非 fork 化路径）。 */
export function deleteRuntimeMessage(sessionId: string, target: SessionRuntimeTarget, messageId: string): Promise<void> {
	return callRuntimeCommand<void>(sessionId, target, "delete-message", { messageId });
}

/** P1：准备重发——取回该消息文本（+图片）；fork 化路径用它作 entryId 文本回退与重投递内容。 */
export function prepareResend(sessionId: string, target: SessionRuntimeTarget, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
	return callRuntimeCommand<{ text: string; images?: ImageContent[] }>(sessionId, target, "prepare-resend", { messageId });
}

/** P1：冷会话激活（与桌面 sessionsRuntimeActivate 同源）——Web 重发/编辑 fork 化的前置：无 runtime 的历史会话先激活再 fork。 */
export async function activateRuntime(sessionId: string): Promise<SessionRuntimeTarget> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/activate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({}),
	});
	if (!res.ok) throw new Error(`runtime activate ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionRuntimeInfo> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? "runtime activate failed");
	}
	return { sessionId, agentId: result.value.agentId, runtimeGeneration: result.value.runtimeGeneration };
}

/** P1：列出可 fork 的历史轮次（entryId + 文本），供 fork 化重发/编辑的 entryId 解析。 */
export function getForkMessages(sessionId: string, target: SessionRuntimeTarget): Promise<Array<{ entryId: string; text: string }>> {
	return callRuntimeCommand<Array<{ entryId: string; text: string }>>(sessionId, target, "get-fork-messages");
}

/** P1：fork 会话（与桌面 sessionsRuntimeFork 同源同参）。mutationFork=true 且非 branchMode =
 * 尾部重发/编辑替换：旧会话打 supersededBy 从列表隐藏，新会话继承原标题；否则分支模式新旧并存。 */
export function forkRuntimeSession(sessionId: string, target: SessionRuntimeTarget, entryId: string, options: { mutationFork?: boolean; branchMode?: boolean } = {}): Promise<WebForkResult> {
	return callForkCommand(sessionId, target, "fork", { entryId, ...options });
}

/** P2：上下文用量（runtime state 子集，供头部圆环轮询）。 */
export async function fetchRuntimeContextUsage(sessionId: string, target: SessionRuntimeTarget): Promise<WebContextUsage> {
	const usage = await callRuntimeCommand<WebContextUsage>(sessionId, target, "state");
	return usage ?? {};
}

/** 供应商额度/余额用量（与桌面圆球面板同源，走主进程 ConfigManager 用量探针）。
 *  该能力是用户显式开关的：未开启/供应商无可用端点时服务端也返回 success=false（恒 200），
 *  因此失败不是错误——调用方按 result.success 决定渲染与否，不弹 toast。 */
export async function fetchProviderUsage(provider: string, backend: UsageProbeBackend = "pi"): Promise<ProviderUsageResult> {
	const params = new URLSearchParams();
	if (backend === "dsh") params.set("backend", "dsh");
	const query = params.toString();
	const res = await apiFetch(`/api/usage/${encodeURIComponent(provider)}${query ? `?${query}` : ""}`);
	if (!res.ok) return { success: false, provider, disabled: true };
	const body = (await res.json()) as { result?: ProviderUsageResult };
	return body.result ?? { success: false, provider, disabled: true };
}

/** P2：提示词库搜索（中文提示词精选）。 */
export async function fetchPrompts(search?: string, category?: string, page = 1, pageSize = 20): Promise<{ categories: YaoPromptCategory[]; prompts: Array<{ slug: string; title: string; category: string; subcategory: string; tags: string[]; description: string }>; total?: number }> {
	const params = new URLSearchParams();
	if (search) params.set("search", search);
	if (category) params.set("category", category);
	params.set("page", String(page));
	params.set("pageSize", String(pageSize));
	const res = await apiFetch(`/api/prompts?${params.toString()}`);
	if (!res.ok) throw new Error(`prompts ${res.status}`);
	return (await res.json()) as { categories: YaoPromptCategory[]; prompts: Array<{ slug: string; title: string; category: string; subcategory: string; tags: string[]; description: string }>; total?: number };
}

/** P2：提示词正文（插入 composer 用）。 */
export async function fetchPromptContent(slug: string, category: string): Promise<string> {
	const params = new URLSearchParams({ category });
	const res = await apiFetch(`/api/prompts/${encodeURIComponent(slug)}?${params.toString()}`);
	if (!res.ok) throw new Error(`prompt detail ${res.status}`);
	const payload = (await res.json()) as { detail?: { promptContent?: string } };
	return payload.detail?.promptContent ?? "";
}

/** P3：git 状态（非 git 仓库返回 {repo:false}）。 */
export async function fetchGitStatus(projectId: string): Promise<{ repo: false } | { repo: true; branch: GitBranchInfo; groups: GitResourceGroups }> {
	const res = await apiFetch(`/api/git/status?projectId=${encodeURIComponent(projectId)}`);
	if (!res.ok) throw new Error(`git status ${res.status}`);
	return (await res.json()) as { repo: false } | { repo: true; branch: GitBranchInfo; groups: GitResourceGroups };
}

/** P3：工作区文件 diff（组内文件路径）。 */
export async function fetchGitDiff(projectId: string, group: "merge" | "index" | "workingTree" | "untracked", path: string): Promise<{ originalContent: string; modifiedContent: string } | null> {
	const params = new URLSearchParams({ group, path });
	const res = await apiFetch(`/api/git/diff?projectId=${encodeURIComponent(projectId)}&${params.toString()}`);
	if (!res.ok) throw new Error(`git diff ${res.status}`);
	const payload = (await res.json()) as { diff?: { originalContent: string; modifiedContent: string } | null };
	return payload.diff ?? null;
}

/** P3：最近提交。 */
export async function fetchGitLog(projectId: string, limit = 15): Promise<CommitEntry[]> {
	const res = await apiFetch(`/api/git/log?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
	if (!res.ok) throw new Error(`git log ${res.status}`);
	const payload = (await res.json()) as { commits?: CommitEntry[] };
	return payload.commits ?? [];
}

/** P3：项目内目录列表（dir 为项目相对路径，空 = 根）。 */
export async function fetchFileList(projectId: string, dir?: string): Promise<WebFileNodeLite[]> {
	const params = new URLSearchParams();
	if (dir) params.set("dir", dir);
	const qs = params.toString();
	const res = await apiFetch(`/api/files?projectId=${encodeURIComponent(projectId)}${qs ? `&${qs}` : ""}`);
	if (!res.ok) throw new Error(`files ${res.status}`);
	const payload = (await res.json()) as { nodes?: WebFileNodeLite[] };
	return payload.nodes ?? [];
}

/**
 * 文件内容读取失败的结构化错误：`code` 区分「需确认」（项目外/敏感文件）与「策略拒绝」，
 * `reason` 与主进程 evaluateUserReadAccess 的 reason 同名，供渲染层选文案。
 */
export class WebFileAccessError extends Error {
	readonly code: string;
	readonly reason: string | undefined;
	constructor(code: string, message: string, reason?: string) {
		super(message);
		this.name = "WebFileAccessError";
		this.code = code;
		this.reason = reason;
	}
}

/** 项目外预览的确认态：`confirm` 只把「需确认」降为放行，服务端仍会独立复核策略（deny 不降级）。 */
export type FileContentOptions = { sessionId?: string; confirmed?: boolean };

/** 文件内容（有界 512KB；二进制/超限时返回结构化标记）。 */
export type WebFileContent = { content?: string; size?: number; mtimeMs?: number; tooLarge?: boolean; truncated?: boolean; binary?: boolean };

/** P3：文件内容（有界 512KB；二进制/超限时返回结构化标记）。`path` 可为项目内相对路径或项目外绝对路径/`~/x`。 */
export async function fetchFileContent(projectId: string, path: string, options: FileContentOptions = {}): Promise<WebFileContent> {
	const params = new URLSearchParams({ path });
	if (options.sessionId) params.set("sessionId", options.sessionId);
	if (options.confirmed) params.set("confirm", "1");
	const res = await apiFetch(`/api/file-content?projectId=${encodeURIComponent(projectId)}&${params.toString()}`);
	if (!res.ok) {
		// 错误体可能是非 JSON（网关/隧道页）：解析失败时仍用状态码兜底，不让预览整条链路抛 TypeError
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string; reason?: string } | null;
		throw new WebFileAccessError(payload?.code ?? `file content ${res.status}`, payload?.message ?? `file content ${res.status}`, payload?.reason);
	}
	return (await res.json()) as { content?: string; size?: number; tooLarge?: boolean; truncated?: boolean; binary?: boolean };
}

/** Web 文件写入错误：code=webError.fileChanged 表示磁盘已被外部修改（可 force 覆盖）。 */
export class WebFileWriteError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WebFileWriteError";
		this.code = code;
	}
}

/**
 * 写入项目内文本文件（Web 编辑器）。
 * expectedMtimeMs 来自最近一次读取，服务端不匹配时回 409，避免静默覆盖外部改动。
 */
export async function writeProjectFile(projectId: string, path: string, content: string, options: { expectedMtimeMs?: number; force?: boolean } = {}): Promise<{ mtimeMs: number }> {
	const res = await apiFetch("/api/file-content", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, path, content, ...options }),
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
		throw new WebFileWriteError(payload?.code ?? `file write ${res.status}`, payload?.message ?? `file write ${res.status}`);
	}
	const payload = (await res.json()) as { mtimeMs?: number };
	return { mtimeMs: payload.mtimeMs ?? Date.now() };
}

/** 文件管理错误：code 用于 UI 区分同名/非法名称/越界，不直接把英文错误抛给用户。 */
export class WebFileOperationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WebFileOperationError";
		this.code = code;
	}
}

async function postFileEntry(path: string, body: Record<string, unknown>): Promise<void> {
	const res = await apiFetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
		throw new WebFileOperationError(payload?.code ?? `file ${res.status}`, payload?.message ?? `file ${res.status}`);
	}
}

/** 新建项目内文件/目录（父目录为项目相对路径，空 = 根）。 */
export function createProjectEntry(projectId: string, dir: string, name: string, kind: "file" | "directory"): Promise<void> {
	return postFileEntry("/api/files/create", { projectId, dir, name, kind });
}

/** 重命名项目内文件/目录（只改父目录内的纯文件名）。 */
export function renameProjectEntry(projectId: string, path: string, newName: string): Promise<void> {
	return postFileEntry("/api/files/rename", { projectId, path, newName });
}

/** 删除项目内文件/目录（主进程走系统回收站）。 */
export function deleteProjectEntry(projectId: string, path: string): Promise<void> {
	return postFileEntry("/api/files/delete", { projectId, path });
}

// ── Git 写操作（只开 stage/unstage/commit；discard/reset/push 不在 Web 暴露）──

async function postGitMutation(path: string, body: Record<string, unknown>): Promise<void> {
	const res = await apiFetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
		throw new Error(payload?.message ?? payload?.error ?? `git ${res.status}`);
	}
}

export function stageGitFiles(projectId: string, paths: string[]): Promise<void> {
	return postGitMutation("/api/git/stage", { projectId, paths });
}

export function unstageGitFiles(projectId: string, paths: string[]): Promise<void> {
	return postGitMutation("/api/git/unstage", { projectId, paths });
}

export function commitGit(projectId: string, message: string): Promise<void> {
	return postGitMutation("/api/git/commit", { projectId, message });
}

/** Git 分支操作错误：code 用于 UI 区分脏工作区/未知分支/非法名称。 */
export class WebGitOperationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WebGitOperationError";
		this.code = code;
	}
}

/** 切换/新建分支；返回切换后的分支信息（与 /api/git/status 的 branch 同形）。 */
export async function checkoutGitBranch(projectId: string, branch: string, options: { create?: boolean; force?: boolean } = {}): Promise<{ current: string | null; branches: string[] }> {
	const res = await apiFetch("/api/git/checkout", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, branch, ...options }),
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
		throw new WebGitOperationError(payload?.code ?? `git checkout ${res.status}`, payload?.message ?? `git checkout ${res.status}`);
	}
	const payload = (await res.json()) as { current?: string | null; branches?: string[] };
	return { current: payload.current ?? null, branches: payload.branches ?? [] };
}

/** fetch 远端（不合并）；push/pull 不在 Web 暴露。 */
export async function fetchGitRemote(projectId: string): Promise<void> {
	await postGitMutation("/api/git/fetch", { projectId });
}

// ── 设置（白名单投影：只在服务端登记的键能读写，未知键 400）──

/** 设置写入失败：code 区分「未知字段」（前端不该发）/「值非法」/服务端错误。 */
export class WebSettingsError extends Error {
	readonly code: string;
	readonly field?: string;
	constructor(code: string, message: string, field?: string) {
		super(message);
		this.name = "WebSettingsError";
		this.code = code;
		this.field = field;
	}
}

export async function fetchWebSettings(): Promise<SafeWebSettings> {
	const res = await apiFetch("/api/settings");
	if (!res.ok) throw new WebSettingsError(`settings ${res.status}`, `settings ${res.status}`);
	const payload = (await res.json()) as { settings?: SafeWebSettings };
	if (!payload.settings) throw new WebSettingsError("settings-missing", "settings projection missing");
	return payload.settings;
}

/** 写入白名单设置；返回服务端归一化后的完整投影（以它为准回填 UI，不做本地推算）。 */
export async function updateWebSettings(patch: Partial<WebWritableSettings>): Promise<SafeWebSettings> {
	const res = await apiFetch("/api/settings", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string; field?: string } | null;
		throw new WebSettingsError(payload?.code ?? `settings ${res.status}`, payload?.message ?? `settings ${res.status}`, payload?.field);
	}
	const payload = (await res.json()) as { settings?: SafeWebSettings };
	if (!payload.settings) throw new WebSettingsError("settings-missing", "settings projection missing");
	return payload.settings;
}

// ── 草稿本（与桌面草稿本同一存储；Web 只传 scope+id，不传宿主路径）──

export type WebScratchPadScope = "global" | "project";
export type WebScratchPadDraft = { id: string; name: string; createdAt: number; updatedAt: number; scope: WebScratchPadScope };

export function scratchPadQuery(scope: WebScratchPadScope, projectId?: string): string {
	const params = new URLSearchParams({ scope });
	if (scope === "project" && projectId) params.set("projectId", projectId);
	return params.toString();
}

export async function listScratchPadDrafts(scope: WebScratchPadScope, projectId?: string): Promise<WebScratchPadDraft[]> {
	const res = await apiFetch(`/api/scratchpad?${scratchPadQuery(scope, projectId)}`);
	if (!res.ok) throw new Error(`scratchpad list ${res.status}`);
	const payload = (await res.json()) as { drafts?: WebScratchPadDraft[] };
	return payload.drafts ?? [];
}

export async function createScratchPadDraft(scope: WebScratchPadScope, projectId?: string): Promise<WebScratchPadDraft> {
	const res = await apiFetch("/api/scratchpad/create", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ scope, ...(scope === "project" && projectId ? { projectId } : {}) }),
	});
	if (!res.ok) throw new Error(`scratchpad create ${res.status}`);
	const payload = (await res.json()) as { draft?: WebScratchPadDraft };
	if (!payload.draft) throw new Error("scratchpad create: missing draft");
	return payload.draft;
}

export async function loadScratchPadDraft(scope: WebScratchPadScope, id: string, projectId?: string): Promise<{ content: string; lastEditedAt: number }> {
	const res = await apiFetch(`/api/scratchpad/${encodeURIComponent(id)}?${scratchPadQuery(scope, projectId)}`);
	if (!res.ok) throw new Error(`scratchpad load ${res.status}`);
	return (await res.json()) as { content: string; lastEditedAt: number };
}

export async function saveScratchPadDraft(scope: WebScratchPadScope, id: string, content: string, projectId?: string): Promise<{ mtimeMs: number }> {
	const res = await apiFetch(`/api/scratchpad/${encodeURIComponent(id)}/save`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ scope, content, ...(scope === "project" && projectId ? { projectId } : {}) }),
	});
	if (!res.ok) throw new Error(`scratchpad save ${res.status}`);
	return (await res.json()) as { mtimeMs: number };
}

export async function deleteScratchPadDraft(scope: WebScratchPadScope, id: string, projectId?: string): Promise<void> {
	const res = await apiFetch(`/api/scratchpad/${encodeURIComponent(id)}?${scratchPadQuery(scope, projectId)}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`scratchpad delete ${res.status}`);
}

// ── 会话活动监控 strips（子代理/todo，与桌面端同源数据） ──

export async function fetchSessionSubagents(sessionId: string): Promise<PiSubagentEntry[]> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
	if (!res.ok) throw new Error(`subagents ${res.status}`);
	const payload = (await res.json()) as { subagents?: PiSubagentEntry[] };
	return payload.subagents ?? [];
}

export async function fetchSessionTodo(sessionId: string): Promise<SessionTodoSnapshot | null> {
	const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/todo`);
	if (!res.ok) throw new Error(`todo ${res.status}`);
	const payload = (await res.json()) as { todo?: SessionTodoSnapshot | null };
	return payload.todo ?? null;
}

// ── 第二批：技能/扩展资产面板（后端剥离宿主路径，前端类型同步去字段） ──

export type WebSkillLocation = Omit<PiSkillLocation, "path">;
export type WebSkillSummary = Omit<PiSkillSummary, "path" | "dir">;
export type WebExtensionSummary = Omit<PiExtensionSummary, "path">;

export async function listWebSkills(): Promise<{ locations: WebSkillLocation[]; skills: WebSkillSummary[] }> {
	const res = await apiFetch("/api/skills");
	if (!res.ok) throw new Error(`skills ${res.status}`);
	return (await res.json()) as { locations: WebSkillLocation[]; skills: WebSkillSummary[] };
}

/** 开关走 name+sourceId（前端无宿主路径；持久化按 name 写 disabledSkills）。 */
export async function toggleWebSkill(name: string, sourceId: WebSkillSummary["sourceId"], enabled: boolean): Promise<WebSkillSummary> {
	const res = await apiFetch("/api/skills/toggle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name, sourceId, enabled }),
	});
	if (!res.ok) throw new Error(`skill toggle ${res.status}`);
	const payload = (await res.json()) as { skill?: WebSkillSummary };
	if (!payload.skill) throw new Error("skill toggle returned no skill");
	return payload.skill;
}

export async function listWebExtensions(): Promise<{ extensions: WebExtensionSummary[]; conflicts: { builtIn: string; thirdParty: string }[] }> {
	const res = await apiFetch("/api/extensions");
	if (!res.ok) throw new Error(`extensions ${res.status}`);
	const payload = (await res.json()) as { extensions?: WebExtensionSummary[]; conflicts?: { builtIn: string; thirdParty: string }[] };
	return { extensions: payload.extensions ?? [], conflicts: payload.conflicts ?? [] };
}

/** 扩展开关写入配置，重启会话后生效（UI 需提示）。 */
export async function toggleWebExtension(source: string, enabled: boolean, scope: "user" | "project" | "unknown"): Promise<void> {
	const res = await apiFetch("/api/extensions/toggle", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, enabled, scope }),
	});
	if (!res.ok) throw new Error(`extension toggle ${res.status}`);
}

// ── 自动化（T8）：白名单投影 + 显式错误码（busy/notFound 由 UI 决定提示） ──

export class WebAutomationError extends Error {
	readonly code: string;
	readonly field?: string;
	constructor(code: string, message: string, field?: string) {
		super(message);
		this.name = "WebAutomationError";
		this.code = code;
		this.field = field;
	}
}

async function automationRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await apiFetch(path, init);
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { code?: string; message?: string; field?: string } | null;
		throw new WebAutomationError(payload?.code ?? `automation ${res.status}`, payload?.message ?? `automation ${res.status}`, payload?.field);
	}
	return (await res.json()) as T;
}

function automationPost<T>(path: string, body: unknown): Promise<T> {
	return automationRequest<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export function fetchAutomationSnapshot(taskId?: string): Promise<WebAutomationSnapshot> {
	const query = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
	return automationRequest<WebAutomationSnapshot>(`/api/automations${query}`);
}

export async function createWebAutomation(input: CreateAutomationTaskInput): Promise<WebAutomationTask> {
	const payload = await automationPost<{ task: WebAutomationTask }>("/api/automations/create", input);
	return payload.task;
}

export async function updateWebAutomation(taskId: string, patch: UpdateAutomationTaskInput): Promise<WebAutomationTask> {
	const payload = await automationPost<{ task: WebAutomationTask }>("/api/automations/update", { taskId, patch });
	return payload.task;
}

export async function deleteWebAutomation(taskId: string): Promise<void> {
	await automationPost<{ ok: boolean }>("/api/automations/delete", { taskId });
}

export async function runWebAutomation(taskId: string): Promise<WebAutomationRun> {
	const payload = await automationPost<{ run: WebAutomationRun }>("/api/automations/run", { taskId });
	return payload.run;
}

export async function abortWebAutomation(runId: string): Promise<void> {
	await automationPost<{ ok: boolean }>("/api/automations/abort", { runId });
}

export async function clearWebAutomationRuns(): Promise<number> {
	const payload = await automationPost<{ removed: number }>("/api/automations/clear-runs", {});
	return payload.removed;
}

export function previewWebAutomationCron(expression: string): Promise<AutomationCronPreview> {
	return automationRequest<AutomationCronPreview>(`/api/automations/preview-cron?expression=${encodeURIComponent(expression)}`);
}

// ── 智能体（T9）：systemPrompt 只允许由主进程从预设读取，调用入参不含它 ──
async function agentRequest<T>(path: string, body?: unknown): Promise<T> {
	const res = await apiFetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (!res.ok) {
		const payload = (await res.json().catch(() => null)) as { message?: string } | null;
		throw new Error(payload?.message ?? `agent ${res.status}`);
	}
	return (await res.json()) as T;
}
export function fetchWebAgents(): Promise<WebAgentSnapshot> {
	return agentRequest<WebAgentSnapshot>("/api/agents");
}
export async function saveWebAgent(input: Record<string, unknown>, agentId?: string): Promise<AgentProfile> {
	const payload = await agentRequest<{ agent: AgentProfile }>(agentId ? "/api/agents/update" : "/api/agents/create", agentId ? { agentId, patch: input } : input);
	return payload.agent;
}
export function deleteWebAgent(agentId: string): Promise<unknown> {
	return agentRequest("/api/agents/delete", { agentId });
}
export function bindWebAgent(sessionId: string, agentId: string | null): Promise<{ sessionAgentBindings: Record<string, string> }> {
	return agentRequest("/api/agents/bind-session", { sessionId, agentId });
}
export function invokeWebAgent(input: AgentInvokeInput): Promise<{ runId: string }> {
	return agentRequest("/api/agents/invoke", input);
}
export function cancelWebAgent(runId: string): Promise<unknown> {
	return agentRequest("/api/agents/invoke/cancel", { runId });
}
export async function fetchWebFavorites(): Promise<FavoriteEntry[]> {
	return (await agentRequest<{ entries: FavoriteEntry[] }>("/api/favorites")).entries;
}
export function addWebSessionFavorite(sessionId: string): Promise<unknown> {
	return agentRequest("/api/favorites/add-session", { sessionId });
}
export function deleteWebFavorite(favoriteId: string): Promise<unknown> {
	return agentRequest("/api/favorites/delete", { favoriteId });
}

// ── 通知 / 公告（T13）：投影只含公告正文与已读 id，notifiedIds 是终端本机簿记不下发 ──
export type WebAnnouncementState = { items: import("../../../shared/types/announcement").AnnouncementItem[]; readIds: string[]; fetchedAt: number | null; source: "remote" | "cache" | "builtin" };
export function fetchWebNotices(): Promise<import("../../../shared/types/noticeHistory").NoticeHistoryFileEntry[]> {
	return agentRequest<{ entries: import("../../../shared/types/noticeHistory").NoticeHistoryFileEntry[] }>("/api/notices").then((payload) => payload.entries);
}
export function clearWebNotices(): Promise<unknown> {
	return agentRequest("/api/notices/clear", {});
}
export function fetchWebAnnouncements(): Promise<WebAnnouncementState> {
	return agentRequest<WebAnnouncementState>("/api/announcements");
}
export function markWebAnnouncementRead(id: string): Promise<unknown> {
	return agentRequest("/api/announcements/mark-read", { id });
}
export function markAllWebAnnouncementsRead(): Promise<unknown> {
	return agentRequest("/api/announcements/mark-all-read", {});
}
