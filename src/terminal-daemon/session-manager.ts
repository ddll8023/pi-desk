/** 终端会话与全链路流控：离线持续维护画面和限量历史，页面按独立投递代际恢复，退出会话冷存储。 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import { TERMINAL_DATA_MAX_CHARS, TERMINAL_DIMENSION_MAX, TERMINAL_DIMENSION_MIN, TERMINAL_TITLE_MAX_CHARS } from '../shared/terminal-api'
import type { TerminalDataEvent, TerminalExitEvent, TerminalSessionInfo, TerminalStatus } from '../shared/terminal-api'
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION, TERMINAL_RECOVERY_TIMEOUT_MS, TERMINAL_SNAPSHOT_CHUNK_CHARS
} from '../shared/terminal-daemon-protocol'
import type { TerminalDaemonStatusData, TerminalSnapshotHeader } from '../shared/terminal-daemon-protocol'
import { terminateProcessTree } from '../main/process-tree-termination'
import { HeadlessEmulator } from './headless-emulator'
import type { HistoryStore, PersistedSessionRecord, PersistedScreen } from './history-store'

const FLUSH_INTERVAL_MS = 16
const PER_SESSION_IN_FLIGHT_CHARS = 512 * 1024
const GLOBAL_IN_FLIGHT_CHARS = 8 * 1024 * 1024
const MAX_PENDING_CHARS = 1024 * 1024
const RESUME_PENDING_CHARS = 256 * 1024
const MAX_SESSIONS = 12
const KILL_GRACE_MS = 1500
const EXCLUDED_ENVIRONMENT_KEYS = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

interface SnapshotTransfer {
  readonly header: TerminalSnapshotHeader
  readonly ansi: string
  offset: number
}
interface DaemonSession {
  readonly id: string
  readonly projectPath: string
  pty: IPty | null
  readonly shell: string
  readonly cwd: string
  /** 用户命名的标题；非空时始终优先于程序上报的标题。 */
  userTitle: string | null
  /** 程序通过 OSC 上报的标题；用户命名后被覆盖展示但不丢失，清除命名后可恢复。 */
  reportedTitle: string | null
  /** 新建时的 shell 默认名；最后回退。 */
  readonly defaultTitle: string
  readonly createdAt: number
  readonly restored: boolean
  cols: number
  rows: number
  status: TerminalStatus
  exitCode: number | null
  emulator: HeadlessEmulator | null
  pending: string[]
  pendingChars: number
  outputSeq: number
  sentSeq: number
  ackedSeq: number
  deliveryId: string | null
  ready: boolean
  transfer: SnapshotTransfer | null
  recoveryTimer: NodeJS.Timeout | null
  snapshotWork: Promise<TerminalSnapshotHeader> | null
  snapshotPaused: boolean
  finalizing: Promise<void> | null
  flushTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  paused: boolean
  released: boolean
  exited: boolean
  readonly exitPromise: Promise<void>
  readonly settleExit: () => void
}
export type TerminalCreateOutcome =
  | { readonly ok: true; readonly info: TerminalSessionInfo }
  | { readonly ok: false; readonly reason: 'invalid' | 'limit' | 'spawn' }
export interface TerminalSessionManagerOptions {
  readonly scrollbackLines: number
  readonly history: HistoryStore
  readonly sendData: (event: TerminalDataEvent) => boolean
  readonly sendExit: (event: TerminalExitEvent) => boolean
  readonly onSessionsChanged: () => void
  readonly onError: (error: unknown) => void
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, DaemonSession>()
  private inFlightChars = 0
  private readonly startedAt = Date.now()
  private stopping = false
  constructor(private readonly options: TerminalSessionManagerOptions) {}

  /** 冷恢复只建立轻量记录；历史和模拟器在查看单个终端时才读取。 */
  async restore(): Promise<void> {
    for (const record of await this.options.history.readSessionRecords()) {
      const session = this.newSession(record, null, true)
      session.status = 'exited'
      session.exited = true
      session.settleExit()
      this.sessions.set(session.id, session)
    }
  }

