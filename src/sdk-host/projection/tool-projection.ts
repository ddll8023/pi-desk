/**
 * 维护当前 Runtime 代际的工具执行条目，按 `toolCallId` 关联一次执行的完整生命周期。
 *
 * 只把 `tool_execution_*` 会话事件重建为有界展示条目：不持有子进程、不管理批次与序号、
 * 不做请求关联，也不进入消息块。`partialResult` 的追加或替换语义由具体工具决定，因此这里
 * 只保留最近一次报告、结束事件再用 `result` 校正，不做内容级累加；非文本内容只保留类型与
 * 估算大小的描述，不携带载荷也不渲染。`details.ui` 是唯一被放行的非文本载荷，
 * 读取时重新走一次完整校验，不符即丢弃。
 *
 * Edit / Write 变更展示只来自 Pi 已有的信息：优先解析结束结果 `details.diff`（Pi 执行时刻
 * 基于真实文件内容算出，天然覆盖重复修改与并发变更），缺失时对 edit 工具用参数 `edits[]`
 * 推断降级片段；其他工具与无法解析的情形不产出 Diff，不读文件、不自行计算基线、不伪造。
 *
 * 条目的开始与结束时刻是 Desktop 收到对应事件的时刻，供界面计算耗时；Pi 的工具事件没有
 * 时间字段，该耗时不代表工具的真实执行时间。恢复会话时补种的历史条目没有开始时刻。
 *
 * 参数除了原始 JSON 文本，还产出值级摘要（`argsSummary`）：长文本、数组与嵌套对象只给规模，
 * 源码不进入展示层；摘要由完整参数算出，因此不受 `argsText` 截断影响。结果里 Pi 保存完整
 * 输出的路径原样带到 `outputPath`，界面据此指路，不自己推测文件位置。
 */
import type {
  ToolArgSummaryEntry,
  ToolArgValue,
  ToolDiff,
  ToolDiffLine,
  ToolExecution,
  ToolExecutionPhase,
  ToolExecutionTextKind,
  ToolNonTextPart
} from '../../shared/runtime-api'
import { parseGenuiPayload } from '../../shared/genui-api'
import type { GenuiPayload } from '../../shared/genui-api'

/** 工具参数摘要上限；超限截断并在条目上标记，不伪装成完整参数。 */
const MAX_TOOL_ARGS_CHARS = 4096

/** 参数摘要的键值对条数上限；超出部分不再列出。 */
const MAX_ARG_SUMMARY_ENTRIES = 16

/** 超过该长度的字符串值只给规模，不再当成可直接显示的短值。 */
const ARG_SUMMARY_INLINE_CHARS = 80

/** Diff 展示文本总量上限；超出停止收行并标 `truncated`，不伪装成完整 Diff。 */
const MAX_DIFF_CHARS = 16384

/** 单条工具结果的非文本描述条数上限；超出只计数，不再追加描述。 */
const MAX_NON_TEXT_PARTS = 32

/** 工具条目数量上限；超出丢弃最旧条目并计数。 */
const MAX_TOOL_ENTRIES = 100

/** 本模块消费的事件类别；调用方据此决定是立即刷新还是走批次节拍。 */
export type ToolEventKind = 'start' | 'update' | 'end' | 'none'

/** 只承认 `content` 为字符串或内容块数组的官方形状；其他形状退化为无文本，不猜测结构。 */
interface ExtractedText {
  readonly text: string
  readonly nonTextBlocks: number
  readonly nonTextParts: ToolNonTextPart[]
}

const EMPTY_TEXT: ExtractedText = { text: '', nonTextBlocks: 0, nonTextParts: [] }

/** 由 Pi 结果 `details.diff` 行解析出的中间行；不匹配官方格式时行号保持缺失。 */
interface ParsedDiffLine {
  readonly kind: ToolDiffLine['kind']
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly text: string
}

