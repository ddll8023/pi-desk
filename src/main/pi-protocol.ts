/**
 * 解析 Pi RPC 的 JSONL 记录并关联请求与响应。
 *
 * 只处理记录分类与请求关联，不持有子进程、不知道 Runtime 业务状态、不缓存消息。
 * 超时只结束等待，不主张 Pi 没有执行该请求；进程退出或写入失败时收敛 pending。
 */
import type { RuntimeInfo } from '../shared/runtime-api'

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

/** 把 get_state 的 data 投影为页面需要的少量字段；缺少约定字段时返回 null。 */
export function toRuntimeInfo(data: unknown): RuntimeInfo | null {
  if (!isRecord(data)) return null
  const { messageCount, isStreaming, thinkingLevel, sessionId } = data
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount)) return null
  if (typeof isStreaming !== 'boolean') return null
  return {
    model: readModelLabel(data.model),
    thinkingLevel: typeof thinkingLevel === 'string' ? thinkingLevel : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    messageCount,
    isStreaming
  }
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
