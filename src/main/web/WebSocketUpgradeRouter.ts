/**
 * WebSocket upgrade 分发（纯函数）
 *
 * 从 `WebServiceManager.start` 抽出来，便于单测覆盖三条路径：
 * - `/api/terminal` → Web 终端路由（未装配时需要销毁 socket，而不是落到 dev 代理）；
 * - dev 模式其余路径 → vite HMR 代理；
 * - 生产模式其余路径 → 销毁（当前没有别的 WS 能力）。
 *
 * 注意顺序：`/api/terminal` 必须优先于 dev 代理，否则开发模式下终端握手会被转发给 vite。
 */

export type UpgradeTarget = "terminal" | "dev-proxy" | "destroy";

export function resolveUpgradeTarget(input: { pathname: string; hasTerminalRoutes: boolean; devProxyEnabled: boolean }): UpgradeTarget {
	if (input.pathname === "/api/terminal") return input.hasTerminalRoutes ? "terminal" : "destroy";
	if (input.devProxyEnabled) return "dev-proxy";
	return "destroy";
}
