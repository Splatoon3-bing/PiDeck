/**
 * Web 写路由限速（WebRateLimit.ts）
 *
 * 目的：`/api/*` 的写方法（POST/PUT/PATCH/DELETE）现在能改设置、文件系统与 Git，
 * 需要一个兜底闸门挡住脚本化刷写（暴力 token 之外的第二道保险）。读/SSE 不限速
 * （状态推送本身就是高频的）。
 *
 * 算法：固定窗口，按「鉴权主体」分桶——有 Bearer 时按 token（哈希后作 key，避免
 * 内存里出现明文），无鉴权模式按对端 IP。默认 240 次/分钟：Web 日常操作（发消息、
 * 草稿自动保存、文件保存、Git 操作）远低于该值，而脚本刷写会立即触发 429。
 *
 * 纯内存、无定时器：桶在下次触达时惰性过期；Map 有硬上限，避免大量 IP 造成无界增长。
 */

export type WriteRateLimitConfig = {
	/** 单个窗口内允许的写请求数。 */
	limit: number;
	/** 窗口长度（ms）。 */
	windowMs: number;
};

/** 默认阈值：240 写/分钟（4/s）。Git fetch、草稿自动保存、消息发送都在这个量级以内。 */
export const DEFAULT_WEB_WRITE_RATE_LIMIT: WriteRateLimitConfig = { limit: 240, windowMs: 60_000 };

/** 同时跟踪的最大桶数（活跃来源上限）；超出时优先淘汰已过期桶。 */
const MAX_TRACKED_KEYS = 4096;

/** 会被限速的 HTTP 方法：所有会改主机状态的方法。 */
export const WEB_WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type WriteRateLimitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

export class WebWriteRateLimiter {
	private readonly buckets = new Map<string, { count: number; resetAt: number }>();

	constructor(
		private readonly config: WriteRateLimitConfig = DEFAULT_WEB_WRITE_RATE_LIMIT,
		private readonly now: () => number = () => Date.now(),
	) {}

	/**
	 * 记一次写请求。返回 allowed=false 时调用方应回 429 + `Retry-After`（秒）。
	 * retryAfterMs 至少 1000，避免客户端在同一个已耗尽窗口里高频重试。
	 */
	take(key: string): WriteRateLimitVerdict {
		const now = this.now();
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			this.prune(now);
			this.buckets.set(key, { count: 1, resetAt: now + this.config.windowMs });
			return { allowed: true };
		}
		if (bucket.count >= this.config.limit) {
			return { allowed: false, retryAfterMs: Math.max(1000, bucket.resetAt - now) };
		}
		bucket.count += 1;
		return { allowed: true };
	}

	/** 惰性清理：只在桶数逼近上限时扫一遍过期项，必要时再淘汰最老的一批。 */
	private prune(now: number): void {
		if (this.buckets.size < MAX_TRACKED_KEYS) return;
		for (const [key, bucket] of this.buckets) {
			if (bucket.resetAt <= now) this.buckets.delete(key);
		}
		if (this.buckets.size < MAX_TRACKED_KEYS) return;
		const overflow = this.buckets.size - MAX_TRACKED_KEYS + 1;
		let dropped = 0;
		for (const key of this.buckets.keys()) {
			if (dropped >= overflow) break;
			this.buckets.delete(key);
			dropped += 1;
		}
	}
}
