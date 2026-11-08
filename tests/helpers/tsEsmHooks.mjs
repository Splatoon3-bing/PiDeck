/**
 * 测试期 TypeScript ESM hooks（配合 tsEsmLoader.mjs 使用）。
 *
 * 只做两件事：
 * 1. `resolve`：`.ts` 源文件里的无扩展名相对导入（`../shared/types`）补 `.ts`/`.tsx`/`index.ts`；
 * 2. `load`：`.ts`/`.tsx` 用仓库依赖的 typescript 转译成 ESM（擦除类型，不改语义）。
 *
 * 其它一切（node_modules、.mjs、JSON…）原样交给下一个 hook。
 */
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const TS_RE = /\.(ts|tsx|mts|cts)$/;
const RELATIVE_RE = /^\.{1,2}\//;

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolve(specifier, context, nextResolve) {
	const parentTs = context.parentURL ? TS_RE.test(new URL(context.parentURL).pathname) : false;
	if (RELATIVE_RE.test(specifier) && !TS_RE.test(new URL(specifier, context.parentURL ?? "file:///").pathname) && parentTs) {
		const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
		for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
			if (await exists(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
		}
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	// 测试常用 `import("x.ts?t=…")` 破坏缓存；扩展名要按 pathname 判断，查询串不参与。
	if (!TS_RE.test(new URL(url).pathname)) return nextLoad(url, context);
	const source = await readFile(new URL(url), "utf8");
	const { outputText } = ts.transpileModule(source, {
		fileName: fileURLToPath(url),
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			jsx: ts.JsxEmit.ReactJSX,
			esModuleInterop: true,
			verbatimModuleSyntax: false,
			isolatedModules: true,
		},
	});
	return { format: "module", source: outputText, shortCircuit: true };
}