  async create(projectPath: string, cols: number, rows: number): Promise<TerminalCreateOutcome> {
    if (this.stopping || !isDimension(cols) || !isDimension(rows)) return { ok: false, reason: 'invalid' }
    if ([...this.sessions.values()].filter((session) => session.status === 'running' || session.emulator !== null).length >= MAX_SESSIONS) {
      return { ok: false, reason: 'limit' }
    }
    const shell = resolveShell()
    let pty: IPty
    try {
      pty = spawnPty(shell.file, shell.args, {
        name: 'xterm-256color', cols, rows, cwd: projectPath, env: terminalEnvironment(),
        // 随包 ConPTY 透传全屏程序使用的鼠标模式；其他平台不传这个选项。
        ...(process.platform === 'win32' ? { useConptyDll: true } : {})
      })
    } catch (error) { this.options.onError(error); return { ok: false, reason: 'spawn' } }
    const session = this.newSession({
      id: randomUUID(), projectPath, shell: shell.file, cwd: projectPath,
      userTitle: null, title: null, defaultTitle: shellTitle(shell.file), cols, rows, createdAt: Date.now()
    }, pty, false)
    session.emulator = new HeadlessEmulator(cols, rows, this.options.scrollbackLines, this.options.onError,
      () => this.updatePressure(session), (reply) => {
        if (!session.released && session.status === 'running') {
          try { pty.write(reply) } catch (error) { this.options.onError(error) }
        }
      }, (title) => this.onTitle(session, title))
    this.sessions.set(session.id, session)
    pty.onData((chunk) => this.onData(session, chunk))
    pty.onExit((event) => this.onExit(session, event.exitCode))
    this.options.onSessionsChanged()
    return { ok: true, info: toSessionInfo(session) }
  }

  /** 程序上报的标题：只有用户未命名时才影响展示；无值时也排入落盘，重启后不再回退到 shell 名。 */
  private onTitle(session: DaemonSession, title: string): void {
    const trimmed = title.trim()
    if (session.released || trimmed === '' || session.reportedTitle === trimmed) return
    session.reportedTitle = trimmed
    // 用户命名优先，但上报值仍要落盘：清除命名后能回到程序自己的标题。
    this.options.onSessionsChanged()
  }

  /**
   * 给终端命名；空标题清除用户命名。返回值与写入、改尺寸一致：已退出或已关闭的终端不接受命名。
   * 命名随会话元数据落盘，重启应用后仍保留。
   */
  rename(id: string, title: string): boolean {
    const session = this.sessions.get(id)
    if (this.stopping || session === undefined || session.released) return false
    const trimmed = title.trim()
    if (trimmed.length > TERMINAL_TITLE_MAX_CHARS) return false
    const next = trimmed === '' ? null : trimmed
    if (session.userTitle === next) return true
    session.userTitle = next
    this.options.onSessionsChanged()
    return true
  }

  private newSession(record: PersistedSessionRecord, pty: IPty | null, restored: boolean): DaemonSession {
    let settleExit: () => void = () => {}
    const exitPromise = new Promise<void>((resolve) => { settleExit = resolve })
    // 记录里的 `title` 是程序上报值，会话侧存成 `reportedTitle`；直接展开会把两个同义字段都带上。
    const { title, ...rest } = record
    return {
      ...rest, pty, restored, status: 'running', exitCode: null, emulator: null,
      reportedTitle: title,
      pending: [], pendingChars: 0, outputSeq: 0, sentSeq: 0, ackedSeq: 0,
      deliveryId: null, ready: false, transfer: null, recoveryTimer: null, snapshotWork: null,
      snapshotPaused: false, finalizing: null, flushTimer: null, killTimer: null,
      paused: false, released: false, exited: false, exitPromise, settleExit
    }
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (this.stopping || session?.pty === null || session === undefined || session.status !== 'running') return false
    try { session.pty.write(data); return true } catch (error) { this.options.onError(error); return false }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (this.stopping || session === undefined || !isDimension(cols) || !isDimension(rows)) return false
    if (session.cols === cols && session.rows === rows) return true
    // 冷会话保留生成画面时的尺寸，避免把旧序列误解释为新尺寸。
    if (session.status === 'exited') return true
    session.emulator?.resize(cols, rows)
    try { session.pty?.resize(cols, rows) } catch (error) { this.options.onError(error); return false }
    session.cols = cols
    session.rows = rows
    this.options.onSessionsChanged()
    return true
  }

