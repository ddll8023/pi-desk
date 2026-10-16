/**
 * 内置终端的 PTY 后端：每个终端标签对应一个伪终端进程，进程、缓冲与生命周期都留在主进程。
 *
 * 输出不逐块直发页面：先按块缓冲，再按「缓冲够大或定时到点」合并下发，减少 IPC 次数；页面确认（ACK）
 * 后才释放背压额度，单个终端与全部终端各有在途上限，因此一个刷屏的终端不会挤掉其他终端的回显。
 * 小批量且当前无在途数据时立即下发，按键回显不必等合并窗口。待下发缓冲超过上限时用 PTY 自身的流控
 * 暂停读取，避免页面长时间不消费时内存无界增长。
 *
 * 边界：只按已登记项目创建终端，工作目录固定为该项目路径；shell 由本机探测决定，不接受页面指定。
 * 关闭、项目移除与应用退出都经 `terminateProcessTree` 收敛进程树。已退出的终端记录保留到页面显式关闭，
 * 以便标签如实展示退出码；退出前最后一段输出一定下发，背压只约束在途流量，不丢数据。
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { spawn as spawnPty } from 'node-pty'
import type { IPty } from 'node-pty'
import { TERMINAL_DATA_MAX_CHARS } from '../shared/terminal-api'
import type {
  TerminalAckRequest,
  TerminalCloseRequest,
  TerminalCommandResult,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalListRequest,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalSessionResult,
  TerminalSessionsResult,
  TerminalStatus,
  TerminalWriteRequest
} from '../shared/terminal-api'
import { terminateProcessTree } from './process-tree-termination'

/** 合并窗口：批量输出按这个节奏合并下发，兼顾吞吐与延迟。 */
const FLUSH_INTERVAL_MS = 16

/** 不超过这个字符数的缓冲直接下发，让按键回显走低延迟路径。 */
const IMMEDIATE_FLUSH_CHARS = 4096

/** 单个终端允许的在途字符数；超过后暂停下发，等页面确认。 */
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

/** 应用退出时的收敛等待：给 shell 一点退出时间，之后强制收敛，不把退出链拖住。 */
const SHUTDOWN_WAIT_MS = 300

/** 交互式 shell 不需要的应用内部变量：把 Electron 的运行开关与 Node 参数留在主进程。 */
const EXCLUDED_ENVIRONMENT_KEYS: readonly string[] = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']

/** 本机默认 shell 及其启动参数。 */
interface ShellChoice {
  readonly file: string
  readonly args: string[]
}

/** 单个终端会话的全部可变状态。 */
interface TerminalSession {
  readonly id: string
  readonly projectPath: string
  readonly pty: IPty
  readonly shell: string
  readonly cwd: string
  readonly title: string
  cols: number
  rows: number
  status: TerminalStatus
  exitCode: number | null
  /** 待下发缓冲；按块保存，下发时合并，避免频繁的小消息。 */
  pending: string[]
  pendingChars: number
  /** 已下发但页面尚未确认的字符数。 */
  inFlightChars: number
  flushTimer: NodeJS.Timeout | null
  /** 收尾强杀定时器；正常退出时清掉，不留悬空定时器。 */
  killTimer: NodeJS.Timeout | null
  /** 因背压暂停了 PTY 读取。 */
  paused: boolean
  /** 已从会话表移除：不再下发、不再改状态，只等进程收尾。 */
  released: boolean
}

export interface TerminalManagerOptions {
  /** 把页面给出的项目路径收敛为已登记项目的规范路径；未登记时返回 null。 */
  readonly resolveProjectPath: (requested: string) => Promise<string | null>
  /** 下发终端输出；返回 false 表示当前没有可信页面接收，此时不下发也不计在途。 */
  readonly sendData: (event: TerminalDataEvent) => boolean
  /** 下发终端退出；同样只发给可信页面。 */
  readonly sendExit: (event: TerminalExitEvent) => boolean
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>()

  /** 全部终端合计的在途字符数；页面确认后递减。 */
  private inFlightChars = 0

  constructor(private readonly options: TerminalManagerOptions) {}

  /** 在已登记项目内新建终端；未登记的项目、非法尺寸与超量请求都回可展示的原因。 */
  async create(request: TerminalCreateRequest): Promise<TerminalSessionResult> {
    const projectPath = await this.options.resolveProjectPath(request.projectPath)
    if (projectPath === null) {
      return sessionFailure('INVALID_REQUEST', '只能为已添加的项目创建终端。')
    }
    if (this.runningCount() >= MAX_SESSIONS) {
      return sessionFailure('TERMINAL_LIMIT_REACHED', `同时运行的终端最多 ${MAX_SESSIONS} 个，请先关闭一个。`)
    }

    const shell = resolveShell()
    let pty: IPty
    try {
      pty = spawnPty(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: projectPath,
        env: terminalEnvironment()
      })
    } catch (error) {
      return sessionFailure('INTERNAL_ERROR', spawnFailureMessage(error, shell.file))
    }

