/**
 * 输出速率的结算：只保留上一轮模型调用的平均速率。
 *
 * 只做数值计算，不持有进程、快照或进程通信；
 * 平均值由宿主在消息结束时用模型上报的输出 token 与生成时长结算。非有限数不参与结算。
 */
import type { OutputRate } from '../shared/runtime-api'

/** 生成时长短于这个时长不给速率，避免开头几个 token 算出天量。 */
const MIN_ELAPSED_MS = 250

export class OutputRateTracker {
  private average: number | null = null
  /** 本轮生成起点；消息结束时据此结算平均值。 */
  private generationStartedAt: number | null = null

  constructor(private readonly onChange: (rate: OutputRate) => void) {}

  /** 助手消息开始：重置本轮生成起点；上一轮平均值保留到本轮结算时才替换。 */
  begin(at: number): void {
    this.generationStartedAt = at
  }

  /** 一轮结束：按本轮输出与生成时长结算平均速率，并通知订阅方。 */
  settle(outputTokens: number | null, at: number): void {
    const started = this.generationStartedAt
    this.generationStartedAt = null
    if (started !== null && outputTokens !== null && Number.isFinite(outputTokens) && outputTokens > 0) {
      const elapsed = at - started
      if (elapsed >= MIN_ELAPSED_MS) this.average = toTokensPerSecond(outputTokens, elapsed)
    }
    // 平均值变化不一定伴随其他状态变化，这里必须无条件通知，否则订阅方拿不到新值。
    this.onChange(this.snapshot())
  }

  /** 当前速率快照；没有结算到有效值时为 null。 */
  snapshot(): OutputRate {
    return { average: this.average }
  }

  /** 退出或换代际：清空平均值，不再向订阅方回报。 */
  reset(): void {
    this.generationStartedAt = null
    this.average = null
  }
}

/** 增量除以毫秒得到 tokens/秒，保留一位小数。 */
function toTokensPerSecond(tokens: number, elapsedMs: number): number {
  return Math.round((tokens / elapsedMs) * 10000) / 10
}
