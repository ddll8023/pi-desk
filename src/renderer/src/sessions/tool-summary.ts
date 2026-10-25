/**
 * 工具卡片的展示推导：摘要行内容、变更展示与结果预览。
 *
 * 只做展示层计算，不改变投影数据。涵盖五类：
 * 参数摘要与参数值文案（长文本、数组与嵌套对象只给规模）；文件路径相对化与 `write` 内容预览；
 * Diff 增删行统计与工具组状态统计；结果规模测量与预览裁剪（按行数、按字符两种裁剪原因分开）；
 * 结果整体是 JSON 时的结构摘要。为不在渲染线程解析大文本，JSON 判定同时限制长度。
 */
import type { ToolArgSummaryEntry, ToolArgValue, ToolDiff, ToolExecutionPhase } from '../../../shared/runtime-api'

/** 折叠摘要的长度上限；只用于那一行摘要，不代替展开后的内容。 */
const ARGS_PREVIEW_CHARS = 120

/** 结果预览的行数上限。 */
export const RESULT_PREVIEW_LINES = 12

/** 结果预览的字符数上限：单行长文本靠它收住。 */
export const RESULT_PREVIEW_CHARS = 2000

/** 低于该长度的结果不值得做结构摘要，直接按普通文本展示。 */
const JSON_SUMMARY_MIN_CHARS = 160

/** JSON 结构摘要的解析上限；超过就不在渲染线程解析。只在本文件内使用，界面不得自行拿它分支。 */
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

/** 需要文件级展示（路径 + 改动量 + Diff）的工具。 */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

/** `write` 内容预览的行数上限；超出只报剩余行数，不把整份文件铺进界面。 */
export const WRITE_PREVIEW_LINES = 20

/** 取路径参数时按顺序尝试的键；`path` 是内置工具的主键，`file_path` 兼容改名后的形态。 */
const FILE_PATH_KEYS: readonly string[] = ['path', 'file_path']

/** 结果规模：完整结果的行数与估算字节数；只做计数，不保留任何副本。 */
export interface ResultMeasure {
  readonly totalLines: number
  readonly totalBytes: number
}

/** 结果预览：`preview` 是实际要显示的文本，`clipped` 表示还有未显示的内容。 */
export interface ResultPreview {
  readonly preview: string
  readonly clipped: boolean
  readonly totalLines: number
  /**
   * 裁剪原因：`lines` 按行数裁，`chars` 按字符上限裁（单行超长结果会只裁一行），`none` 未裁。
   * 界面要按原因给文案：按字符裁时「已显示前 N 行」并不成立。
   */
  readonly clipReason: 'none' | 'lines' | 'chars'
}

/**
 * 完整结果的行数与字节数：一次扫描同时累计换行数与 UTF-8 字节数，不切分数组、不编码全文。
 * 字节数逐码点按编码规则精确计数：代理对算 4 字节，孤立代理与 U+0800 以上算 3 字节，
 * U+0080 以上算 2 字节，其余 1 字节；结果与 `TextEncoder` 一致，不能用 `text.length` 代替
 * （中文在 UTF-8 里占 3 字节）。工具输出常达数百 KB，为一行展示数字分配等长缓冲不划算。
 * 空结果记 0 行，因为界面在这种情况下不展示行数。
 */
export function measureResult(text: string): ResultMeasure {
  if (text === '') return { totalLines: 0, totalBytes: 0 }
  let newlines = 0
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10) newlines += 1
    if (code < 0x80) {
      bytes += 1
      continue
    }
    if (code < 0x800) {
      bytes += 2
      continue
    }
    const next = text.charCodeAt(index + 1)
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4
      index += 1
      continue
    }
    bytes += 3
  }
  return { totalLines: newlines + 1, totalBytes: bytes }
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

/**
 * 从参数摘要里取文件路径；只接受可内联展示的短值，长文本与嵌套结构不当路径用。
 * 摘要不可得时返回 null，调用方退回通用摘要。
 */
