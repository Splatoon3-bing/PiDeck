/**
 * Web 端 Async Clipboard API 垫片（非安全上下文兜底）。
 *
 * 问题：浏览器只在 **secure context**（https / localhost）暴露 `navigator.clipboard`。
 * PiDeck Web 服务默认跑在 `http://<LAN-IP>:<port>`（手机/平板访问的常态），此时
 * `navigator.clipboard` 是 undefined。streamdown 的代码块/表格/图表复制按钮只调
 * `navigator.clipboard.writeText` / `navigator.clipboard.write`，缺失时直接抛错并被
 * 它自己的 onError 吞掉——用户看到的现象就是「点了复制没反应」。
 *
 * 做法照 lgarron/clipboard-polyfill（https://github.com/lgarron/clipboard-polyfill）：
 * 缺失时把标准的 `navigator.clipboard` + `ClipboardItem` 形状补上，文本写入落到
 * 隐藏 textarea + `document.execCommand("copy")`（唯一在非安全上下文可用的路径，
 * 必须在用户手势的同步栈里调用，所以这里不加 await/微任务）。
 *
 * 只在缺失时安装：安全上下文里保留浏览器原生实现（异步、无需选区、支持富文本）。
 */

/** `navigator.clipboard.write` 的入参形态（原生 ClipboardItem 或本垫片实现）。 */
type ClipboardItemLike = {
	types?: readonly string[];
	getType?: (type: string) => Promise<Blob>;
};

/**
 * 同步写文本：隐藏 textarea + execCommand("copy")。
 *
 * 用 textarea 而不是 contenteditable：textarea 的选区在 iOS/Android/桌面浏览器上
 * 都被 execCommand 认（clipboard-polyfill 同款选择）；只读属性防止移动端弹键盘。
 */
function writeTextWithExecCommand(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.setAttribute("readonly", "true");
		// 不能用 display:none / visibility:hidden：不可见元素无法被选中
		textarea.style.position = "fixed";
		textarea.style.top = "0";
		textarea.style.left = "0";
		textarea.style.width = "1px";
		textarea.style.height = "1px";
		textarea.style.padding = "0";
		textarea.style.border = "0";
		textarea.style.opacity = "0";
		document.body.appendChild(textarea);
		const selection = document.getSelection();
		const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
		try {
			textarea.select();
			textarea.setSelectionRange(0, text.length);
			const ok = document.execCommand("copy");
			if (ok) resolve();
			else reject(new Error("execCommand copy rejected"));
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			textarea.remove();
			// 还原用户原有选区：复制不该顺手把页面里的选中文本清掉
			if (previousRange && selection) {
				selection.removeAllRanges();
				selection.addRange(previousRange);
			}
		}
	});
}

/** 从 ClipboardItem 里取纯文本：优先 text/plain，退而用 text/html 的文本内容。 */
async function plainTextOfItem(item: ClipboardItemLike): Promise<string | null> {
	const types = Array.isArray(item.types) ? item.types : [];
	const pick = types.includes("text/plain") ? "text/plain" : types.includes("text/html") ? "text/html" : types[0];
	if (!pick || typeof item.getType !== "function") return null;
	const blob = await item.getType(pick);
	if (!blob) return null;
	const raw = await blob.text();
	if (pick !== "text/html") return raw;
	const holder = document.createElement("div");
	holder.innerHTML = raw;
	return holder.textContent ?? "";
}

/** 缺失时补上 `window.ClipboardItem`：streamdown 的表格复制会先 `new ClipboardItem(...)`。 */
function installClipboardItem(): void {
	if (typeof window === "undefined" || "ClipboardItem" in window) return;
	class ClipboardItemPolyfill {
		private readonly items: Record<string, Blob | string>;
		constructor(items: Record<string, Blob | string>) {
			this.items = items;
		}
		get types(): string[] {
			return Object.keys(this.items);
		}
		getType(type: string): Promise<Blob> {
			const value = this.items[type];
			if (value === undefined) return Promise.reject(new Error(`ClipboardItem has no type ${type}`));
			return Promise.resolve(typeof value === "string" ? new Blob([value], { type }) : value);
		}
	}
	Object.defineProperty(window, "ClipboardItem", { value: ClipboardItemPolyfill, configurable: true, writable: true });
}

/**
 * 安装垫片（幂等）。在 Web 入口渲染前调用一次即可。
 *
 * 判据用 `navigator.clipboard?.writeText` 而不是 `window.isSecureContext`：
 * 某些内嵌浏览器会暴露 isSecureContext=false 却给半个 clipboard 对象，按能力判定更准。
 */
export function installWebClipboardShim(): void {
	if (typeof navigator === "undefined" || typeof document === "undefined") return;
	installClipboardItem();
	if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return;
	const clipboard = {
		writeText: (text: string) => writeTextWithExecCommand(String(text ?? "")),
		// 富文本降级为纯文本：非安全上下文的 execCommand 也能写 html（contenteditable 路径），
		// 但表单/表格复制的实际需求是「粘到别处能看」，纯文本语义更稳定。
		write: async (items: ClipboardItemLike[]) => {
			for (const item of items) {
				const text = await plainTextOfItem(item);
				if (text !== null) {
					await writeTextWithExecCommand(text);
					return;
				}
			}
			throw new Error("no writable clipboard item");
		},
	};
	try {
		Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true, writable: true });
	} catch {
		// 只读环境（极少见）：保持原状，调用方自己的兜底路径仍然生效
	}
}
