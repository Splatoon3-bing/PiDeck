/**
 * Web 端主题（亮/暗/跟随系统/跟随时间）。
 *
 * 桌面端暗色机制是 `:root[data-theme="dark"]`（foundation.css 变量集），
 * Web 端复用同一套 token：把解析结果写到 documentElement.dataset.theme 即可，
 * 不引入第二套样式。
 *
 * 偏好来源是主机的设置（`/api/settings` 投影的 `theme`），与桌面端同一份值——
 * 否则「手机改成暗色、桌面还是亮的」会被当成 bug。localStorage 只当首帧缓存：
 * web-main 在 React 挂载前先按上次已知值落 data-theme，避免刷新闪白；
 * 服务端设置到达后覆盖本地状态。
 */
import type { AppThemeMode } from "../../../shared/types";
import { msUntilNextThemeBoundary, resolveAppColorScheme } from "../../../shared/themeSchedule";

export type WebThemePreference = AppThemeMode;
export type ResolvedWebTheme = "light" | "dark";

/** 首帧缓存键（含跟随时间模式：值就是 AppThemeMode 原文）。 */
const STORAGE_KEY = "pideck-web-theme";

function isThemeMode(value: string | null): value is WebThemePreference {
	return value === "light" || value === "dark" || value === "system" || value === "schedule";
}

export function readStoredWebTheme(): WebThemePreference {
	if (typeof localStorage === "undefined") return "system";
	const value = localStorage.getItem(STORAGE_KEY);
	return isThemeMode(value) ? value : "system";
}

export function storeWebTheme(pref: WebThemePreference): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, pref);
	} catch {
		// 隐私模式/存储禁用：仅本次会话生效，不报错
	}
}

/** 偏好 → 实际主题：system 看 prefers-color-scheme，schedule 看本地时钟（与桌面同源解析）。 */
export function resolveWebTheme(pref: WebThemePreference, systemDark: boolean, schedule: { lightStart: string; darkStart: string } = { lightStart: "07:00", darkStart: "19:00" }, now: Date = new Date()): ResolvedWebTheme {
	return resolveAppColorScheme({ theme: pref, themeScheduleLightStart: schedule.lightStart, themeScheduleDarkStart: schedule.darkStart, systemPrefersDark: systemDark, now });
}

/** 跟随时间模式下距下一次明暗切换的毫秒数（其它模式返回 null，调用方不必挂定时器）。 */
export function msUntilWebThemeChange(pref: WebThemePreference, schedule: { lightStart: string; darkStart: string }, now: Date = new Date()): number | null {
	if (pref !== "schedule") return null;
	return msUntilNextThemeBoundary(now, schedule.lightStart, schedule.darkStart);
}

/**
 * 三态循环的下一档：light → dark → system → …
 *
 * 从 system 出发时必须跳到「与当前系统解析结果相反」的那一档。若按字面写死 light，
 * 系统本身是亮色时第一次点击毫无视觉变化，用户会以为按钮坏了。
 * schedule（跟随时间）不是头部按钮的循环档位：按 system 同语义处理（跳到与当前解析相反的一档）。
 */
export function nextWebTheme(pref: WebThemePreference, resolved: ResolvedWebTheme): WebThemePreference {
	if (pref === "light") return "dark";
	if (pref === "dark") return "system";
	return resolved === "dark" ? "light" : "dark";
}

/**
 * 一键明暗翻转（Web 头部按钮）：显式档直接对翻；system/schedule 档按「当前实际解析结果」翻到
 * 对面，并退出自动模式——一次点击必须产生可见变化。语义与桌面底栏 dock 的 toggleThemeMode 一致。
 */
export function toggleWebTheme(pref: WebThemePreference, resolved: ResolvedWebTheme): WebThemePreference {
	if (pref === "light") return "dark";
	if (pref === "dark") return "light";
	return resolved === "dark" ? "light" : "dark";
}

export function applyWebTheme(theme: ResolvedWebTheme): void {
	if (typeof document === "undefined") return;
	// foundation 变量只在 dark 有覆盖集，light 显式写属性保持 DOM 状态可观察
	document.documentElement.dataset.theme = theme;
	// theme-color 同步状态栏/标题栏颜色（PWA 场景）
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", theme === "dark" ? "#18181b" : "#ffffff");
}

export function systemPrefersDark(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * 首帧前的主题初始化：按「已存偏好 + 系统明暗」落 data-theme，避免手动选暗色的用户刷新时先闪一下亮色。
 *
 * 只做一次性应用，不在这里订阅 prefers-color-scheme：运行期跟随系统由持有主题状态的 WebChatApp
 * 负责，两处同时写会互相覆盖用户的手动选择。
 */
export function bootstrapWebTheme(): ResolvedWebTheme {
	const resolved = resolveWebTheme(readStoredWebTheme(), systemPrefersDark());
	applyWebTheme(resolved);
	return resolved;
}
