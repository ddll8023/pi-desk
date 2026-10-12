/**
 * 解析 Pi RPC 的 JSONL 记录并关联请求与响应。
 *
 * 只处理记录分类、请求关联与响应字段投影，不持有子进程、不知道 Runtime 业务状态、不缓存消息。
 * 超时只结束等待，不主张 Pi 没有执行该请求；进程退出或写入失败时收敛 pending。
 */
import { createHash } from 'node:crypto'
import type {
  ContextUsage,
  ExtensionErrorEntry,
  ModelSummary,
  PiResourceEntry,
  PiResourceKind,
  PromptDisposition,
  RuntimeInfo,
  SessionUsage
} from '../shared/runtime-api'

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

/** 当前模型的 provider 与 id：只在两者都是非空字符串时才算可识别。 */
function readModelIdentity(value: unknown): { provider: string | null; id: string | null } {
  if (!isRecord(value)) return { provider: null, id: null }
  return {
    provider: typeof value.provider === 'string' && value.provider !== '' ? value.provider : null,
    id: typeof value.id === 'string' && value.id !== '' ? value.id : null
  }
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

/** 把 get_state 的 data 投影为会话与图片输入所需字段；缺少约定字段时返回 null。 */
export function toRuntimeInfo(data: unknown): RuntimeInfo | null {
  if (!isRecord(data)) return null
  const { messageCount, isStreaming, sessionId } = data
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount)) return null
  if (typeof isStreaming !== 'boolean') return null
  const identity = readModelIdentity(data.model)
  return {
    modelProvider: identity.provider,
    modelId: identity.id,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    messageCount,
    isStreaming,
    // 用量与速率不来自 get_state；由 get_session_stats 与会话事件单独补上。
    usage: null,
    rate: { live: null, average: null }
  }
}

/** 累计统计中的有限数有效，其余（含缺失、NaN）按 0 处理。 */
function readUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 上下文占用的未知值必须保持 null：压缩后与模型目录缺窗口都是合法未知。 */
function readOptionalUsageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `contextUsage` 缺失或形状不符时为 null，不做任何推算。 */
function readContextUsage(value: unknown): ContextUsage | null {
  if (!isRecord(value)) return null
  return {
    tokens: readOptionalUsageNumber(value.tokens),
    contextWindow: readOptionalUsageNumber(value.contextWindow),
    percent: readOptionalUsageNumber(value.percent)
  }
}

/**
 * 把 `get_session_stats` 的 data 投影为会话用量：`tokens` 不是对象时返回 null（视为未取到），
 * 单个累计字段缺失按 0，上下文占用按未知保持 null。
 */
export function toSessionUsage(data: unknown): SessionUsage | null {
  if (!isRecord(data) || !isRecord(data.tokens)) return null
  const tokens = data.tokens
  return {
    input: readUsageNumber(tokens.input),
    output: readUsageNumber(tokens.output),
    cacheRead: readUsageNumber(tokens.cacheRead),
    cacheWrite: readUsageNumber(tokens.cacheWrite),
    cost: readUsageNumber(data.cost),
    context: readContextUsage(data.contextUsage)
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
      // 显示名与上下文窗口来自模型目录；缺失或形状不符时为 null，不猜造。
      name: readOptionalText(entry.name),
      contextWindow: readContextWindow(entry.contextWindow),
      // 模型目录的 input 字段描述支持的输入模态；缺失时不猜造。
      imageInput: readImageInput(entry.input)
    })
  }
  return models
}

/** 正有限数为有效上下文窗口，其余（含缺失）一律 null。 */
function readContextWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** `input` 数组含 `image` 为 true，是数组但不含为 false，缺失或其他形状为 null。 */
function readImageInput(value: unknown): boolean | null {
  if (!Array.isArray(value)) return null
  return value.some((entry) => entry === 'image')
}

/** `get_commands` 的 `source` 到页面资源分类的映射；其他来源不进入页面。 */
const RESOURCE_KIND_BY_SOURCE: Readonly<Record<string, PiResourceKind>> = {
  skill: 'skill',
  prompt: 'prompt',
  extension: 'extension'
}

