/**
 * Web 生图（T11 v1）：/api/imagegen
 *
 * 安全边界（切片见 .ai/sdd/specs/001-web-parity/t11-imagegen-web-slice.md）：
 * - 供应商凭据（apiKey/baseUrl/extraParams）只在主进程，投影只给 id/name/models/referenceMode；
 * - 会话必须存在且 backend=imagegen（生图不走 pi/DSH runtime，fail-closed）；
 * - 产物落 ImageBlobStore，响应只回 ref；字节另行经 /api/imagegen/blob/<ref> 下发。
 *
 * 生视频（videogen）是长任务 + 事件流，需独立评审，v1 不在 Web 开放。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentBackend } from "../../shared/types/agent";
import type { ChatMessage, ImageContent } from "../../shared/types/session";
import type { ImageBlobPayload, ImageGenRequest, ImageGenResult } from "../../shared/types/imagegen";
import type { ImageGenConfigFile, ImageGenProviderConfig, ImageGenReferenceMode } from "../../shared/imageGenConfig";
import { parseImageGenReferenceImages } from "../../shared/imageGenParams";
import { getAppLogger } from "../logging/sharedLogger";
import { readJson, WEB_CORS_HEADERS } from "./WebHttpResponders";

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;
const MAX_REF_CHARS = 200;
const BLOB_PREFIX = "/api/imagegen/blob/";

/** Web 可见的生图配置：凭据字段一律不出现（单测逐项断言）。 */
export type WebImageGenProvider = { id: string; name: string; models: string[]; referenceMode: ImageGenReferenceMode };
export type WebImageGenConfig = { configured: boolean; providers: WebImageGenProvider[]; activeProviderId: string; activeModel: string };

export function toWebImageGenConfig(config: ImageGenConfigFile): WebImageGenConfig {
	return {
		// 只有「供应商 + 至少一个模型」才算可用：空 apiKey 由 ImageGenService 侧拦成 notConfigured。
		configured: config.providers.some((provider) => provider.models.length > 0),
		providers: config.providers.map((provider) => ({ id: provider.id, name: provider.name, models: [...provider.models], referenceMode: provider.referenceMode ?? "none" })),
		activeProviderId: config.activeProviderId,
		activeModel: config.activeModel,
	};
}

export type WebImageGenRoutesDeps = {
	getConfig: () => Promise<ImageGenConfigFile>;
	/** 只写 activeProviderId / activeModel（Web 选择器只换模型，不碰凭据与字段开关）。 */
	saveConfig?: (config: ImageGenConfigFile) => Promise<{ ok: true; config: ImageGenConfigFile } | { ok: false; error: string }>;
	generate: (request: ImageGenRequest) => Promise<ImageGenResult>;
	putBlob: (data: string, mimeType: string) => Promise<string | null>;
	readBlob: (ref: string) => Promise<ImageBlobPayload | null>;
	getSession: (sessionId: string) => { id: string; projectId: string; backend?: AgentBackend } | undefined;
	/** 生成结果落会话历史（user + assistant 两条；图片只存 ref）。失败只记日志，不影响已生成的结果。 */
	appendMessages?: (sessionId: string, messages: ChatMessage[]) => Promise<void>;
	promote?: (sessionId: string) => Promise<unknown>;
	log?: (message: string, details: Record<string, unknown>) => void;
};

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...WEB_CORS_HEADERS });
	response.end(JSON.stringify(body));
}
function fail(response: ServerResponse, status: number, code: string, field?: string): void {
	json(response, status, { code, message: "imagegen request rejected", ...(field ? { field } : {}) });
}
function invalid(message: string, field?: string): Error {
	return Object.assign(new Error(message), { name: "WebImageGenValidationError", field });
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("object body is required");
	return value as Record<string, unknown>;
}
const ALLOWED_KEYS = new Set(["sessionId", "prompt", "provider", "model", "size", "watermark", "outputFormat", "referenceImages"]);

