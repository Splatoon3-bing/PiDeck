#!/usr/bin/env node
/**
 * Web 端零手动手部署：构建 → 打包 → 替换 /opt/PiDeck/app.asar → 重启服务 → 验证。
 *
 * 背景：Web 页面由 systemd 单元 pideck.service 跑 /opt/PiDeck/pideck 提供，/opt 属 root。
 * 本机当前用户无免密 sudo，但在 docker 组内：用容器（root in container）替换 root 拥有的
 * app.asar，再 kill 进程让 `Restart=always` 的 systemd 用新包自拉起，全程无需人工授权。
 * 容器不可用时回退到一次性安装的部署助手 `/usr/local/bin/pideck-deploy`（sudo NOPASSWD）。
 *
 * 用法：
 *   node scripts/deploy-web.mjs                # 全流程（构建 + 打包 + 部署 + 验证）
 *   node scripts/deploy-web.mjs --skip-build   # 复用刚构建的 out/
 *   node scripts/deploy-web.mjs --skip-pack    # 复用刚打包的 app.asar（只部署 + 验证）
 *
 * 退出码：0 成功；1 构建/打包/验证失败；2 部署助手未安装（打印一次性安装命令）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const ASAR = join(repoRoot, "release/linux-unpacked/resources/app.asar");
const WEB_HTML = join(repoRoot, "out/renderer/web.html");
const HEALTH = "http://127.0.0.1:8765/api/health";
const PAGE = "http://127.0.0.1:8765/";
const HELPER = "/usr/local/bin/pideck-deploy";
const RELEASE_RESOURCES = join(repoRoot, "release/linux-unpacked/resources");
const CONTAINER_SCRIPT = join(repoRoot, "scripts/pideck-deploy-container.sh");
const LOG_DIR = join(homedir(), ".pideck-deploy");
const DEPLOY_IMAGE = "alpine:3.20";
const OPT_RESOURCES = "/opt/PiDeck/resources";
/** 容器内侧脚本最多需要「安装 + 90s 重启等待 + 回滚 + 90s」；宿主侧只读结果行。 */
const VERDICT_TIMEOUT_MS = 240_000;

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const skipPack = args.has("--skip-pack");
/** 只打印将要执行的部署命令（不安装、不重启），用于改脚本后自检。 */
const printPlan = args.has("--print-plan");

