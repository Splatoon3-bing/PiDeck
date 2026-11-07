import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * Web 终端 S4 E2E（真实 WS + 真实 node-pty）：
 * - 开关开启：工作区抽屉出现「终端」→ 打开面板 → xterm 就绪 → 输入命令回显 → 关闭 tab；
 * - 开关关闭：入口不出现（C1：只有桌面能开）；
 * - 390px：终端面板不产生横向溢出。
 *
 * 端口 8881：8765 是本机常驻 pideck.service，8877/8878/8879 已被其它 web spec 占用。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-web-terminal-"));
writeFileSync(join(projectDir, "readme.md"), "# terminal e2e\n", "utf8");

test.afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

const BASE = "http://127.0.0.1:8881";

async function waitForHealthy(): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const response = await fetch(`${BASE}/api/health`).catch(() => null);
		if (response?.ok) return true;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

async function openPage(app: import("@playwright/test").ElectronApplication) {
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(BASE);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	// 等设置投影到达（终端入口是否显示依赖 terminalEnabled）。
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", /compact|medium|large|xlarge/, { timeout: 20_000 });
	return page;
}

async function createSession(page: import("@playwright/test").Page) {
	const group = page.locator(".project-group").filter({ hasText: "Terminal" }).first();
	await group.locator(".project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });
}

async function openWorkspace(page: import("@playwright/test").Page) {
	await page
		.locator(".web-header-actions button")
		.filter({ has: page.locator(".lucide-panel-right") })
		.click();
	const drawer = page.getByTestId("web-workspace-drawer");
	await expect(drawer).toBeVisible();
	return drawer;
}

test.describe("web terminal enabled", () => {
	test.use({
		seedSettings: {
			webServiceEnabled: true,
			webServiceHost: "127.0.0.1",
			webServicePort: 8881,
			webServiceRequiresAuth: false,
			webTerminalEnabled: true,
		},
		seedProjects: async ({}, use) => use([{ id: "p-web-terminal", name: "Terminal", path: projectDir }]),
	});

	test("web terminal: opens a PTY, echoes input and closes the tab", async ({ app }) => {
		test.setTimeout(180_000);
		const page = await openPage(app);
		await createSession(page);
		const drawer = await openWorkspace(page);

		await drawer.getByRole("tab", { name: "终端" }).click();
		await expect(page.getByTestId("web-terminal-panel")).toBeVisible();
		// xterm 动态加载 + WS 握手 + 服务端 spawn shell 后才出现
		await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 40_000 });

		const marker = `pideck-${Date.now().toString(36)}`;
		await page.locator(".xterm-screen").first().click();
		await page.keyboard.type(`echo ${marker}`);
		await page.keyboard.press("Enter");
		await expect(page.locator(".xterm-rows")).toContainText(marker, { timeout: 30_000 });

		// 关闭 tab：服务端关闭 PTY，xterm 实例随 tabs 移除
		await page.getByRole("button", { name: "关闭终端" }).first().click();
		await expect(page.locator(".xterm").first()).toHaveCount(0, { timeout: 20_000 });
	});

	test("web terminal: 390px panel does not overflow horizontally", async ({ app }) => {
		test.setTimeout(180_000);
		const page = await openPage(app);
		await createSession(page);
		const drawer = await openWorkspace(page);
		await drawer.getByRole("tab", { name: "终端" }).click();
		await expect(page.locator(".xterm").first()).toBeVisible({ timeout: 40_000 });

		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(300);
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});

test.describe("web terminal disabled", () => {
	test.use({
		seedSettings: {
			webServiceEnabled: true,
			webServiceHost: "127.0.0.1",
			webServicePort: 8881,
			webServiceRequiresAuth: false,
			webTerminalEnabled: false,
		},
		seedProjects: async ({}, use) => use([{ id: "p-web-terminal", name: "Terminal", path: projectDir }]),
	});

	test("web terminal: entry stays hidden when the desktop switch is off", async ({ app }) => {
		test.setTimeout(120_000);
		const page = await openPage(app);
		await createSession(page);
		const drawer = await openWorkspace(page);
		await expect(drawer.getByRole("tab", { name: "终端" })).toHaveCount(0);
		await expect(page.getByTestId("web-terminal-panel")).toHaveCount(0);
	});
});
