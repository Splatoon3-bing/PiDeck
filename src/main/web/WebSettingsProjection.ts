/**
 * 设置 → Web 端安全投影 + 白名单写入（WebSettingsProjection.ts）
 *
 * 为什么是白名单：`AppSettings` 里混着 Web 服务令牌、供应商凭据、安全等级、终端/远端/插件
 * 开关。用黑名单意味着「每加一个高风险字段就默认暴露给浏览器」，漏一个就是提权；白名单反过来，
 * 未知键在路由层直接 400（不静默忽略），新增字段必须同时改本文件才能被读写。
 *
 * 投影范围只包含 Web 端真正会应用的字段：
 * - 外观：明暗偏好 + 三档字号。主题样式/配色（themeStyle/themePalette/accent/customTheme*）
 *   刻意不下发——Web 页有自己的视觉 token（web.css 覆盖 foundation 的 --color-*），
 *   同时落 data-appearance/data-palette 会让两套色板按选择器优先级互相压盖，观感更差。
 * - 新会话默认后端：只有 pi / dsh（acp 需要工具 id，生图/生视频是独立链路）。
 * - 输入行为：发送快捷键、流式过程是否自动展开。
 */
import type { AppFontSizeMode, AppSettings, AppThemeMode, SafeWebSettings, SendShortcutMode, WebDefaultAgentBackend } from "../../shared/types";
import { APP_FONT_SIZE_MODES, normalizeOptionalFontSizeMode } from "../../shared/fontSize";

/** 明暗偏好：跟随时间由桌面端设置，Web 端只解析应用（可用于写入，覆盖掉 schedule）。 */
export const WEB_THEME_MODES: readonly AppThemeMode[] = ["light", "dark", "system", "schedule"];
export const WEB_SEND_SHORTCUTS: readonly SendShortcutMode[] = ["enter-send", "ctrl-enter-send", "shift-enter-send"];
export const WEB_DEFAULT_AGENT_BACKENDS: readonly WebDefaultAgentBackend[] = ["pi", "dsh"];

/** 校验失败：路由层据此回 400，并带上「是哪个字段错了」。 */
export class WebSettingsValidationError extends Error {
	readonly field: string;
	constructor(field: string, reason: "unknownKey" | "invalidValue" | "invalidBody") {
		super(reason === "unknownKey" ? `unknown setting: ${field}` : reason === "invalidValue" ? `invalid value for setting: ${field}` : `invalid body: ${field}`);
		this.name = "WebSettingsValidationError";
		this.field = field;
	}
}

/**
 * 校验错误判定：按 name 而不只按 instanceof。
 * 测试/sandbox 里模块可能被多个 vm realm 各加载一次，跨 realm 的 class identity 不相等，
 * 只认 instanceof 会把 400 误升成 500。
 */
export function isWebSettingsValidationError(error: unknown): error is WebSettingsValidationError {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { name?: unknown; field?: unknown };
	return candidate.name === "WebSettingsValidationError" && typeof candidate.field === "string";
}

/** 白名单键 → 值归一化。键集即写权限，多一个键都要先在这里登记。 */
const WRITABLE_SETTINGS: Record<string, (raw: unknown) => unknown> = {
	theme: (raw) => pickEnum<AppThemeMode>(raw, WEB_THEME_MODES),
	fontSize: (raw) => pickEnum<AppFontSizeMode>(raw, APP_FONT_SIZE_MODES),
	uiFontSize: (raw) => nullableFontSize(raw),
	chatFontSize: (raw) => nullableFontSize(raw),
	defaultAgentBackend: (raw) => pickEnum<WebDefaultAgentBackend>(raw, WEB_DEFAULT_AGENT_BACKENDS),
	sendShortcut: (raw) => pickEnum<SendShortcutMode>(raw, WEB_SEND_SHORTCUTS),
	expandInterimDuringStream: (raw) => {
		if (typeof raw !== "boolean") throw new WebSettingsValidationError("expandInterimDuringStream", "invalidValue");
		return raw;
	},
};

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[]): T {
	if (typeof raw !== "string" || !allowed.includes(raw as T)) throw new WebSettingsValidationError("enum", "invalidValue");
	return raw as T;
}

/** 字号覆盖：null = 跟随全局（必须保留 null），非法档位归一化到中档（与设置页同源）。 */
function nullableFontSize(raw: unknown): AppFontSizeMode | null {
	if (raw !== null && typeof raw !== "string") throw new WebSettingsValidationError("fontSize", "invalidValue");
	return normalizeOptionalFontSizeMode(raw);
}

/**
 * 解析 Web 端设置 patch。返回的补丁可直接交给 `SettingsStore.update`：
 * - 未知键 → 抛错（不部分写入）；
 * - 空补丁 → 抛错（没有可写的键，避免「看起来保存成功但什么都没变」）；
 * - `defaultAgentBackend` 顺手写 `defaultAgentBackendManual`：用户显式选过默认后端后，
 *   自动回退逻辑（只有 DSH 时用 dsh）不应再改写它。
 */
export function parseSafeWebSettingsPatch(body: unknown): Partial<AppSettings> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new WebSettingsValidationError("body", "invalidBody");
	const raw = body as Record<string, unknown>;
	const keys = Object.keys(raw);
	if (keys.length === 0) throw new WebSettingsValidationError("body", "invalidBody");
	const patch: Record<string, unknown> = {};
	for (const key of keys) {
		// 必须 hasOwn：`WRITABLE_SETTINGS[key]` 会命中原型链（toString/constructor/valueOf…），
		// 让 {"constructor":"x"} 这类未知键绕过白名单写进设置，个别键还会把 400 抬成 500。
		if (!Object.hasOwn(WRITABLE_SETTINGS, key)) throw new WebSettingsValidationError(key, "unknownKey");
		const accept = WRITABLE_SETTINGS[key];
		try {
			patch[key] = accept(raw[key]);
		} catch (error) {
			// 归一化函数只认识自己的字段名，把错误字段统一换成本次循环的键
			if (isWebSettingsValidationError(error)) throw new WebSettingsValidationError(key, "invalidValue");
			throw error;
		}
	}
	if (typeof patch.defaultAgentBackend === "string") patch.defaultAgentBackendManual = true;
	return patch as Partial<AppSettings>;
}

/**
 * 设置 → Web 可读投影。只做字段裁剪与兜底，不改语义：
 * - `defaultAgentBackend` 非 pi/dsh（acp/生图/生视频）按 pi 投影：它们不是「新会话默认」的
 *   合法取值，Web 设置页也只提供 pi/dsh 两个入口。
 * - `expandInterimDuringStream` 缺省按 true（老设置无此字段时的既有行为）。
 */
export function toSafeWebSettings(settings: AppSettings): SafeWebSettings {
	return {
		theme: settings.theme,
		themeScheduleLightStart: settings.themeScheduleLightStart,
		themeScheduleDarkStart: settings.themeScheduleDarkStart,
		fontSize: settings.fontSize,
		uiFontSize: settings.uiFontSize,
		chatFontSize: settings.chatFontSize,
		defaultAgentBackend: settings.defaultAgentBackend === "dsh" ? "dsh" : "pi",
		sendShortcut: settings.sendShortcut,
		expandInterimDuringStream: settings.expandInterimDuringStream !== false,
	};
}