export class WebImageGenRoutes {
	constructor(private readonly deps: WebImageGenRoutesDeps) {}

	async handle(url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		if (url.pathname !== "/api/imagegen/config" && url.pathname !== "/api/imagegen/generate" && url.pathname !== "/api/imagegen/selection" && !url.pathname.startsWith(BLOB_PREFIX)) return false;
		try {
			if (url.pathname === "/api/imagegen/config" && request.method === "GET") {
				json(response, 200, toWebImageGenConfig(await this.deps.getConfig()));
				return true;
			}
			if (url.pathname === "/api/imagegen/selection" && request.method === "POST") return await this.select(request, response);
			if (url.pathname.startsWith(BLOB_PREFIX) && request.method === "GET") return await this.blob(url, response);
			if (url.pathname !== "/api/imagegen/generate" || request.method !== "POST") {
				fail(response, 405, "webError.methodNotAllowed");
				return true;
			}
			return await this.generate(request, response);
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			if (name === "WebBodyTooLargeError") fail(response, 413, "webError.bodyTooLarge");
			else if (name === "WebInvalidJsonError") fail(response, 400, "webError.invalidJson");
			else if (name === "WebImageGenValidationError") fail(response, 400, "webError.invalidImageGen", (error as { field?: string }).field);
			else if (name === "WebImageGenNotConfiguredError") fail(response, 409, "webError.imageGenNotConfigured");
			else if (name === "WebImageGenNotFoundError") fail(response, 404, "webError.imageGenSessionNotFound");
			else fail(response, 400, "webError.imageGenFailed");
			return true;
		}
	}

	private async select(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = record(await readJson(request, 8 * 1024));
		for (const key of Object.keys(body)) if (key !== "providerId" && key !== "modelId") throw invalid(`unknown field: ${key}`, key);
		const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
		const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
		if (!providerId || providerId.length > MAX_REF_CHARS) throw invalid("providerId is invalid", "providerId");
		if (!modelId || modelId.length > MAX_REF_CHARS) throw invalid("modelId is invalid", "modelId");
		const save = this.deps.saveConfig;
		if (!save) throw Object.assign(new Error("selection is not writable"), { name: "WebImageGenNotConfiguredError" });
		const config = await this.deps.getConfig();
		const provider = config.providers.find((item) => item.id === providerId);
		// 白名单：只能选配置里真实存在且属于该供应商的模型，不接受任意字符串写入配置文件。
		if (!provider || !provider.models.includes(modelId)) throw invalid("model is not available for this provider", "modelId");
		const next: ImageGenConfigFile = { ...config, activeProviderId: provider.id, activeModel: modelId };
		const result = await save(next);
		if (!result.ok) throw Object.assign(new Error(result.error), { name: "WebImageGenNotConfiguredError" });
		json(response, 200, { ok: true, activeProviderId: provider.id, activeModel: modelId });
		return true;
	}

	private async generate(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const body = record(await readJson(request, MAX_BODY_BYTES));
		for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) throw invalid(`unknown field: ${key}`, key);
		const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
		if (!sessionId || sessionId.length > MAX_REF_CHARS) throw invalid("sessionId is invalid", "sessionId");
		const session = this.deps.getSession(sessionId);
		// fail-closed：只有生图会话能走这条链路，避免把生图结果写进 pi/DSH 会话历史。
		if (!session) throw Object.assign(new Error("session not found"), { name: "WebImageGenNotFoundError" });
		if (session.backend !== "imagegen") throw invalid("session backend is not imagegen", "sessionId");

		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw invalid("prompt is invalid", "prompt");

		const config = await this.deps.getConfig();
		const provider = this.resolveProvider(config, body.provider);
		const model = this.resolveModel(provider, config, body.model);
		if (!model) throw Object.assign(new Error("imagegen not configured"), { name: "WebImageGenNotConfiguredError" });

