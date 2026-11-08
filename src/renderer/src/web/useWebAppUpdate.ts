import { useCallback, useEffect, useRef, useState } from "react";
import { hasNewerBuild, recordLoadedBuildId } from "./webBuildUpdate";
import { registerWebServiceWorker, usePwaInstall } from "./webPwa";

/**
 * PWA 注册与「前端已重新构建」检测。
 *
 * 从组合根抽出：注册/安装/指纹基线是同一件事（本页 bundle 的生命周期），
 * 组合根只需要 canInstall/install/updateAvailable 与每次状态快照的 syncBuildId。
 */
export function useWebAppUpdate() {
	const loadedBuildIdRef = useRef<string | null>(null);
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const { canInstall, install } = usePwaInstall();

	// SW 注册一次：失败静默降级，不影响页面功能。
	useEffect(() => {
		registerWebServiceWorker();
	}, []);

	/** 指纹基线：首次落地即记录本页版本，之后变化才算「有新版本」（是否重载由用户决定）。 */
	const syncBuildId = useCallback((buildId: string | null | undefined) => {
		loadedBuildIdRef.current = recordLoadedBuildId(loadedBuildIdRef.current, buildId);
		setUpdateAvailable(hasNewerBuild(loadedBuildIdRef.current, buildId));
	}, []);

	return { canInstall, install, updateAvailable, syncBuildId };
}
