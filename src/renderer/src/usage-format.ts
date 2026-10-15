/**
 * 用量数值的展示口径：会话累计、单条消息用量与缓存命中率共用同一套格式化，
 * 避免各组件各写一份而出现不一致的短格式或百分比。
 *
 * 未知值一律保持 `?`/null，不用 0 或空串冒充；缓存命中率在没有任何 prompt token 时为 null。
 */

/** 数值短格式：1234 → 1.2K、1234567 → 1.2M；未知值保持 `?`。 */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '?'
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

/** 费用保留三位小数；异常值保持 `?`。 */
export function formatCost(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '?'
}

/** 缓存命中率所需的 prompt 分项；会话累计与单条消息用量都满足该形状。 */
export interface CacheHitUsage {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** 缓存命中率：缓存读 /（输入 + 缓存读 + 缓存写）；没有 prompt token 时为 null。 */
export function cacheHitRate(usage: CacheHitUsage): number | null {
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
  if (promptTokens <= 0) return null
  return usage.cacheRead / promptTokens
}
