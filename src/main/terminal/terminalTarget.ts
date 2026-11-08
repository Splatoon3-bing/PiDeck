/**
 * 终端目标/Shell 入参解析（桌面 IPC 与 Web 终端共用同一套校验）
 *
 * 为什么抽出来：Web 终端（T6）与桌面终端 IPC 必须接受完全相同的 target 形状，
 * 各写一份必然漂移（例如 Web 少校验 runtimeGeneration 就会把输入打到旧 runtime）。
 * 这里只做纯校验，不依赖 Electron/服务实例，两端各自再做「归属是否存在」的查询。
 */
import type { TerminalAgentTarget, TerminalShell, TerminalTarget } from "../../shared/types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

/** 严格解析：只接受 {kind:"project",projectId} 或 {kind:"agent",sessionId,agentId,runtimeGeneration}。 */
export function parseTerminalTarget(value: unknown): TerminalTarget {
	if (!isRecord(value) || typeof value.kind !== "string") throw new Error("INVALID_TERMINAL_TARGET");
	if (value.kind === "project") {
		if (!hasOnlyKeys(value, ["kind", "projectId"]) || typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId.length > 256) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		return { kind: "project", projectId: value.projectId };
	}
	if (value.kind === "agent") {
		const { sessionId, agentId, runtimeGeneration } = value;
		if (
			!hasOnlyKeys(value, ["kind", "sessionId", "agentId", "runtimeGeneration"]) ||
			typeof sessionId !== "string" ||
			!sessionId.trim() ||
			sessionId.length > 256 ||
			typeof agentId !== "string" ||
			!agentId.trim() ||
			agentId.length > 256 ||
			typeof runtimeGeneration !== "number" ||
			!Number.isSafeInteger(runtimeGeneration) ||
			runtimeGeneration < 1
		) {
			throw new Error("INVALID_TERMINAL_TARGET");
		}
		const target: TerminalAgentTarget = { kind: "agent", sessionId, agentId, runtimeGeneration };
		return target;
	}
	throw new Error("INVALID_TERMINAL_TARGET");
}

/** Shell 枚举：只允许平台候选表里的 9 个值，绝不接受任意命令/路径。 */
export function parseTerminalShell(value: unknown): TerminalShell | undefined {
	if (value === undefined) return undefined;
	if (value === "pwsh" || value === "powershell" || value === "cmd" || value === "zsh" || value === "bash" || value === "fish" || value === "sh" || value === "git-bash" || value === "wsl") {
		return value;
	}
	throw new Error("INVALID_TERMINAL_SHELL");
}