export function toolFilePath(summary: readonly ToolArgSummaryEntry[] | null): string | null {
  if (summary === null) return null
  return findPreviewArg(summary, FILE_PATH_KEYS)
}

/**
 * 把工具参数里的绝对路径裁成相对项目目录的显示路径；裁不动时原样返回。
 * 两种分隔符都按 `/` 比较，因此 Windows 反斜杠路径与 POSIX 路径共用同一套判断。
 */
export function displayToolPath(path: string, root: string | null): string {
  const value = path.trim()
  if (value === '' || root === null) return value
  const normalizedRoot = root.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/')
  if (normalizedRoot === '') return value
  const normalizedValue = value.replace(/\\/g, '/')
  if (!normalizedValue.startsWith(`${normalizedRoot}/`)) return value
  return normalizedValue.slice(normalizedRoot.length + 1)
}

/** 改动量：只数投影已算出的新增与删除行，没有变更时返回 null。 */
export function diffChangeCounts(diff: ToolDiff | null): { readonly add: number; readonly remove: number } | null {
  if (diff === null) return null
  let add = 0
  let remove = 0
  for (const line of diff.lines) {
    if (line.kind === 'add') add += 1
    else if (line.kind === 'remove') remove += 1
  }
  return add === 0 && remove === 0 ? null : { add, remove }
}

/** 结果规模文案「N 行 · M 字节」；入参来自 `measureResult`，不重复切分文本。 */
export function formatResultSize(totalLines: number, totalBytes: number): string {
  return `${totalLines} 行 · ${formatBytes(totalBytes)}`
}

/** 工具组统计里的状态文案；顺序固定，与单个卡片的文案一致。 */
const GROUP_PHASE_LABELS: Readonly<Record<ToolExecutionPhase, string>> = {
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  unknown: '未确认结束'
}

/**
 * 工具组头部统计：只列出实际出现的状态，顺序固定，避免同一组的状态文案随到达顺序抖动。
 * `null` 表示该调用还没有执行记录，不把它当成失败或成功。
 */