		let referenceImages: ImageContent[] | undefined;
		if (body.referenceImages !== undefined) {
			const parsed = parseImageGenReferenceImages(body.referenceImages);
			if (!parsed) throw invalid("referenceImages is invalid", "referenceImages");
			referenceImages = parsed.length > 0 ? parsed : undefined;
		}
		if (body.size !== undefined && (typeof body.size !== "string" || body.size.length > 40)) throw invalid("size is invalid", "size");
		if (body.watermark !== undefined && typeof body.watermark !== "boolean") throw invalid("watermark is invalid", "watermark");
		if (body.outputFormat !== undefined && (typeof body.outputFormat !== "string" || body.outputFormat.length > 20)) throw invalid("outputFormat is invalid", "outputFormat");

		const result = await this.deps.generate({
			provider: provider.id,
			model,
			prompt,
			sessionId,
			...(typeof body.size === "string" ? { size: body.size } : {}),
			...(typeof body.watermark === "boolean" ? { watermark: body.watermark } : {}),
			...(typeof body.outputFormat === "string" ? { outputFormat: body.outputFormat } : {}),
			...(referenceImages ? { referenceImages } : {}),
		});
		if (!result.ok) {
			if (result.error === "notConfigured") {
				fail(response, 409, "webError.imageGenNotConfigured");
				return true;
			}
			this.log("generate.rejected", { sessionId, provider: provider.id, error: result.error });
			json(response, 400, { code: "webError.imageGenFailed", error: result.error, message: "image generation failed" });
			return true;
		}

