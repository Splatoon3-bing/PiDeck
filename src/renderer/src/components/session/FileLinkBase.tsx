import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { localImageUrl } from "../../../../shared/localImage";
import type { ProjectFileAccessScope } from "../../../../shared/types";
import { getFilePathVerdict, requestFilePathVerdicts, subscribeFilePathVerdicts } from "../../utils/filePathVerdictStore";
import { resolveFileLinkPath } from "../../utils/filePathLinks";
import { getRendererHomeDir } from "../../utils/rendererHomeDir";

type FileLinkBase = {
	baseDir?: string;
	projectRoot?: string;
	scope?: ProjectFileAccessScope;
	/** 会话身份：右键菜单里的系统动作要与左键点击走同一道安全等级门（会话级覆盖优先于全局默认） */
	sessionId?: string;
	/**
	 * 绝对路径 → 可加载 URL 的宿主实现（缺省为桌面端的 `pideck-file://` 只读协议）。
	 *
	 * Web 服务跑在浏览器里，自定义协议不存在，只能走 HTTP 字节路由
	 *（`/api/file-raw`，令牌拼在 query 上）；否则正文里的本地图片 `/api/file-raw`
	 * 加载不出来，表现为「图片静默消失」。
	 */
	toLocalResourceUrl?: (absolutePath: string) => string;
};

/**
 * 文件路径链接的解析与授权上下文。
 *
 * 分屏时每个 SessionRuntimeInjector 都提供本栏自己的 cwd/project；App 层 Provider
 * 只作为非会话静态区域的兜底。存在性校验和点击打开因此始终使用同一栏的基准。
 */
const FileLinkBaseContext = createContext<FileLinkBase>({});

export function FileLinkBaseProvider(props: { baseDir: string | undefined; projectRoot?: string; projectId?: string; sessionId?: string; toLocalResourceUrl?: (absolutePath: string) => string; children: ReactNode }) {
	const value = useMemo<FileLinkBase>(
		() => ({
			baseDir: props.baseDir,
			projectRoot: props.projectRoot,
			scope: props.projectId ? { projectId: props.projectId } : undefined,
			sessionId: props.sessionId,
			toLocalResourceUrl: props.toLocalResourceUrl,
		}),
		[props.baseDir, props.projectId, props.projectRoot, props.sessionId, props.toLocalResourceUrl],
	);
	return <FileLinkBaseContext.Provider value={value}>{props.children}</FileLinkBaseContext.Provider>;
}

export function useFileLinkBaseDir(): string | undefined {
	return useContext(FileLinkBaseContext).baseDir;
}

/**
 * 本地绝对路径 → 可加载 URL 的解析器（Markdown 图片共用）。
 * 缺省是桌面端 `pideck-file://` 协议；Web 由 Provider 注入 `/api/file-raw`。
 */
export function useLocalResourceUrl(): (absolutePath: string) => string {
	return useContext(FileLinkBaseContext).toLocalResourceUrl ?? localImageUrl;
}

/**
 * 文件链接右键菜单等场景需要完整的解析上下文（baseDir/projectRoot/scope/sessionId），
 * 与存在性校验共用同一份基准，保证「菜单里复制的路径」=「点击打开的路径」，
 * 且菜单里的系统动作（默认应用 / 文件管理器）按同一会话的安全等级求值。
 */
export function useFileLinkContext(): FileLinkBase {
	return useContext(FileLinkBaseContext);
}

/**
 * 单个路径的存在性判定订阅：首次遇到未校验路径时登记批量请求（store 内部
 * 去抖合并 IPC），结果经缓存广播回来；undefined 表示未知/校验中。
 * 每个文件锚点独立订阅自己的键，避免一条长回复整体重渲染。
 */
export function useFilePathExists(rawPath: string | undefined): boolean | undefined {
	const { baseDir, projectRoot, scope } = useContext(FileLinkBaseContext);
	// resolveFileLinkPath 返回 null = 无法解析或越出本栏项目边界：
	// 不发 stat，更不能让主进程按进程 cwd 猜测相对路径。`~` 先按家目录展开（issue #426），
	// 否则 `~/x` 在有 projectRoot 的会话里会被一致地判成「项目外」。
	const absPath = rawPath === undefined ? undefined : resolveFileLinkPath(rawPath, baseDir, projectRoot, getRendererHomeDir());
	const resolvable = typeof absPath === "string";
	useEffect(() => {
		if (!rawPath || !resolvable || absPath === undefined) return;
		requestFilePathVerdicts([absPath], scope);
	}, [absPath, rawPath, resolvable, scope]);
	return useSyncExternalStore(subscribeFilePathVerdicts, () => (resolvable ? getFilePathVerdict(absPath, scope) : undefined));
}
