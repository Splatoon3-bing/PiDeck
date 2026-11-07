/**
 * 字号档位 → `<html>` dataset（纯函数，无 React 依赖）。
 *
 * 桌面端（App 持久化应用 / 设置弹窗实时预览）与 Web 端（/api/settings 投影应用）共用同一份
 * 回落链，避免「两处各自算一遍，改了设置只生效一半」：
 *   ui ← uiFontSize ?? fontSize；tab ← tabBarFontSize ?? ui（Tab 跟界面不跟全局）；
 *   chat/input ← 各自字段 ?? fontSize。
 *
 * 入参只要求 fontSize 必有、其余可选：Web 投影只下发全局与界面/会话三档，
 * 缺的档位按「未覆盖」处理，与桌面端 null 语义一致。
 */
import type { AppSettings } from "../../../../shared/types";

export type FontSizeSettingsSlice = Pick<AppSettings, "fontSize"> & Partial<Pick<AppSettings, "uiFontSize" | "tabBarFontSize" | "chatFontSize" | "inputFontSize">>;

export function applyFontSizeAttributes(root: HTMLElement, settings: FontSizeSettingsSlice): void {
	const uiFontSize = settings.uiFontSize ?? settings.fontSize;
	root.dataset.uiFontSize = uiFontSize;
	root.dataset.tabFontSize = settings.tabBarFontSize ?? uiFontSize;
	root.dataset.chatFontSize = settings.chatFontSize ?? settings.fontSize;
	root.dataset.inputFontSize = settings.inputFontSize ?? settings.fontSize;
	// 旧属性保留，兼容外部依赖或测试仍读取 dataset.fontSize 的场景
	root.dataset.fontSize = settings.fontSize;
}
