/**
 * 会话取样：只读本产品会话记录，抽出发言样本供风格蒸馏。
 *
 * 路径只来自宿主注入的会话根，模型不能指定；项目归属按会话头的 cwd 判定，不按分组目录名猜。
 * 只取 `type:"message"` 且 `role:"user"` 的文本块，硬过滤先于统计：整条只含确认句、夹入系统或技能注入段、
 * 代码与 diff、图片标记、以路径或日志为主、符号密度过高、短于下限的发言都先被剔除并计入过滤计数；
 * 库里已收录的原句（会话 + 逐字原句）与超单条预算的发言同样计入统计，不静默丢弃。
 * 全程不落盘、不改会话、不读会话根之外的文件；单会话超过字节上限整份跳过，不截断使用。
 */
import { constants } from 'node:fs'
import type { Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { JsonObject } from './engine.ts'
import { missing } from './files.ts'

/** 单会话读取上限：超过即整份跳过并计入统计，避免一次取样把内存和上下文撑爆。 */
const SESSION_FILE_MAX_BYTES = 8 * 1024 * 1024
/** 会话头在第一行，只读开头一段即可判定身份与归属，无需整份加载。 */
const SESSION_HEAD_BYTES = 8_192
/** 单个会话贡献的样本上限，与一条风格 12 条原句的上限一致。 */
const SAMPLES_PER_SESSION = 12
/** 长／短样本阈值：蒸馏阶段据此区分「需求式长句」与「短指令」。 */
const LONG_SAMPLE_CHARS = 200
/** 非空白字符中符号占比超过该值即视为表达式或代码为主。 */
const SYMBOL_DENSITY_LIMIT = 0.2

type SampleKind = 'long' | 'short'
type FilterName = 'confirm' | 'injection' | 'code' | 'image' | 'paths' | 'logs' | 'symbols' | 'used' | 'too_long' | 'short'

const FILTER_ORDER: readonly FilterName[] = ['confirm', 'injection', 'code', 'image', 'paths', 'logs', 'symbols', 'used', 'too_long', 'short']

/** 整条只是应答的确认句：这类发言不承载表达方式，进样本只会放大口头禅。 */
const CONFIRM_ONLY = /^(?:继续(?:执行|当前步骤)?|确认|同意|可以|好的?|收到|了解|明白|行|嗯+|哦+|ok|okay|continue|proceed|yes|y)[\s。.!！,，、]*$/i
/** 系统、技能与记忆背景的注入标记：它们以 user 身份落盘，但不是用户本人说的话。 */
const INJECTION_MARKERS = ['<skill ', '以下是 pi-memory 为本次请求提供的', '【适用偏好】', '【常驻约定',
  '【当前项目近况', '<project_context>', '<system-reminder', '<tools>', '<intent-summary>', '<instructions']
/** 代码围栏与 diff 标记：代码块内的自然语言不是表达样本。 */
const CODE_MARKER = /```|^~~~|^\s*(?:diff --git|index [0-9a-f]{7,}|@@ )/m
const IMAGE_MARKER = /!\[[^\]]*\]\(|<image|data:image\//i
/** 单行以绝对路径、盘符或相对路径开头。 */
const PATH_LINE = /^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])/
const PATH_SHAPE = /(?:[A-Za-z]:)?(?:[\\/][\w.@$-]+){2,}/
const LOG_LINE = /^\s*(?:at\s+[\w$.<>]+\s*\(|File ".*", line \d+|Traceback |\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[(?:info|warn|error|debug)\]|(?:error|warn|info|debug)\s*:)/i
const SYMBOL_CHARS = /[{}[\]()<>=+*/\\|&^%~$#@`]/g

export interface StyleSamplingRequest {
  /** 宿主注入的会话根；独立 CLI 没有该值，调用方在传参前就应报错。 */
  readonly sessionsRoot: string
  readonly scope: 'current-project' | 'all'
  /** `scope` 为 current-project 时的注册表项目 ID。 */
  readonly projectId: string | null
  /** 注册表映射；只用于按会话头 cwd 匹配归属。 */
  readonly projects: readonly { id: string; name: string; path: string }[]
  readonly days: number
  readonly sessionLimit: number
  readonly maxChars: number
  readonly minChars: number
  readonly offset: number
  /** 库里已收录样本的键集合：由调用方读 `styles` 后构造，取样模块不自己访问库。 */
  readonly usedKeys: ReadonlySet<string>
  /** 是否保留已收录样本：默认过滤，留作核对或重建时使用。 */
  readonly includeUsed: boolean
}

/**
 * 已收录样本的键：会话 ID 与逐字原句的组合。
 * 两侧（扩展与记忆桥）必须用同一口径构造，否则「已收录」判定会错位。
 */
export function sampleKey(sessionId: string, quote: string): string {
  return `${sessionId}\u0000${quote}`
}

interface SessionHead {
  readonly id: string
  readonly cwd: string
  /** 会话头条目时间戳的日期部分；缺失时为空串，样本日期回退到文件名日期。 */
  readonly date: string
}

