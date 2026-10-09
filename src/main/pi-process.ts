/**
 * 管理固定 Pi sidecar 的定位、三段管道与进程退出。
 *
 * 只负责把 staging 根下的固定可执行文件跑起来，并把 stdout 与 stderr 按 LF 分帧成行；
 * 不做 JSON 解析、请求关联或业务状态，也不接受页面传入的可执行文件路径或启动参数。
 * 关闭只处理本进程启动的子进程，不接受外部 PID 或按进程名批量终止。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app } from 'electron'

/** 与开发总览第 4.3 节的打包映射一致：开发和正式包使用同一相对子路径。 */
const RUNTIME_RELATIVE_SEGMENTS = ['runtime', 'pi'] as const

/** 单条记录字符数上限；超限按协议错误处理，不无界缓存。 */
const MAX_RECORD_CHARS = 8 * 1024 * 1024

/** stderr 诊断只保留最近若干行，并限制单行长度。 */
const MAX_DIAGNOSTIC_LINES = 40
const MAX_DIAGNOSTIC_LINE_CHARS = 400

/** 等待 Pi 自行退出（关闭 stdin 后）的期限。 */
const STOP_GRACE_MS = 5_000

/** 平台兜底终止后，每个阶段等待退出的期限。 */
const FORCE_WAIT_MS = 2_000

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g

export class PiProcessError extends Error {}

export interface PiExitEvent {
  readonly code: number | null
  readonly signal: string | null
}

export interface PiProcessHandlers {
  readonly onStdoutLine: (line: string) => void
  readonly onProtocolError: (message: string) => void
  readonly onSpawnFailure: (message: string) => void
  readonly onExit: (event: PiExitEvent) => void
}

export interface PiProcessOptions {
  readonly projectPath: string
  readonly handlers: PiProcessHandlers
  /** 会话根目录：主进程显式指定，作为 `--session-dir`，不依赖 Pi 自己的配置优先级。 */
  readonly sessionDir: string
  /** 要恢复的会话 id；为 null 表示新建会话。 */
  readonly sessionId: string | null
  /**
   * Project Trust 决定：有受保护资源时为用户决定（`--approve`/`--no-approve`），
   * 无受保护资源时为 null（不传，交给官方默认）；决定由主进程探测与记录，不由页面指定。
   */
  readonly trustDecision: 'trusted' | 'untrusted' | null
  /**
   * 安全启动：只用于 Extension 加载失败导致 RPC 启动直接失败时的逃生路径，
   * 固定传 `--no-extensions`（仅本次，不写任何配置）。常规启动不传该字段。
   */
  readonly disableExtensions?: boolean
}

/** Runtime 目录由平台与架构决定，页面无法指定。 */
export function getPiRuntimeDirectory(): string {
  const targetId = `${process.platform}-${process.arch}`
  // 开发期 __dirname 是构建产物目录 out/main；正式包改用资源目录，相对子路径相同。
  const base = app.isPackaged
    ? join(process.resourcesPath, ...RUNTIME_RELATIVE_SEGMENTS)
    : resolve(__dirname, '..', '..', ...RUNTIME_RELATIVE_SEGMENTS)
  return join(base, targetId)
}

export function getPiExecutablePath(): string {
  const executableName = process.platform === 'win32' ? 'pi.exe' : 'pi'
  return join(getPiRuntimeDirectory(), executableName)
}

/**
 * 启动参数固定：RPC 模式、按信任决定传递项目资源覆盖、显式工具集、会话目录与可选恢复会话，
 * 以及仅用于安全启动的 `--no-extensions`。
 *
 * Skills、Prompt Templates 与 MCP 自 P3-06 起不再用 `--no-*` 全量关闭：它们由 Pi 自己的资源
 * 加载规则与 Project Trust 决定（用户级资源始终加载，项目级资源只在信任时加载）。Extension 自
 * P3-02 起同样由 Trust 决定控制；`--no-extensions` 不是常规路径。
 * 会话由 Pi 持久化，不再使用 `--no-session`；页面不能覆盖其中任何一项。
 */
