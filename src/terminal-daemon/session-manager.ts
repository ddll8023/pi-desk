/**
 * 守护进程侧的终端会话管理：每个终端标签对应一个伪终端进程，进程、缓冲、画面状态与历史都在这里。
 *
 * 输出不逐块直发客户端：先按块缓冲，再按「缓冲够大或定时到点」合并下发，减少帧数与解析开销；客户端
 * 确认（ACK）后才释放背压额度，单个终端与全部终端各有在途上限，因此一个刷屏的终端不会挤掉其他终端的回显。
 * 待下发缓冲超过上限时用 PTY 自身的流控暂停读取，避免长时间没人消费时内存无界增长。
 *
 * 与页面断开不影响会话：没有客户端时输出只进缓冲、画面与历史照常更新，等客户端接回时用快照补齐。
 * 取快照时先冻结该终端的新输出（暂存不写入模拟器），排空已有写入后序列化，再清空待下发缓冲并放行冻结的
 * 输出——这样快照与随后的实时数据既不重复也不丢段。
 *
 * 边界：只按调用方给出的项目路径创建终端，shell 由本机探测决定；关闭、全部关闭与守护进程退出都经
 * `terminateProcessTree` 收敛进程树。已退出的终端记录保留到显式关闭，以便标签如实展示退出码；
 * 由历史恢复的终端没有进程，只能查看与关闭。
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import {
  TERMINAL_DATA_MAX_CHARS,
  TERMINAL_DIMENSION_MAX,
  TERMINAL_DIMENSION_MIN
} from '../shared/terminal-api'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalSessionSnapshot,
  TerminalStatus
} from '../shared/terminal-api'
import { TERMINAL_DAEMON_PROTOCOL_VERSION } from '../shared/terminal-daemon-protocol'
import type { TerminalDaemonStatusData } from '../shared/terminal-daemon-protocol'
import { terminateProcessTree } from '../main/process-tree-termination'
import { HeadlessEmulator } from './headless-emulator'
import type { HistoryStore, PersistedSessionRecord } from './history-store'

/** 合并窗口：批量输出按这个节奏合并下发，兼顾吞吐与延迟。 */
const FLUSH_INTERVAL_MS = 16

/** 不超过这个字符数的缓冲直接下发，让按键回显走低延迟路径。 */
const IMMEDIATE_FLUSH_CHARS = 4096

/** 单个终端允许的在途字符数；超过后暂停下发，等客户端确认。 */
const PER_SESSION_IN_FLIGHT_CHARS = 512 * 1024

/** 全部终端合计允许的在途字符数；单个刷屏终端不会占满全部额度。 */
const GLOBAL_IN_FLIGHT_CHARS = 8 * 1024 * 1024

/** 待下发缓冲上限；超过后用 PTY 流控暂停读取。 */
const MAX_PENDING_CHARS = 4 * 1024 * 1024

/** 确认后待下发量降到这个值以下时重新读取。 */
const RESUME_PENDING_CHARS = 1024 * 1024

/** 同时运行的终端数上限；只拒绝明显过量的请求，不代替系统资源限制。 */
const MAX_SESSIONS = 12

/** 终止进程树后的收尾等待：仍未退出时补一次强杀，避免残留 shell 及其子进程。 */
const KILL_GRACE_MS = 1500

/** 守护进程退出时的收敛等待：给 shell 一点退出时间，等它的退出回调回到主线程。 */
const SHUTDOWN_WAIT_MS = 400

/** 强制收敛后的确认等待：SIGKILL 生效很快，预算内仍不确认就放弃，不把退出链拖住。 */
const SHUTDOWN_KILL_WAIT_MS = 300

/** 交互式 shell 不需要的应用内部变量：把 Electron 的运行开关与 Node 参数留在守护进程之外。 */
const EXCLUDED_ENVIRONMENT_KEYS: readonly string[] = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

/** 本机默认 shell 及其启动参数。 */
interface ShellChoice {
  readonly file: string
  readonly args: string[]
}

