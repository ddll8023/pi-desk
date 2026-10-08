/**
 * 管理固定 Pi sidecar 的定位、三段管道与进程退出。
 *
 * 只负责把 staging 根下的固定可执行文件跑起来，并把 stdout 与 stderr 按 LF 分帧成行；
 * 不做 JSON 解析、请求关联或业务状态，也不接受页面传入的可执行文件路径或启动参数。
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

/** 等待进程退出的默认期限；完整关闭编排由后续任务补齐。 */
const DEFAULT_EXIT_GRACE_MS = 3_000

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

/** 启动参数固定：RPC 模式、内存 Session、拒绝项目资源、关闭四类资源、显式工具集。 */
export function getPiLaunchArguments(): string[] {
  const tools = process.platform === 'win32'
    ? 'read,powershell,edit,write'
    : 'read,bash,edit,write'
  return [
    '--mode', 'rpc',
    '--no-session',
    '--no-approve',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-mcp',
    '--tools', tools
  ]
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

    const child = spawn(executablePath, getPiLaunchArguments(), {
      cwd: options.projectPath,
      // 只追加版本检查开关；凭据等仍由 Pi 自己的配置与环境提供。
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
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
   * 最小回收：先关闭 stdin，超时后强制结束。
   * 平台定向进程树终止与完整关闭编排属于后续任务，这里只保证不留下受管子进程。
   */
  async stop(graceMs = DEFAULT_EXIT_GRACE_MS): Promise<void> {
    if (this.exited) return
    this.closeStdin()
    if (await this.waitForClose(graceMs)) return
    this.child.kill()
    await this.waitForClose(graceMs)
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
