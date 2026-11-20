/**
 * 成员会话的登记与只读读取。
 *
 * 成员会话是「不占标签、不进会话列表」的会话：它的会话文件放在
 * `<agentDir>/team-sessions/<根会话 id>/`，与项目会话目录并列但不在其中，
 * 因此列表、按项目定位会话与删除链都不需要新增过滤。该目录是一层平铺目录，
 * 符合 Pi 对 `--session-dir` 只扫描本层 `.jsonl` 的要求。
 * 登记只存标识；会话是否存在、是否有内容由每次读取时的文件状态决定。
 * 派活由 SDK 宿主的团队工具起子进程，账本随根会话记录；本文件不启动进程、不写会话文件。
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import type { TeamSessionBinding } from '../config/desktop-config-store'
import type { TeamSessionContent, TeamSessionHistory, TeamSessionMessage, TeamSessionView } from '../../shared/team-session-api'
import {
  MAX_TEAM_SESSION_MESSAGE_CHARS,
  MAX_TEAM_SESSION_PREVIEW
} from '../../shared/team-session-api'
import { getPiAgentDir } from '../shared/pi-paths'
import { teamMemberSessionId, teamSessionDirectory as sharedTeamSessionDirectory } from '../../shared/team-session-path'
import { getSessionRoot, readSessionHead } from './session-store'

/** 登记读写口；实现由 `src/main/services.ts` 接到 `DesktopConfigStore`。 */
export interface TeamSessionBindings {
  readonly list: (projectPath: string, rootSessionId: string) => Promise<readonly TeamSessionBinding[]>
  readonly save: (entries: readonly TeamSessionBinding[]) => Promise<void>
  readonly forget: (projectPath: string, rootSessionId: string) => Promise<void>
}

/** 成员会话目录：与 SDK 宿主的派活共用同一份拼法，两侧不一致就找不到文件。 */
export function teamSessionDirectory(rootSessionId: string, agentDir: string = getPiAgentDir()): string {
  return sharedTeamSessionDirectory(rootSessionId, agentDir)
}

/**
 * 按会话 id 找文件：Pi 的会话文件名是 `<时间>_<会话 id>.jsonl`，无法由 id 直接算出，
 * 只能在本层目录里按后缀匹配。目录最多几十个文件，不做缓存，避免派活后看不到新文件。
 */
async function findSessionFile(directory: string, sessionId: string): Promise<string | null> {
  const suffix = `_${sessionId}.jsonl`
  try {
    const names = await readdir(directory)
    const name = names.find(item => item.endsWith(suffix))
    return name === undefined ? null : join(directory, name)
  } catch {
    // 目录还不存在：成员尚未派活，按没有文件处理。
    return null
  }
}

/** 物化成员登记：开团时按团队定义的成员生成，已存在的登记由存储层保留其会话 id。 */
export async function materializeTeamSessions(input: {
  readonly bindings: TeamSessionBindings
  readonly projectPath: string
  readonly rootSessionId: string
  readonly teamId: string
  readonly memberExpertIds: readonly string[]
  /** 注入当前时间，测试与批内多条登记共用同一个创建时间。 */
  readonly now?: Date
}): Promise<void> {
  if (input.memberExpertIds.length === 0) return
  const createdAt = (input.now ?? new Date()).toISOString()
  await input.bindings.save(input.memberExpertIds.map(memberExpertId => ({
    projectPath: input.projectPath,
    rootSessionId: input.rootSessionId,
    teamId: input.teamId,
    memberExpertId,
    sessionId: null,
    createdAt
  })))
}

/**
 * 列出某个根会话的成员登记。
 * 状态判定只看文件：文件不在且登记从未写回会话 id 是「尚未派活」，登记有 id 但文件不见是「缺失」——
 * 后两者对用户意味不同，不能合并成一种空。
 */
export async function listTeamSessions(input: {
  readonly bindings: TeamSessionBindings
  readonly projectPath: string
  readonly rootSessionId: string
}): Promise<TeamSessionView[]> {
  const entries = await input.bindings.list(input.projectPath, input.rootSessionId)
  const directory = teamSessionDirectory(input.rootSessionId)
  const views: TeamSessionView[] = []
  for (const entry of entries) {
    // 会话 id 由根会话与成员确定性推出：未登记的旧条目也按同一 id 找文件，不把已派活误报成未派活。
    const sessionId = entry.sessionId ?? teamMemberSessionId(input.rootSessionId, entry.memberExpertId)
    const file = await findSessionFile(directory, sessionId)
    views.push({
      id: entry.memberExpertId,
      teamId: entry.teamId,
      memberExpertId: entry.memberExpertId,
      sessionId,
      createdAt: entry.createdAt,
      state: file === null ? (entry.sessionId === null ? 'idle' : 'missing') : 'active'
    })
  }
  return views
}