interface MutableToolExecution {
  readonly toolCallId: string
  toolName: string
  phase: ToolExecutionPhase
  startedAt: number | null
  endedAt: number | null
  argsText: string | null
  argsTruncated: boolean
  argsSummary: readonly ToolArgSummaryEntry[] | null
  outputPath: string | null
  text: string
  textKind: ToolExecutionTextKind
  textTruncated: boolean
  nonTextBlocks: number
  nonTextParts: ToolNonTextPart[]
  diff: ToolDiff | null
  ui: GenuiPayload | null
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

/** 恢复会话时补种的一条历史工具结果；开始时刻与事件流都不存在。 */
export interface SeededToolResult {
  readonly toolCallId: string
  readonly toolName: string | null
  readonly isError: boolean
  readonly argsText: string | null
  /** 历史 `toolResult` 消息本身；其中 `content` 的文本与非文本块由本模块提取。 */
  readonly result: unknown
  readonly endedAt: number | null
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

/** 统计 UTF-8 字节数；只用于给界面报规模，不做编码转换。 */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** 统计行数；空字符串算 0 行，长文本参数只用它报规模。 */
function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1
  return lines
}

/** 单值摘要：只有短且单行的字符串才直接显示，其余只给规模。 */
function summarizeArgValue(value: unknown): ToolArgValue {
  if (typeof value === 'string') {
    if (value.length <= ARG_SUMMARY_INLINE_CHARS && !value.includes('\n')) {
      return { kind: 'inline', text: value }
    }
    return { kind: 'text', lines: countLines(value), bytes: utf8Bytes(value) }
  }
  if (Array.isArray(value)) return { kind: 'items', count: value.length }
  if (isRecord(value)) return { kind: 'object', fields: Object.keys(value).length }
  return { kind: 'inline', text: value === null || value === undefined ? '未知' : String(value) }
}

/**
 * 参数摘要：按参数对象自己的键顺序取值摘要，最多 `MAX_ARG_SUMMARY_ENTRIES` 个键。
 * 非对象参数（如字符串或数组形式）保持为不可摘要，界面回退到 `argsText` 原文。
 */
export function summarizeToolArguments(value: unknown): readonly ToolArgSummaryEntry[] | null {
  if (!isRecord(value)) return null
  const entries: ToolArgSummaryEntry[] = []
  for (const key of Object.keys(value)) {
    if (entries.length >= MAX_ARG_SUMMARY_ENTRIES) break
    entries.push({ key, value: summarizeArgValue(value[key]) })
  }
  return entries
}

/** 历史补种只有参数文本时解析出摘要；解析失败返回 null，不猜造键值。 */
function summarizeArgsText(argsText: string | null): readonly ToolArgSummaryEntry[] | null {
  if (argsText === null) return null
  try {
    return summarizeToolArguments(JSON.parse(argsText))
  } catch {
    return null
  }
}

/** 结束结果里 Pi 保存的完整输出路径；没有或形状不符时为 null。 */
function readOutputPath(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.details)) return null
  const path = result.details.fullOutputPath
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * 生成式 UI 载荷：只从结果 `details.ui` 读取，并重新走一次完整校验。
 * 宿主已校验过的载荷在这里仍然重校，是因为渲染端只能相信跨进程契约，不能相信上游一定校验过；
 * 形状不符、版本未知或超限时返回 null，由界面降级为文本结果。
 */
function readUiPayload(result: unknown): GenuiPayload | null {
  if (!isRecord(result) || !isRecord(result.details)) return null
  return parseGenuiPayload(result.details.ui)
}

