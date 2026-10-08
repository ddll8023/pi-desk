/**
 * 当前项目会话文件的唯一读取者：会话目录定位、摘要列表与单条会话的存在性校验。
 *
 * 会话文件由 Pi 管理（`<agent-dir>/sessions/--<cwd munged>--/<时间>_<会话 id>.jsonl`），本模块只按
 * 有界读取拿到首部元数据与首条用户消息开头，不解析消息模型、不写入也不删除任何会话数据；
 * 路径归一化在 project-path.ts，启动与切换编排在 session-manager.ts。
 */
import type { Stats } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SessionList, SessionSummary } from '../shared/session-api'

/** 头部行与预览共用的单次读取上限；不为此扫描完整会话文件。 */
const MAX_HEAD_BYTES = 256 * 1024

/** 会话列表上限；超出只保留最近修改的若干条并计数。 */
const MAX_SESSIONS = 100

/** 预览长度上限；只取首条用户消息的开头。 */
const MAX_PREVIEW_CHARS = 120

/** Pi 的会话 id 只允许字母、数字、点、下划线与短横线。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** 会话目录无法读取；由调用方归为通用内部错误并保留原因文本。 */
export class SessionStorageError extends Error {}

interface CachedSummary {
  readonly size: number
  readonly mtimeMs: number
  /** 无法解析或不属于当前项目的文件缓存为 null，避免每次列表重复读取。 */
  readonly summary: SessionSummary | null
}

interface HeadContent {
  readonly header: Record<string, unknown> | null
  readonly preview: string | null
}

/** 运行期缓存；键是会话文件绝对路径，每轮列表只保留仍然存在的文件。 */
const summaryCache = new Map<string, CachedSummary>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 会话根目录：`--session-dir` 的唯一取值来源。
 * `PI_CODING_AGENT_DIR` 只在是绝对路径时参与解析，相对值交给 Pi 的默认位置。
 */
export function getSessionRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
  const agentDirectory = configured !== undefined && configured !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.pi', 'agent')
  return join(agentDirectory, 'sessions')
}

/** 分组目录名：去掉开头分隔符后把 `/`、`\`、`:` 换成 `-`，与 Pi 的布局一致。 */
function getProjectGroupName(projectPath: string): string {
  return `--${projectPath.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`
}

/** 项目路径比较在 Windows 上折叠大小写；其他平台保持严格比较。 */
function isSamePath(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

function parseJsonRecord(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined || line.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  return isRecord(value) ? value : null
}

function readMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const entry of content) {
    if (isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string') return entry.text
  }
  return null
}

/** 只识别 message 条目里的首条用户消息文本；其他条目一律忽略。 */
function previewFromLine(line: string): string | null {
  if (!line.includes('"user"')) return null
  const entry = parseJsonRecord(line)
  if (entry === null || entry.type !== 'message') return null

  const message = entry.message
  if (!isRecord(message) || message.role !== 'user') return null

  const text = readMessageText(message.content)
  if (text === null) return null
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed.slice(0, MAX_PREVIEW_CHARS)
}

/** 单次有界读取：首行是会话头，其余行里找首条用户消息；截断的末行不可信，直接丢弃。 */
async function readHead(filePath: string): Promise<HeadContent> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_HEAD_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    // 只有读满上限时最后一行才可能被截断，直接丢弃。
    if (bytesRead === MAX_HEAD_BYTES) lines.pop()

    const header = parseJsonRecord(lines.shift())
    let preview: string | null = null
    for (const line of lines) {
      preview = previewFromLine(line)
      if (preview !== null) break
    }
    return { header, preview }
  } finally {
    await handle.close()
  }
}

/** 头部记录决定会话归属：分组目录名会歧义，cwd 不符的文件不属于当前项目。 */
async function readSummary(
  filePath: string,
  projectPath: string,
  info: Stats
): Promise<SessionSummary | null> {
  const { header, preview } = await readHead(filePath)
  if (header === null || header.type !== 'session') return null

  const sessionId = typeof header.id === 'string' ? header.id : null
  const createdAt = typeof header.timestamp === 'string' ? header.timestamp : null
  const cwd = typeof header.cwd === 'string' ? header.cwd : null
  if (sessionId === null || !SESSION_ID_PATTERN.test(sessionId)) return null
  if (createdAt === null || cwd === null) return null
  if (!isSamePath(cwd, projectPath)) return null

  return {
    sessionId,
    createdAt,
    updatedAt: info.mtimeMs,
    sizeBytes: info.size,
    preview
  }
}

/** 读取会话摘要列表；目录不存在按无会话处理，无法读取才是错误。 */
export async function listSessions(projectPath: string): Promise<SessionList> {
  const directory = join(getSessionRoot(), getProjectGroupName(projectPath))

  let names: string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error) {
    if (isMissingPath(error)) return { sessions: [], skipped: 0, truncated: 0 }
    throw new SessionStorageError('无法读取本机会话目录。')
  }

  const nextCache = new Map<string, CachedSummary>()
  const accepted: SessionSummary[] = []
  let skipped = 0

  for (const name of names) {
    const filePath = join(directory, name)
    let info: Stats
    try {
      info = await stat(filePath)
    } catch {
      skipped += 1
      continue
    }
    if (!info.isFile()) {
      skipped += 1
      continue
    }

    const cached = summaryCache.get(filePath)
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      nextCache.set(filePath, cached)
      if (cached.summary === null) skipped += 1
      else accepted.push(cached.summary)
      continue
    }

    let summary: SessionSummary | null = null
    try {
      summary = await readSummary(filePath, projectPath, info)
    } catch {
      // 文件在读取期间被删除或被占用：按无法解析处理。
      summary = null
    }
    nextCache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, summary })
    if (summary === null) skipped += 1
    else accepted.push(summary)
  }

  // 每轮只保留本轮见过的文件，缓存不会随时间无界增长。
  summaryCache.clear()
  for (const [key, value] of nextCache) summaryCache.set(key, value)

  accepted.sort((left, right) => right.updatedAt - left.updatedAt)
  return {
    sessions: accepted.slice(0, MAX_SESSIONS),
    skipped,
    truncated: Math.max(0, accepted.length - MAX_SESSIONS)
  }
}

/**
 * 在当前项目的分组目录内解析会话文件；返回绝对路径，找不到或不属于该项目时返回 null。
 * 结果只在主进程内用于存在性校验，不跨 IPC 交给页面。
 */
export async function resolveSessionFile(
  projectPath: string,
  sessionId: string
): Promise<string | null> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null

  const directory = join(getSessionRoot(), getProjectGroupName(projectPath))
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return null
  }

  const match = names.find((name) => name.endsWith(`_${sessionId}.jsonl`))
  if (match === undefined) return null

  const filePath = join(directory, match)
  try {
    const info = await stat(filePath)
    const summary = await readSummary(filePath, projectPath, info)
    return summary === null ? null : filePath
  } catch {
    return null
  }
}
