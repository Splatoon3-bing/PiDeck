import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * Web 工作台对齐（多标签 / 工作区抽屉 / 文件编辑 / 草稿本）：
 * - 标签：打开两个会话 → 标签栏出现；刷新后恢复；关闭当前标签落到左邻；
 * - 文件：抽屉里打开项目内文件 → 编辑 → 保存 → 磁盘内容更新；
 * - 草稿本：输入 → 自动保存 → 刷新后仍能读回。
 *
 * 这些是「在 Web 上日常使用」的核心路径，纯单测覆盖不到布局/持久化/真实写盘。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-web-workbench-"));
writeFileSync(join(projectDir, "note.txt"), "hello from disk\n", "utf8");

/**
 * 分支用例需要真仓库（路由要求 isGitRepo）；建不了（未装 git）时用例在体内 skip。
 * 用独立目录，避免给文件/草稿本用例的临时项目套上 .git（回收站/symlink 语义不变）。
 */
const gitProjectDir = mkdtempSync(join(tmpdir(), "pideck-web-git-"));
const GIT = process.env.PIDECK_E2E_GIT || "git";
let gitAvailable = true;
let gitBaseBranch = "main";
try {
	try {
		execFileSync(GIT, ["init", "-b", "main", gitProjectDir], { stdio: "ignore" });
	} catch {
		// git < 2.28 没有 -b：回落到 init 后读默认分支
		execFileSync(GIT, ["init", gitProjectDir], { stdio: "ignore" });
		gitBaseBranch = execFileSync(GIT, ["-C", gitProjectDir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim() || "main";
	}
	const identity = ["-c", "user.email=e2e@pideck.local", "-c", "user.name=PiDeck E2E"];
	writeFileSync(join(gitProjectDir, "README.md"), "# git repo for branch e2e\n", "utf8");
	execFileSync(GIT, ["-C", gitProjectDir, ...identity, "add", "README.md"], { stdio: "ignore" });
	execFileSync(GIT, ["-C", gitProjectDir, ...identity, "commit", "-m", "init"], { stdio: "ignore" });
	gitBaseBranch = execFileSync(GIT, ["-C", gitProjectDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
} catch {
	gitAvailable = false;
}

test.afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(gitProjectDir, { recursive: true, force: true });
});

test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8877,
		webServiceRequiresAuth: false,
	},
	// 多个种子必须用函数式覆盖：Playwright 会把长度 ≥2 的数组当成 [value, options] 元组截断。
	seedProjects: async ({}, use) =>
		use([
			{ id: "p-web-workbench", name: "Workbench", path: projectDir },
			{ id: "p-web-git", name: "GitRepo", path: gitProjectDir },
		]),
});

const BASE = "http://127.0.0.1:8877";

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

function workbenchGroup(page: import("@playwright/test").Page) {
	return projectGroup(page, "Workbench");
}

/** 按项目显示名定位侧栏项目组（多个种子项目时各自独立断言）。 */
function projectGroup(page: import("@playwright/test").Page, name: string) {
	return page.locator(".project-group").filter({ hasText: name }).first();
}

async function createSession(page: import("@playwright/test").Page) {
	return createSessionIn(page, "Workbench");
}

/** 在指定项目行点 + 新建会话，返回新会话 id（从 /s/<id> 地址取）。 */
async function createSessionIn(page: import("@playwright/test").Page, projectName: string) {
	const before = await page.locator(".chat-list-pane .session-row").count();
	await projectGroup(page, projectName).locator(".project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row")).toHaveCount(before + 1, { timeout: 20_000 });
	const row = page.locator(".chat-list-pane .session-row.active");
	await expect(row).toHaveCount(1, { timeout: 20_000 });
	// active 状态先落地，pushState 在其后的 effect 里：等 URL 真正写进 /s/<id> 再取。
	await expect.poll(() => page.url()).toContain("/s/");
	return (await page.url()).split("/s/")[1] ?? "";
}

async function openWorkspace(page: import("@playwright/test").Page) {
	const button = page.locator(".web-header-actions button").filter({ has: page.locator(".lucide-panel-right") });
	await button.click();
	const drawer = page.getByTestId("web-workspace-drawer");
	await expect(drawer).toBeVisible();
	return drawer;
}

