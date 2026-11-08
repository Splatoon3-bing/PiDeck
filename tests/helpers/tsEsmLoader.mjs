/**
 * 测试期 TypeScript ESM loader（Node 无内置类型剥离时使用）。
 *
 * 背景：部分测试直接 `import "../src/....ts"`。官方 Node 构建自带类型剥离，
 * 但 distro 构建可能未编译 amaro（`ERR_NO_TYPESCRIPT` / `ERR_UNKNOWN_FILE_EXTENSION`），
 * 于是整文件加载失败。这里用仓库既有的 `typescript` 依赖做转译，行为与官方剥离一致：
 * 只擦除类型、不改语义；`.ts` 之外的模块原样交给下一个 hook。
 *
 * 用法：`node --import ./tests/helpers/tsEsmLoader.mjs --test …`（已接进 npm test）。
 * 不改变测试断言与生产代码；有原生支持的 Node 上同样可用（多一次转译开销）。
 */
import { register, registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

register("./tsEsmHooks.mjs", import.meta.url);

/**
 * CJS 侧同样兜底：少数测试用手写沙箱 + createRequire 直接 require(".ts")，
 * Node 的 require 不认 .ts（Unexpected token ':'）。同步 hooks 只在 require 条件下生效，
 * ESM 由上面的 async hooks 负责，互不重复。
 */
registerHooks({
	load(url, context, next) {
		let pathname = "";
		try {
			pathname = new URL(url).pathname;
		} catch {
			return next(url, context);
		}
		const isTs = /\.(ts|tsx|mts|cts)$/.test(pathname);
		const isRequire = Array.isArray(context.conditions) && context.conditions.includes("require");
		if (!isTs || !isRequire) return next(url, context);
		const source = readFileSync(new URL(url), "utf8");
		const { outputText } = ts.transpileModule(source, {
			fileName: pathname,
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
		});
		return { format: "commonjs", source: outputText, shortCircuit: true };
	},
});