/** 由 base64 字符数估算解码后字节数；不解析内容，也不保留数据本身。 */
function estimateBase64Bytes(data: string): number {
  if (data === '') return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/** Pi diff 行的首字符语义：`+` 新增、`-` 删除、空格上下文，其余不识别。 */
function readDiffLineKind(marker: string): ToolDiffLine['kind'] | null {
  if (marker === '+') return 'add'
  if (marker === '-') return 'remove'
  if (marker === ' ') return 'context'
  return null
}

/**
 * 解析 Pi 内置 edit 工具 `details.diff` 的一行：首字符 + 右对齐行号 + 空格 + 内容，
 * 折叠省略行是 ` ...`（无行号）。行号缺失不拒绝该行，只如实不帧行号。
 */
function parseResultDiffLine(line: string): ParsedDiffLine | null {
  if (line === ' ...' || line.trimEnd() === '...') return { kind: 'fold', oldLine: null, newLine: null, text: ' ...' }
  const kind = readDiffLineKind(line.charAt(0))
  if (kind === null) return null
  const body = line.slice(1)
  const separator = body.indexOf(' ')
  if (separator <= 0) return { kind, oldLine: null, newLine: null, text: body }
  const numberText = body.slice(0, separator)
  const text = body.slice(separator + 1)
  if (!/^\d+$/.test(numberText)) return { kind, oldLine: null, newLine: null, text: body }
  const lineNumber = Number.parseInt(numberText, 10)
  return {
    kind,
    // Pi 对上下文行新旧行号同值；增删行分别只带一个行号。
    oldLine: kind === 'add' ? null : lineNumber,
    newLine: kind === 'remove' ? null : lineNumber,
    text
  }
}

/** 由 Pi 的 diff 文本逐行解析展示行；总量超限后停止收行并标 `truncated`。 */
function toResultDiff(diffText: string): ToolDiff {
  const lines: ToolDiffLine[] = []
  let used = 0
  let truncated = false
  for (const line of diffText.split('\n')) {
    if (used + line.length > MAX_DIFF_CHARS && lines.length > 0) {
      truncated = true
      break
    }
    const parsed = parseResultDiffLine(line)
    if (parsed !== null) {
      lines.push(parsed)
      used += line.length + 1
    }
    // 不匹配官方格式的行直接丢弃，不猜造语义。
  }
  return { source: 'result', lines, truncated }
}

/** 把 edit 参数的一对替换文本拆为推断展示行；`oldText` 行在前，`newText` 行在后。 */
function appendArgsEditLines(lines: ToolDiffLine[], oldText: string, newText: string): void {
  for (const line of oldText.split('\n')) {
    lines.push({ kind: 'remove', oldLine: null, newLine: null, text: line })
  }
  for (const line of newText.split('\n')) {
    lines.push({ kind: 'add', oldLine: null, newLine: null, text: line })
  }
}

/**
 * 降级来源：无结果 diff 且工具为 edit 时，用参数 `edits[]` 推断变更片段。
 * 只接受能解析出 `path` 与至少一对 `oldText`/`newText` 均为字符串的参数；否则返回 null，不伪造。
 */
function toArgsDiff(toolName: string, argsText: string | null): ToolDiff | null {
  if (toolName !== 'edit' || argsText === null) return null
  let args: unknown
  try {
    args = JSON.parse(argsText)
  } catch {
    return null
  }
  if (!isRecord(args) || !Array.isArray(args.edits) || args.edits.length === 0) return null

  const lines: ToolDiffLine[] = []
  for (const edit of args.edits) {
    if (!isRecord(edit)) return null
    const oldText = edit.oldText
    const newText = edit.newText
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    appendArgsEditLines(lines, oldText, newText)
    if (lines.join('\n').length > MAX_DIFF_CHARS) {
      return { source: 'args', lines: lines.slice(0, -1), truncated: true }
    }
  }
  return { source: 'args', lines, truncated: false }
}

/**
 * 提取条目 diff：优先 Pi 结束结果的 `details.diff`（执行时刻基于真实文件内容算出）；
 * 缺失或形状不符时按 edit 参数推断降级；两者都不可得时为 null，不伪造 Diff。
 */
function extractDiff(toolName: string, argsText: string | null, result: unknown): ToolDiff | null {
  if (isRecord(result)) {
    const details = result.details
    if (isRecord(details) && typeof details.diff === 'string') {
      const diff = toResultDiff(details.diff)
      if (diff.lines.length > 0) return diff
    }
  }
  return toArgsDiff(toolName, argsText)
}

/** 非文本内容块只描述类型与估算大小；未知形状如实标为未知，不猜造字段。 */
function describeNonTextBlock(block: Record<string, unknown>): ToolNonTextPart {
  const type = readString(block.type) ?? 'unknown'
  const mimeType = readString(block.mimeType)
  if (type !== 'image') return { type, mimeType, bytes: null }

  const data = readString(block.data)
  return { type, mimeType, bytes: data === null ? null : estimateBase64Bytes(data) }
}

function extractResultText(value: unknown): ExtractedText {
  if (typeof value === 'string') return { text: value, nonTextBlocks: 0, nonTextParts: [] }
  if (!isRecord(value)) return EMPTY_TEXT

  const content = value.content
  if (typeof content === 'string') return { text: content, nonTextBlocks: 0, nonTextParts: [] }
  if (!Array.isArray(content)) return EMPTY_TEXT

  const parts: string[] = []
  const nonTextParts: ToolNonTextPart[] = []
  let nonTextBlocks = 0
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    // 图片与其他内容块只保留描述：图片数据不进入展示投影。
    nonTextBlocks += 1
    if (isRecord(block) && nonTextParts.length < MAX_NON_TEXT_PARTS) {
      nonTextParts.push(describeNonTextBlock(block))
    }
  }
  return { text: parts.join('\n'), nonTextBlocks, nonTextParts }
}