/** 单个终端会话的全部可变状态。 */
interface DaemonSession {
  readonly id: string
  readonly projectPath: string
  /** 由历史恢复的终端没有进程；只能查看与关闭。 */
  readonly pty: IPty | null
  readonly shell: string
  readonly cwd: string
  readonly title: string
  readonly createdAt: number
  readonly restored: boolean
  cols: number
  rows: number
  status: TerminalStatus
  exitCode: number | null
  /** 画面与滚动历史的复刻；由历史恢复的终端也有，用于接回时出快照。 */
  emulator: HeadlessEmulator | null
  /** 待下发缓冲；按块保存，下发时合并，避免频繁的小消息。 */
  pending: string[]
  pendingChars: number
  /** 已下发但客户端尚未确认的字符数。 */
  inFlightChars: number
  /** 累计已下发的字符数；快照用它标记覆盖边界。 */
  emittedChars: number
  flushTimer: NodeJS.Timeout | null
  /** 收尾强杀定时器；正常退出时清掉，不留悬空定时器。 */
  killTimer: NodeJS.Timeout | null
  /** 因背压暂停了 PTY 读取。 */
  paused: boolean
  /** 已从会话表移除：不再下发、不再改状态，只等进程收尾。 */
  released: boolean
  /** PTY 进程已确认退出；退出链靠它判断能否安全结束。 */
  exited: boolean
  /** 取快照期间冻结的新输出；非 null 表示冻结中，内容先暂存不进模拟器也不下发。 */
  frozen: string[] | null
  /** 退出确认兑现时完成；与 `released` 无关，只表达进程真的没了。 */
  readonly exitPromise: Promise<void>
  /** 兑现 `exitPromise`：退出事件到达时调用，重复调用无副作用。 */
  readonly settleExit: () => void
}

/** 新建终端的结果：失败时区分「达到上限」与「启动失败」，两者在页面上的提示不同。 */
export type TerminalCreateOutcome =
  | { readonly ok: true; readonly info: TerminalSessionInfo }
  | { readonly ok: false; readonly reason: 'invalid' | 'limit' | 'spawn' }

export interface TerminalSessionManagerOptions {
  /** 回滚缓冲行数；决定快照能还原多少历史。 */
  readonly scrollbackLines: number
  readonly history: HistoryStore
  /** 下发终端输出；返回 false 表示当前没有客户端接收，此时不下发也不计在途。 */
  readonly sendData: (event: TerminalDataEvent) => boolean
  /** 下发终端退出；同样只发给已连接的客户端。 */
  readonly sendExit: (event: TerminalExitEvent) => boolean
  /** 会话清单变化（新建、退出、关闭、改尺寸）后通知调用方落盘元数据。 */
  readonly onSessionsChanged: () => void
  /** 记录非致命错误；不中断会话。 */
  readonly onError: (error: unknown) => void
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, DaemonSession>()

  /** 全部终端合计的在途字符数；客户端确认后递减。 */
  private inFlightChars = 0

  private readonly startedAt = Date.now()

  constructor(private readonly options: TerminalSessionManagerOptions) {}

  /**
   * 从落盘的元数据与历史恢复终端：进程已经不在，恢复成「已结束但保留历史」的会话。
   * 历史为空的记录直接丢弃，避免重启后留下一批空白标签。
   */
  async restore(): Promise<void> {
    const records = await this.options.history.readSessionRecords()
    if (records.length === 0) return
    for (const record of records) {
      const content = await this.options.history.readRestorable(record.id)
      if (content === '') continue
      const emulator = new HeadlessEmulator(
        clampDimension(record.cols),
        clampDimension(record.rows),
        this.options.scrollbackLines,
        this.options.onError
      )
      emulator.write(content)
      let settleExit: () => void = () => {}
      const exitPromise = new Promise<void>((resolveExit) => {
        settleExit = resolveExit
      })
      settleExit()
      const session: DaemonSession = {
        id: record.id,
        projectPath: record.projectPath,
        pty: null,
        shell: record.shell,
        cwd: record.cwd,
        title: record.title,
        createdAt: record.createdAt,
        restored: true,
        cols: clampDimension(record.cols),
        rows: clampDimension(record.rows),
        status: 'exited',
        exitCode: null,
        emulator,
        pending: [],
        pendingChars: 0,
        inFlightChars: 0,
        emittedChars: 0,
        flushTimer: null,
        killTimer: null,
        paused: false,
        released: false,
        exited: true,
        frozen: null,
        exitPromise,
        settleExit
      }
      this.sessions.set(session.id, session)
    }
    this.options.onSessionsChanged()
  }

