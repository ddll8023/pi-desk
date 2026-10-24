/**
 * 项目会话文件的唯一读取者与受控删除者：会话目录定位、摘要列表、单条会话的存在性校验与单个会话文件删除。
 *
 * 会话文件由 Pi 管理（`<agent-dir>/sessions/--<cwd munged>--/<时间>_<会话 id>.jsonl`），本模块只按
 * 有界读取拿到首部元数据与首条用户消息开头，不解析消息模型、也不写入任何会话数据；删除仅限已解析
 * 归属该项目的单个会话文件，不批量清理目录；首条用户消息若是 `/skill:` 展开的技能调用，预览只取技能名
 * 与追加文本，不把技能正文当会话标题；并为 SDK 接管提供只读的目标身份复核（目录归属、头部身份与读取期间
 * 是否变化），该复核不接受越过该项目会话目录的路径引用。
 *
 * 列表按窗口读取：排序需要全目录的修改时间，因此每个文件都要 stat，但只有窗口内的文件才会被读取头部
 * 并校验归属，窗口外的会话既没有摘要也不参与计数；窗口大小由调用方（页面）决定，逐页扩展由页面发起。
 * 读取范围由调用方给出的项目路径决定，不读当前项目；路径归一化在 project-path.ts，
 * 列表、打开、重载与删除编排在 session-manager.ts。
 */