/** 从文件尾部倒读的块大小：只为凑够最近几条消息，不把整个会话文件读进内存。 */
const TAIL_CHUNK_BYTES = 65_536

/** 会话消息行：只认 `type === 'message'` 且角色为 user/assistant 的条目。 */
function messageFromLine(line: string): TeamSessionMessage | null {
  if (!line.includes('"message"')) return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (entry.type !== 'message') return null
  const message = entry.message
  if (typeof message !== 'object' || message === null) return null
  const record = message as Record<string, unknown>
  if (record.role !== 'user' && record.role !== 'assistant') return null
  const text = readContentText(record.content)
  if (text === null) return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  return {
    role: record.role,
    text: trimmed.length > MAX_TEAM_SESSION_MESSAGE_CHARS
      ? trimmed.slice(0, MAX_TEAM_SESSION_MESSAGE_CHARS)
      : trimmed
  }
}

/** 消息正文：字符串或内容块中的首个 text 块；其他形态（图片、工具结果）不进历史。 */
function readContentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const entry of content) {
    if (typeof entry !== 'object' || entry === null) continue
    const block = entry as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return null
}

/**
 * 从文件尾部按块倒读，凑够 `limit` 个消息条目就停。
 * 返回的文本行按原文件顺序排列，因此解析后直接是时间正序。
 */
async function readTailMessages(filePath: string, limit: number): Promise<{ messages: TeamSessionMessage[]; truncated: boolean }> {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    let position = info.size
    let carry = ''
    const lines: string[] = []
    while (position > 0 && lines.length <= limit) {
      const size = Math.min(TAIL_CHUNK_BYTES, position)
      position -= size
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, position)
      const text = buffer.subarray(0, bytesRead).toString('utf8') + carry
      const parts = text.split('\n')
      // 首块可能是从行中间切开的，留给下一次往前拼。
      carry = position > 0 ? parts.shift() ?? '' : ''
      // 末尾的最后一个元素是空串（文件以换行结尾）；统一从后面取行，保证顺序。
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const line = (parts[index] ?? '').trim()
        if (line === '') continue
        lines.push(line)
        if (lines.length > limit) return { messages: toMessages(lines.slice(0, limit).reverse()), truncated: true }
      }
    }
    if (position > 0) return { messages: toMessages(lines.slice(0, limit).reverse()), truncated: true }
    return { messages: toMessages(lines.reverse()), truncated: false }
  } finally {
    await handle.close()
  }
}

function toMessages(lines: readonly string[]): TeamSessionMessage[] {
  const messages: TeamSessionMessage[] = []
  for (const line of lines) {
    const message = messageFromLine(line)
    if (message !== null) messages.push(message)
  }
  return messages
}

/** 截断预览：列表里只有一行摘要，超长文本直接截断而不换行。 */
function clipPreview(preview: string | null): string | null {
  if (preview === null) return null
  const text = preview.trim()
  if (text === '') return null
  return text.length > MAX_TEAM_SESSION_PREVIEW ? text.slice(0, MAX_TEAM_SESSION_PREVIEW) : text
}

/**
 * 读取单个成员会话的头部与预览。
 * 登记不存在时返回 null；`cwd` 与项目不一致时同样按不存在处理，
 * 避免根会话被复制到别的项目后读到不相关的会话文件。
 */
export async function readTeamSession(input: {
  readonly bindings: TeamSessionBindings
  readonly projectPath: string
  readonly rootSessionId: string
  readonly teamSessionId: string
}): Promise<TeamSessionContent | null> {
  const entries = await input.bindings.list(input.projectPath, input.rootSessionId)
  const entry = entries.find(item => item.memberExpertId === input.teamSessionId)
  if (entry === undefined) return null
  const sessionId = entry.sessionId ?? teamMemberSessionId(input.rootSessionId, entry.memberExpertId)
  const empty: TeamSessionContent = { id: entry.memberExpertId, sessionId, preview: null, updatedAt: null }
  const file = await findSessionFile(teamSessionDirectory(input.rootSessionId), sessionId)
  if (file === null) return empty
  try {
    const info = await stat(file)
    const head = await readSessionHead(file)
    if (head === null || head.sessionId !== sessionId) return empty
    if (head.cwd !== null && head.cwd !== input.projectPath) return empty
    return {
      id: entry.memberExpertId,
      sessionId,
      preview: clipPreview(head.preview),
      updatedAt: info.mtimeMs
    }
  } catch {
    // 读不到按没有内容处理：只读查看不应因为一次读取失败把整份清单带崩。
    return empty
  }
}

