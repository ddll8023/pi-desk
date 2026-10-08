/**
 * 解析 Pi RPC 的 JSONL 记录并关联请求与响应。
 *
 * 只处理记录分类、请求关联与响应字段投影，不持有子进程、不知道 Runtime 业务状态、不缓存消息。
 * 超时只结束等待，不主张 Pi 没有执行该请求；进程退出或写入失败时收敛 pending。
 */
import type { ContextUsage, ModelSummary, PromptDisposition, RuntimeInfo } from '../shared/runtime-api'

export type PiRecordKind = 'response' | 'session-event' | 'extension-ui' | 'unknown'

export interface PiResponseRecord {
  readonly id: string | null
  readonly command: string
  readonly success: boolean
  readonly data: unknown
  readonly error: string | null
}

export type PiRequestOutcome =
  | { readonly status: 'response'; readonly response: PiResponseRecord }
  | { readonly status: 'timeout' }
  | { readonly status: 'closed'; readonly reason: string }

export interface PiProtocolCallbacks {
  readonly onProtocolError: (message: string) => void
  readonly onRecord: (kind: PiRecordKind, payload: Record<string, unknown>) => void
  readonly onUnmatchedResponse: (response: PiResponseRecord) => void
}

interface PendingRequest {
  readonly resolve: (outcome: PiRequestOutcome) => void
  readonly timer: NodeJS.Timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只按记录族分类，不穷举事件名；未知记录归为 unknown 而不报错。 */
export function classifyPiRecord(payload: Record<string, unknown>): PiRecordKind {
  const type = payload.type
  if (type === 'response') return 'response'
  if (type === 'extension_ui_request' || type === 'extension_ui_response') return 'extension-ui'
  if (typeof type === 'string') return 'session-event'
  return 'unknown'
}

function toResponseRecord(payload: Record<string, unknown>): PiResponseRecord | null {
  const { id, command, success, error } = payload
  if (id !== undefined && typeof id !== 'string') return null
  if (typeof command !== 'string' || typeof success !== 'boolean') return null
  return {
    id: typeof id === 'string' ? id : null,
    command,
    success,
    data: payload.data,
    error: typeof error === 'string' ? error : null
  }
}

function readModelLabel(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider : null
  const modelId = typeof value.id === 'string' ? value.id : null
  if (provider !== null && modelId !== null) return `${provider}/${modelId}`
  if (modelId !== null) return modelId
  return typeof value.name === 'string' ? value.name : null
}

/** 当前模型的 provider 与 id：只在两者都是非空字符串时才算可识别。 */
function readModelIdentity(value: unknown): { provider: string | null; id: string | null } {
  if (!isRecord(value)) return { provider: null, id: null }
  return {
    provider: typeof value.provider === 'string' && value.provider !== '' ? value.provider : null,
    id: typeof value.id === 'string' && value.id !== '' ? value.id : null
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** prompt 接受响应只承认三个合法 disposition；其他取值按响应契约不符处理。 */
export function toPromptDisposition(data: unknown): PromptDisposition | null {
  if (!isRecord(data)) return null
  const { disposition } = data
  if (disposition === 'started' || disposition === 'queued' || disposition === 'handled') {
    return disposition
  }
  return null
}

/** 把 get_state 的 data 投影为页面需要的少量字段；缺少约定字段时返回 null。 */
export function toRuntimeInfo(data: unknown): RuntimeInfo | null {
  if (!isRecord(data)) return null
  const { messageCount, isStreaming, isCompacting, thinkingLevel, sessionId } = data
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount)) return null
  if (typeof isStreaming !== 'boolean') return null
  if (typeof isCompacting !== 'boolean') return null
  const identity = readModelIdentity(data.model)
  return {
    model: readModelLabel(data.model),
    modelProvider: identity.provider,
    modelId: identity.id,
    thinkingLevel: typeof thinkingLevel === 'string' ? thinkingLevel : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    messageCount,
    isStreaming,
    isCompacting
  }
}

/**
 * 把 `get_available_models` 的 data 投影为精简列表；`models` 不是数组时返回 null，
 * 单条形状不符只丢弃该条，不因此让整个列表不可用。
 */
export function toModelSummaries(data: unknown): ModelSummary[] | null {
  if (!isRecord(data) || !Array.isArray(data.models)) return null

  const models: ModelSummary[] = []
  for (const entry of data.models) {
    if (!isRecord(entry)) continue
    const provider = typeof entry.provider === 'string' ? entry.provider : ''
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (provider === '' || id === '') continue
    models.push({
      provider,
      id,
      name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
      reasoning: entry.reasoning === true,
      contextWindow: isNonNegativeInteger(entry.contextWindow) ? entry.contextWindow : null
    })
  }
  return models
}

/** 只承认非空字符串并去重；不支持推理的模型由 Pi 返回 `["off"]`，这里不做判断。 */
export function toThinkingLevels(data: unknown): string[] | null {
  if (!isRecord(data) || !Array.isArray(data.levels)) return null

  const levels: string[] = []
  for (const level of data.levels) {
    if (typeof level !== 'string' || level === '' || levels.includes(level)) continue
    levels.push(level)
  }
  return levels
}

/** 上下文占用只承认官方形状；三个字段都允许为 null（压缩后尚无有效用量）。 */
function toContextUsage(value: unknown): ContextUsage | null {
  if (!isRecord(value)) return null
  const tokens = readNullableCount(value.tokens)
  const contextWindow = readNullableCount(value.contextWindow)
  const percent = readNullablePercent(value.percent)
  if (tokens === undefined || contextWindow === undefined || percent === undefined) return null
  return { tokens, contextWindow, percent }
}

/** 计数或 null；其他取值（含缺失）返回 undefined，表示形状不符。 */
function readNullableCount(value: unknown): number | null | undefined {
  if (value === null) return null
  return isNonNegativeInteger(value) ? value : undefined
}

/** 百分比或 null；只要求有限且非负，不额外限定上限。 */
function readNullablePercent(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

/**
 * 读取 `get_session_stats` 的上下文占用：字段缺失或为 null 表示 Pi 没有可用上下文窗口，
 * 用 `{ usage: null }` 表达；整体形状不符返回 null，由调用方按格式错误处理。
 */
export function toContextUsageField(data: unknown): { readonly usage: ContextUsage | null } | null {
  if (!isRecord(data)) return null
  const raw = data.contextUsage
  if (raw === undefined || raw === null) return { usage: null }
  const usage = toContextUsage(raw)
  return usage === null ? null : { usage }
}

export class PiProtocol {
  private counter = 0
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly callbacks: PiProtocolCallbacks) {}

  /**
   * 生成唯一请求 id 并串行写入一条命令，等待它的 response。
   * 超时只结束等待；写入失败按管道关闭收敛。
   */
  async request(
    command: Record<string, unknown>,
    write: (line: string) => Promise<void>,
    timeoutMs: number
  ): Promise<PiRequestOutcome> {
    const id = `desk-${(this.counter += 1)}`
    const outcome = new Promise<PiRequestOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { status: 'timeout' }), timeoutMs)
      this.pending.set(id, { resolve, timer })
    })
    try {
      await write(`${JSON.stringify({ ...command, id })}\n`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '写入 Pi 标准输入失败。'
      this.settle(id, { status: 'closed', reason })
    }
    return outcome
  }

  /** 处理一条已分帧的 stdout 记录。 */
  handleLine(line: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      this.callbacks.onProtocolError('Pi 输出了一条无法解析为 JSON 的记录。')
      return
    }
    if (!isRecord(payload)) {
      this.callbacks.onProtocolError('Pi 输出了一条不是 JSON 对象的记录。')
      return
    }

    const kind = classifyPiRecord(payload)
    if (kind !== 'response') {
      this.callbacks.onRecord(kind, payload)
      return
    }

    const response = toResponseRecord(payload)
    if (response === null) {
      this.callbacks.onProtocolError('Pi 返回了不符合 response 契约的记录。')
      return
    }
    if (response.id !== null && this.pending.has(response.id)) {
      this.settle(response.id, { status: 'response', response })
      return
    }
    this.callbacks.onUnmatchedResponse(response)
  }

  /** 管道关闭或进程退出时收敛所有等待中的请求。 */
  failAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { status: 'closed', reason })
    }
  }

  private settle(id: string, outcome: PiRequestOutcome): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve(outcome)
  }
}
