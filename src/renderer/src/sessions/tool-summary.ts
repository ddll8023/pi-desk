/**
 * 工具卡片的展示推导：折叠摘要、参数值文案与结果预览裁剪。
 *
 * 只做展示层计算，不改变投影数据——参数摘要与完整输出路径来自投影快照，这里只负责挑选要显示的
 * 键、把值摘要格式化成文案，并把长结果裁成预览。结果整体是 JSON 时只给结构摘要，避免把 MCP
 * 与资源工具返回的单行 JSON 原文铺进界面；为不在渲染线程解析大文本，JSON 判定同时限制长度。
 */
import type { ToolArgSummaryEntry, ToolArgValue } from '../../../shared/runtime-api'

/** 折叠摘要的长度上限；只用于那一行摘要，不代替展开后的内容。 */
const ARGS_PREVIEW_CHARS = 120

/** 结果预览的行数上限。 */
export const RESULT_PREVIEW_LINES = 12

/** 结果预览的字符数上限：单行长文本靠它收住。 */
export const RESULT_PREVIEW_CHARS = 2000

/** 低于该长度的结果不值得做结构摘要，直接按普通文本展示。 */
const JSON_SUMMARY_MIN_CHARS = 160

/** JSON 结构摘要的解析上限；超过就不在渲染线程解析。 */
const JSON_SUMMARY_MAX_CHARS = 256 * 1024

/** 折叠摘要优先展示的参数键；顺序即优先级。 */
const PREVIEW_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  read: ['path', 'file_path'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  ls: ['path', 'file_path'],
  bash: ['command'],
  grep: ['pattern', 'path'],
  find: ['pattern', 'path']
}

/** 未知工具（含 MCP 工具）最多展示的短参数个数。 */
const FALLBACK_PREVIEW_ARGS = 2

/** 结果预览：`preview` 是实际要显示的文本，`clipped` 表示还有未显示的内容。 */
export interface ResultPreview {
  readonly preview: string
  readonly clipped: boolean
  readonly totalLines: number
}

/** 字节数格式化；只用于展示规模，不做单位换算之外的语义。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 参数值文案：长文本只给行数与字节数，数组与嵌套对象只给规模。 */
export function formatToolArgValue(value: ToolArgValue): string {
  switch (value.kind) {
    case 'inline': return value.text === '' ? '空' : value.text
    case 'text': return `文本 ${value.lines} 行 / ${formatBytes(value.bytes)}`
    case 'items': return `${value.count} 项`
    case 'object': return `${value.fields} 个字段`
  }
}

/** 超长摘要按字符数截断，保持单行可扫读。 */
function clipPreview(text: string): string {
  return text.length > ARGS_PREVIEW_CHARS ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…` : text
}

/** 取该工具优先键里的短值；没有就返回 null。 */
function findPreviewArg(summary: readonly ToolArgSummaryEntry[], keys: readonly string[]): string | null {
  for (const key of keys) {
    const entry = summary.find(candidate => candidate.key === key)
    if (entry !== undefined && entry.value.kind === 'inline' && entry.value.text !== '') return entry.value.text
  }
  return null
}

/** 未知工具按 `键=值` 展示前几个短参数，避免退化成参数 JSON 的首行。 */
function joinFallbackArgs(summary: readonly ToolArgSummaryEntry[]): string | null {
  const parts: string[] = []
  for (const entry of summary) {
    if (parts.length >= FALLBACK_PREVIEW_ARGS) break
    if (entry.value.kind === 'inline' && entry.value.text !== '') parts.push(`${entry.key}=${entry.value.text}`)
  }
  return parts.length === 0 ? null : parts.join(' ')
}

/**
 * 折叠状态那一行的摘要：内置工具按优先级取路径、命令或 pattern；未知工具（含 MCP）取前两个
 * 短参数；摘要不可得时回退到参数文本首行。都不成立时返回 null，不显示摘要。
 */
export function toolCallPreview(
  toolName: string,
  summary: readonly ToolArgSummaryEntry[] | null,
  argsText: string | null
): string | null {
  if (summary !== null && summary.length > 0) {
    const keys = PREVIEW_ARG_KEYS[toolName]
    const preferred = keys === undefined ? joinFallbackArgs(summary) : findPreviewArg(summary, keys)
    if (preferred !== null) return clipPreview(preferred)
  }
  const firstLine = argsText?.split('\n', 1)[0]?.trim() ?? ''
  return firstLine === '' ? null : clipPreview(firstLine)
}

/** 按行数与字符数双重上限裁剪结果文本。 */
export function previewTextLines(text: string, maxLines: number, maxChars: number): ResultPreview {
  const lines = text.split('\n')
  let preview = lines.slice(0, maxLines).join('\n')
  let clipped = lines.length > maxLines
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars)}…`
    clipped = true
  }
  return { preview, clipped, totalLines: lines.length }
}

/** JSON 值的结构文案：只报类型与规模，不展示内容。 */
function describeJson(value: unknown, text: string): string {
  const size = formatBytes(new TextEncoder().encode(text).length)
  if (Array.isArray(value)) return `JSON 数组 · ${value.length} 项 · ${size}`
  if (typeof value === 'object' && value !== null) return `JSON 对象 · ${Object.keys(value).length} 个字段 · ${size}`
  return `JSON 值 · ${size}`
}

/**
 * 结果整体是 JSON 且长度在可解析区间时，给出结构摘要；否则返回 null 表示按普通文本展示。
 * 首尾字符先做廉价的形状检查，流式过程中不完整的 JSON 因此在解析前就被排除。
 */
export function summarizeResultText(text: string): string | null {
  if (text.length < JSON_SUMMARY_MIN_CHARS || text.length > JSON_SUMMARY_MAX_CHARS) return null
  const head = text.trimStart().charAt(0)
  const trimmed = text.trimEnd()
  const tail = trimmed.charAt(trimmed.length - 1)
  const looksLikeJson = (head === '{' && tail === '}') || (head === '[' && tail === ']')
  if (!looksLikeJson) return null
  try {
    return describeJson(JSON.parse(text) as unknown, text)
  } catch {
    return null
  }
}