export function getPiLaunchArguments(options: PiProcessOptions): string[] {
  const tools = process.platform === 'win32'
    ? 'read,powershell,edit,write'
    : 'read,bash,edit,write'
  const args = [
    '--mode', 'rpc',
    '--tools', tools,
    '--session-dir', options.sessionDir
  ]
  if (options.disableExtensions === true) args.push('--no-extensions')
  if (options.trustDecision === 'trusted') args.push('--approve')
  else if (options.trustDecision === 'untrusted') args.push('--no-approve')
  if (options.sessionId !== null) args.push('--session-id', options.sessionId)
  return args
}

export class PiProcess {
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly diagnostics: string[] = []
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private writeQueue: Promise<void> = Promise.resolve()
  private exited = false
  private lastExit: PiExitEvent | null = null

  private constructor(
    private readonly child: ChildProcess,
    private readonly handlers: PiProcessHandlers
  ) {}

  static start(options: PiProcessOptions): PiProcess {
    const executablePath = getPiExecutablePath()
    if (!existsSync(executablePath)) {
      throw new PiProcessError(
        `未找到 Pi Runtime：${executablePath}。请先在项目根目录运行 npm run pi:prepare。`
      )
    }

    const child = spawn(executablePath, getPiLaunchArguments(options), {
      cwd: options.projectPath,
      // 只追加版本检查开关；凭据等仍由 Pi 自己的配置与环境提供。
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      // 独立进程组便于按组终止；不调用 unref，进程仍由应用管理。
      detached: true,
      windowsHide: true
    })
    const piProcess = new PiProcess(child, options.handlers)
    piProcess.attach()
    return piProcess
  }

  get isExited(): boolean {
    return this.exited
  }

  get exitEvent(): PiExitEvent | null {
    return this.lastExit
  }

  /** 受管子进程的 pid；进程已退出或未启动时为空。 */
  get pid(): number | undefined {
    return this.child.pid
  }

  /** 串行写入完整记录，并等待背压排空；写入不等于收到响应。 */
  write(line: string): Promise<void> {
    const task = this.writeQueue.then(() => this.writeChunk(line))
    this.writeQueue = task.then(() => undefined, () => undefined)
    return task
  }