test("web workbench: tabs persist across reload and close falls back to the left neighbor", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);

	const firstId = await createSession(page);
	expect(firstId).not.toBe("");
	// 单标签不占一行：标签栏在第二个会话出现前保持隐藏。
	await expect(page.getByTestId("web-session-tabs")).toHaveCount(0);

	const secondId = await createSession(page);
	expect(secondId).not.toBe(firstId);
	const tabs = page.getByTestId("web-session-tabs").getByRole("tab");
	await expect(tabs).toHaveCount(2, { timeout: 20_000 });
	await expect(page.getByTestId("web-session-tabs").getByRole("tab", { selected: true })).toHaveCount(1);

	// 刷新：URL 保持当前会话，标签顺序从 localStorage 恢复。
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId("web-session-tabs").getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
	// 关闭当前（第二个）标签：右邻不存在 → 落到左邻（第一个），标签栏只剩一项并隐藏。
	await page.getByTestId("web-session-tabs").getByRole("tab", { selected: true }).getByRole("button").click();
	await expect(page.getByTestId("web-session-tabs")).toHaveCount(0, { timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();
	// 关闭后地址回到左邻会话，而不是根路径。
	await expect.poll(() => page.url()).toContain(`/s/${firstId}`);
});

test("web workbench: file edit saves through the project write boundary", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSession(page);

	const drawer = await openWorkspace(page);
	const fileRow = drawer.locator("button").filter({ hasText: "note.txt" }).first();
	await expect(fileRow).toBeVisible({ timeout: 20_000 });
	await fileRow.click();

	// 全屏预览：编辑 → 保存
	const preview = page.locator("div.fixed.inset-0").last();
	await expect(preview).toBeVisible();
	await preview.getByRole("button", { name: "编辑", exact: true }).click();
	const editor = preview.locator('textarea[aria-label="保存"]');
	await expect(editor).toBeVisible();
	await editor.fill("edited on web\nsecond line\n");
	await preview.getByRole("button", { name: "保存", exact: true }).click();
	await expect(preview.getByText("已保存")).toBeVisible({ timeout: 20_000 });
	expect(readFileSync(join(projectDir, "note.txt"), "utf8")).toBe("edited on web\nsecond line\n");
});

