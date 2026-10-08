/**
 * 维护当前 Runtime 代际的工具执行条目，按 `toolCallId` 关联一次执行的完整生命周期。
 *
 * 只把 `tool_execution_*` 会话事件重建为有界展示条目：不持有子进程、不管理批次与序号、
 * 不做请求关联，也不进入消息块。`partialResult` 的追加或替换语义由具体工具决定，因此这里
 * 只保留最近一次报告、结束事件再用 `result` 校正，不做内容级累加；非文本内容只计数，不渲染。
 */
import type { ToolExecution, ToolExecutionPhase, ToolExecutionTextKind } from '../shared/runtime-api'

/** 工具参数摘要上限；超限截断并在条目上标记，不伪装成完整参数。 */
const MAX_TOOL_ARGS_CHARS = 4096

/** 工具条目数量上限；超出丢弃最旧条目并计数。 */
const MAX_TOOL_ENTRIES = 100

/** 本模块消费的事件类别；调用方据此决定是立即刷新还是走批次节拍。 */
export type ToolEventKind = 'start' | 'update' | 'end' | 'none'

/** 只承认 `content` 为字符串或内容块数组的官方形状；其他形状退化为无文本，不猜测结构。 */
interface ExtractedText {
  readonly text: string
  readonly nonTextBlocks: number
}

const EMPTY_TEXT: ExtractedText = { text: '', nonTextBlocks: 0 }

interface MutableToolExecution {
  readonly toolCallId: string
  toolName: string
  phase: ToolExecutionPhase
  argsText: string | null
  argsTruncated: boolean
  text: string
  textKind: ToolExecutionTextKind
  textTruncated: boolean
  nonTextBlocks: number
}

export interface ToolProjectionCallbacks {
  readonly onUpdate: (tool: ToolExecution) => void
}

/** 工具条目快照；截断与丢弃计数由消息投影合并进投影快照。 */
export interface ToolProjectionSnapshot {
  readonly tools: readonly ToolExecution[]
  readonly truncated: boolean
  readonly droppedTools: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 把工具参数序列化为展示文本；无法序列化时返回 null，不因此丢弃条目。 */
export function serializeToolArguments(value: unknown): string | null {
  if (value === undefined) return null
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : null
  } catch {
    // 参数无法序列化不应导致工具条目丢失。
    return null
  }
}

function extractResultText(value: unknown): ExtractedText {
  if (typeof value === 'string') return { text: value, nonTextBlocks: 0 }
  if (!isRecord(value)) return EMPTY_TEXT

  const content = value.content
  if (typeof content === 'string') return { text: content, nonTextBlocks: 0 }
  if (!Array.isArray(content)) return EMPTY_TEXT

  const parts: string[] = []
  let nonTextBlocks = 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    // 图片与其他内容块只计数：图片不进入展示投影。
    nonTextBlocks += 1
  }
  return { text: parts.join('\n'), nonTextBlocks }
}

function toPublicTool(entry: MutableToolExecution): ToolExecution {
  return {
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    phase: entry.phase,
    argsText: entry.argsText,
    argsTruncated: entry.argsTruncated,
    text: entry.text,
    textKind: entry.textKind,
    textTruncated: entry.textTruncated,
    nonTextBlocks: entry.nonTextBlocks
  }
}

export class ToolProjection {
  private readonly entries: MutableToolExecution[] = []
  private readonly index = new Map<string, MutableToolExecution>()
  private droppedTools = 0
  private truncated = false
  private disposed = false

  constructor(
    private readonly maxTextChars: number,
    private readonly callbacks: ToolProjectionCallbacks
  ) {}

  /** 应用一条会话事件；只处理工具执行生命周期，其他事件不改变条目。 */
  apply(payload: Record<string, unknown>): ToolEventKind {
    if (this.disposed) return 'none'
    switch (payload.type) {
      case 'tool_execution_start':
        return this.startExecution(payload)
      case 'tool_execution_update':
        return this.updateExecution(payload)
      case 'tool_execution_end':
        return this.endExecution(payload)
      default:
        return 'none'
    }
  }

  /** 代际收敛时把仍未结束的条目标为未确认；不把缺失结束事件伪装成成功。 */
  settleRunning(): void {
    if (this.disposed) return
    for (const entry of this.entries) {
      if (entry.phase !== 'running') continue
      entry.phase = 'unknown'
      this.emit(entry)
    }
  }