    const session: TerminalSession = {
      id: randomUUID(),
      projectPath,
      pty,
      shell: shell.file,
      cwd: projectPath,
      title: shellTitle(shell.file),
      cols: request.cols,
      rows: request.rows,
      status: 'running',
      exitCode: null,
      pending: [],
      pendingChars: 0,
      inFlightChars: 0,
      flushTimer: null,
      killTimer: null,
      paused: false,
      released: false
    }
    this.sessions.set(session.id, session)
    pty.onData((chunk) => this.onData(session, chunk))
    pty.onExit((event) => this.onExit(session, event.exitCode))
    return { ok: true, data: toSessionInfo(session) }
  }

  /** 把页面输入写入终端；已退出或已关闭的终端不再接受输入。 */
  write(request: TerminalWriteRequest): TerminalCommandResult {
    const session = this.sessions.get(request.id)
    if (session === undefined) return commandFailure('TERMINAL_NOT_FOUND', '该终端已关闭。')
    if (session.status !== 'running') return commandFailure('TERMINAL_NOT_FOUND', '该终端已退出，不能再输入。')
    try {
      session.pty.write(request.data)
    } catch {
      return commandFailure('INTERNAL_ERROR', '写入终端失败，请重新打开终端。')
    }
    return { ok: true }
  }

  /** 同步终端尺寸；已退出的终端只更新记录，不再转给 PTY。 */
  resize(request: TerminalResizeRequest): TerminalCommandResult {
    const session = this.sessions.get(request.id)
    if (session === undefined) return commandFailure('TERMINAL_NOT_FOUND', '该终端已关闭。')
    session.cols = request.cols
    session.rows = request.rows
    if (session.status !== 'running') return { ok: true }
    try {
      session.pty.resize(request.cols, request.rows)
    } catch {
      return commandFailure('INTERNAL_ERROR', '调整终端尺寸失败，请重新打开终端。')
    }
    return { ok: true }
  }

  /** 关闭终端并收敛其进程树；关闭不存在的终端按已关闭处理，重复调用是安全的。 */
  close(request: TerminalCloseRequest): TerminalCommandResult {
    const session = this.sessions.get(request.id)
    if (session === undefined) return { ok: true }
    this.sessions.delete(request.id)
    this.release(session)
    return { ok: true }
  }

  /** 读取终端清单；按项目过滤时只认已登记项目，未登记回非法请求而不是空清单。 */
  async list(request: TerminalListRequest): Promise<TerminalSessionsResult> {
    const projectPath = request.projectPath === null
      ? null
      : await this.options.resolveProjectPath(request.projectPath)
    if (request.projectPath !== null && projectPath === null) {
      return sessionsFailure('INVALID_REQUEST', '只能读取已添加项目的终端。')
    }
    const sessions: TerminalSessionInfo[] = []
    for (const session of this.sessions.values()) {
      if (projectPath !== null && session.projectPath !== projectPath) continue
      sessions.push(toSessionInfo(session))
    }
    return { ok: true, data: { sessions } }
  }

  /** 释放页面已消费的背压额度；未知终端与非法数量一律忽略，不回传结果。 */
  acknowledge(request: TerminalAckRequest): void {
    const session = this.sessions.get(request.id)
    if (session === undefined || session.released) return
    // 只释放确实下发过的额度：页面回报超出部分不计入，避免一个错误回报把全局额度清空。
    const consumed = Math.min(request.chars, session.inFlightChars)
    session.inFlightChars -= consumed
    this.inFlightChars = Math.max(0, this.inFlightChars - consumed)
    if (session.paused && session.pendingChars <= RESUME_PENDING_CHARS) resumeReading(session)
    this.flush(session)
  }

  /** 关闭某个项目的全部终端；项目被移除时调用，页面无需逐个关闭。 */
  closeProject(projectPath: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.projectPath !== projectPath) continue
      this.sessions.delete(session.id)
      this.release(session)
    }
  }

  /**
   * 页面重新加载后调用：上一份页面未确认的在途额度不再有人回报，清掉它避免终端被永久背压。
   * 终端与待下发缓冲都保留，页面重新挂载后由后续输出继续下发。
   */
  resetDelivery(): void {
    this.inFlightChars = 0
    for (const session of this.sessions.values()) {
      session.inFlightChars = 0
      if (session.paused) resumeReading(session)
    }
  }

  /** 应用退出：收敛全部终端并等一小段收尾时间，之后强制结束，不把退出链拖住。 */
  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    if (sessions.length === 0) return
    for (const session of sessions) this.release(session)
    await delay(SHUTDOWN_WAIT_MS)
    for (const session of sessions) {
      if (session.killTimer !== null) {
        clearTimeout(session.killTimer)
        session.killTimer = null
      }
      killPty(session)
    }
  }

  /** 仍在运行的终端数；已退出但未关闭的终端不占用额度。 */
  private runningCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.status === 'running') count += 1
    }
    return count
  }

  /** PTY 输出：先入缓冲，再决定立即下发还是等合并窗口。 */
  private onData(session: TerminalSession, chunk: string): void {
    if (session.released || chunk === '') return
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

  private scheduleFlush(session: TerminalSession): void {
    if (session.flushTimer !== null || session.status !== 'running') return
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null
      this.flush(session)
    }, FLUSH_INTERVAL_MS)
  }

  /** 下发一段缓冲：受在途额度约束，超出单次上限的部分留在缓冲里等下一次。 */
  private flush(session: TerminalSession): void {
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
    if (!this.options.sendData({ id: session.id, chunk: text, chars: text.length })) {
      // 没有可信页面接收：额度退回并把这一段放回队首，等页面重新挂载后再下发。
      session.inFlightChars -= text.length
      this.inFlightChars -= text.length
      session.pending.unshift(text)
      session.pendingChars += text.length
      return
    }
    if (session.pendingChars > 0) this.scheduleFlush(session)
  }

  /** 退出前的最后一段输出不等待额度：背压只约束在途流量，不能丢掉结尾。 */
  private flushFinal(session: TerminalSession): void {
    if (session.pendingChars === 0) return
    const text = session.pending.join('')
    session.pending = []
    session.pendingChars = 0
    session.inFlightChars += text.length
    this.inFlightChars += text.length
    if (!this.options.sendData({ id: session.id, chunk: text, chars: text.length })) {
      session.inFlightChars -= text.length
      this.inFlightChars -= text.length
    }
  }

  private onExit(session: TerminalSession, exitCode: number): void {
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
  }

  /** 在途额度：单个终端与全局各有一个上限，任一触顶都暂停下发。 */
  private hasBudget(session: TerminalSession): boolean {
    return session.inFlightChars < PER_SESSION_IN_FLIGHT_CHARS
      && this.inFlightChars < GLOBAL_IN_FLIGHT_CHARS
  }

  /** 会话离开清单：清理定时器与缓冲，并收敛进程树。 */
  private release(session: TerminalSession): void {
    session.released = true
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer)
      session.flushTimer = null
    }
    // 会话已离开清单，页面不会再为它确认：把它的在途额度直接退回，避免拖住其他终端。
    this.inFlightChars = Math.max(0, this.inFlightChars - session.inFlightChars)
    session.inFlightChars = 0
    session.pending = []
    session.pendingChars = 0

    terminatePty(session)
    session.killTimer = setTimeout(() => {
      session.killTimer = null
      killPty(session)
    }, KILL_GRACE_MS)
  }
}

