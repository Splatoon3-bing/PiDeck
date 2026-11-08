/**
 * WebPickerSurface — 轻量选择器的响应式容器（模型 / 思考 / 后端共用）。
 *
 * 同一个触发器两套承载：
 * - 窄屏：底部弹层（拇指可达的大触控行），触发器自己负责开关
 * - 桌面：锚定触发器的局部 Popover，带标题栏（标题 + 关闭），不再是「一打开就是搜索框」的半成品观感
 *
 * 触发器不带业务 onClick，由这里统一接线：桌面交给 Radix 的 PopoverTrigger（asChild），
 * 窄屏没有 Radix 包装，必须补回点击语义，否则手机上点 pill 毫无反应。
 */
import { cloneElement, isValidElement, type ReactNode } from "react";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui-shadcn/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebBottomSheet } from "./WebBottomSheet";
import { useIsMobileViewport } from "./useIsMobileViewport";

export function WebPickerSurface(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; trigger: ReactNode; children: ReactNode; className?: string }) {
	const mobile = useIsMobileViewport();

	if (mobile) {
		const trigger = isValidElement<{ onClick?: () => void; "aria-haspopup"?: string; "aria-expanded"?: boolean }>(props.trigger)
			? cloneElement(props.trigger, {
					onClick: () => props.onOpenChange(!props.open),
					"aria-haspopup": "dialog",
					"aria-expanded": props.open,
				})
			: props.trigger;
		return (
			<>
				{trigger}
				<WebBottomSheet open={props.open} onOpenChange={props.onOpenChange} title={props.title}>
					{props.children}
				</WebBottomSheet>
			</>
		);
	}

	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
			{/* 弹层与输入卡留出呼吸间距，并限制高度让列表内部滚动——不遮住正在编辑的 composer。 */}
			<PopoverContent side="top" align="start" sideOffset={12} collisionPadding={16} className={cn("flex max-h-[min(32rem,70dvh)] w-80 flex-col overflow-hidden p-0", props.className)} aria-label={props.title}>
				<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
					<span className="min-w-0 truncate text-sm font-semibold text-foreground">{props.title}</span>
					<button type="button" onClick={() => props.onOpenChange(false)} aria-label={t("common.close")} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
						<X className="size-4" aria-hidden="true" />
					</button>
				</div>
				{props.children}
			</PopoverContent>
		</Popover>
	);
}