  /** 新建终端；非法尺寸与超量请求都回可展示的原因。 */
  async create(projectPath: string, cols: number, rows: number): Promise<TerminalCreateOutcome> {
    if (!isDimension(cols) || !isDimension(rows)) return { ok: false, reason: 'invalid' }
    if (this.runningCount() >= MAX_SESSIONS) return { ok: false, reason: 'limit' }

    const shell = resolveShell()
    let pty: IPty
    try {
      pty = spawnPty(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: projectPath,
        env: terminalEnvironment(),
        // Windows 用 node-pty 随包的 conpty.dll（Windows Terminal 的实现）：系统 ConPTY 会吞掉应用请求
        // 鼠标上报的 DECSET 1000/1002/1003/1006，xterm 因此不会上报鼠标，全屏 TUI（opencode、vim）的
        // 点击与滚轮全部失效。包内实现会透传鼠标模式与 SGR 鼠标输入；其他平台没有这个选项。
        ...(process.platform === 'win32' ? { useConptyDll: true } : {})
      })
    } catch (error) {
      this.options.onError(error)
      return { ok: false, reason: 'spawn' }
    }

    let settleExit: () => void = () => {}
    const exitPromise = new Promise<void>((resolveExit) => {
      settleExit = resolveExit
    })
    const emulator = new HeadlessEmulator(cols, rows, this.options.scrollbackLines, this.options.onError)
    const session: DaemonSession = {
      id: randomUUID(),
      projectPath,
      pty,
      shell: shell.file,
      cwd: projectPath,
      title: shellTitle(shell.file),
      createdAt: Date.now(),
      restored: false,
      cols,
      rows,
      status: 'running',
      exitCode: null,
      emulator,
      pending: [],
      pendingChars: 0,
      inFlightChars: 0,
      emittedChars: 0,
      flushTimer: null,
      killTimer: null,
      paused: false,
      released: false,
      exited: false,
      frozen: null,
      exitPromise,
      settleExit
    }
    this.sessions.set(session.id, session)
    pty.onData((chunk) => this.onData(session, chunk))
    pty.onExit((event) => this.onExit(session, event.exitCode))
    this.options.onSessionsChanged()
    return { ok: true, info: toSessionInfo(session) }
  }

  /** 把客户端输入写入终端；已退出或由历史恢复的终端不再接受输入。 */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (session === undefined || session.pty === null || session.status !== 'running') return false
    try {
      session.pty.write(data)
      return true
    } catch (error) {
      this.options.onError(error)
      return false
    }
  }

  /** 同步终端尺寸；已退出的终端只更新记录，不再转给 PTY。 */
  resize(id: string, cols: number, rows: number): boolean {
    if (!isDimension(cols) || !isDimension(rows)) return false
    const session = this.sessions.get(id)
    if (session === undefined) return false
    session.cols = cols
    session.rows = rows
    session.emulator?.resize(cols, rows)
    if (session.pty !== null && session.status === 'running') {
      try {
        session.pty.resize(cols, rows)
      } catch (error) {
        this.options.onError(error)
        return false
      }
    }
    this.options.onSessionsChanged()
    return true
  }

  /** 关闭终端并收敛其进程树；关闭不存在的终端按已关闭处理，重复调用是安全的。 */
  close(id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined) return
    this.sessions.delete(id)
    this.release(session)
    this.options.onSessionsChanged()
  }

  /** 关闭全部终端；用于用户显式清理常驻会话。 */
  closeAll(): void {
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.id)
      this.release(session)
    }
    this.options.onSessionsChanged()
  }

  /** 读取终端清单；`projectPath` 为 null 时列全部。 */
  list(projectPath: string | null): readonly TerminalSessionInfo[] {
    const result: TerminalSessionInfo[] = []
    for (const session of this.sessions.values()) {
      if (projectPath !== null && session.projectPath !== projectPath) continue
      result.push(toSessionInfo(session))
    }
    return result
  }

  /** 释放客户端已消费的背压额度；未知终端与非法数量一律忽略。 */
  acknowledge(id: string, chars: number): void {
    const session = this.sessions.get(id)
    if (session === undefined || session.released) return
    // 只释放确实下发过的额度：客户端回报超出部分不计入，避免一个错误回报把全局额度清空。
    const consumed = Math.min(chars, session.inFlightChars)
    session.inFlightChars -= consumed
    this.inFlightChars = Math.max(0, this.inFlightChars - consumed)
    if (session.paused && session.pendingChars <= RESUME_PENDING_CHARS) resumeReading(session)
    this.flush(session)
  }

  /** 客户端重新挂载后调用：上一份页面未确认的在途额度不再有人回报，清掉它避免终端被永久背压。 */
  resetDelivery(): void {
    this.inFlightChars = 0
    for (const session of this.sessions.values()) {
      session.inFlightChars = 0
      if (session.paused) resumeReading(session)
    }
  }

  /**
   * 取全部终端的画面快照。冻结 → 排空 → 序列化 → 清空待下发 → 放行冻结输出：
   * 快照覆盖到 `seq` 为止的全部内容，待下发缓冲因此可以直接丢弃；冻结期间的新输出在快照之后才下发。
   */
  async snapshots(): Promise<readonly TerminalSessionSnapshot[]> {
    const sessions = [...this.sessions.values()]
    for (const session of sessions) session.frozen = []
    const snapshots: TerminalSessionSnapshot[] = []
    for (const session of sessions) {
      const ansi = session.emulator === null ? '' : await session.emulator.serialize()
      snapshots.push({
        id: session.id,
        ansi,
        cols: session.cols,
        rows: session.rows,
        status: session.status,
        exitCode: session.exitCode,
        seq: session.emittedChars
      })
      session.pending = []
      session.pendingChars = 0
      if (session.paused) resumeReading(session)
    }
    for (const session of sessions) {
      const buffered = session.frozen ?? []
      session.frozen = null
      for (const chunk of buffered) {
        session.emulator?.write(chunk)
        session.pending.push(chunk)
        session.pendingChars += chunk.length
        this.flush(session)
      }
    }
    return snapshots
  }

  /** 守护进程状态：会话计数与启动信息，不暴露端点或 token。 */
  status(): TerminalDaemonStatusData {
    let runningCount = 0
    let restoredCount = 0
    for (const session of this.sessions.values()) {
      if (session.status === 'running') runningCount += 1
      if (session.restored) restoredCount += 1
    }
    return {
      protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      sessionCount: this.sessions.size,
      runningCount,
      restoredCount
    }
  }

  /** 是否还有会话；守护进程据此判断空闲退出。 */
  get sessionCount(): number {
    return this.sessions.size
  }

  /**
   * 守护进程退出：收敛全部终端，并等到进程真的退出、退出回调已派发完才返回。
   * 先给 SIGTERM 一点时间；仍未退出的进程树用 SIGKILL 收敛，再等一次确认。
   */
  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) this.release(session)
    this.options.onSessionsChanged()
    if (sessions.length === 0) return
    await waitForExits(sessions, SHUTDOWN_WAIT_MS)
    const survivors = sessions.filter((session) => !session.exited)
    for (const session of survivors) {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer)
        session.killTimer = null
      }
      terminatePty(session, 'SIGKILL')
    }
    if (survivors.length > 0) await waitForExits(survivors, SHUTDOWN_KILL_WAIT_MS)
    for (const session of sessions) {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer)
        session.killTimer = null
      }
    }
  }

  /** 当前会话的可持久化记录；只写能重建标签与历史所需的最少字段。 */
  persistedRecords(): readonly PersistedSessionRecord[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      projectPath: session.projectPath,
      shell: session.shell,
      cwd: session.cwd,
      title: session.title,
      cols: session.cols,
      rows: session.rows,
      createdAt: session.createdAt
    }))
  }

  /** 仍在运行的终端数；已退出但未关闭的终端不占用额度。 */
  private runningCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.status === 'running') count += 1
    }
    return count
  }

  /** PTY 输出：历史与画面立即更新，下发走缓冲。 */
  private onData(session: DaemonSession, chunk: string): void {
    if (session.released || chunk === '') return
    this.options.history.append(session.id, chunk)
    // 取快照期间先暂存：此时写进模拟器会让快照与随后的实时数据重复。
    if (session.frozen !== null) {
      session.frozen.push(chunk)
      return
    }
    session.emulator?.write(chunk)
    session.pending.push(chunk)
    session.pendingChars += chunk.length
    if (session.pendingChars > MAX_PENDING_CHARS) pauseReading(session)
    // 小批量且没有在途数据时立即下发：按键回显不必等合并窗口。
    if (session.pendingChars <= IMMEDIATE_FLUSH_CHARS && session.inFlightChars === 0) {
      this.flush(session)
      return
    }
    this.scheduleFlush(session)
  }

  private scheduleFlush(session: DaemonSession): void {
    if (session.flushTimer !== null || session.status !== 'running') return
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null
      this.flush(session)
    }, FLUSH_INTERVAL_MS)
  }

  /** 下发一段缓冲：受在途额度约束，超出单次上限的部分留在缓冲里等下一次。 */
  private flush(session: DaemonSession): void {
    if (session.released || session.status !== 'running' || session.pendingChars === 0) return
    if (!this.hasBudget(session)) return

    let text = session.pending.join('')
    if (text.length > TERMINAL_DATA_MAX_CHARS) {
      const rest = text.slice(TERMINAL_DATA_MAX_CHARS)
      session.pending = [rest]
      session.pendingChars = rest.length
      text = text.slice(0, TERMINAL_DATA_MAX_CHARS)
    } else {
      session.pending = []
      session.pendingChars = 0
    }

    session.inFlightChars += text.length
    this.inFlightChars += text.length
    session.emittedChars += text.length
    const delivered = this.options.sendData({
      id: session.id,
      chunk: text,
      chars: text.length,
      seqEnd: session.emittedChars
    })
    if (!delivered) {
      // 没有客户端接收：额度与序号一起退回，把这一段放回队首，等客户端接回后再下发。
      session.inFlightChars -= text.length
      this.inFlightChars -= text.length
      session.emittedChars -= text.length
      session.pending.unshift(text)
      session.pendingChars += text.length
      return
    }
    if (session.pendingChars > 0) this.scheduleFlush(session)
  }

  /** 退出前的最后一段输出不等待额度：背压只约束在途流量，不能丢掉结尾。 */
  private flushFinal(session: DaemonSession): void {
    if (session.pendingChars === 0) return
    const text = session.pending.join('')
    session.pending = []
    session.pendingChars = 0
    session.inFlightChars += text.length
    this.inFlightChars += text.length
    session.emittedChars += text.length
    if (!this.options.sendData({
      id: session.id,
      chunk: text,
      chars: text.length,
      seqEnd: session.emittedChars
    })) {
      session.inFlightChars -= text.length
      this.inFlightChars -= text.length
      session.emittedChars -= text.length
    }
  }

  private onExit(session: DaemonSession, exitCode: number): void {
    // 先记录并兑现退出确认：退出链等的是进程真的没了，与客户端是否还认这个终端无关。
    session.exited = true
    session.settleExit()
    if (session.released) return
    session.status = 'exited'
    session.exitCode = exitCode
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    if (session.paused) resumeReading(session)
    this.flushFinal(session)
    this.options.sendExit({ id: session.id, exitCode })
    this.options.onSessionsChanged()
  }

  /** 在途额度：单个终端与全局各有一个上限，任一触顶都暂停下发。 */
  private hasBudget(session: DaemonSession): boolean {
    return session.inFlightChars < PER_SESSION_IN_FLIGHT_CHARS
      && this.inFlightChars < GLOBAL_IN_FLIGHT_CHARS
  }

  /** 会话离开清单：清理定时器、缓冲与模拟器，并收敛进程树。 */
  private release(session: DaemonSession): void {
    session.released = true
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // 会话已离开清单，客户端不会再为它确认：把它的在途额度直接退回，避免拖住其他终端。
    this.inFlightChars = Math.max(0, this.inFlightChars - session.inFlightChars)
    session.inFlightChars = 0
    session.pending = []
    session.pendingChars = 0
    session.frozen = null
    session.emulator?.dispose()
    session.emulator = null
    this.options.history.remove(session.id)
    if (session.pty === null) return
    terminatePty(session)
    session.killTimer = setTimeout(() => {
      session.killTimer = null
      killPty(session)
    }, KILL_GRACE_MS)
  }
}