/** 非空字符串或 null；其他取值一律视为缺失，不猜造。 */
function readOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 把 `get_commands` 的 data 投影为资源条目列表：只保留 skill/prompt/extension 三类，
 * 名称或来源不符的条目丢弃，`commands` 不是数组时返回 null（由调用方按格式错误处理）。
 * 归属信息只取官方 sourceInfo；缺失字段一律为 null。
 */
export function toResources(data: unknown): PiResourceEntry[] | null {
  if (!isRecord(data) || !Array.isArray(data.commands)) return null

  const entries: PiResourceEntry[] = []
  for (const entry of data.commands) {
    if (!isRecord(entry)) continue
    const kind = typeof entry.source === 'string' ? RESOURCE_KIND_BY_SOURCE[entry.source] : undefined
    const name = readOptionalText(entry.name)
    if (kind === undefined || name === null) continue
    const info = isRecord(entry.sourceInfo) ? entry.sourceInfo : {}
    entries.push({
      kind,
      name,
      description: readOptionalText(entry.description),
      path: readOptionalText(info.path),
      scope: readOptionalText(info.scope),
      origin: readOptionalText(info.origin),
      baseDir: readOptionalText(info.baseDir)
    })
  }
  return entries
}

/** RPC 的 `extension_error` 事件只带 path/event/error；`error` 缺失时不计入展示。 */
export function toExtensionError(payload: Record<string, unknown>): ExtensionErrorEntry | null {
  const error = readOptionalText(payload.error)
  if (error === null) return null
  return {
    path: readOptionalText(payload.extensionPath),
    event: readOptionalText(payload.event),
    error
  }
}

/** 只保存摘要与时间戳，不为回退额外保留完整消息或图片。 */
export interface UserMessageIdentity {
  readonly timestamp: number | null
  readonly digest: string
}

/** 截断展示前建立身份；文本与图片按固定字段规范化，未知内容拒绝猜测。 */
export function toUserMessageIdentity(value: unknown): UserMessageIdentity | null {
  if (!isRecord(value) || value.role !== 'user') return null
  const source = typeof value.content === 'string'
    ? [{ type: 'text', text: value.content }]
    : value.content
  if (!Array.isArray(source)) return null
  const blocks: Record<string, string>[] = []
  let hasText = false
  for (const block of source) {
    if (!isRecord(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
      hasText ||= block.text.trim() !== ''
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    } else {
      return null
    }
  }
  if (!hasText) return null
  return {
    timestamp: typeof value.timestamp === 'number' ? value.timestamp : null,
    digest: createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  }
}

/** get_entries 含废弃分支：只沿当前叶子的父链核对，重复身份或损坏父链一律拒绝。 */
export function findUserForkEntry(data: unknown, identity: UserMessageIdentity): string | null {
  if (!isRecord(data) || !Array.isArray(data.entries) || typeof data.leafId !== 'string') return null
  const entries = new Map<string, Record<string, unknown>>()
  for (const entry of data.entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entries.has(entry.id)
      || (entry.parentId !== null && typeof entry.parentId !== 'string')) return null
    entries.set(entry.id, entry)
  }
  const seen = new Set<string>()
  const matches: string[] = []
  let id: string | null = data.leafId
  while (id !== null) {
    if (seen.has(id)) return null
    seen.add(id)
    const entry = entries.get(id)
    if (entry === undefined) return null
    const candidate = entry.type === 'message' ? toUserMessageIdentity(entry.message) : null
    if (candidate?.digest === identity.digest && candidate.timestamp === identity.timestamp) matches.push(id)
    id = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  return matches.length === 1 ? matches[0] ?? null : null
}

/** 分支变更必须空闲，压缩中或仍有排队输入都不允许回退。 */
export function isPiIdle(data: unknown): boolean {
  return isRecord(data) && data.isStreaming === false && data.isCompacting === false
    && data.pendingMessageCount === 0
}

/** fork 被扩展取消时可能没有 text；成功时必须带完整原文。 */
export function toForkResult(data: unknown): { cancelled: boolean; text: string | null } | null {
  if (!isRecord(data) || typeof data.cancelled !== 'boolean') return null
  if (data.cancelled) return { cancelled: true, text: null }
  return typeof data.text === 'string' ? { cancelled: false, text: data.text } : null
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