interface SessionFile {
  readonly path: string
  readonly date: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseJson(line: string): unknown {
  try { return JSON.parse(line) as unknown } catch { return null }
}

/** 日期窗口：按 UTC 自然日结算，与会话文件名的时间戳口径一致。 */
function dayOffset(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 列出窗口内的会话文件：会话根下每个分组目录一层，文件名为 `<时间>_<会话 id>.jsonl`。
 * 只按目录项判定，不跟随符号链接；缺失的目录按空处理，不视为故障。
 */
async function listSessions(root: string, cutoff: string): Promise<SessionFile[]> {
  let groups: Dirent[]
  try { groups = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const files: SessionFile[] = []
  for (const group of groups) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue
    const directory = join(root, group.name)
    let entries: Dirent[]
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if (missing(error)) continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue
      const matched = /^(\d{4}-\d{2}-\d{2})T/.exec(entry.name)
      const date = matched === null ? undefined : matched[1]
      if (date === undefined || date < cutoff) continue
      files.push({ path: join(directory, entry.name), date })
    }
  }
  // 新的会话优先，同一天内按文件名倒序：取样先给模型最近期的表达方式。
  files.sort((left, right) => (left.date === right.date
    ? (left.path < right.path ? 1 : left.path > right.path ? -1 : 0)
    : (left.date < right.date ? 1 : -1)))
  return files
}

/** 只读开头一段取会话头；不是 `type:"session"` 的条目不算本产品的会话文件。 */
async function readSessionHead(path: string): Promise<SessionHead | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) return null
    const buffer = Buffer.alloc(SESSION_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SESSION_HEAD_BYTES, 0)
    const record = asObject(parseJson(new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead)).split('\n')[0] ?? ''))
    if (record === null || record.type !== 'session' || typeof record.id !== 'string'
      || typeof record.cwd !== 'string' || record.id === '') return null
    return { id: record.id, cwd: record.cwd,
      date: typeof record.timestamp === 'string' ? record.timestamp.slice(0, 10) : '' }
  } finally { await handle.close() }
}

/** 整份读取会话文件；超过上限返回 null，由调用方计入跳过而不做部分读取。 */
async function readSessionText(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size > BigInt(SESSION_FILE_MAX_BYTES)) return null
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const buffer = Buffer.alloc(65_536)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > SESSION_FILE_MAX_BYTES) return null
      chunks.push(buffer.subarray(0, bytesRead))
    }
    // 单行损坏不应让整份取样失败：解码用替换字符，解析失败的行按坏行计数后跳过。
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
  } finally { await handle.close() }
}

