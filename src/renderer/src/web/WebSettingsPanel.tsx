/**
 * WebSettingsPanel — Web 端设置面板（外观 / 会话默认 / 输入行为）。
 *
 * 数据面：父级（WebChatApp）持有 `/api/settings` 的投影，本组件只负责表单与状态提示。
 * 为什么不在面板里自己 fetch：明暗与字号是整页生效的，投影必须在组合根持有；
 * 面板只是第二个消费者，各自拉一份会出现「面板显示已保存、页面没变」。
 *
 * 保存语义：每次改动立即 POST（无「保存」按钮），服务端归一化后的投影是回填来源——
 * 这样非法值/被拒绝的写入不会在 UI 上留下假状态。
 */
import { Loader2 } from "lucide-react";
import type { SafeWebSettings, WebWritableSettings } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { Switch } from "@/components/ui-shadcn/switch";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { WebSettingsController } from "./useWebSettings";

/** 字号覆盖「跟随全局」的哨兵值：Radix Select 不接受空字符串作为 item value。 */
const FOLLOW_GLOBAL = "__follow";

const FONT_SIZE_OPTIONS = [
	{ value: "compact", labelKey: "settings.fontSizeCompact" },
	{ value: "medium", labelKey: "settings.fontSizeMedium" },
	{ value: "large", labelKey: "settings.fontSizeLarge" },
	{ value: "xlarge", labelKey: "settings.fontSizeXlarge" },
] as const;

const THEME_OPTIONS = [
	{ value: "system", labelKey: "web.settingsThemeSystem" },
	{ value: "light", labelKey: "web.settingsThemeLight" },
	{ value: "dark", labelKey: "web.settingsThemeDark" },
	{ value: "schedule", labelKey: "web.settingsThemeSchedule" },
] as const;

const SEND_SHORTCUT_OPTIONS = [
	{ value: "enter-send", labelKey: "web.settingsSendEnter" },
	{ value: "ctrl-enter-send", labelKey: "web.settingsSendCtrl" },
	{ value: "shift-enter-send", labelKey: "web.settingsSendShift" },
] as const;

const BACKEND_OPTIONS = [
	{ value: "pi", labelKey: "web.settingsBackendPi" },
	{ value: "dsh", labelKey: "web.settingsBackendDsh" },
] as const;

function SettingRow(props: { label: string; description?: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 py-2">
			<div className="min-w-0 flex-1">
				<div className="truncate text-control text-foreground">{props.label}</div>
				{props.description ? <div className="mt-0.5 text-micro leading-4 text-text-tertiary">{props.description}</div> : null}
			</div>
			<div className="shrink-0">{props.children}</div>
		</div>
	);
}

function Section(props: { title: string; children: React.ReactNode }) {
	return (
		<section className="border-b border-border/60 pb-1 last:border-b-0">
			<h3 className="pt-1 pb-0.5 text-micro font-medium tracking-wide text-text-tertiary uppercase">{props.title}</h3>
			<div className="divide-y divide-border/40">{props.children}</div>
		</section>
	);
}

