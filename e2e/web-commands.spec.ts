import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * Web 命令面板（T4）E2E：纯键盘路径。
 * - Ctrl+Shift+P 打开 → 输入过滤 → Enter 执行 → 面板关闭、目标界面出现；
 * - ↑/↓ 改变选中项（无障碍 listbox 的 aria-selected/activedescendant 同步）；
 * - 移动端没有物理键盘，⋮ 菜单里也有入口（同一组件）。
 *
 * 端口 8880：8765 是本机常驻服务，8877–8879 已被其它 web spec 占用。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-web-commands-"));

test.afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8880,
		webServiceRequiresAuth: false,
	},
	seedProjects: [{ id: "p-web-commands", name: "Commands", path: projectDir }],
});

const BASE = "http://127.0.0.1:8880";

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
	return page;
}

async function openPalette(page: import("@playwright/test").Page) {
	await page.keyboard.press("Control+Shift+P");
	const palette = page.getByTestId("web-command-palette");
	await expect(palette).toBeVisible();
	const input = palette.getByRole("textbox");
	await expect(input).toBeFocused();
	return { palette, input };
}

test("web commands: keyboard open, filter, navigate and execute", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);

	// 建一个草稿会话，供「会话切换 / 打开工作区」命令使用。
	const created = await page.request.post(`${BASE}/api/sessions`, { data: { projectId: "p-web-commands", title: "命令面板会话" } });
	expect(created.ok()).toBe(true);
	const sessionId = ((await created.json()) as { session: { id: string } }).session.id;
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });

	// 1) 会话切换：输入标题 → Enter → 地址栏落到该会话。
	let { palette, input } = await openPalette(page);
	await input.fill("命令面板会话");
	await expect(palette.getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Enter");
	await expect(palette).toHaveCount(0);
	await expect.poll(() => page.url()).toContain(`/s/${sessionId}`);

	// 2) 工作区命令：过滤「文件」→ Enter → 抽屉打开且文件面板处于选中态。
	({ palette, input } = await openPalette(page));
	await input.fill("文件");
	const options = palette.getByRole("option");
	await expect(options).toHaveCount(1);
	await expect(options.first()).toContainText("打开文件面板");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("web-workspace-drawer")).toBeVisible();
	const fileTab = page.getByTestId("web-workspace-drawer").getByRole("tab", { name: "文件" });
	if ((await fileTab.count()) > 0) await expect(fileTab).toHaveAttribute("aria-selected", "true");

	// 3) 键盘导航：空查询下列表有多条，↓ 把选中项移到第二项（aria-selected 唯一）。
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("web-workspace-drawer")).toHaveCount(0);
	({ palette } = await openPalette(page));
	const activeBefore = await palette.locator('[data-active="true"]').getAttribute("data-command-id");
	await page.keyboard.press("ArrowDown");
	const activeAfter = await palette.locator('[data-active="true"]').getAttribute("data-command-id");
	expect(activeAfter).not.toBe(activeBefore);
	await expect(palette.getByRole("option", { selected: true })).toHaveCount(1);

	// 4) Esc 关闭且不执行命令。
	await page.keyboard.press("Escape");
	await expect(palette).toHaveCount(0);
	await expect(page.getByTestId("web-settings-panel")).toHaveCount(0);

	// 5) ⋮ 菜单入口（移动端无键盘路径）：打开设置面板。
	await page.locator(".web-header-actions button").last().click();
	await page.getByRole("menuitem", { name: "命令面板" }).click();
	await expect(page.getByTestId("web-command-palette")).toBeVisible();
	await page.getByTestId("web-command-palette").getByRole("textbox").fill("设置");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("web-settings-panel")).toBeVisible();
});