import type { Stats } from 'node:fs'
import { open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { SessionList, SessionSummary } from '../../shared/session-api'
import type { SdkSessionReference } from '../../sdk-host/protocol'
import { parseSkillBlock, stripImageMarkerLines } from '../../shared/user-message-text'
import { getPiAgentDir } from '../shared/pi-paths'

/**
 * 头部行与预览共用的单次读取上限；不为此扫描完整会话文件。
 * 首条用户消息内嵌图片时单行可达数百 KB，上限取不到就会被截断成「未命名会话」。
 */
const MAX_HEAD_BYTES = 1024 * 1024

/** 预览长度上限；只取首条用户消息的开头。 */
const MAX_PREVIEW_CHARS = 120

/** Pi 的会话 id 只允许字母、数字、点、下划线与短横线。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/** 会话目录无法读取；由调用方归为通用内部错误并保留原因文本。 */
export class SessionStorageError extends Error {}

interface CachedSummary {
  /** 项目令牌：分组目录名可能碰撞，缓存必须按项目区分，不能复用其他项目的过滤结果。 */
  readonly projectPath: string
  /** 会话文件绝对路径；每轮按本项目目录清单剪枝时用它判断文件是否仍然存在。 */
  readonly filePath: string
  readonly size: number
  readonly mtimeMs: number
  /** 无法解析或不属于该项目的文件缓存为 null，避免每次列表重复读取。 */
  readonly summary: SessionSummary | null
}

interface HeadContent {
  readonly header: Record<string, unknown> | null
  readonly preview: string | null
}
/**
 * 运行期缓存；键是项目令牌与会话文件绝对路径。每轮按本项目拿到的目录清单剪枝：文件消失即丢弃，
 * 其他项目的条目留给它们自己的读取轮次，多项目展开时不会互相清空。
 */
const summaryCache = new Map<string, CachedSummary>()

/**
 * 列表元数据的并行度：取修改时间必须逐文件 stat，串行时延迟随会话数线性增长，
 * 按批并行把这段系统调用压成常数级等待，同时不给文件系统制造无界并发。
 */
const STAT_CONCURRENCY = 32

/** 缓存键：项目路径与会话文件路径都可能包含任意字符，用 NUL 分隔避免拼接歧义。 */
function summaryCacheKey(projectPath: string, filePath: string): string {
  return `${projectPath}\u0000${filePath}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 会话根目录：各项目分组目录的父目录，也是列会话时的起点。
 * `--session-dir` 的取值见 `getProjectSessionDir()`；agent 目录的解析见 pi-paths.ts。
 */
function getSessionRoot(): string {
  return join(getPiAgentDir(), 'sessions')
}

/**
 * 单个项目的会话目录，也是 Pi 的 `--session-dir` 取值。
 *
 * 不能把会话根目录传给它：Pi 收到 `--session-dir` 时会**平铺扫描该目录**（`SessionManager.findById`
 * 只认这一层的 `.jsonl`），从根目录只能看到各项目的分组子目录，于是按 id 找不到会话、
 * 报 “No project session found” 并用同一个 id 新建空会话，表现为打开历史会话后聊天区空白。
 */
export function getProjectSessionDir(projectPath: string): string {
  return join(getSessionRoot(), getProjectGroupName(projectPath))
}

/** 分组目录名：去掉开头分隔符后把 `/`、`\`、`:` 换成 `-`，与 Pi 的布局一致。 */
function getProjectGroupName(projectPath: string): string {
  return `--${projectPath.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`
}

/** SDK 接管前读取的文件身份；只在应用内部传递，不替代 JSONL 真相。 */
interface SdkSessionFileIdentity {
  readonly sessionFile: string
  readonly sessionId: string
  readonly fileStamp: string
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

/**
 * 预览文本归一化：先按共用判定丢弃 Pi 注入的 `[Image: …]` 标记行，再把剩余空白折叠为单个空格，
 * 去掉首尾空白并按上限截断；切成空串时返回 null，由调用方回退为「未命名会话」。
 */
function normalizePreviewText(text: string): string | null {
  const stripped = stripImageMarkerLines(text)
    .replace(/\s+/g, ' ')
    .trim()
  return stripped === '' ? null : stripped.slice(0, MAX_PREVIEW_CHARS)
}

/**
 * 只识别 message 条目里的首条用户消息文本；其他条目一律忽略。
 * 技能调用消息的正文是被 Pi 展开的机器内容，预览只取用户追加文本，没有追加文本时才用技能名占位。
 */
function previewFromLine(line: string): string | null {
  if (!line.includes('"user"')) return null
  const entry = parseJsonRecord(line)
  if (entry === null || entry.type !== 'message') return null

  const message = entry.message
  if (!isRecord(message) || message.role !== 'user') return null

  const text = readMessageText(message.content)
  if (text === null) return null
  const skill = parseSkillBlock(text)
  if (skill !== null) return normalizePreviewText(skill.userMessage ?? `技能：${skill.name}`)
  return normalizePreviewText(text)
}

/**
 * 末行被读取上限截断时的容错预览：不再依赖 JSON 结构，只从这段前缀里取首个文本片段。
 * 要求用户角色标记出现在文本之前；取不到或转义不完整时返回 null，宁可显示未命名也不猜内容。
 */
function previewFromTruncatedLine(line: string): string | null {
  const roleIndex = line.indexOf('"user"')
  const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line)
  if (roleIndex < 0 || match === null || match.index < roleIndex) return null

  let text: unknown
  try {
    text = JSON.parse(`"${match[1]}"`)
  } catch {
    return null
  }
  if (typeof text !== 'string') return null
  // 技能块被读上限截断时无法完整解析：宁可报未读取到，也不把技能正文当预览。
  if (text.trimStart().startsWith('<skill name="')) return null
  return normalizePreviewText(text)
}

/** 单次有界读取：首行是会话头，其余行里找首条用户消息；截断的末行只做容错解析。 */
async function readHead(filePath: string): Promise<HeadContent> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MAX_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_HEAD_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    // 只有读满上限时最后一行才可能被截断：完整行照常解析，截断的末行留给容错解析。
    const truncatedTail = bytesRead === MAX_HEAD_BYTES ? lines.pop() ?? null : null

    const header = parseJsonRecord(lines.shift())
    let preview: string | null = null
    for (const line of lines) {
      preview = previewFromLine(line)
      if (preview !== null) break
    }
    if (preview === null && truncatedTail !== null) preview = previewFromTruncatedLine(truncatedTail)
    return { header, preview }
  } finally {
    await handle.close()
  }
}

/**
 * 回退（Pi 的 fork）产生的来源会话 id：头部 `parentSession` 是来源会话文件的绝对路径，
 * 这里只取文件名里的会话 id；文件不存在、路径不含合法 id 或与自身相同时返回 null。
 */
function forkedFromSessionId(header: Record<string, unknown>, sessionId: string): string | null {
  const parentSession = header.parentSession
  if (typeof parentSession !== 'string' || parentSession === '') return null
  const name = parentSession.replace(/\\/g, '/').split('/').pop() ?? ''
  // 文件名形如 `<时间>_<会话 id>.jsonl`；不匹配就当作没有来源，不猜内容。
  const match = /^.+_([A-Za-z0-9._-]+)\.jsonl$/.exec(name)
  const parentId = match?.[1] ?? null
  if (parentId === null || !SESSION_ID_PATTERN.test(parentId) || parentId === sessionId) return null
  return parentId
}

/** 头部记录决定会话归属：分组目录名会歧义，cwd 不符的文件不属于该项目。 */
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
    preview,
    forkedFromSessionId: forkedFromSessionId(header, sessionId)
  }
}

/**
 * 读取会话列表窗口：`limit` 是“最近 limit 条”的上界，由调用方按自己的加载进度给出；
 * 上界由 IPC 契约校验（shared/session-api.ts 的 `MAX_SESSION_WINDOW`），这里不再重复限制。
 * 目录不存在按无会话处理，无法读取才是错误。
 * 窗口外的文件只参与排序与 `remaining` 计数，不读取头部：列表成本从“全目录头部读取”降到“窗口内头部读取”，
 * 而逐页扩大窗口时已读过的条目直接命中缓存，不重复读盘。
 */
export async function listSessions(projectPath: string, limit: number): Promise<SessionList> {
  const directory = join(getSessionRoot(), getProjectGroupName(projectPath))

  let names: string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error) {
    if (isMissingPath(error)) return { sessions: [], skipped: 0, remaining: 0, limit, projectPath }
    throw new SessionStorageError('无法读取本机会话目录。')
  }

  // 第一遍只取元数据：排序需要全目录的修改时间，但不读任何文件内容；按批并行取，避免随会话数线性变慢。
  const present = new Set<string>()
  const files: { readonly filePath: string; readonly info: Stats }[] = []
  let skipped = 0
  for (let start = 0; start < names.length; start += STAT_CONCURRENCY) {
    const batch = names.slice(start, start + STAT_CONCURRENCY)
    const rows = await Promise.all(batch.map(async (name) => {
      const filePath = join(directory, name)
      try {
        const info = await stat(filePath)
        return info.isFile() ? { filePath, info } : null
      } catch {
        return null
      }
    }))
    for (const [index, name] of batch.entries()) {
      present.add(join(directory, name))
      const row = rows[index]
      if (row === null || row === undefined) {
        skipped += 1
        continue
      }
      files.push(row)
    }
  }
  files.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)

  // 缓存只按本项目本轮目录清单剪枝：其他项目的条目留给它们自己的读取轮次，多项目展开时不会互相清空。
  const nextCache = new Map<string, CachedSummary>()
  for (const [key, value] of summaryCache) {
    if (!isSamePath(value.projectPath, projectPath) || present.has(value.filePath)) nextCache.set(key, value)
  }

  const accepted: SessionSummary[] = []
  for (const { filePath, info } of files.slice(0, limit)) {
    const cacheKey = summaryCacheKey(projectPath, filePath)
    const cached = nextCache.get(cacheKey)
    if (cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
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
    nextCache.set(cacheKey, { projectPath, filePath, size: info.size, mtimeMs: info.mtimeMs, summary })
    if (summary === null) skipped += 1
    else accepted.push(summary)
  }

  summaryCache.clear()
  for (const [key, value] of nextCache) summaryCache.set(key, value)

  // 窗口已经按修改时间降序排好（`updatedAt` 就是文件 mtime），不再二次排序。
  return {
    sessions: accepted,
    skipped,
    remaining: Math.max(0, files.length - limit),
    limit,
    projectPath
  }
}

/**
 * SDK 目标授权：只读复核规范目录、文件、头部身份及读取期间是否变化。
 * 路径引用不能越过该项目会话目录；不使用持久化 SessionManager 做预检。
 */
export async function resolveSdkSessionFile(
  projectPath: string,
  reference: Exclude<SdkSessionReference, { readonly kind: 'new' }>
): Promise<SdkSessionFileIdentity> {
  try {
    const requested = reference.kind === 'id'
      ? await resolveSessionFile(projectPath, reference.sessionId) : reference.sessionFile
    if (requested === null || !isAbsolute(requested)) throw new SessionStorageError('该项目下找不到目标会话。')
    const [directory, filePath] = await Promise.all([
      realpath(getProjectSessionDir(projectPath)), realpath(requested)
    ])
    if (!isSamePath(dirname(filePath), directory)) {
      throw new SessionStorageError('目标会话不属于该项目的会话目录。')
    }
    const before = await stat(filePath, { bigint: true })
    if (!before.isFile() || !filePath.endsWith('.jsonl')) throw new SessionStorageError('目标不是会话文件。')
    const { header } = await readHead(filePath)
    if (header?.type !== 'session' || typeof header.id !== 'string'
      || !SESSION_ID_PATTERN.test(header.id) || typeof header.cwd !== 'string'
      || !isAbsolute(header.cwd)) throw new SessionStorageError('目标会话头部无效。')
    const cwd = await realpath(header.cwd)
    if (!isSamePath(cwd, projectPath)
      || (reference.kind === 'id' && header.id !== reference.sessionId)) {
      throw new SessionStorageError('目标会话身份或项目归属已变化。')
    }
    const after = await stat(filePath, { bigint: true })
    const stamp = (info: typeof before): string =>
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    if (stamp(before) !== stamp(after)) throw new SessionStorageError('目标会话在读取期间发生变化。')
    return { sessionFile: filePath, sessionId: header.id, fileStamp: stamp(after) }
  } catch (error) {
    if (error instanceof SessionStorageError) throw error
    throw new SessionStorageError('目标会话不存在、无法访问或无法安全确认归属。')
  }
}

/**
 * 在该项目的分组目录内解析会话文件；返回绝对路径，找不到或不属于该项目时返回 null。
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

/**
 * 删除已解析归属该项目的单个会话文件；只能由 session-manager 在占用收敛后调用。
 * 会话已在删除前消失时按成功处理，其余失败按无法删除报告；列表缓存每轮自重建，无需失效。
 */
export async function deleteSessionFile(projectPath: string, sessionId: string): Promise<void> {
  const filePath = await resolveSessionFile(projectPath, sessionId)
  if (filePath === null) throw new SessionStorageError('该项目下找不到要删除的会话。')
  try {
    await unlink(filePath)
  } catch (error) {
    if (isMissingPath(error)) return
    throw new SessionStorageError('会话文件无法删除，可能正被其他程序占用。')
  }
}
