/**
 * 生图会话的发送器（Web）：不进 useChat/SSE——生图是单次请求 + 落盘结果。
 *
 * 只在 backend=imagegen 的会话启用；其它后端完全不受影响（不加载配置、不拦发送）。
 * 失败只回错误文案（供应商未配置/密钥无效等），不重试：重试会二次计费。
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "@/i18n";
import { dataUrlToImageContent, fetchWebImageGenConfig, generateWebImage, type WebImageGenConfig } from "./webImageGen";

export function useWebImageGen(deps: { sessionId: string | null; enabled: boolean; onError: (message: string) => void; onGenerated: (sessionId: string) => void }) {
	const [config, setConfig] = useState<WebImageGenConfig | null>(null);
	const [generating, setGenerating] = useState(false);
	const { enabled, sessionId, onError, onGenerated } = deps;

	useEffect(() => {
		if (!enabled) {
			setConfig(null);
			return;
		}
		let disposed = false;
		void fetchWebImageGenConfig()
			.then((next) => {
				if (!disposed) setConfig(next);
			})
			.catch(() => {
				if (!disposed) setConfig(null);
			});
		return () => {
			disposed = true;
		};
	}, [enabled]);

	const generate = useCallback(
		async (prompt: string, images: string[]) => {
			if (!sessionId || generating || !prompt.trim()) return;
			setGenerating(true);
			try {
				const referenceImages = images.map(dataUrlToImageContent).filter((item): item is { data: string; mimeType: string } => item !== null);
				await generateWebImage({ sessionId, prompt: prompt.trim(), ...(referenceImages.length ? { referenceImages } : {}) });
				onGenerated(sessionId);
			} catch (cause) {
				const code = (cause as { code?: string }).code;
				onError(code === "webError.imageGenNotConfigured" ? t("web.imageGenNotConfigured") : t("web.imageGenFailed"));
			} finally {
				setGenerating(false);
			}
		},
		[generating, onError, onGenerated, sessionId],
	);

	/** 组合根只问「这条消息是不是生图」：是则接住（返回 true），否则交回普通发送链路。 */
	const maybeGenerate = useCallback(
		(prompt: string, images: string[]) => {
			if (!enabled || !sessionId) return false;
			void generate(prompt, images);
			return true;
		},
		[enabled, generate, sessionId],
	);

	return { config, generating, generate, maybeGenerate };
}