test("web workbench: create, rename and delete project entries", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSession(page);
	const drawer = await openWorkspace(page);

	// 新建文件：工具栏 + 菜单 → 对话框 → 文件树刷新
	await drawer.getByTestId("web-files-add").click();
	await page.getByRole("menuitem", { name: "新建文件", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("textbox", { name: "名称" }).fill("created-by-web.txt");
	await dialog.getByRole("button", { name: "确认" }).click();
	await expect(dialog).toBeHidden({ timeout: 20_000 });
	const createdRow = drawer.locator("li").filter({ hasText: "created-by-web.txt" }).first();
	await expect(createdRow).toBeVisible({ timeout: 20_000 });
	expect(existsSync(join(projectDir, "created-by-web.txt"))).toBe(true);

	// 重命名：行菜单 → 对话框
	await createdRow.getByTestId("web-file-row-menu").click();
	await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
	const renameDialog = page.getByRole("dialog");
	await expect(renameDialog).toBeVisible();
	const renameInput = renameDialog.getByRole("textbox", { name: "名称" });
	await renameInput.fill("renamed-by-web.txt");
	await renameDialog.getByRole("button", { name: "确认" }).click();
	await expect(renameDialog).toBeHidden({ timeout: 20_000 });
	const renamedRow = drawer.locator("li").filter({ hasText: "renamed-by-web.txt" }).first();
	await expect(renamedRow).toBeVisible({ timeout: 20_000 });
	await expect(drawer.locator("li").filter({ hasText: "created-by-web.txt" })).toHaveCount(0);
	expect(existsSync(join(projectDir, "created-by-web.txt"))).toBe(false);
	expect(existsSync(join(projectDir, "renamed-by-web.txt"))).toBe(true);

	// 删除：行菜单 → 确认（走回收站，项目内文件消失）
	await renamedRow.getByTestId("web-file-row-menu").click();
	await page.getByRole("menuitem", { name: "删除", exact: true }).click();
	const alert = page.locator("[data-slot='alert-dialog-content']");
	await expect(alert).toBeVisible();
	await alert.getByRole("button", { name: "删除", exact: true }).click();
	await expect(alert).toBeHidden({ timeout: 20_000 });
	await expect(drawer.locator("li").filter({ hasText: "renamed-by-web.txt" })).toHaveCount(0, { timeout: 20_000 });
	expect(existsSync(join(projectDir, "renamed-by-web.txt"))).toBe(false);
});

/**
 * 分支切换走真仓库：路由层校验 isGitRepo/脏工作区，mock 不了；
 * 断言「UI 显示的分支」与「磁盘上的 HEAD」都变了，才算真的切了。
 */
/** 建会话会在项目里写文件（.pi 等）：工作区可能变脏 → 分支路由回 409，UI 弹二次确认。 */
async function confirmDirtyWorktreeIfAsked(page: import("@playwright/test").Page): Promise<boolean> {
	const alert = page.locator("[data-slot='alert-dialog-content']");
	// 等一小段：脏检查往返很快，但需要给 409 回来的时间；没弹就按「干净工作区」继续。
	const appeared = await alert
		.waitFor({ state: "visible", timeout: 5_000 })
		.then(() => true)
		.catch(() => false);
	if (!appeared) return false;
	await expect(alert).toContainText("工作区有未提交改动");
	await alert.getByRole("button", { name: "仍然切换", exact: true }).click();
	await expect(alert).toBeHidden({ timeout: 20_000 });
	return true;
}

test("web workbench: git branches can be created and switched", async ({ app }) => {
	test.skip(!gitAvailable, "git 不可用，跳过分支 E2E");
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSessionIn(page, "GitRepo");
	const drawer = await openWorkspace(page);
	await drawer.getByRole("tab", { name: "Git", exact: true }).click();

	const branchTrigger = drawer.getByRole("button", { name: "切换分支" });
	await expect(branchTrigger).toContainText(gitBaseBranch, { timeout: 20_000 });

	// 新建并切换：下拉 → 新建分支 → 输入名称 → 确认
	await branchTrigger.click();
	await page.getByRole("menuitem", { name: "新建分支", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("textbox", { name: "分支名称" }).fill("feature/e2e-branch");
	await dialog.getByRole("button", { name: "确认", exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 20_000 });
	await confirmDirtyWorktreeIfAsked(page);
	await expect(branchTrigger).toContainText("feature/e2e-branch", { timeout: 20_000 });
	const headAfterCreate = execFileSync(GIT, ["-C", gitProjectDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
	expect(headAfterCreate).toBe("feature/e2e-branch");

	// 切回原分支：下拉里选基础分支（脏工作区同样先确认）
	await branchTrigger.click();
	await page.getByRole("menuitem", { name: gitBaseBranch, exact: true }).click();
	await confirmDirtyWorktreeIfAsked(page);
	await expect(branchTrigger).toContainText(gitBaseBranch, { timeout: 20_000 });
	const headAfterSwitch = execFileSync(GIT, ["-C", gitProjectDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
	expect(headAfterSwitch).toBe(gitBaseBranch);
});

test("web workbench: notes autosave and read back after reload", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSession(page);

	let drawer = await openWorkspace(page);
	await drawer.getByRole("tab", { name: "草稿本" }).click();
	const noteEditor = drawer.locator('textarea[aria-label="编辑"]');
	await expect(noteEditor).toBeVisible({ timeout: 20_000 });
	await noteEditor.fill("web notes persisted");
	await expect(drawer.getByText("已保存")).toBeVisible({ timeout: 20_000 });

	// 刷新后重开抽屉：草稿本从服务端读回，不依赖页面内存。
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	drawer = await openWorkspace(page);
	await drawer.getByRole("tab", { name: "草稿本" }).click();
	const reopened = drawer.locator('textarea[aria-label="编辑"]');
	await expect(reopened).toHaveValue("web notes persisted", { timeout: 20_000 });
});

/**
 * T7a 状态面板：抽屉里能打开「状态」，展示后端/运行态与上下文用量区（无运行态时给占位）。
 */
test("web workbench: status panel shows backend and runtime", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openPage(app);
	await createSession(page);
	const drawer = await openWorkspace(page);
	await drawer.getByRole("tab", { name: "状态" }).click();
	const panel = page.getByTestId("web-status-panel");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("Pi");
	await expect(panel).toContainText("运行状态");
});

/**
 * T7b 分屏（只读 peek）：⋮ 菜单「分屏查看上一个标签」→ 右侧预览左邻会话 → 可关闭。
 */
test("web workbench: split view previews the previous tab", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSession(page);
	await createSession(page);

	await page.locator(".web-header-actions button").last().click();
	await page.getByRole("menuitem", { name: "分屏查看上一个标签" }).click();
	const pane = page.getByTestId("web-split-pane");
	await expect(pane).toBeVisible();
	await expect(pane).toContainText("只读预览");

	await pane.getByRole("button", { name: "关闭分屏" }).click();
	await expect(pane).toHaveCount(0);
});

/**
 * T8 自动化面板：新建 manual 任务 → 列表出现 → 删除确认后消失（不真正运行，避免 E2E 依赖 mock agent 回合）。
 */
test("web workbench: automation panel creates and deletes a manual task", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSession(page);
	const drawer = await openWorkspace(page);
	await drawer.getByRole("tab", { name: "自动化" }).click();
	const panel = page.getByTestId("web-automation-panel");
	await expect(panel).toBeVisible();

	await panel.getByRole("button", { name: "新建任务" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.locator("#automation-name").fill("e2e-task");
	await dialog.locator("#automation-prompt").fill("say hi");
	await dialog.getByRole("button", { name: "保存" }).click();
	await expect(panel.getByTestId("web-automation-list")).toContainText("e2e-task", { timeout: 20_000 });

	await panel.getByRole("button", { name: "删除" }).first().click();
	await page.getByRole("alertdialog").getByRole("button", { name: "删除" }).click();
	await expect(panel.getByTestId("web-automation-list")).not.toContainText("e2e-task", { timeout: 20_000 });
});

/**
 * 移动端（390px）工作区：文件面板与 Git 面板都不能产生横向溢出。
 * 设置面板的 390px 用例在 web-settings.spec.ts；这里补抽屉/分支下拉这两块最容易撑破宽度的区域。
 * 先在桌面视口建会话并打开抽屉，再缩到 390px —— 移动端侧栏是抽屉，入口本身另有覆盖（设置用例）。
 */
test("web workbench: mobile 390px workspace drawer and git panel do not overflow", async ({ app }) => {
	test.setTimeout(150_000);
	const page = await openPage(app);
	await createSessionIn(page, "GitRepo");
	const drawer = await openWorkspace(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(200);

	const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

	await expect(drawer.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
	expect(await overflow()).toBeLessThanOrEqual(0);

	await drawer.getByRole("tab", { name: "Git" }).click();
	await expect(drawer.getByRole("button", { name: "切换分支" })).toBeVisible({ timeout: 20_000 });
	expect(await overflow()).toBeLessThanOrEqual(0);
});

/**
 * 手动视觉走查（默认跳过）：桌面/移动的多标签、工作区三面板。
 *   PIDECK_CAPTURE_WORKBENCH=1 npx playwright test e2e/web-workbench.spec.ts -g "visual"
 * 截图写到 e2e/.snapshots/web-workbench/（已 gitignore），不入库。
 */
test("web workbench: visual capture", async ({ app }) => {
	// 注意：test.skip 必须在测试体内，放在文件顶层会跳过整个文件。
	test.skip(process.env.PIDECK_CAPTURE_WORKBENCH !== "1", "manual screenshot script; set PIDECK_CAPTURE_WORKBENCH=1 to run");
	test.setTimeout(150_000);
	mkdirSync(join(__dirname, ".snapshots", "web-workbench"), { recursive: true });
	const page = await openPage(app);
	await createSession(page);
	await createSession(page);
	await expect(page.getByTestId("web-session-tabs").getByRole("tab")).toHaveCount(2, { timeout: 20_000 });
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "desktop-tabs.png") });

	const drawer = await openWorkspace(page);
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "desktop-files.png") });
	await drawer.getByRole("tab", { name: "Git" }).click();
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "desktop-git.png") });
	await drawer.getByRole("tab", { name: "草稿本" }).click();
	const noteEditor = drawer.locator('textarea[aria-label="编辑"]');
	await noteEditor.fill("# 今天的记录\n\n- 多标签工作台\n- 文件编辑 + Git 提交\n- 草稿本自动保存\n\n> 在 Web 上也能连续工作。");
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "desktop-notes.png") });
	await drawer.getByRole("button", { name: "预览", exact: true }).click();
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "desktop-notes-preview.png") });

	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(__dirname, ".snapshots", "web-workbench", "mobile-tabs.png") });
});