/**
 * 读取成员会话最近若干条消息。
 * 与头部读取同一套定位与归属校验：登记不存在、文件缺失或项目不一致都返回 null，
 * 由调用方区分「没有登记」与「还没有内容」。
 */
export async function readTeamSessionHistory(input: {
  readonly bindings: TeamSessionBindings
  readonly projectPath: string
  readonly rootSessionId: string
  readonly teamSessionId: string
  readonly limit: number
}): Promise<TeamSessionHistory | null> {
  const entries = await input.bindings.list(input.projectPath, input.rootSessionId)
  const entry = entries.find(item => item.memberExpertId === input.teamSessionId)
  if (entry === undefined) return null
  const sessionId = entry.sessionId ?? teamMemberSessionId(input.rootSessionId, entry.memberExpertId)
  const file = await findSessionFile(teamSessionDirectory(input.rootSessionId), sessionId)
  if (file === null) return null
  const head = await readSessionHead(file)
  if (head === null || head.sessionId !== sessionId) return null
  if (head.cwd !== null && head.cwd !== input.projectPath) return null
  const { messages, truncated } = await readTailMessages(file, input.limit)
  return { id: entry.memberExpertId, sessionId, messages, truncated }
}

/**
 * 根会话是否还在：按整个会话根扫描，不按项目清单逐个查。
 * 项目被暂时从清单里移除时，它的会话文件仍在磁盘上，该团队的成员目录不能因此当成孤儿清掉。
 */
async function sessionExistsAnywhere(rootSessionId: string): Promise<boolean> {
  const suffix = `_${rootSessionId}.jsonl`
  const root = getSessionRoot()
  let groups: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    groups = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    // 会话根不存在：没有任何根会话，成员目录全部属于孤儿。
    return false
  }
  for (const group of groups) {
    try {
      const names = await readdir(join(root, group))
      if (names.some(name => name.endsWith(suffix))) return true
    } catch {
      // 单个分组读不到不影响判定，继续看下一组。
    }
  }
  return false
}

/**
 * 清理孤儿成员会话：根会话文件在会话根里任何分组目录都找不到时，
 * 这些成员会话已经无法从界面进入，连同登记与团队绑定一起清掉。
 * 判据只有一条——根会话还在不在；不按时间过期（时间判据会删掉用户仍想回看的记录）。
 */
export async function pruneOrphanTeamSessions(input: {
  /** 按根会话全量清登记：不依赖项目清单，项目被移除后旧登记也能清掉。 */
  readonly forgetSessions: (rootSessionId: string) => Promise<void>
  /** 按会话 id 全量清团队绑定，同上。 */
  readonly forgetTeam: (rootSessionId: string) => Promise<void>
}): Promise<{ readonly removed: number; readonly failed: number }> {
  const root = join(getPiAgentDir(), 'team-sessions')
  let roots: string[] = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    roots = entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    // 目录不存在：从未开过团，无需清理。
    return { removed: 0, failed: 0 }
  }
  if (roots.length === 0) return { removed: 0, failed: 0 }

  let removed = 0
  let failed = 0
  for (const rootSessionId of roots) {
    if (await sessionExistsAnywhere(rootSessionId)) continue
    try {
      await removeTeamSessionDirectory(rootSessionId)
      // 登记与绑定都按 id 全量清：它们按项目存，但孤儿判定不依赖项目清单。
      await input.forgetSessions(rootSessionId)
      await input.forgetTeam(rootSessionId)
      removed += 1
    } catch {
      failed += 1
    }
  }
  return { removed, failed }
}

/**
 * 移走根会话的成员目录：与项目内删除同语义，交给系统废纸篓而不是直接删文件。
 * 目录不存在时静默返回，删除会话不应因为这里没有内容而失败。
 */
export async function removeTeamSessionDirectory(rootSessionId: string): Promise<void> {
  const directory = teamSessionDirectory(rootSessionId)
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return
  } catch {
    return
  }
  try {
    await shell.trashItem(directory)
  } catch {
    // 废纸篓不可用（部分 Linux 环境）时按失败处理但不阻断删除：会话本身已删，登记已清。
  }
}