  snapshot(): ToolProjectionSnapshot {
    return {
      tools: this.entries.map((entry) => toPublicTool(entry)),
      truncated: this.truncated,
      droppedTools: this.droppedTools
    }
  }

  dispose(): void {
    this.disposed = true
    this.entries.length = 0
    this.index.clear()
  }

  private startExecution(payload: Record<string, unknown>): ToolEventKind {
    const entry = this.ensureEntry(payload, 'running')
    if (entry === null) return 'none'
    this.applyArgs(entry, serializeToolArguments(payload.args))
    this.emit(entry)
    return 'start'
  }

  private updateExecution(payload: Record<string, unknown>): ToolEventKind {
    const entry = this.ensureEntry(payload, 'running')
    if (entry === null) return 'none'
    this.applyArgs(entry, serializeToolArguments(payload.args))
    const partial = extractResultText(payload.partialResult)
    this.setText(entry, partial, 'partial')
    entry.nonTextBlocks = partial.nonTextBlocks
    this.emit(entry)
    return 'update'
  }

  private endExecution(payload: Record<string, unknown>): ToolEventKind {
    const phase: ToolExecutionPhase = payload.isError === true ? 'failed' : 'succeeded'
    const entry = this.ensureEntry(payload, phase)
    if (entry === null) return 'none'
    entry.phase = phase
    this.applyArgs(entry, serializeToolArguments(payload.args))
    // 最终结果覆盖 partial 报告，避免继续累加造成重复内容。
    const result = extractResultText(payload.result)
    this.setText(entry, result, 'result')
    entry.nonTextBlocks = result.nonTextBlocks
    this.emit(entry)
    return 'end'
  }

  /** 按 `toolCallId` 取或建条目；重复的开始事件只刷新字段，不重置已有输出。 */
  private ensureEntry(
    payload: Record<string, unknown>,
    initialPhase: ToolExecutionPhase
  ): MutableToolExecution | null {
    const toolCallId = readString(payload.toolCallId)
    if (toolCallId === null || toolCallId === '') return null

    const toolName = readString(payload.toolName)
    const existing = this.index.get(toolCallId)
    if (existing !== undefined) {
      if (toolName !== null && toolName !== '') existing.toolName = toolName
      return existing
    }

    const entry: MutableToolExecution = {
      toolCallId,
      toolName: toolName ?? '',
      phase: initialPhase,
      argsText: null,
      argsTruncated: false,
      text: '',
      textKind: 'none',
      textTruncated: false,
      nonTextBlocks: 0
    }
    this.entries.push(entry)
    this.index.set(toolCallId, entry)
    this.enforceLimit()
    return entry
  }

  private applyArgs(entry: MutableToolExecution, argsText: string | null): void {
    if (argsText === null) return
    if (argsText.length > MAX_TOOL_ARGS_CHARS) {
      entry.argsText = argsText.slice(0, MAX_TOOL_ARGS_CHARS)
      entry.argsTruncated = true
      this.truncated = true
      return
    }
    entry.argsText = argsText
    entry.argsTruncated = false
  }

  /** 整块替换条目文本；空文本不标来源，截断只在本次替换超限时标记。 */
  private setText(entry: MutableToolExecution, extracted: ExtractedText, kind: ToolExecutionTextKind): void {
    if (extracted.text.length > this.maxTextChars) {
      entry.text = extracted.text.slice(0, this.maxTextChars)
      entry.textTruncated = true
      this.truncated = true
    } else {
      entry.text = extracted.text
      entry.textTruncated = false
    }
    entry.textKind = extracted.text === '' ? 'none' : kind
  }

  /** 条目上限从最旧开始丢弃；丢弃后界面必须说明被省略的条数。 */
  private enforceLimit(): void {
    while (this.entries.length > MAX_TOOL_ENTRIES) {
      const removed = this.entries.shift()
      if (removed === undefined) break
      this.index.delete(removed.toolCallId)
      this.droppedTools += 1
      this.truncated = true
    }
  }

  private emit(entry: MutableToolExecution): void {
    this.callbacks.onUpdate(toPublicTool(entry))
  }
}
