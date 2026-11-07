import { useEffect, useState } from "react";
import { WEB_MOBILE_MAX_WIDTH, isMobileViewport, readViewportWidth } from "./webViewport";

export function useIsMobileViewport(): boolean {
	const [mobile, setMobile] = useState(() => isMobileViewport(readViewportWidth()));
	useEffect(() => {
		const media = window.matchMedia(`(max-width: ${WEB_MOBILE_MAX_WIDTH}px)`);
		// 浏览器窗口恢复/屏幕旋转时，Electron 偶发漏发 MediaQueryList change；
		// resize 直接读取 innerWidth，避免 CSS 已是窄屏而 React 仍停留在桌面弹层。
		const sync = () => setMobile(isMobileViewport(window.innerWidth));
		sync();
		window.addEventListener("resize", sync);
		media.addEventListener("change", sync);
		return () => {
			window.removeEventListener("resize", sync);
			media.removeEventListener("change", sync);
		};
	}, []);
	return mobile;
}

/**
 * 触屏主指针，与全站 `pointer-coarse` CSS 变体同一判定（窄窗口桌面键盘不误伤）。
 * 虚拟键盘没有 Shift/修饰键，Enter 键行为、输入提示文案等触屏专属分支用它门控，
 * 而不是移动宽度断点——两者语义不同（触屏手机 vs 窄窗口）。
 */
export function useCoarsePointer(): boolean {
	const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches);
	useEffect(() => {
		const media = window.matchMedia("(pointer: coarse)");
		const sync = () => setCoarse(media.matches);
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);
	return coarse;
}
