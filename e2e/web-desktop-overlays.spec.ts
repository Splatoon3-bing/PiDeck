import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/** 桌面 Web 的轻量选择器与工作区应保持当前会话可见，而不是整页模态遮挡。 */
test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8876,
		webServiceRequiresAuth: false,
	},
});

const DESKTOP = { width: 1280, height: 800 };

async function openDesktopPage(app: import("@playwright/test").ElectronApplication) {
	const baseUrl = "http://127.0.0.1:8876";
	let healthy = false;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const response = await fetch(`${baseUrl}/api/health`).catch(() => null);
		if (response?.ok) {
			healthy = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	expect(healthy).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize(DESKTOP);
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();
	return page;
}

test("desktop: model and thinking pickers open as local popovers", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openDesktopPage(app);
	const modelRow = page.getByTestId("web-composer-model-row");
	const modelPill = modelRow.locator("button").first();

	await modelPill.click();
	const modelPopover = page.locator("[data-slot='popover-content']");
	await expect(modelPopover).toBeVisible();
	await expect(page.locator("[role='dialog'][aria-modal='true']")).toHaveCount(0);
	const [triggerBox, popoverBox] = await Promise.all([modelPill.boundingBox(), modelPopover.boundingBox()]);
	expect(popoverBox?.width ?? DESKTOP.width).toBeLessThan(560);
	expect(popoverBox?.y ?? DESKTOP.height).toBeLessThan(triggerBox?.y ?? 0);
	await expect(modelPopover.getByTestId("web-model-row").first()).toBeVisible();
	// 行内信息层级：名称与能力徽标同行，provider · id 与上下文窗口次行（进不去滚动也能看到）
	await expect(modelPopover.getByTestId("web-model-row").first()).toContainText(/\d+K|\d+M/);
	// 选一个模型后重开：当前模型必然出现在「最近使用」首位（打开弹层第一眼确认现在是谁）
	await modelPopover.getByTestId("web-model-row").first().click();
	await expect(modelPopover).toBeHidden();
	await modelPill.click();
	await expect(modelPopover.getByText("最近使用")).toBeVisible();
	await modelPill.click();
	await expect(modelPopover).toBeHidden();

	await modelRow.locator("button").nth(1).click();
	const thinkingPopover = page.locator("[data-slot='popover-content']");
	await expect(thinkingPopover).toBeVisible();
	await expect(thinkingPopover.getByTestId("web-thinking-row")).toHaveCount(7);
	await expect(page.locator("[role='dialog'][aria-modal='true']")).toHaveCount(0);
	const thinkingBox = await thinkingPopover.boundingBox();
	expect(thinkingBox?.width ?? DESKTOP.width).toBeLessThanOrEqual(340);
	// 弹层自带标题栏（含关闭），不再是一打开就是内容列表
	await expect(thinkingPopover.getByText("思考档位")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(thinkingPopover).toBeHidden();
});

test("desktop: rebuilt frontend shows an update button and only reloads on click", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openDesktopPage(app);
	// 基线：刚打开就是当前构建，不应误报「有新版本」。
	await expect(page.getByTestId("web-apply-update")).toHaveCount(0);

	// 模拟「桌面端重新构建」：web.html 引用的 bundle 名变化 → 构建指纹变化。
	// 只改这一份测试应用自己的构建产物，finally 必须恢复。
	const webEntry = join(__dirname, "..", "out", "renderer", "web.html");
	const original = readFileSync(webEntry, "utf8");
	try {
		writeFileSync(webEntry, original.replace("</body>", "<!-- rebuilt --></body>"));
		const updateButton = page.getByTestId("web-apply-update");
		await expect(updateButton).toBeVisible({ timeout: 20_000 });
		// 按钮只在用户点击后重载：页面要等到 click 才有导航。
		await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }), updateButton.click()]);
		await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("web-apply-update")).toHaveCount(0);
	} finally {
		writeFileSync(webEntry, original);
	}
});

test("desktop: deleting a session uses a local menu and a bounded confirmation dialog", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openDesktopPage(app);
	await page.locator(".project-group .project-action").first().click();
	const row = page.locator(".chat-list-pane .session-row.active");
	await expect(row).toHaveCount(1, { timeout: 20_000 });

	// 侧栏「会话操作」在桌面是局部菜单，不得用全屏遮罩盖住聊天区。
	await row.getByRole("button", { name: "会话操作" }).click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await expect(page.locator("[role='dialog'][aria-modal='true']")).toHaveCount(0);
	expect((await menu.boundingBox())?.width ?? DESKTOP.width).toBeLessThan(280);
	await menu.getByRole("menuitem", { name: "删除会话" }).click();

	const dialog = page.locator("[data-slot='alert-dialog-content']");
	await expect(dialog).toBeVisible();
	expect((await dialog.boundingBox())?.width ?? DESKTOP.width).toBeLessThanOrEqual(512);
	await dialog.getByRole("button", { name: "删除", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.locator(".chat-list-pane .session-row")).toHaveCount(0);
	await expect(page.locator(".app")).toHaveAttribute("class", /web-app/);
	await expect(page.locator("textarea#prompt")).toBeVisible();
});

test("desktop: workspace docks beside chat without an overlay", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openDesktopPage(app);
	await page.locator(".project-group .project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });

	const workspaceButton = page.locator(".web-header-actions button").filter({ has: page.locator(".lucide-panel-right") });
	await workspaceButton.click();
	const workspace = page.locator("aside").filter({ has: page.getByRole("tab", { name: /Git/ }) });
	await expect(workspace).toBeVisible();
	await expect(page.locator("textarea#prompt")).toBeVisible();
	await expect(page.locator(".fixed.inset-0.bg-black\\/30")).toHaveCount(0);

	const [workspaceBox, chatBox] = await Promise.all([workspace.boundingBox(), page.locator("main.chat-pane").boundingBox()]);
	expect(workspaceBox?.width ?? DESKTOP.width).toBeLessThanOrEqual(448);
	expect(workspaceBox?.x ?? 0).toBeGreaterThanOrEqual((chatBox?.x ?? 0) + (chatBox?.width ?? 0) - 1);
	await page.keyboard.press("Escape");
	await expect(workspace).toHaveCount(0);
});