function toSessionInfo(session: DaemonSession): TerminalSessionInfo {
  return {
    id: session.id,
    projectPath: session.projectPath,
    title: session.title,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    status: session.status,
    exitCode: session.exitCode
  }
}

function isDimension(value: number): boolean {
  return Number.isInteger(value) && value >= TERMINAL_DIMENSION_MIN && value <= TERMINAL_DIMENSION_MAX
}

function clampDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.min(TERMINAL_DIMENSION_MAX, Math.max(TERMINAL_DIMENSION_MIN, Math.floor(value)))
}

/** 终止整个进程树：shell 的子进程（构建、服务）不能因为关标签或守护进程退出而留下。 */
function terminatePty(session: DaemonSession, signal: NodeJS.Signals = 'SIGTERM'): void {
  const pty = session.pty
  if (pty === null) return
  // node-pty 的 IPty 与 ChildProcess 在终止路径上只需要 pid 与 kill，这里按结构适配既有实现。
  const target = {
    pid: pty.pid,
    kill: (killSignal?: string) => pty.kill(killSignal)
  } as unknown as ChildProcess
  terminateProcessTree(target, signal)
}

/** 等一批终端进程真正退出：全部兑现返回 true，预算用完返回 false。 */
async function waitForExits(sessions: readonly DaemonSession[], budgetMs: number): Promise<boolean> {
  const pending = sessions.filter((session) => !session.exited)
  if (pending.length === 0) return true
  let settleTimeout: (expired: boolean) => void = () => {}
  const timeout = new Promise<boolean>((resolve) => {
    settleTimeout = resolve
  })
  const timer = setTimeout(() => settleTimeout(false), budgetMs)
  try {
    return await Promise.race([
      Promise.all(pending.map((session) => session.exitPromise)).then(() => true),
      timeout
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** 强杀：进程树终止未在收尾时间内生效时的兜底，失败不再上报。 */
function killPty(session: DaemonSession): void {
  try {
    session.pty?.kill()
  } catch {
    // 进程已退出时忽略：这里只负责收敛，不判定成败。
  }
}

/** 待下发缓冲过大时暂停读取：缓冲回落由确认路径恢复。 */
function pauseReading(session: DaemonSession): void {
  if (session.paused || session.pty === null) return
  session.paused = true
  try {
    session.pty.pause()
  } catch {
    // 流控不可用时退化为继续缓冲，不影响下发路径。
  }
}

function resumeReading(session: DaemonSession): void {
  if (!session.paused || session.pty === null) return
  session.paused = false
  try {
    session.pty.resume()
  } catch {
    // 同上：恢复失败不影响后续下发。
  }
}

/**
 * 本机默认 shell：Windows 依次探测 PowerShell 7、Windows PowerShell 与命令提示符，
 * 其他平台用登录 shell（`-l`）以读到用户自己的启动文件。只按 PATH 探测，不读任何 shell 配置。
 */
function resolveShell(): ShellChoice {
  if (process.platform === 'win32') {
    for (const candidate of ['pwsh', 'powershell', 'cmd']) {
      const resolved = findExecutableOnPath(candidate)
      if (resolved !== null) return { file: resolved, args: [] }
    }
    return { file: 'cmd.exe', args: [] }
  }
  const shell = process.env.SHELL?.trim()
  if (shell !== undefined && shell !== '') return { file: shell, args: ['-l'] }
  return { file: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', args: ['-l'] }
}

/** 在 PATH 中查找可执行文件；Windows 还按 PATHEXT 逐个后缀尝试，找不到返回 null。 */
function findExecutableOnPath(base: string): string | null {
  const entries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension !== '')
  for (const directory of entries) {
    for (const extension of extensions) {
      const candidate = join(directory, base + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * 终端环境变量：从守护进程环境派生，只补终端类型相关变量。
 * 守护进程由应用拉起，环境与应用一致；Electron 的运行开关属于应用内部语义，不带给用户的交互式 shell。
 */
function terminalEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || EXCLUDED_ENVIRONMENT_KEYS.includes(key)) continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

/** 终端默认标题取 shell 的可执行文件名，去掉 Windows 的 `.exe` 后缀；重命名由页面自己保存。 */
function shellTitle(file: string): string {
  const name = basename(file)
  return name.toLowerCase().endsWith('.exe') ? name.slice(0, -4) : name
}
