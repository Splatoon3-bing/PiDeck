import { app, dialog, ipcMain } from "electron";
import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ipcChannels } from "../../shared/ipc";
import type { DraftMeta, ScratchPadData, ScratchPadScope } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import { ScratchPadService } from "../scratchPad/ScratchPadService";

export type ScratchPadIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
	/** 宿主已构造的共享实例（Web 服务使用同一份）；缺省时按当前 userData 自建。 */
	service?: ScratchPadService;
};

/**
 * 草稿本 IPC 壳：存储与边界校验的唯一实现已迁到 `ScratchPadService`
 *（Web 服务共用同一份，避免两条入口各写一套路径规则）。
 */
export function registerScratchPadIpc({ appLogger, service: injectedService }: ScratchPadIpcDeps): void {
	const userDataDir = app.getPath("userData");
	const service =
		injectedService ??
		new ScratchPadService({
			draftsDir: join(userDataDir, "drafts"),
			legacyDraftPath: join(userDataDir, "scratch-pad.md"),
			logger: appLogger,
		});

	ipcMain.handle(ipcChannels.scratchPadList, async (_event, scope?: ScratchPadScope): Promise<DraftMeta[]> => service.list(scope));

	ipcMain.handle(ipcChannels.scratchPadCreate, async (_event, scope?: ScratchPadScope): Promise<DraftMeta> => service.create(scope));

	ipcMain.handle(ipcChannels.scratchPadDelete, async (_event, draftPath: string): Promise<void> => service.delete(draftPath));

	ipcMain.handle(ipcChannels.scratchPadLoad, async (_event, draftPath?: string): Promise<ScratchPadData> => service.load(draftPath));

	ipcMain.handle(ipcChannels.scratchPadSave, async (_event, draftPath: string, content: string, cursorPosition: number) => service.save(draftPath, content, cursorPosition));

	/** 导出指定草稿到用户选择的路径（目标由系统对话框选定，源仍受 drafts 边界约束）。 */
	ipcMain.handle(ipcChannels.scratchPadExport, async (_event, draftPath?: string) => {
		if (!draftPath) return false;
		const safePath = service.resolveDraftPath(draftPath);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: basename(safePath),
			filters: [{ name: "Markdown", extensions: ["md"] }],
		});
		if (canceled || !filePath) return false;
		const content = await readFile(safePath, "utf8");
		await writeFile(filePath, content, "utf8");
		return true;
	});
}
