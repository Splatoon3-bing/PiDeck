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
import { register } from "node:module";

register("./tsEsmHooks.mjs", import.meta.url);