  close(id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined || this.stopping) return
    this.sessions.delete(id)
    this.release(session, true)
    this.options.onSessionsChanged()
  }
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
  list(projectPath: string | null): readonly TerminalSessionInfo[] {
    return [...this.sessions.values()].filter((session) => projectPath === null || session.projectPath === projectPath).map(toSessionInfo)
  }

  acknowledge(id: string, deliveryId: string, seqEnd: number): void {
    const session = this.sessions.get(id)
    if (session === undefined || session.deliveryId !== deliveryId || !Number.isSafeInteger(seqEnd)
      || seqEnd <= session.ackedSeq || seqEnd > session.sentSeq) return
    this.inFlightChars = Math.max(0, this.inFlightChars - (seqEnd - session.ackedSeq))
    session.ackedSeq = seqEnd
    // 额度可能被另一个终端占用；释放后唤醒所有待投递会话，而不是只唤醒回报者。
    for (const current of this.sessions.values()) { this.flush(current); this.updatePressure(current) }
  }

  detach(id: string, deliveryId: string): void {
    const session = this.sessions.get(id)
    if (session?.deliveryId === deliveryId) this.detachSession(session)
  }
  resetDelivery(): void {
    for (const session of this.sessions.values()) this.detachSession(session)
  }
  private detachSession(session: DaemonSession): void {
    this.inFlightChars = Math.max(0, this.inFlightChars - (session.sentSeq - session.ackedSeq))
    session.sentSeq = session.outputSeq
    session.ackedSeq = session.outputSeq
    session.deliveryId = null
    session.ready = false
    session.transfer = null
    session.pending = []
    session.pendingChars = 0
    if (session.flushTimer !== null) clearTimeout(session.flushTimer)
    session.flushTimer = null
    if (session.recoveryTimer !== null) clearTimeout(session.recoveryTimer)
    session.recoveryTimer = null
    this.updatePressure(session)
  }

  /** 暂停 PTY 读取并排空解析，建立精确边界；传完快照仍须等待页面解析完成。 */
  async beginSnapshot(id: string, deliveryId: string): Promise<TerminalSnapshotHeader> {
    const session = this.sessions.get(id)
    if (session === undefined || this.stopping) throw new Error('该终端已关闭。')
    const previous = session.snapshotWork
    this.detachSession(session)
    session.deliveryId = deliveryId
    if (previous !== null) await previous.catch(() => {})
    this.assertDelivery(session, deliveryId)
    const work = this.buildSnapshot(session, deliveryId)
    session.snapshotWork = work
    try { return await work } finally {
      if (session.snapshotWork === work) session.snapshotWork = null
    }
  }

  private async buildSnapshot(session: DaemonSession, deliveryId: string): Promise<TerminalSnapshotHeader> {
    session.snapshotPaused = true
    this.updatePressure(session)
    // 恢复超时也撤销代际；迟到的磁盘/解析结果不会重新挂起新页面。
    session.recoveryTimer = setTimeout(() => {
      if (session.deliveryId === deliveryId) this.detachSession(session)
    }, TERMINAL_RECOVERY_TIMEOUT_MS)
    try {
      await session.finalizing
      let screen: PersistedScreen
      if (session.emulator !== null) {
        screen = { ansi: await session.emulator.serialize(), cols: session.cols, rows: session.rows }
      } else {
        const saved = await this.options.history.readScreen(session.id)
        if (saved !== null) screen = saved
        else {
          const emulator = new HeadlessEmulator(session.cols, session.rows, this.options.scrollbackLines, this.options.onError,
            undefined, undefined, (title) => this.onTitle(session, title))
          try {
            emulator.write(await this.options.history.readRestorable(session.id))
            screen = { ansi: await emulator.serialize(), cols: session.cols, rows: session.rows }
          } finally { emulator.dispose() }
        }
      }
      this.assertDelivery(session, deliveryId)
      session.pending = []
      session.pendingChars = 0
      session.sentSeq = session.outputSeq
      session.ackedSeq = session.outputSeq
      const header: TerminalSnapshotHeader = {
        id: session.id, deliveryId, cols: screen.cols, rows: screen.rows,
        status: session.status, exitCode: session.exitCode, seq: session.outputSeq, totalChars: screen.ansi.length
      }
      session.transfer = { header, ansi: screen.ansi, offset: 0 }
      return header
    } catch (error) {
      if (session.deliveryId === deliveryId) this.detachSession(session)
      throw error
    } finally {
      session.snapshotPaused = false
      this.updatePressure(session)
    }
  }

  readSnapshot(id: string, deliveryId: string, offset: number): { readonly chunk: string; readonly nextOffset: number } {
    const transfer = this.sessions.get(id)?.transfer
    if (transfer === null || transfer === undefined || transfer.header.deliveryId !== deliveryId || offset !== transfer.offset) {
      throw new Error('终端恢复已失效，请重新接回。')
    }
    const chunk = transfer.ansi.slice(offset, offset + TERMINAL_SNAPSHOT_CHUNK_CHARS)
    transfer.offset += chunk.length
    return { chunk, nextOffset: transfer.offset }
  }

  readySnapshot(id: string, deliveryId: string): boolean {
    const session = this.sessions.get(id)
    if (session?.deliveryId !== deliveryId || session.transfer === null
      || session.transfer.offset !== session.transfer.header.totalChars) return false
    session.transfer = null
    session.ready = true
    if (session.recoveryTimer !== null) clearTimeout(session.recoveryTimer)
    session.recoveryTimer = null
    this.flush(session)
    this.updatePressure(session)
    return true
  }

  private assertDelivery(session: DaemonSession, deliveryId: string): void {
    if (session.released || session.deliveryId !== deliveryId || this.stopping) throw new Error('终端恢复已被新的连接替代。')
  }

  /** 历史和解析消费后重新评估水位；即使没有页面，后台命令也有独立消费者。 */
  flushPending(): void {
    for (const session of this.sessions.values()) this.flush(session)
  }
  historyConsumed(id: string): void {
    const session = this.sessions.get(id)
    if (session !== undefined) this.updatePressure(session)
  }
  private updatePressure(session: DaemonSession): void {
    if (session.pty === null || session.released) return
    const backlog = Math.max(session.pendingChars, session.emulator?.pendingChars ?? 0, this.options.history.getPendingChars(session.id))
    const shouldPause = session.snapshotPaused || backlog >= (session.paused ? RESUME_PENDING_CHARS : MAX_PENDING_CHARS)
    if (shouldPause === session.paused) return
    try {
      if (shouldPause) session.pty.pause()
      else session.pty.resume()
      session.paused = shouldPause
    } catch (error) {
      this.options.onError(error)
      // 无法执行流控时终止该进程，不能继续以无界缓冲兜底。
      terminatePty(session, 'SIGKILL')
    }
  }

  private onData(session: DaemonSession, chunk: string): void {
    if (session.released || chunk === '') return
    session.outputSeq += chunk.length
    this.options.history.append(session.id, chunk)
    session.emulator?.write(chunk)
    if (session.deliveryId !== null) {
      session.pending.push(chunk)
      session.pendingChars += chunk.length
      if (session.ready && session.pendingChars <= 4096 && session.sentSeq === session.ackedSeq) this.flush(session)
      else this.scheduleFlush(session)
    }
    this.updatePressure(session)
  }
  private scheduleFlush(session: DaemonSession): void {
    if (session.flushTimer !== null || !session.ready || session.released) return
    session.flushTimer = setTimeout(() => { session.flushTimer = null; this.flush(session) }, FLUSH_INTERVAL_MS)
  }

  /** 只取预算内的队头；不会为发送一个小包反复合并整份积压。 */
  private flush(session: DaemonSession): void {
    if (session.released || !session.ready || session.deliveryId === null || session.pendingChars === 0) return
    let budget = Math.min(TERMINAL_DATA_MAX_CHARS,
      PER_SESSION_IN_FLIGHT_CHARS - (session.sentSeq - session.ackedSeq), GLOBAL_IN_FLIGHT_CHARS - this.inFlightChars)
    if (budget <= 0) return
    const parts: string[] = []
    let count = 0
    while (count < session.pending.length && budget > 0) {
      const chunk = session.pending[count]
      if (chunk === undefined) break
      if (chunk.length <= budget) { parts.push(chunk); budget -= chunk.length; count += 1 }
      else { parts.push(chunk.slice(0, budget)); session.pending[count] = chunk.slice(budget); budget = 0 }
    }
    session.pending.splice(0, count)
    const text = parts.join('')
    if (text === '') return
    session.pendingChars -= text.length
    session.sentSeq += text.length
    this.inFlightChars += text.length
    if (!this.options.sendData({ id: session.id, deliveryId: session.deliveryId, chunk: text, chars: text.length, seqEnd: session.sentSeq })) {
      this.detachSession(session)
      return
    }
    this.updatePressure(session)
    if (session.pendingChars > 0) this.scheduleFlush(session)
  }

  private onExit(session: DaemonSession, exitCode: number): void {
    session.exited = true
    session.pty = null
    session.settleExit()
    if (session.killTimer !== null) clearTimeout(session.killTimer)
    session.killTimer = null
    if (session.released) return
    session.status = 'exited'
    session.exitCode = exitCode
    this.flush(session)
    // 尾部依旧分片并等待 ACK；退出通知只改状态，不绕过输出预算。
    this.options.sendExit({ id: session.id, exitCode })
    session.finalizing = this.storeColdScreen(session)
    this.options.onSessionsChanged()
  }
  private async storeColdScreen(session: DaemonSession): Promise<void> {
    const emulator = session.emulator
    try {
      if (emulator !== null) {
        const ansi = await emulator.serialize()
        if (!session.released) await this.options.history.writeScreen(session.id, { ansi, cols: session.cols, rows: session.rows })
      }
      await this.options.history.seal(session.id)
    } catch (error) { this.options.onError(error) } finally {
      if (session.emulator === emulator) session.emulator = null
      emulator?.dispose()
    }
  }

  /** 会话侧状态；构建标识由编排层补充，不在这里重复获取。 */
  status(): Omit<TerminalDaemonStatusData, 'buildId'> {
    const sessions = [...this.sessions.values()]
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, pid: process.pid, startedAt: this.startedAt,
      sessionCount: sessions.length, runningCount: sessions.filter((session) => session.status === 'running').length,
      restoredCount: sessions.filter((session) => session.restored).length
    }
  }
  /** 仍在运行（持有 PTY）的终端数；只有这部分需要守护进程常驻。 */
  get runningSessionCount(): number {
    return [...this.sessions.values()].filter((session) => session.status === 'running').length
  }
  persistedRecords(): readonly PersistedSessionRecord[] {
    return [...this.sessions.values()].map(({ id, projectPath, shell, cwd, userTitle, reportedTitle, defaultTitle, cols, rows, createdAt }) => ({
      id, projectPath, shell, cwd, userTitle, title: reportedTitle, defaultTitle, cols, rows, createdAt
    }))
  }

  /** 停止保留历史；显式关标签才走删除路径。 */
  async shutdown(): Promise<void> {
    this.stopping = true
    const sessions = [...this.sessions.values()]
    this.resetDelivery()
    for (const session of sessions) {
      if (!session.exited) terminatePty(session, 'SIGTERM')
    }
    await waitForExits(sessions, 400)
    for (const session of sessions) if (!session.exited) terminatePty(session, 'SIGKILL')
    await waitForExits(sessions, 300)
    // 对仍未派发退出事件的终端也保存已有画面；不删除历史与会话元数据。
    for (const session of sessions) {
      session.snapshotPaused = true
      this.updatePressure(session)
      await session.snapshotWork?.catch(() => {})
      await (session.finalizing ?? this.storeColdScreen(session))
      this.release(session, false)
    }
    this.sessions.clear()
  }

  private release(session: DaemonSession, removeHistory: boolean): void {
    this.detachSession(session)
    session.released = true
    if (session.killTimer !== null) clearTimeout(session.killTimer)
    session.killTimer = null
    session.emulator?.dispose()
    session.emulator = null
    if (removeHistory) this.options.history.remove(session.id)
    if (session.exited || session.pty === null) return
    terminatePty(session, 'SIGTERM')
    session.killTimer = setTimeout(() => {
      session.killTimer = null
      if (!session.exited) terminatePty(session, 'SIGKILL')
    }, KILL_GRACE_MS)
  }
}

