/**
 * Web 端连接相位（纯函数 + 一个监听 hook）。
 *
 * 为什么要分三态：`connected` 只表示「最近一次 /api/state 成功」，浏览器离线时它同样是 false，
 * 两者混用会让用户以为服务挂了（实际是设备断网），也看不出该等还是该刷新。
 * - offline：设备离线（navigator.onLine === false），等网络恢复即可；
 * - connecting：设备在线但服务端还没回（首次加载/服务重启/局域网主机下线）；
 * - online：服务端可达。
 */
import { useEffect, useState } from "react";

export type WebConnectionPhase = "online" | "connecting" | "offline";

export function resolveConnectionPhase(serverReachable: boolean, browserOnline: boolean): WebConnectionPhase {
	if (!browserOnline) return "offline";
	return serverReachable ? "online" : "connecting";
}

/** 订阅浏览器在线态（SSR / 测试环境无 window 时按在线处理，避免误报离线）。 */
export function useBrowserOnline(): boolean {
	const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
	useEffect(() => {
		if (typeof window === "undefined") return;
		const sync = () => setOnline(navigator.onLine !== false);
		window.addEventListener("online", sync);
		window.addEventListener("offline", sync);
		sync();
		return () => {
			window.removeEventListener("online", sync);
			window.removeEventListener("offline", sync);
		};
	}, []);
	return online;
}
