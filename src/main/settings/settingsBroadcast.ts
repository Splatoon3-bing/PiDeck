/**
 * 设置变更广播（settingsBroadcast.ts）
 *
 * 桌面渲染层把 `settings:apply-window` 当作「设置已生效」的同步点（App.tsx 的
 * onSettingsApplied → setSettings，首拉与推送共用同一处应用逻辑）。设置从**主进程内部**
 * 被改写时（目前是 Web 端 /api/settings），只落盘不广播，桌面端窗口会停在旧外观上，
 * 直到用户重开设置页或刷新窗口。
 *
 * 因此这里复用既有通道广播完整设置，而不是新增第二条 IPC 通道。
 */
import { BrowserWindow } from "electron";
import type { AppSettings } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";

export function broadcastSettingsApplied(settings: AppSettings): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.webContents.send(ipcChannels.settingsApplyWindow, settings);
	}
}
