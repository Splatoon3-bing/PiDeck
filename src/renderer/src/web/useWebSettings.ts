/**
 * Web 端主机设置（`/api/settings` 白名单投影）的持有者。
 *
 * 为什么抽成 hook：明暗与字号是整页生效的，投影必须在组合根只有一份——设置面板、
 * 头部主题按钮、composer 发送快捷键、时间线过程展开都是它的消费者。原先这些状态与
 * 应用副作用散在 WebChatApp 里（+130 行），超出组合根的行数约束，这里按域收口。
 *
 * 数据流：
 *   首帧 ← localStorage 缓存（web-main 的 bootstrapWebTheme 已先落 data-theme，防闪白）
 *   之后 ← /api/settings（服务端是权威来源；写入后以服务端归一化投影回填）
 */
import { useCallback, useEffect, useState } from "react";
import type { SafeWebSettings, WebWritableSettings } from "../../../shared/types";
import { t } from "@/i18n";
import { applyFontSizeAttributes } from "../hooks/appearance/fontSizeAttributes";
import { fetchWebSettings, updateWebSettings } from "./webApi";
import { applyWebTheme, msUntilWebThemeChange, nextWebTheme, readStoredWebTheme, resolveWebTheme, storeWebTheme, systemPrefersDark, toggleWebTheme, type ResolvedWebTheme, type WebThemePreference } from "./webTheme";

/** schedule 模式的默认时间窗（服务端投影未到时兜底，与桌面出厂值一致）。 */
const DEFAULT_SCHEDULE = { lightStart: "07:00", darkStart: "19:00" };

export type WebSettingsController = {
	/** null = 首次加载未完成；此时用 localStorage 缓存值渲染主题 */
	settings: SafeWebSettings | null;
	themePreference: WebThemePreference;
	resolvedTheme: ResolvedWebTheme;
	loading: boolean;
	loadError: string | null;
	saving: boolean;
	saveError: string | null;
	reload: () => void;
	patch: (patch: Partial<WebWritableSettings>) => void;
	cycleTheme: () => void;
	toggleTheme: () => void;
};

export function useWebSettings(): WebSettingsController {
	const [themePreference, setThemePreference] = useState<WebThemePreference>(() => readStoredWebTheme());
	const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
	const [settings, setSettings] = useState<SafeWebSettings | null>(null);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	// 跟随时间模式的边界重算：到点后强制重渲染（只对 schedule 挂定时器）。
	const [, setThemeTick] = useState(0);

	const themeSchedule = {
		lightStart: settings?.themeScheduleLightStart ?? DEFAULT_SCHEDULE.lightStart,
		darkStart: settings?.themeScheduleDarkStart ?? DEFAULT_SCHEDULE.darkStart,
	};
	const resolvedTheme = resolveWebTheme(themePreference, systemDark, themeSchedule);

	// 主题：与桌面同源的 data-theme 机制（亮/暗由 schedule/system 解析后落属性）。
	useEffect(() => {
		applyWebTheme(resolvedTheme);
	}, [resolvedTheme]);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	// 字号：与桌面同一份 dataset 回落链（投影缺的档位按未覆盖处理）。
	useEffect(() => {
		if (settings) applyFontSizeAttributes(document.documentElement, settings);
	}, [settings]);

	useEffect(() => {
		const delay = msUntilWebThemeChange(themePreference, themeSchedule);
		if (delay === null) return;
		const timer = window.setTimeout(() => setThemeTick((tick) => tick + 1), delay);
		return () => window.clearTimeout(timer);
	}, [themePreference, themeSchedule.lightStart, themeSchedule.darkStart]);

	/** 加载投影：失败只降级到本地缓存，不阻断聊天。 */
	const load = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			const next = await fetchWebSettings();
			setSettings(next);
			// 同步本地偏好缓存：刷新/断网时首帧仍按同一档渲染。
			setThemePreference(next.theme);
			storeWebTheme(next.theme);
		} catch {
			setLoadError(t("web.settingsLoadFailed"));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * 写入：乐观回填（主题/字号立即生效），成功后以服务端归一化投影覆盖；
	 * 失败回滚到上一份投影，避免 UI 停在「以为保存了」的假状态。
	 */
	const patch = useCallback(
		async (next: Partial<WebWritableSettings>) => {
			const previous = settings;
			setSaving(true);
			setSaveError(null);
			if (previous) setSettings({ ...previous, ...next });
			if (next.theme) {
				setThemePreference(next.theme);
				storeWebTheme(next.theme);
			}
			try {
				const updated = await updateWebSettings(next);
				setSettings(updated);
				setThemePreference(updated.theme);
				storeWebTheme(updated.theme);
			} catch {
				setSettings(previous);
				if (previous) setThemePreference(previous.theme);
				setSaveError(t("web.settingsSaveFailed"));
			} finally {
				setSaving(false);
			}
		},
		[settings],
	);

	return {
		settings,
		themePreference,
		resolvedTheme,
		loading,
		loadError,
		saving,
		saveError,
		reload: () => void load(),
		// system/schedule 档跳到与当前解析相反的显式档：一次点击必须有可见变化。
		cycleTheme: () => void patch({ theme: nextWebTheme(themePreference, resolvedTheme) }),
		toggleTheme: () => void patch({ theme: toggleWebTheme(themePreference, resolvedTheme) }),
		patch: (next) => void patch(next),
	};
}
