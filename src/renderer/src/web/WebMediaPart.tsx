/**
 * WebMediaPart — 回合内媒体产物（图片 / 视频 / 音频）的内联渲染。
 *
 * 为什么要单独一层：生图（imagegen）与生视频（videogen）的 assistant 消息正文是空串，
 * 产物只存在于 `images` / `videos` 字段（经 chatMessagesToUiMessages 映射成 AI SDK
 * file part）。时间线原先只渲染正文，于是「生图成功但页面上什么都没有」。
 * 这里把媒体段渲染成可直接播放/放大的元素，而不是把地址当文本打印给用户。
 *
 * 地址来源两种，都是渲染层可直接消费的形态：
 * - `data:` URL（用户消息里的参考图 / 桌面内联旧数据）；
 * - 带令牌的 HTTP blob 路由（`/api/imagegen/blob/<ref>?token=…`、`/api/file-raw?…#token`），
 *   `<img>`/`<video>` 不能带 Authorization，所以令牌必须已经拼进 URL。
 *
 * 视频默认 `preload="metadata"`：只取头部信息，时长/首帧出来即可，不抢占带宽；
 * `playsInline` 保证 iOS 不强制全屏（Web 服务的主要使用场景是手机/iPad）。
 */
import { memo, useCallback, useState } from "react";
import { ImageLightbox } from "@/components/session/ImageLightbox";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { MediaSegment } from "./webTimelineGrouping";

export const WebMediaPart = memo(function WebMediaPart(props: { segment: MediaSegment }) {
	const { src, mediaType } = props.segment;
	const alt = props.segment.alt || t("web.messageImage");
	const [open, setOpen] = useState(false);
	const [failed, setFailed] = useState(false);
	const close = useCallback(() => setOpen(false), []);

	if (mediaType.startsWith("video/")) {
		return <video className="max-h-[420px] w-full max-w-[min(100%,640px)] rounded-lg border border-border bg-black" src={src} controls preload="metadata" playsInline />;
	}
	if (mediaType.startsWith("audio/")) {
		// eslint-disable-next-line jsx-a11y/media-has-caption
		return <audio className="w-full max-w-[420px]" src={src} controls preload="metadata" />;
	}
	if (failed) {
		return <span className="text-caption text-text-tertiary">{`${t("markdown.imageLoadFailed")} · ${alt}`}</span>;
	}
	return (
		<>
			<img
				src={src}
				alt={alt}
				title={t("markdown.imageOpen")}
				role="button"
				tabIndex={0}
				loading="lazy"
				decoding="async"
				referrerPolicy="no-referrer"
				className={cn("block max-h-[420px] w-auto max-w-[min(100%,640px)] cursor-zoom-in rounded-lg border border-border object-contain")}
				onClick={() => setOpen(true)}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						setOpen(true);
					}
				}}
				onError={() => setFailed(true)}
			/>
			{open ? <ImageLightbox src={src} alt={alt} onClose={close} /> : null}
		</>
	);
});
