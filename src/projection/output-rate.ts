/**
 * 输出速率的滑动窗口采样：实时值与上一轮平均值。
 *
 * 只做时间窗口与数值计算，不持有进程、快照或进程通信；
 * 静默超过窗口后自行停表，因此运行期间只在有输出时存在一个 250ms 定时器。
 * 样本来自 `message_update` 顶层的累计 `usage.output`，非有限数不采样。
 */
import type { OutputRate } from '../shared/runtime-api'

/** 实时速率的滑动窗口：只看最近这段时间的输出，与 Pi 的 token-rate 扩展一致。 */
const WINDOW_MS = 2000

/** 窗口重算节拍：窗口自己会滑走，静止时速率随之衰减。 */
const TICK_MS = 250

/** 窗口短于这个时长不给速率，避免开头几个 token 算出天量。 */
const MIN_ELAPSED_MS = 250

/** 超过这么久没有新的输出事件就停表，并通知实时速率收尾。 */
const QUIET_MS = 2000

/** 一个采样点：时刻与该时刻的累计输出 token。 */
interface Sample {
  readonly at: number
  readonly tokens: number
}

export class OutputRateTracker {
  private samples: Sample[] = []
  private live: number | null = null
  private average: number | null = null
  private startedAt: number | null = null
  private lastEventAt = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (rate: OutputRate) => void) {}

  /** 助手消息开始：清空实时样本；上一轮的平均值保留到本轮结算时才替换。 */
  begin(at: number): void {
    this.samples = []
    this.startedAt = at
    this.lastEventAt = at
    this.startTimer()
  }

  /** 累计输出 token 推进窗口；数值回退说明是新的一次调用，窗口重开。 */
  push(outputTokens: number, at: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) return
    if (this.startedAt === null) this.begin(at)
    this.lastEventAt = at
    const last = this.samples[this.samples.length - 1]
    if (last !== undefined && outputTokens < last.tokens) this.samples = []
    const previous = this.samples[this.samples.length - 1]
    if (previous === undefined || previous.tokens !== outputTokens) {
      this.samples.push({ at, tokens: outputTokens })
    }
    while (this.samples.length > 2) {
      const oldest = this.samples[0]
      if (oldest === undefined || at - oldest.at <= WINDOW_MS) break
      this.samples.shift()
    }
  }

  /** 一轮结束：按本轮输出与生成时长结算平均速率，并停止实时采样。 */
  settle(outputTokens: number | null, at: number): void {
    const started = this.startedAt
    if (started !== null && outputTokens !== null && Number.isFinite(outputTokens) && outputTokens > 0) {
      const elapsed = at - started
      if (elapsed >= MIN_ELAPSED_MS) this.average = toTokensPerSecond(outputTokens, elapsed)
    }
    this.stop()
  }

  /** 当前速率快照；没有有效样本时各字段为 null。 */
  snapshot(): OutputRate {
    return { live: this.live, average: this.average }
  }

  /** 退出或换代际：停表并清空样本与平均值，不再向订阅方回报。 */
  reset(): void {
    this.samples = []
    this.startedAt = null
    this.average = null
    this.live = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private startTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /** 停表并清空窗口；实时值变化时通知订阅方收敛为 null。 */
  private stop(): void {
    this.samples = []
    this.startedAt = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.live !== null) {
      this.live = null
      this.onChange(this.snapshot())
    }
  }

  private tick(): void {
    if (Date.now() - this.lastEventAt > QUIET_MS) {
      this.stop()
      return
    }
    const next = this.computeLive()
    if (next === this.live) return
    this.live = next
    this.onChange(this.snapshot())
  }

  /** 窗口内首尾样本的增量除以时长；样本不足或没有增量时不给值。 */
  private computeLive(): number | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    if (first === undefined || last === undefined) return null
    const elapsed = last.at - first.at
    if (elapsed < MIN_ELAPSED_MS) return null
    const delta = last.tokens - first.tokens
    if (delta <= 0) return null
    return toTokensPerSecond(delta, elapsed)
  }
}

/** 增量除以毫秒得到 tokens/秒，保留一位小数。 */
function toTokensPerSecond(tokens: number, elapsedMs: number): number {
  return Math.round((tokens / elapsedMs) * 10000) / 10
}
