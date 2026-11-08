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
import { register, createRequire } from "node:module";
import { readFileSync } from "node:fs";
import ts from "typescript";

register("./tsEsmHooks.mjs", import.meta.url);

/**
 * CJS 侧兜底：少数测试用手写沙箱 + createRequire 直接 require(".ts")。
 * 不能用 module.registerHooks（同步 load 钩子对 CommonJS 必须给 source，
 * 透传 next() 拿到 source:null 会 ERR_INVALID_RETURN_PROPERTY_VALUE，反而打挂整文件），
 * 所以只给 require.extensions 装一个转译器——作用域仅限 require。
 */
const requireFromHere = createRequire(import.meta.url);
for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
	requireFromHere.extensions[ext] ??= (module, filename) => {
		const source = readFileSync(filename, "utf8");
		const { outputText } = ts.transpileModule(source, {
			fileName: filename,
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
		});
		module._compile(outputText, filename);
	};
}