		const image = result.image;
		const data = image.data;
		if (!data) {
			fail(response, 502, "webError.imageGenEmpty");
			return true;
		}
		const ref = await this.deps.putBlob(data, image.mimeType);
		if (!ref) {
			fail(response, 500, "webError.imageGenFailed");
			return true;
		}
		await this.persist(sessionId, prompt, { ref, mimeType: image.mimeType }, typeof body.size === "string" ? body.size : undefined, referenceImages);
		this.log("generate.ok", { sessionId, provider: provider.id, mimeType: image.mimeType });
		json(response, 200, { ref, mimeType: image.mimeType });
		return true;
	}

	/** 历史渲染：内容寻址 ⇒ 同一 ref 字节永不变，可长缓存；仍要求令牌（/api/* 链路覆盖）。 */
	private async blob(url: URL, response: ServerResponse): Promise<boolean> {
		const raw = url.pathname.slice(BLOB_PREFIX.length);
		const ref = raw ? decodeURIComponent(raw) : "";
		if (!ref || ref.length > 200 || ref.includes("/") || ref.includes("\\")) {
			fail(response, 404, "webError.imageGenBlobNotFound");
			return true;
		}
		const payload = await this.deps.readBlob(ref);
		if (!payload) {
			fail(response, 404, "webError.imageGenBlobNotFound");
			return true;
		}
		const bytes = Buffer.from(payload.data, "base64");
		response.writeHead(200, {
			"content-type": payload.mimeType,
			"content-length": String(bytes.byteLength),
			"cache-control": "private, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		});
		response.end(bytes);
		return true;
	}

	/** provider 必须在服务端配置里；未指定时用 activeProviderId，再退回第一个可用供应商。 */
	private resolveProvider(config: ImageGenConfigFile, value: unknown): ImageGenProviderConfig {
		const requested = typeof value === "string" ? value.trim() : "";
		if (requested) {
			const found = config.providers.find((provider) => provider.id === requested);
			if (!found) throw invalid("provider is not configured", "provider");
			return found;
		}
		const active = config.providers.find((provider) => provider.id === config.activeProviderId);
		const fallback = config.providers.find((provider) => provider.models.length > 0);
		const provider = active ?? fallback;
		if (!provider) throw Object.assign(new Error("imagegen not configured"), { name: "WebImageGenNotConfiguredError" });
		return provider;
	}

	private resolveModel(provider: ImageGenProviderConfig, config: ImageGenConfigFile, value: unknown): string | null {
		const requested = typeof value === "string" ? value.trim() : "";
		if (requested) {
			if (!provider.models.includes(requested)) throw invalid("model is not in provider", "model");
			return requested;
		}
		if (provider.id === config.activeProviderId && config.activeModel && provider.models.includes(config.activeModel)) return config.activeModel;
		return provider.models[0] ?? null;
	}

	/** 落盘复用 ImageSessionStore：图片只存 ref（base64 不进 JSONL，AGENTS.md 生图硬约束）。 */
	private async persist(sessionId: string, prompt: string, image: { ref: string; mimeType: string }, size: string | undefined, referenceImages: ImageContent[] | undefined): Promise<void> {
		try {
			const now = Date.now();
			const messages: ChatMessage[] = [
				{ id: `${sessionId}-u-${now}`, agentId: "", role: "user", text: prompt, timestamp: now, images: (referenceImages ?? []).map((ref) => ({ type: "image" as const, data: ref.data, mimeType: ref.mimeType })) },
				{ id: `${sessionId}-a-${now}`, agentId: "", role: "assistant", text: "", stopReason: "stop", timestamp: now, images: [{ type: "image" as const, ref: image.ref, mimeType: image.mimeType }], meta: { imageGen: { status: "complete", prompt, ...(size ? { size } : {}) } } },
			];
			await this.deps.appendMessages?.(sessionId, messages);
			await this.deps.promote?.(sessionId);
		} catch (error) {
			// 结果已经生成且落 blob：持久化失败只影响历史，不能让 Web 以为生成失败（重试会二次计费）。
			this.log("persist.failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private log(message: string, details: Record<string, unknown>): void {
		if (this.deps.log) this.deps.log(message, details);
		else void getAppLogger()?.info("web-imagegen", message, details);
	}
}

/**
 * 装配工厂：把主进程既有的生图 service / blob / 会话存储接成 Web 依赖。
 * 放在域模块里，`main/index.ts` 只留一行——装配层不该知道「哪些字段拼哪些存储」。
 */
let installedDeps: WebImageGenRoutesDeps | null = null;

/** 装配入口：域模块自己持有「已装配依赖」，装配层不再需要模块级 `let`。 */
export function installWebImageGenDeps(deps: WebImageGenRoutesDeps): void {
	installedDeps = deps;
}

/** 供 Web 路由注册读取（启动后段才装好；未装好时路由不注册，而不是 500）。 */
export function getWebImageGenDeps(): WebImageGenRoutesDeps | null {
	return installedDeps;
}

export function createWebImageGenDeps(deps: {
	config: { getConfig: () => Promise<ImageGenConfigFile>; saveConfig?: (config: ImageGenConfigFile) => Promise<{ ok: true; config: ImageGenConfigFile } | { ok: false; error: string }> };
	service: { generate: (request: ImageGenRequest) => Promise<ImageGenResult> };
	blobs: { put: (data: string, mimeType: string) => Promise<string | null>; readPayload: (ref: string) => Promise<ImageBlobPayload | null> };
	sessions: { append: (sessionId: string, messages: ChatMessage[]) => Promise<void> };
	catalog: () => { get: (sessionId: string) => { id: string; projectId: string; backend?: AgentBackend } | undefined; promoteToActive: (sessionId: string) => Promise<unknown> };
}): WebImageGenRoutesDeps {
	return {
		getConfig: () => deps.config.getConfig(),
		saveConfig: deps.config.saveConfig ? (config) => deps.config.saveConfig!(config) : undefined,
		generate: (request) => deps.service.generate(request),
		putBlob: (data, mimeType) => deps.blobs.put(data, mimeType),
		readBlob: (ref) => deps.blobs.readPayload(ref),
		getSession: (sessionId) => deps.catalog().get(sessionId),
		appendMessages: (sessionId, messages) => deps.sessions.append(sessionId, messages),
		promote: (sessionId) => deps.catalog().promoteToActive(sessionId),
	};
}
