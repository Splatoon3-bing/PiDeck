/**
 * WebThinkingSelector — 思考档位选择（Composer 工具行驻留）。
 *
 * 交互：pill 触发器常驻 composer 工具行（Brain 图标 + 当前档位短标签），与模型 pill 并排；
 * 窄屏底部弹层、桌面锚定触发器的局部菜单（WebPickerSurface 提供标题栏）。
 *
 * 2026-11 视觉返工：行高 40px + 行间 2px（原先 36px 紧贴，七档连成一片）；
 * 选中态改为左侧主色竖条 + 主色文字，不再整条铺灰底（看起来像表格）；
 * 右侧加档位强度条，一眼看出「当前强度在刻度上的位置」而不必读文字。
 */
import { useState } from "react";
import { Brain, Check } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebPickerSurface } from "./WebPickerSurface";

import { THINKING_LEVELS } from "@/components/session/sessionPickerOptions";

/** pi 支持的思考档位（顺序即展示顺序）；单源自桌面 THINKING_LEVELS，桌面加档位 Web 自动跟随。 */
export const WEB_THINKING_LEVELS = THINKING_LEVELS.map((level) => level.value);

export function webThinkingLabel(level: string) {
	switch (level) {
		case "minimal":
			return t("thinking.levelLabel.minimal");
		case "low":
			return t("thinking.levelLabel.low");
		case "medium":
			return t("thinking.levelLabel.medium");
		case "high":
			return t("thinking.levelLabel.high");
		case "xhigh":
			return t("thinking.levelLabel.xhigh");
		case "max":
			return t("thinking.levelLabel.max");
		default:
			return t("thinking.levelLabel.off");
	}
}

/** 档位强度条：一档一格，填到当前档；off 全空（读作「不思考」）。颜色走思考身份色。 */
function ThinkingIntensity(props: { level: string }) {
	const currentIndex = WEB_THINKING_LEVELS.indexOf(props.level);
	// off=0 格、minimal=1 格 … max=6 格：格数就是「强度」，而不是「列表位置」。
	const filledCount = currentIndex > 0 ? currentIndex : 0;
	return (
		<span className="flex shrink-0 items-center gap-[3px]" aria-hidden="true">
			{WEB_THINKING_LEVELS.map((level, index) => (
				<span key={level} className={cn("h-3 w-[3px] rounded-full transition-colors", index < filledCount ? "bg-[var(--color-thinking)]" : "bg-muted-foreground/25")} />
			))}
		</span>
	);
}

export function WebThinkingSelector(props: { level?: string; onChange: (level: string) => void }) {
	const [open, setOpen] = useState(false);
	const current = props.level ?? "off";

	return (
		<WebPickerSurface
			open={open}
			onOpenChange={setOpen}
			title={t("web.thinkingSheetTitle")}
			trigger={
				<Button type="button" variant="ghost" className="h-8 shrink-0 gap-1 px-1 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:h-9" aria-label={t("web.thinking")} title={t("web.thinkingSheetTitle")}>
					<Brain className="size-4 shrink-0" aria-hidden="true" />
					{/* 档位标签驻留模型行（非操作行，不挤发送钮）：移动走查 #6——只显图标时
					    用户看不到当前思考档位是关还是高；窄屏用 text-micro + 限宽，宽屏常规字号。 */}
					<span className="min-w-0 max-w-10 truncate text-micro sm:max-w-none sm:text-caption">{webThinkingLabel(current)}</span>
				</Button>
			}
		>
			{/* 行高 40px + 行间 2px：七档之间靠留白断开；触屏回到 48px 大行。 */}
			<ul className="px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]">
				{WEB_THINKING_LEVELS.map((level) => {
					const selected = level === current;
					return (
						<li key={level}>
							<button
								type="button"
								aria-pressed={selected}
								data-testid="web-thinking-row"
								className={cn("group relative flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 pointer-coarse:h-12", selected ? "text-primary" : "text-foreground")}
								onClick={() => {
									props.onChange(level);
									setOpen(false);
								}}
							>
								{/* 选中态：左侧主色竖条，替代原先整条铺色 */}
								<span aria-hidden="true" className={cn("absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary transition-opacity", selected ? "opacity-100" : "opacity-0")} />
								<span className="min-w-0 flex-1 truncate font-medium">{webThinkingLabel(level)}</span>
								<ThinkingIntensity level={level} />
								<Check className={cn("size-4 shrink-0 text-primary transition-opacity", selected ? "opacity-100" : "opacity-0")} aria-hidden="true" />
							</button>
						</li>
					);
				})}
				<li aria-hidden="true" className="h-1" />
			</ul>
		</WebPickerSurface>
	);
}