export function toolGroupStats(phases: readonly (ToolExecutionPhase | null)[]): string {
  const counts = new Map<string, number>()
  for (const phase of phases) {
    const label = phase === null ? '执行记录未到达' : GROUP_PHASE_LABELS[phase]
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = [...counts].map(([label, count]) => `${count} ${label}`)
  return `${phases.length} 个工具 · ${parts.join(' / ')}`
}

/**
 * `write` 的内容预览：`lines` 是前 `limit` 行，`remaining` 是未展示的行数，`total` 是内容总行数。
 * 总行数单独给出：改动量要用它，不能由 `lines.length + remaining` 反推，否则预览上限一改，改动量数字跟着错。
 * 参数不可解析或不是字符串内容时返回 null。
 */
export interface WriteContentPreview {
  readonly lines: readonly string[]
  readonly remaining: number
  readonly total: number
}

export function writeContentPreview(argsText: string | null, limit: number): WriteContentPreview | null {
  if (argsText === null) return null
  let args: unknown
  try {
    args = JSON.parse(argsText)
  } catch {
    return null
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const content = (args as Record<string, unknown>).content
  if (typeof content !== 'string') return null
  const all = content.split('\n')
  // 文件以换行结尾时末尾会多出一个空行，它不是文件内容，不计入行数。
  let end = all.length
  while (end > 0 && all[end - 1] === '') end -= 1
  const lines = all.slice(0, end)
  return { lines: lines.slice(0, limit), remaining: Math.max(0, lines.length - limit), total: lines.length }
}

/**
 * 按行数与字符数双重上限裁剪结果文本；只在确实要展示预览时调用。
 * 标题只要行数与字节数时走 `measureResult`，不把预览裁剪与它绑在一起。
 * 已经量过行数时传入 `totalLines`，避免为同一段文本再数一次换行；
 * 不先 `split` 全文：只需找到第 `maxLines` 个换行符就能拿到预览，超大输出因此不必分配等长数组。
 */
export function clipResultPreview(
  text: string,
  maxLines: number,
  maxChars: number,
  totalLines?: number
): ResultPreview {
  let cut = -1
  let newlines = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    newlines += 1
    if (cut < 0 && newlines === maxLines) {
      cut = index
      // 行数已由调用方量好时不必再数完整篇，找到裁切点就可以停。
      if (totalLines !== undefined) break
    }
  }
  // `cut` 是第 maxLines 个换行符的位置：它之后还有内容才说明行数被裁；
  // 恰好落在末尾时只是文件以换行结尾，整段文本都是预览。
  const clippedByLines = cut >= 0 && cut < text.length - 1
  let preview = clippedByLines ? text.slice(0, cut) : text
  const clippedByChars = preview.length > maxChars
  if (clippedByChars) preview = `${preview.slice(0, maxChars)}…`
  const clipReason = clippedByChars ? 'chars' : clippedByLines ? 'lines' : 'none'
  return {
    preview,
    clipped: clipReason !== 'none',
    totalLines: totalLines ?? newlines + 1,
    clipReason
  }
}

/** JSON 值的结构文案：只报类型与规模，不展示内容。字节数由调用方给，不在渲染线程重新编码全文。 */
function describeJson(value: unknown, bytes: number): string {
  const size = formatBytes(bytes)
  if (Array.isArray(value)) return `JSON 数组 · ${value.length} 项 · ${size}`
  if (typeof value === 'object' && value !== null) return `JSON 对象 · ${Object.keys(value).length} 个字段 · ${size}`
  return `JSON 值 · ${size}`
}

/**
 * 首尾字符的形状检查：只判断外层是不是 `{}` 或 `[]`，不切分、不解析。
 * 长度区间由调用方各自把关，这里只回答「形状对不对」，避免两个导出函数各写一份。
 */
function hasJsonShape(text: string): boolean {
  const head = text.trimStart().charAt(0)
  const trimmed = text.trimEnd()
  const tail = trimmed.charAt(trimmed.length - 1)
  return (head === '{' && tail === '}') || (head === '[' && tail === ']')
}

/**
 * 结果的廉价形状检查：只做长度区间与首尾字符判断，不切分、不解析。
 * 只在本文件内供 `summarizeResultText` 使用：界面不应自己拿它决定分支，
 * 否则会绕过统一口径，出现「摘要分支」与「纯文本分支」的提示互相竞争。
 */
function looksLikeJsonText(text: string): boolean {
  return text.length >= JSON_SUMMARY_MIN_CHARS && text.length <= JSON_SUMMARY_MAX_CHARS && hasJsonShape(text)
}

/**
 * 形状像 JSON 但超出解析上限：结构摘要缺席是因为结果过大，不是因为它不是 JSON。
 * 界面据此说明「结果过大，按纯文本展示」，不让用户以为摘要坏了。
 */
export function isOversizedJsonText(text: string): boolean {
  return text.length > JSON_SUMMARY_MAX_CHARS && hasJsonShape(text)
}

/**
 * 结果整体是 JSON 且长度在可解析区间时，给出结构摘要；否则返回 null 表示按普通文本展示。
 * 首尾字符先做廉价的形状检查，流式过程中不完整的 JSON 因此在解析前就被排除。
 * `totalBytes` 已由 `measureResult` 算好时传入，避免为了一个展示数字再编码一遍全文。
 */
export function summarizeResultText(text: string, totalBytes?: number): string | null {
  if (!looksLikeJsonText(text)) return null
  try {
    return describeJson(JSON.parse(text) as unknown, totalBytes ?? measureResult(text).totalBytes)
  } catch {
    return null
  }
}
