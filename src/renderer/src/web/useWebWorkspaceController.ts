import { useCallback, useState } from "react";
import { readStoredWorkspacePanel, storeWorkspacePanel, type WebWorkspacePanel } from "./WebWorkspaceDrawer";

/** 抽屉开关与面板持久化的唯一 owner；组合根只消费动作，不重复拼装配。 */
export function useWebWorkspaceController() {
	const [open, setOpen] = useState(false);
	const [panel, setPanel] = useState<WebWorkspacePanel>(() => readStoredWorkspacePanel());
	const selectPanel = useCallback((next: WebWorkspacePanel) => {
		setPanel(next);
		storeWorkspacePanel(next);
	}, []);
	const openPanel = (next: WebWorkspacePanel) => {
		selectPanel(next);
		setOpen(true);
	};
	return { open, panel, selectPanel, openPanel, close: () => setOpen(false) };
}