  /** 关闭 stdin 即请求 Pi 有序退出，本身不等待退出。 */
  closeStdin(): void {
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed) return
    stdin.end()
  }

  /**
   * 关闭链：先关闭 stdin 请求 Pi 自行退出，超时后按平台定向终止受管进程树。
   * Windows 不先只杀根进程再假定能找到子进程；macOS 按进程组发送信号。
   */
  async stop(graceMs = STOP_GRACE_MS, forceWaitMs = FORCE_WAIT_MS): Promise<void> {
    if (this.exited) return
    this.closeStdin()
    if (await this.waitForClose(graceMs)) return

    if (process.platform === 'win32') {
      this.terminateProcessTree()
      if (await this.waitForClose(forceWaitMs)) return
      // taskkill 不可用时的最后手段：至少结束根进程。
      this.child.kill()
      await this.waitForClose(forceWaitMs)
      return
    }

    this.signalProcessGroup('SIGTERM')
    if (await this.waitForClose(forceWaitMs)) return
    this.signalProcessGroup('SIGKILL')
    await this.waitForClose(forceWaitMs)
  }

  /** 返回最近的有界诊断行副本，交给主进程拼接错误信息。 */
  readDiagnostics(): readonly string[] {
    return [...this.diagnostics]
  }

  private attach(): void {
    let spawned = false
    this.child.once('spawn', () => {
      spawned = true
    })
    this.child.stdin?.on('error', () => {
      // 管道关闭在退出路径上属于预期情况，由退出收敛处理。
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    this.child.stdout?.on('end', () => {
      if (this.stdoutBuffer !== '') {
        this.stdoutBuffer = ''
        this.handlers.onProtocolError('Pi 的标准输出在一条记录中途结束。')
      }
    })
    this.child.stderr?.on('data', (chunk: Buffer) => this.consumeStderr(chunk))
    this.child.once('error', (error: Error) => {
      this.pushDiagnostic(`启动 Pi 失败：${error.message}`)
      if (spawned) {
        this.handlers.onExit({ code: null, signal: null })
        return
      }
      this.handlers.onSpawnFailure(error.message)
    })
    // close 在 stdio 关闭后触发，保证退出通知前已消费完剩余输出。
    this.child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true
      this.lastExit = { code, signal }
      this.handlers.onExit(this.lastExit)
    })
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk)
    this.stdoutBuffer = this.emitCompleteLines(this.stdoutBuffer, (line) => this.handlers.onStdoutLine(line))
    if (this.stdoutBuffer.length > MAX_RECORD_CHARS) {
      this.stdoutBuffer = ''
      this.handlers.onProtocolError(`Pi 输出了超过 ${MAX_RECORD_CHARS} 字符的单条记录。`)
    }
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.write(chunk)
    this.stderrBuffer = this.emitCompleteLines(this.stderrBuffer, (line) => this.pushDiagnostic(line))
    if (this.stderrBuffer.length > MAX_DIAGNOSTIC_LINE_CHARS) {
      this.pushDiagnostic(this.stderrBuffer)
      this.stderrBuffer = ''
    }
  }

  /** 只按 LF 分帧并去掉行尾可选 CR；U+2028/U+2029 可以是记录内容，不能当分隔符。 */
  private emitCompleteLines(buffer: string, onLine: (line: string) => void): string {
    let rest = buffer
    let index = rest.indexOf('\n')
    while (index >= 0) {
      const line = rest.slice(0, index)
      rest = rest.slice(index + 1)
      const record = line.endsWith('\r') ? line.slice(0, -1) : line
      if (record.length > 0) onLine(record)
      index = rest.indexOf('\n')
    }
    return rest
  }

  private pushDiagnostic(line: string): void {
    const trimmed = line.replace(ANSI_ESCAPE, '').trim()
    if (trimmed.length === 0) return
    this.diagnostics.push(trimmed.slice(0, MAX_DIAGNOSTIC_LINE_CHARS))
    if (this.diagnostics.length > MAX_DIAGNOSTIC_LINES) {
      this.diagnostics.shift()
    }
  }

  /** Windows：用系统 taskkill 定向终止当前受管进程树，不依赖 PATH。 */
  private terminateProcessTree(): void {
    const pid = this.child.pid
    if (pid === undefined) return
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    try {
      const killer = spawn(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      // 失败的 spawn 会异步 emit error，必须消费以避免拖垮主进程。
      killer.once('error', () => {})
      killer.unref()
    } catch {
      // taskkill 无法执行时由调用方回退到单进程终止。
    }
  }

  /** macOS：向独立进程组发送信号，失败时只终止根进程。 */
  private signalProcessGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        this.child.kill(signal)
      } catch {
        // 进程已退出。
      }
    }
  }

  private async writeChunk(line: string): Promise<void> {
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed || this.exited) {
      throw new Error('Pi 的标准输入已不可用。')
    }
    if (stdin.write(line, 'utf8')) return
    await new Promise<void>((resolve) => {
      stdin.once('drain', resolve)
    })
  }

  private waitForClose(graceMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const onClose = (): void => finish(true)
      const timer = setTimeout(() => finish(false), graceMs)
      const finish = (closed: boolean): void => {
        clearTimeout(timer)
        this.child.off('close', onClose)
        resolve(closed)
      }
      this.child.once('close', onClose)
    })
  }
}