/** 用户消息正文：字符串或 `{type:'text'}` 块数组；其他块（图片、工具结果）不参与表达取样。 */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const row = asObject(block)
    if (row === null || row.type !== 'text' || typeof row.text !== 'string') continue
    parts.push(row.text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * 硬过滤：只覆盖可判定形态，不做主观筛选。
 * 顺序与规范一致——确认句、注入段、代码、图片、路径为主、日志为主、符号密度、长度下限；
 * 长度判定放最后，保证被记为 `short` 的条目确实只是太短，而不是同时更像代码或日志。
 */
function filterReason(text: string, minChars: number): FilterName | null {
  const trimmed = text.trim()
  if (trimmed === '') return 'short'
  if (CONFIRM_ONLY.test(trimmed)) return 'confirm'
  if (INJECTION_MARKERS.some(marker => trimmed.includes(marker))) return 'injection'
  if (CODE_MARKER.test(trimmed)) return 'code'
  if (IMAGE_MARKER.test(trimmed)) return 'image'
  const lines = trimmed.split('\n').filter(line => line.trim() !== '')
  if (lines.length > 1) {
    const pathLines = lines.filter(line => PATH_LINE.test(line.trim()) || PATH_SHAPE.test(line.trim())).length
    if (pathLines / lines.length >= 0.6) return 'paths'
    const logLines = lines.filter(line => LOG_LINE.test(line)).length
    if (logLines / lines.length >= 0.4) return 'logs'
  }
  const visible = trimmed.replace(/\s+/g, '')
  if ((visible.match(SYMBOL_CHARS) ?? []).length / visible.length > SYMBOL_DENSITY_LIMIT) return 'symbols'
  if (trimmed.length < minChars) return 'short'
  return null
}

/**
 * 收集风格样本。
 *
 * 分页按会话维度：`offset` 跳过前 N 个范围内的会话，`session_limit` 限定本批处理数。
 * 预算或单会话样本上限触顶即停止并置 `has_more`；`stopped_by` 说明停止原因，避免把「预算耗尽」误读为「已取完」。
 * `projectIdOf` 由调用方给出（注册表最长前缀匹配），本模块不自行推断项目身份。
 */
export async function collectStyleSamples(request: StyleSamplingRequest,
  projectIdOf: (cwd: string) => string | null): Promise<JsonObject> {
  const cutoff = dayOffset(request.days - 1)
  const all = await listSessions(request.sessionsRoot, cutoff)
  // 先按归属筛选再分页：被范围排除的会话不占 session_limit，也不计为候选。
  const scoped: (SessionFile & { readonly head: SessionHead })[] = []
  let unreadable = 0
  for (const file of all) {
    const head = await readSessionHead(file.path)
    if (head === null) { unreadable += 1; continue }
    if (request.scope === 'current-project'
      && (request.projectId === null || projectIdOf(head.cwd) !== request.projectId)) continue
    scoped.push({ ...file, head })
  }
  const page = scoped.slice(request.offset, request.offset + request.sessionLimit)

  const filtered: Record<FilterName, number> = {
    confirm: 0, injection: 0, code: 0, image: 0, paths: 0, logs: 0, symbols: 0, used: 0, too_long: 0, short: 0
  }
  const samples: JsonObject[] = []
  const seen = new Set<string>()
  let userMessages = 0
  let chars = 0
  let sessionsScanned = 0
  let processed = 0
  let duplicateSessions = 0
  let overLimitSessions = 0
  let badLines = 0
  let stoppedBy: 'budget' | 'session_limit' | 'end' = 'end'

  for (const [index, entry] of page.entries()) {
    if (seen.has(entry.head.id)) { duplicateSessions += 1; continue }
    const text = await readSessionText(entry.path)
    if (text === null) { overLimitSessions += 1; continue }
    seen.add(entry.head.id)
    sessionsScanned += 1
    processed += 1
    let kept = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const record = asObject(parseJson(line))
      if (record === null) { badLines += 1; continue }
      if (record.type !== 'message') continue
      const message = asObject(record.message)
      if (message === null || message.role !== 'user') continue
      const quote = userText(message.content)?.trim()
      if (quote === undefined || quote === '') continue
      userMessages += 1
      const reason = filterReason(quote, request.minChars)
      if (reason !== null) { filtered[reason] += 1; continue }
      // 已收录的句子先剔除：重跑蒸馏不应把上次用过的原句再取一遍，除非显式要求保留。
      if (!request.includeUsed && request.usedKeys.has(sampleKey(entry.head.id, quote))) {
        filtered.used += 1
        continue
      }
      // 单会话样本达上限即止：一个长会话不应占满整批样本。
      if (kept >= SAMPLES_PER_SESSION) break
      // 单条长于整份预算时跳过而不是截断：截断会把别人的半句话当成表达样本。
      // 计入过滤统计，否则不同 max_chars 下的保留数差异无法解释。
      if (quote.length > request.maxChars) { filtered.too_long += 1; continue }
      if (chars + quote.length > request.maxChars) { stoppedBy = 'budget'; break }
      const stamp = typeof record.timestamp === 'string' ? record.timestamp.slice(0, 10) : ''
      const date = /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : entry.head.date || entry.date
      const kind: SampleKind = quote.length >= LONG_SAMPLE_CHARS ? 'long' : 'short'
      samples.push({ quote, session_id: entry.head.id, date, kind })
      chars += quote.length
      kept += 1
    }
    if (stoppedBy === 'budget') break
    // 本批按会话数截断且后面还有范围内会话时，说明只是取到本批上限。
    if (index === page.length - 1 && page.length === request.sessionLimit
      && request.offset + page.length < scoped.length) stoppedBy = 'session_limit'
  }

  // 预算中断时按已处理的会话数前进：否则 next_offset 会跳过本页尚未扫描的会话。
  const nextOffset = stoppedBy === 'budget' ? request.offset + processed : request.offset + page.length
  const more = stoppedBy !== 'end' || nextOffset < scoped.length
  return {
    scope: request.scope,
    project: request.projectId === null ? null : { id: request.projectId,
      name: request.projects.find(project => project.id === request.projectId)?.name ?? null },
    window_days: request.days,
    cutoff,
    session_offset: request.offset,
    session_limit: request.sessionLimit,
    sessions_matched: scoped.length,
    sessions_scanned: sessionsScanned,
    duplicate_sessions: duplicateSessions,
    unreadable_sessions: unreadable + overLimitSessions,
    over_limit_sessions: overLimitSessions,
    bad_lines: badLines,
    max_chars: request.maxChars,
    min_chars: request.minChars,
    include_used: request.includeUsed,
    used_keys: request.usedKeys.size,
    samples_per_session: SAMPLES_PER_SESSION,
    session_file_limit_bytes: SESSION_FILE_MAX_BYTES,
    chars_used: chars,
    long_threshold: LONG_SAMPLE_CHARS,
    samples,
    stats: { user_messages: userMessages, kept: samples.length,
      filtered: Object.fromEntries(FILTER_ORDER.filter(name => filtered[name] > 0)
        .map(name => [name, filtered[name]])) },
    stopped_by: stoppedBy,
    has_more: more,
    next_offset: more ? nextOffset : null,
    note: '只读用户本人发言并已剔除注入段、代码与日志；样本是表达素材，不代表当前适用的决定，也不含会话之外的内容'
  }
}