export function WebSettingsPanel(props: { open: boolean; onOpenChange: (open: boolean) => void; settings: SafeWebSettings | null; loading: boolean; loadError: string | null; saving: boolean; saveError: string | null; onReload: () => void; onPatch: (patch: Partial<WebWritableSettings>) => void }) {
	const { settings, saving } = props;
	const scheduleHint = settings && settings.theme === "schedule" ? `${settings.themeScheduleLightStart} – ${settings.themeScheduleDarkStart}` : null;
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] flex-col gap-2 sm:max-w-md" data-testid="web-settings-panel">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{t("web.settingsTitle")}
						{props.saving ? <Loader2 className="size-3.5 animate-spin text-text-tertiary" aria-label={t("web.settingsSaving")} /> : null}
					</DialogTitle>
					<DialogDescription className="text-micro">{t("web.settingsDescription")}</DialogDescription>
				</DialogHeader>

				{props.loadError ? (
					<div className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-caption text-danger" role="alert">
						<span className="min-w-0 flex-1">{props.loadError}</span>
						<Button type="button" variant="outline" size="sm" className="h-6 px-2 text-micro" onClick={props.onReload}>
							{t("web.settingsRetry")}
						</Button>
					</div>
				) : null}

				{/* scroll-ok: transient —— 设置面板内容固定，不是随数据增长的列表。 */}
				<div className={cn("min-h-0 flex-1 overflow-y-auto pr-0.5", !settings && "opacity-60")}>
					{!settings ? (
						<div className="flex items-center justify-center py-8 text-caption text-text-tertiary">{props.loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : t("web.settingsUnavailable")}</div>
					) : (
						<>
							<Section title={t("web.settingsAppearance")}>
								<SettingRow label={t("web.settingsTheme")} description={scheduleHint ? t("web.settingsThemeScheduleHint", { range: scheduleHint }) : undefined}>
									<Select value={settings.theme} disabled={saving} onValueChange={(value) => props.onPatch({ theme: value as SafeWebSettings["theme"] })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("web.settingsTheme")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{THEME_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								<SettingRow label={t("settings.fontSize")}>
									<Select value={settings.fontSize} disabled={saving} onValueChange={(value) => props.onPatch({ fontSize: value as SafeWebSettings["fontSize"] })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("settings.fontSize")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{FONT_SIZE_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								<SettingRow label={t("settings.uiFontSize")}>
									<Select value={settings.uiFontSize ?? FOLLOW_GLOBAL} disabled={saving} onValueChange={(value) => props.onPatch({ uiFontSize: value === FOLLOW_GLOBAL ? null : (value as SafeWebSettings["fontSize"]) })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("settings.uiFontSize")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											<SelectItem value={FOLLOW_GLOBAL}>{t("web.settingsFollowGlobal")}</SelectItem>
											{FONT_SIZE_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								<SettingRow label={t("settings.chatFontSize")}>
									<Select value={settings.chatFontSize ?? FOLLOW_GLOBAL} disabled={saving} onValueChange={(value) => props.onPatch({ chatFontSize: value === FOLLOW_GLOBAL ? null : (value as SafeWebSettings["fontSize"]) })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("settings.chatFontSize")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											<SelectItem value={FOLLOW_GLOBAL}>{t("web.settingsFollowGlobal")}</SelectItem>
											{FONT_SIZE_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
							</Section>

							<Section title={t("web.settingsSessionDefaults")}>
								<SettingRow label={t("web.settingsDefaultBackend")} description={settings.defaultAgentBackendDesktopOnly ? t("web.settingsDefaultBackendDesktopOnly") : t("web.settingsDefaultBackendDesc")}>
									<Select value={settings.defaultAgentBackend} disabled={saving || settings.defaultAgentBackendDesktopOnly} onValueChange={(value) => props.onPatch({ defaultAgentBackend: value as SafeWebSettings["defaultAgentBackend"] })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("web.settingsDefaultBackend")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{BACKEND_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
							</Section>

							<Section title={t("web.settingsInput")}>
								<SettingRow label={t("web.settingsSendShortcut")}>
									<Select value={settings.sendShortcut} disabled={saving} onValueChange={(value) => props.onPatch({ sendShortcut: value as SafeWebSettings["sendShortcut"] })}>
										<SelectTrigger className="h-8 w-36 text-caption" aria-label={t("web.settingsSendShortcut")}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{SEND_SHORTCUT_OPTIONS.map((option) => (
												<SelectItem key={option.value} value={option.value}>
													{t(option.labelKey)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</SettingRow>
								<SettingRow label={t("web.settingsExpandInterim")} description={t("web.settingsExpandInterimDesc")}>
									<Switch checked={settings.expandInterimDuringStream} disabled={saving} onCheckedChange={(checked) => props.onPatch({ expandInterimDuringStream: checked })} aria-label={t("web.settingsExpandInterim")} />
								</SettingRow>
							</Section>
						</>
					)}
				</div>

				{props.saveError ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-micro text-danger" role="alert">
						{props.saveError}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/**
 * 组合根用的弹层包装：把 useWebSettings 控制器直接接进面板。
 *
 * 分开的理由只有一条——WebChatApp 是巨文件（≤ 行数预算），把 11 行 prop 搬运留在本文件，
 * 组合根保持「一行一个弹层」。
 */
export function WebSettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; controller: WebSettingsController }) {
	const { controller } = props;
	return <WebSettingsPanel open={props.open} onOpenChange={props.onOpenChange} settings={controller.settings} loading={controller.loading} loadError={controller.loadError} saving={controller.saving} saveError={controller.saveError} onReload={controller.reload} onPatch={controller.patch} />;
}