function toPublicTool(entry: MutableToolExecution): ToolExecution {
  return {
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    phase: entry.phase,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    argsText: entry.argsText,
    argsTruncated: entry.argsTruncated,
    argsSummary: entry.argsSummary,
    outputPath: entry.outputPath,
    text: entry.text,
    textKind: entry.textKind,
    textTruncated: entry.textTruncated,
    nonTextBlocks: entry.nonTextBlocks,
    nonTextParts: entry.nonTextParts,
    diff: entry.diff,
    ui: entry.ui
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

  /** 回退后清空旧工具及截断计数；投影仍可承接新分支的事件。 */
  reset(): void {
    this.entries.length = 0
    this.index.clear()
    this.droppedTools = 0
    this.truncated = false
  }

  dispose(): void {
    this.disposed = true
    this.reset()
  }

  /**
   * 补种一条历史工具结果；已有实时条目时不覆盖，开始时刻保持缺失。
   * 结果文本、错误状态与结束时刻都来自历史消息，不冒充本轮执行。
   */
  seedResult(seed: SeededToolResult): void {
    if (this.disposed || seed.toolCallId === '' || this.index.has(seed.toolCallId)) return

    const extracted = extractResultText(seed.result)
    const entry: MutableToolExecution = {
      toolCallId: seed.toolCallId,
      toolName: seed.toolName ?? '',
      phase: seed.isError ? 'failed' : 'succeeded',
      startedAt: null,
      endedAt: seed.endedAt,
      argsText: null,
      argsTruncated: false,
      argsSummary: null,
      outputPath: null,
      text: '',
      textKind: 'none',
      textTruncated: false,
      nonTextBlocks: 0,
      nonTextParts: [],
      diff: null,
      ui: null
    }
    this.entries.push(entry)
    this.index.set(seed.toolCallId, entry)
    this.enforceLimit()
    this.applyArgsText(entry, seed.argsText)
    this.setText(entry, extracted, 'result')
    this.applyNonText(entry, extracted)
    entry.outputPath = readOutputPath(seed.result)
    entry.diff = extractDiff(entry.toolName, entry.argsText, seed.result)
    entry.ui = readUiPayload(seed.result)
    this.emit(entry)
  }

  private startExecution(payload: Record<string, unknown>): ToolEventKind {
    const entry = this.ensureEntry(payload, 'running', Date.now())
    if (entry === null) return 'none'
    // 重复的开始事件只刷新字段；已有 diff 与界面一并重置，避免残留上一轮结果。
    entry.diff = null
    entry.outputPath = null
    entry.ui = null
    this.applyArgs(entry, payload.args)
    this.emit(entry)
    return 'start'
  }

  private updateExecution(payload: Record<string, unknown>): ToolEventKind {
    const entry = this.ensureEntry(payload, 'running', Date.now())
    if (entry === null) return 'none'
    this.applyArgs(entry, payload.args)
    const partial = extractResultText(payload.partialResult)
    this.setText(entry, partial, 'partial')
    this.applyNonText(entry, partial)
    this.emit(entry)
    return 'update'
  }

  private endExecution(payload: Record<string, unknown>): ToolEventKind {
    const phase: ToolExecutionPhase = payload.isError === true ? 'failed' : 'succeeded'
    // 只见过结束事件的条目没有开始时刻，因此不编造耗时。
    const entry = this.ensureEntry(payload, phase, null)
    if (entry === null) return 'none'
    entry.phase = phase
    entry.endedAt = Date.now()
    this.applyArgs(entry, payload.args)
    entry.outputPath = readOutputPath(payload.result)
    // 最终结果覆盖 partial 报告，避免继续累加造成重复内容。
    const result = extractResultText(payload.result)
    this.setText(entry, result, 'result')
    this.applyNonText(entry, result)
    entry.diff = extractDiff(entry.toolName, entry.argsText, payload.result)
    entry.ui = readUiPayload(payload.result)
    this.emit(entry)
    return 'end'
  }

  /** 按 `toolCallId` 取或建条目；重复的开始事件只刷新字段，不重置已有输出。 */
  private ensureEntry(
    payload: Record<string, unknown>,
    initialPhase: ToolExecutionPhase,
    startedAt: number | null
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
      startedAt,
      endedAt: null,
      argsText: null,
      argsTruncated: false,
      argsSummary: null,
      outputPath: null,
      text: '',
      textKind: 'none',
      textTruncated: false,
      nonTextBlocks: 0,
      nonTextParts: [],
      diff: null,
      ui: null
    }
    this.entries.push(entry)
    this.index.set(toolCallId, entry)
    this.enforceLimit()
    return entry
  }

  /** 事件参数：先算值级摘要（不受截断影响），再存可能被截断的参数文本。 */
  private applyArgs(entry: MutableToolExecution, rawArgs: unknown): void {
    const argsText = serializeToolArguments(rawArgs)
    if (argsText === null) return
    entry.argsSummary = summarizeToolArguments(rawArgs)
    this.storeArgsText(entry, argsText)
  }

  /** 历史补种只有参数文本：先解析摘要，再存可能被截断的文本。 */
  private applyArgsText(entry: MutableToolExecution, argsText: string | null): void {
    if (argsText === null) return
    entry.argsSummary = summarizeArgsText(argsText)
    this.storeArgsText(entry, argsText)
  }

  /** 参数文本超限时截断并标记；不伪装成完整参数。 */
  private storeArgsText(entry: MutableToolExecution, argsText: string): void {
    if (argsText.length > MAX_TOOL_ARGS_CHARS) {
      entry.argsText = argsText.slice(0, MAX_TOOL_ARGS_CHARS)
      entry.argsTruncated = true
      this.truncated = true
      return
    }
    entry.argsText = argsText
    entry.argsTruncated = false
  }

  /** 非文本内容只更新描述与总数；描述条数上限在提取阶段已生效。 */
  private applyNonText(entry: MutableToolExecution, extracted: ExtractedText): void {
    entry.nonTextBlocks = extracted.nonTextBlocks
    entry.nonTextParts = extracted.nonTextParts
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
