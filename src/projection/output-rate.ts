/**
 * 输出速率的滑动窗口采样：实时值与上一轮平均值。
 *
 * 只做时间窗口与数值计算，不持有进程、快照或进程通信；
 * 静默超过窗口后自行停表，因此运行期间只在有输出时存在一个 250ms 定时器。
 * 实时样本是宿主按流式文本估算的累计输出 token——Pi 只在收尾才写 `usage`，流式期间拿不到权威增量；
 * 平均值由宿主在消息结束时用模型上报的输出 token 结算。非有限数不采样。
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
  /** 实时窗口起点；静默停表时清空，下一次输出会重新开窗。 */
  private windowStartedAt: number | null = null
  /** 本轮生成起点；静默停表不清空，供消息结束时结算平均值。 */
  private generationStartedAt: number | null = null
  private lastEventAt = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (rate: OutputRate) => void) {}

  /** 助手消息开始：清空实时样本并重置本轮生成起点；上一轮平均值保留到本轮结算时才替换。 */
  begin(at: number): void {
    this.samples = []
    this.generationStartedAt = at
    this.startWindow(at)
  }

  /** 累计输出 token 推进窗口；数值回退说明是新的一次调用，窗口重开。 */
  push(tokens: number, at: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    // 静默停表后的首次输出只重开窗口，不重置本轮生成起点，否则平均值会被算短。
    if (this.windowStartedAt === null) this.startWindow(at)
    this.lastEventAt = at
    const last = this.samples[this.samples.length - 1]
    if (last !== undefined && tokens < last.tokens) this.samples = []
    const previous = this.samples[this.samples.length - 1]
    if (previous === undefined || previous.tokens !== tokens) {
      this.samples.push({ at, tokens })
    }
    while (this.samples.length > 2) {
      const oldest = this.samples[0]
      if (oldest === undefined || at - oldest.at <= WINDOW_MS) break
      this.samples.shift()
    }
  }

  /** 一轮结束：按本轮输出与生成时长结算平均速率，停表并通知订阅方。 */
  settle(outputTokens: number | null, at: number): void {
    const started = this.generationStartedAt
    this.generationStartedAt = null
    if (started !== null && outputTokens !== null && Number.isFinite(outputTokens) && outputTokens > 0) {
      const elapsed = at - started
      if (elapsed >= MIN_ELAPSED_MS) this.average = toTokensPerSecond(outputTokens, elapsed)
    }
    this.clearWindow()
    // 平均值变化不一定伴随实时值变化，这里必须无条件通知，否则订阅方拿不到新值。
    this.onChange(this.snapshot())
  }

  /** 当前速率快照；没有有效样本时各字段为 null。 */
  snapshot(): OutputRate {
    return { live: this.live, average: this.average }
  }

  /** 退出或换代际：停表并清空样本与平均值，不再向订阅方回报。 */
  reset(): void {
    this.samples = []
    this.windowStartedAt = null
    this.generationStartedAt = null
    this.average = null
    this.live = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 开窗并起表；不影响本轮生成起点。 */
  private startWindow(at: number): void {
    this.windowStartedAt = at
    this.lastEventAt = at
    this.startTimer()
  }

  private startTimer(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  /** 停表并清空实时窗口；返回实时值是否由有值变为 null，由调用方决定何时通知。 */
  private clearWindow(): boolean {
    this.samples = []
    this.windowStartedAt = null
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.live === null) return false
    this.live = null
    return true
  }

  private tick(): void {
    if (Date.now() - this.lastEventAt > QUIET_MS) {
      if (this.clearWindow()) this.onChange(this.snapshot())
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
