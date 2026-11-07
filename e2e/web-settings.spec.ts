import { test, expect, type Locator, type Page } from "./mock-pi-fixture";

/**
 * Web 设置面板（T1）E2E：
 * - 改字号/明暗 → DOM dataset 立即生效 → 刷新后仍生效（说明来自服务端设置，不是一次性的本地状态）；
 * - 设置投影走白名单：未知字段（含 token 类）400 且不落库，投影里也不出现该字段。
 *
 * 端口用 8879：8765 是本机常驻 pideck.service，8877/8878 已被其它 web spec 占用。
 */
test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8879,
		webServiceRequiresAuth: false,
		theme: "light",
		fontSize: "medium",
	},
});

const BASE = "http://127.0.0.1:8879";

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
	// 设置投影到达前不落字号 dataset；等它带上初始档位再操作。
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", "medium", { timeout: 20_000 });
	return page;
}

async function openSettingsPanel(page: Page) {
	await page.locator(".web-header-actions button").last().click();
	await page.getByRole("menuitem", { name: "设置" }).click();
	const panel = page.getByTestId("web-settings-panel");
	await expect(panel).toBeVisible();
	return panel;
}

async function pickOption(page: Page, panel: Locator, label: string, option: string) {
	await panel.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

test("web settings: appearance changes apply, persist across reload and sync through the allowlist", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);

	const panel = await openSettingsPanel(page);

	// 字号：全局字号 → 大。dataset 由 applyFontSizeAttributes 写，界面立刻变大。
	await pickOption(page, panel, "全局字号", "大");
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", "large", { timeout: 20_000 });

	// 明暗：跟随系统 → 深色。
	await pickOption(page, panel, "明暗主题", "深色");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 20_000 });

	// 服务端投影已落库（不是只改了本地 state）。
	const roundTrip = await page.request.get(`${BASE}/api/settings`);
	expect(roundTrip.ok()).toBe(true);
	const projected = (await roundTrip.json()) as { settings: Record<string, unknown> };
	expect(projected.settings.fontSize).toBe("large");
	expect(projected.settings.theme).toBe("dark");
	// 投影里不该出现任何凭据/安全/终端类字段。
	const serialized = JSON.stringify(projected);
	for (const forbidden of ["webServiceToken", "securityConfig", "acpTools", "terminalShells"]) expect(serialized).not.toContain(forbidden);

	// 刷新：字号没有任何 localStorage 缓存，仍生效说明读的是服务端设置。
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", "large", { timeout: 20_000 });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 20_000 });
});

test("web settings: unknown keys are rejected with 400 and do not partially write", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openPage(app);

	const before = await (await page.request.get(`${BASE}/api/settings`)).json();
	const response = await page.request.post(`${BASE}/api/settings`, {
		data: { theme: "light", webServiceToken: "attacker-controlled" },
	});
	expect(response.status()).toBe(400);
	const errorBody = (await response.json()) as { code?: string; field?: string };
	expect(errorBody.code).toBe("webError.settings.unknownKey");
	expect(errorBody.field).toBe("webServiceToken");

	// 兄弟字段也不能被部分写入。
	const after = await (await page.request.get(`${BASE}/api/settings`)).json();
	expect((after as { settings: { theme: string } }).settings.theme).toBe((before as { settings: { theme: string } }).settings.theme);
	expect(JSON.stringify(after)).not.toContain("attacker-controlled");
});

/**
 * 桌面端一致性：Web 改设置必须经既有 `settings:apply-window` 广播即时落到桌面窗口，
 * 而不是等用户重开设置页/重启。这里不导航到 Web 页——直接对服务 POST，观察桌面窗口的
 * `html[data-theme]` 变化（同一份 SettingsStore 是两端唯一事实来源）。
 */
test("web settings: desktop window applies web writes immediately via settings:apply-window", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light", { timeout: 20_000 });

	const response = await fetch(`${BASE}/api/settings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ theme: "dark" }),
	});
	expect(response.ok).toBe(true);

	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark", { timeout: 20_000 });
});

/**
 * 移动端（390px）走查：设置面板必须能用触控打开、且不产生横向溢出。
 * Electron 窗口没有真触屏，这里验能验的两点：入口可达（⋮ 菜单）+ 布局不溢出。
 */
test("web settings: mobile 390px entry is reachable and does not overflow horizontally", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(BASE);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", /compact|medium|large|xlarge/, { timeout: 20_000 });

	const overflowBefore = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflowBefore).toBeLessThanOrEqual(0);

	// 移动端没有快捷键入口：⋮ 菜单里必须能打开设置。
	await page.locator(".web-header-actions button").last().click();
	await page.getByRole("menuitem", { name: "设置" }).click();
	const panel = page.getByTestId("web-settings-panel");
	await expect(panel).toBeVisible();
	// 面板内的控件在 390px 下仍可操作（触控目标沿用 pointer-coarse:size-9 / h-8+）。
	await expect(panel.getByRole("combobox", { name: "全局字号" })).toBeVisible();
	const overflowWithPanel = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflowWithPanel).toBeLessThanOrEqual(0);

	// 触控路径改字号：立即生效（dataset 变化），说明移动端不必借助键盘也能改设置。
	await panel.getByRole("combobox", { name: "全局字号" }).click();
	await page.getByRole("option", { name: "特大", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("data-ui-font-size", "xlarge", { timeout: 20_000 });
});