function toSessionInfo(session: DaemonSession): TerminalSessionInfo {
  return { id: session.id, projectPath: session.projectPath, title: displayTitleOf(session), shell: session.shell,
    cwd: session.cwd, cols: session.cols, rows: session.rows, status: session.status, exitCode: session.exitCode }
}
/** 展示标题：用户命名优先，其次是程序上报，最后是 shell 默认名。 */
function displayTitleOf(session: DaemonSession): string {
  return session.userTitle ?? session.reportedTitle ?? session.defaultTitle
}
function isDimension(value: number): boolean {
  return Number.isInteger(value) && value >= TERMINAL_DIMENSION_MIN && value <= TERMINAL_DIMENSION_MAX
}
function terminatePty(session: DaemonSession, signal: NodeJS.Signals): void {
  if (session.pty === null || session.exited) return
  const pty = session.pty
  terminateProcessTree({ pid: pty.pid, kill: (killSignal?: string) => pty.kill(killSignal) } as unknown as ChildProcess, signal)
}
async function waitForExits(sessions: readonly DaemonSession[], ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.all(sessions.filter((session) => !session.exited).map((session) => session.exitPromise)),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
interface ShellChoice { readonly file: string; readonly args: string[] }
function resolveShell(): ShellChoice {
  if (process.platform === 'win32') {
    for (const candidate of ['pwsh', 'powershell', 'cmd']) {
      const resolved = findExecutableOnPath(candidate)
      if (resolved !== null) return { file: resolved, args: [] }
    }
    return { file: 'cmd.exe', args: [] }
  }
  const shell = process.env.SHELL?.trim()
  return { file: shell || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] }
}
function findExecutableOnPath(base: string): string | null {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const directory of entries) for (const extension of extensions) {
    const candidate = join(directory, base + extension)
    if (existsSync(candidate)) return candidate
  }
  return null
}
function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !EXCLUDED_ENVIRONMENT_KEYS.includes(key)) env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}
function shellTitle(file: string): string {
  const name = basename(file)
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}