/** 子进程跑命令：默认继承 stdio（构建日志要可见），失败直接退出。 */
function run(command, argv, options = {}) {
	const result = spawnSync(command, argv, { cwd: repoRoot, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", env: options.env ?? process.env });
	return result;
}

function die(message, code = 1) {
	console.error(`\n[deploy] ${message}`);
	process.exit(code);
}

/** 期望的页面 bundle：从刚构建的 web.html 取带 hash 的入口文件名。 */
function expectedBundle() {
	if (!existsSync(WEB_HTML)) die("缺少 out/renderer/web.html，先跑 npm run build:fast（或去掉 --skip-build）");
	const match = readFileSync(WEB_HTML, "utf8").match(/assets\/web-[A-Za-z0-9_-]+\.js/);
	if (!match) die("out/renderer/web.html 里找不到 web-*.js 入口");
	return match[0];
}

function asarContains(bundle) {
	if (!existsSync(ASAR)) return false;
	return readFileSync(ASAR).includes(bundle);
}

async function poll(url, predicate, attempts = 40, delayMs = 1000) {
	let last = "";
	for (let i = 0; i < attempts; i += 1) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
			last = await response.text();
			if (predicate(last)) return last;
		} catch (error) {
			last = String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	die(`等待 ${url} 超时（最后结果：${last.slice(0, 120)}）`);
}

const bundle = expectedBundle();

if (!skipBuild) {
	console.log("[deploy] 1/4 构建渲染层与主进程…");
	const build = run("npm", ["run", "build:fast"]);
	if (build.status !== 0) die("构建失败，已中止（线上未受影响）");
}

if (!skipPack) {
	console.log("[deploy] 2/4 打包 app.asar…");
	// electronDist 指向本地已安装的 electron：离线/代理挂掉时也能打包。
	// afterPack 的 node-pty 校验在不带 postinstall 的依赖树下会失败；asar 本身已产出，
	// 因此不把退出码当判据，改为「包内包含本次入口 bundle」。
	const env = { ...process.env };
	for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[key];
	run("npx", ["electron-builder", "--dir", "--config.electronDist=node_modules/electron/dist"], { env });
}

console.log("[deploy] 3/4 校验产物…");
if (!asarContains(bundle)) die(`app.asar 不含本次入口 ${bundle}，拒绝部署（线上未受影响）`);

console.log(`[deploy] 4/4 部署（${bundle}）…`);

const dockerReady = run("docker", ["info"], { capture: true }).status === 0;

/**
 * 安装 + 重启 + 验证 + 回滚全部交给容器的原因（两条实测教训）：
 *
 * 1) 从 PiDeck 内的 agent 会话发起时，重启会连带杀掉 pideck.service 的整个 cgroup，
 *    宿主机侧脚本活不到「验证/回滚」；容器在 docker 的 cgroup 里，能活下来。
 * 2) 普通容器的 pkill 会静默失败：docker-default 的 AppArmor 不允许向 unconfined 的
 *    pideck 发信号（dmesg: apparmor="DENIED" operation="signal" ... peer="pideck"）。
 *    必须 --privileged；主进程又捕获了 SIGTERM，所以容器脚本用 SIGKILL 并等「新 PID」
 *    才算重启成功（只看 /api/health 会被旧进程应答骗成假成功）。
 *
 * 结果通过宿主机日志里的 `DEPLOY_RESULT=` 行回传：即便本进程在重启中被杀，
 * 容器仍会写完日志并完成自动回滚。
 */
function deployViaDocker(bundleName, stamp) {
	if (!existsSync(CONTAINER_SCRIPT)) die(`缺少容器侧脚本 ${CONTAINER_SCRIPT}`);
	mkdirSync(LOG_DIR, { recursive: true });
	const logPath = join(LOG_DIR, `deploy-${stamp}.log`);
	const name = `pideck-deploy-${stamp}`;
	const dockerArgs = [
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--privileged",
		"--pid=host",
		"--network=host",
		"-e",
		`BUNDLE=${bundleName}`,
		...(process.env.PIDECK_DEPLOY_DELAY ? ["-e", `DELAY=${process.env.PIDECK_DEPLOY_DELAY}`] : []),
		"-v",
		`${OPT_RESOURCES}:/target`,
		"-v",
		`${RELEASE_RESOURCES}:/src:ro`,
		"-v",
		`${CONTAINER_SCRIPT}:/deploy.sh:ro`,
		"-v",
		`${logPath}:/log`,
		DEPLOY_IMAGE,
		"sh",
		"/deploy.sh",
	];
	if (printPlan) {
		console.log(`[deploy] --print-plan：将执行\n  docker ${dockerArgs.join(" ")}\n  日志：${logPath}`);
		return true;
	}
	writeFileSync(logPath, "");
	const result = run("docker", dockerArgs, { capture: true });
	if (result.status !== 0) die(`启动部署容器失败：${(`${result.stderr ?? ""}`.trim() || result.status).toString().slice(0, 200)}`);

	console.log(`\n[deploy] 容器 ${name} 已启动（安装 → 重启 → 验证 → 失败自动回滚）`);
	console.log(`[deploy] 实时日志：${logPath}`);
	console.log("[deploy] 若本进程因重启被中断，容器会继续跑完并把结果写进上面的日志。\n");

	const deadline = Date.now() + VERDICT_TIMEOUT_MS;
	let printed = 0;
	while (Date.now() < deadline) {
		const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		for (; printed < lines.length; printed += 1) console.log(`  ${lines[printed]}`);
		const verdict = text.match(/DEPLOY_RESULT=(\w+)([^\n]*)/);
		if (verdict) {
			const detail = verdict[2].trim();
			if (verdict[1] === "ok") {
				console.log(`\n[deploy] ✅ 已上线：${bundleName}（${PAGE}${detail ? `，${detail}` : ""}）`);
				return true;
			}
			die(`部署失败（${verdict[1]}${detail ? `，${detail}` : ""}），详见 ${logPath}`);
		}
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
		} catch {
			// SharedArrayBuffer 不可用时退化成忙等，仅影响进度输出节奏，不影响判定。
		}
	}
	die(`等待部署结果超时（${VERDICT_TIMEOUT_MS / 1000}s），无结论不代表失败：请查看 ${logPath}`);
}

async function healthy() {
	return poll(HEALTH, (body) => body.includes('"ok":true'), 45, 1000).then(
		() => true,
		() => false,
	);
}

if (dockerReady) {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	deployViaDocker(bundle, stamp);
	process.exit(0);
}

// 回退路径：一次性安装的 sudo 助手。
// 注意：这条路径在「从 PiDeck 会话内发起」时不可靠——助手的 systemctl restart 会把
// 它自己所在的 cgroup 一起重启，健康自检与回滚都跑不完。建议在普通终端里用。
const deploy = run("sudo", ["-n", HELPER], { capture: true });
if (deploy.status !== 0) {
	const stderr = `${deploy.stderr ?? ""}`.trim();
	console.error(`\n[deploy] docker 与部署助手都不可用（stderr：${stderr.split("\n")[0] || "未知"}）`);
	console.error("[deploy] 二选一即可（都只需一次）：");
	console.error("  A) 把当前用户加入 docker 组：sudo usermod -aG docker $USER（重新登录后生效）");
	console.error(`  B) 安装部署助手：sudo install -m 755 -o root -g root ${join(repoRoot, "scripts/pideck-deploy-helper.sh")} ${HELPER}`);
	console.error(`     printf 'bing ALL=(root) NOPASSWD: ${HELPER}\\n' | sudo tee /etc/sudoers.d/pideck-deploy >/dev/null`);
	console.error("     sudo chmod 440 /etc/sudoers.d/pideck-deploy && sudo visudo -cf /etc/sudoers.d/pideck-deploy\n");
	process.exit(2);
}
console.log("[deploy] 验证服务与页面…");
await poll(HEALTH, (body) => body.includes('"ok":true'));
await poll(PAGE, (body) => body.includes(bundle));
console.log(`\n[deploy] ✅ 已上线：${bundle}（http://127.0.0.1:8765/）`);