function sessionFailure(
  code: 'INVALID_REQUEST' | 'INTERNAL_ERROR' | 'TERMINAL_LIMIT_REACHED',
  message: string
): TerminalSessionResult {
  return { ok: false, error: { code, message } }
}

function sessionsFailure(
  code: 'INVALID_REQUEST' | 'INTERNAL_ERROR',
  message: string
): TerminalSessionsResult {
  return { ok: false, error: { code, message } }
}

function commandFailure(
  code: 'INTERNAL_ERROR' | 'TERMINAL_NOT_FOUND',
  message: string
): TerminalCommandResult {
  return { ok: false, error: { code, message } }
}

function toSessionInfo(session: TerminalSession): TerminalSessionInfo {
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

/** 终止整个进程树：shell 的子进程（构建、服务）不能因为关标签而留下。 */
function terminatePty(session: TerminalSession): void {
  // node-pty 的 IPty 与 ChildProcess 在终止路径上只需要 pid 与 kill，这里按结构适配既有实现。
  const target = {
    pid: session.pty.pid,
    kill: (signal?: string) => session.pty.kill(signal)
  } as unknown as ChildProcess
  terminateProcessTree(target, 'SIGTERM')
}

/** 强杀：进程树终止未在收尾时间内生效时的兜底，失败不再上报。 */
function killPty(session: TerminalSession): void {
  try {
    session.pty.kill()
  } catch {
    // 进程已退出时忽略：这里只负责收敛，不判定成败。
  }
}

/** 待下发缓冲过大时暂停读取：缓冲回落由确认路径恢复。 */
function pauseReading(session: TerminalSession): void {
  if (session.paused) return
  session.paused = true
  try {
    session.pty.pause()
  } catch {
    // 流控不可用时退化为继续缓冲，不影响下发路径。
  }
}

function resumeReading(session: TerminalSession): void {
  if (!session.paused) return
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
 * 终端环境变量：从主进程环境派生，只补终端类型相关变量。
 * Electron 的运行开关与 Node 参数属于应用内部语义，不带给用户的交互式 shell。
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

/** 启动失败的可展示原因：只区分找不到 shell 与通用失败，附上错误码便于排查；完整错误只留在主进程日志。 */
function spawnFailureMessage(error: unknown, file: string): string {
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
  console.error(`创建终端失败（shell=${file}）：`, error)
  if (code === 'ENOENT') return `找不到 shell 可执行文件：${file}`
  return code === undefined ? `启动终端失败：${file}` : `启动终端失败：${file}（${code}）`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
