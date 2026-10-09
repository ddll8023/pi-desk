/**
 * 管理认证辅助进程的定位、三段管道与退出。
 *
 * 只负责把 `out/auth-helper/index.mjs` 作为独立 Node 入口跑起来，并把 stdout 按 LF 分帧成帧记录；
 * 不做认证状态机、不解析业务载荷。辅助进程不是 Pi sidecar：它由 `ELECTRON_RUN_AS_NODE` 启动、
 * 只加载官方 SDK，因此不涉及 Pi 的启动参数、项目目录或会话。
 *
 * 退出策略与 pi-process.ts 一致：先关闭 stdin，超时后按平台定向终止进程树，不接受外部 PID。
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { app } from 'electron'
import { AUTH_HELPER_MAX_RECORD_CHARS, isAuthHelperFrame } from '../auth-helper/protocol'
import type { AuthHelperFrame, AuthHelperRequest } from '../auth-helper/protocol'

/** 关闭 stdin 后等待辅助进程自行退出的期限。 */
const STOP_GRACE_MS = 3_000

/** 平台兜底终止后，每个阶段等待退出的期限。 */
const FORCE_WAIT_MS = 2_000

/** stderr 诊断只保留最近若干行，并限制单行长度。 */
const MAX_DIAGNOSTIC_LINES = 20
const MAX_DIAGNOSTIC_LINE_CHARS = 300

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g

/** 辅助进程入口的固定文件名；页面不能指定路径。 */
const HELPER_ENTRY_NAME = 'index.mjs'

export class AuthHelperProcessError extends Error {}

export interface AuthHelperExitEvent {
  readonly code: number | null
  readonly signal: string | null
}

export interface AuthHelperHandlers {
  readonly onFrame: (frame: AuthHelperFrame) => void
  readonly onProtocolError: (message: string) => void
  readonly onSpawnFailure: (message: string) => void
  readonly onExit: (event: AuthHelperExitEvent) => void
}

/** 入口路径固定：开发期是构建产物目录，正式包从资源目录读取同一相对子路径。 */
export function getAuthHelperEntryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'auth-helper', HELPER_ENTRY_NAME)
    : resolve(__dirname, '..', 'auth-helper', HELPER_ENTRY_NAME)
}

export class AuthHelperProcess {
  private readonly stdoutDecoder = new StringDecoder('utf8')
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly diagnostics: string[] = []
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private writeQueue: Promise<void> = Promise.resolve()
  private exited = false
  private lastExit: AuthHelperExitEvent | null = null

  private constructor(
    private readonly child: ChildProcess,
    private readonly handlers: AuthHelperHandlers
  ) {}

  static start(handlers: AuthHelperHandlers): AuthHelperProcess {
    const entryPath = getAuthHelperEntryPath()
    if (!existsSync(entryPath)) {
      throw new AuthHelperProcessError(
        `未找到认证辅助进程：${entryPath}。请在项目根目录运行 npm run auth-helper:build。`
      )
    }

    const child = spawn(process.execPath, [entryPath], {
      // 用 Electron 自带的 Node 运行普通 ESM 入口，不创建窗口、不加载页面。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true
    })
    const helper = new AuthHelperProcess(child, handlers)
    helper.attach()
    return helper
  }

  get isExited(): boolean {
    return this.exited
  }

  get exitEvent(): AuthHelperExitEvent | null {
    return this.lastExit
  }

  /** 串行写入完整请求帧；写入不等于辅助进程已处理该请求。 */
  write(request: AuthHelperRequest): Promise<void> {
    const task = this.writeQueue.then(() => this.writeChunk(`${JSON.stringify(request)}\n`))
    this.writeQueue = task.then(() => undefined, () => undefined)
    return task
  }

  /** 关闭 stdin 即请求辅助进程退出，本身不等待退出。 */
  closeStdin(): void {
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed) return
    stdin.end()
  }

  /** 关闭链：先关闭 stdin，超时后按平台定向终止受管进程树。 */
  async stop(graceMs = STOP_GRACE_MS, forceWaitMs = FORCE_WAIT_MS): Promise<void> {
    if (this.exited) return
    this.closeStdin()
    if (await this.waitForClose(graceMs)) return

    if (process.platform === 'win32') {
      this.terminateProcessTree()
      if (await this.waitForClose(forceWaitMs)) return
      this.child.kill()
      await this.waitForClose(forceWaitMs)
      return
    }

    this.signalProcessGroup('SIGTERM')
    if (await this.waitForClose(forceWaitMs)) return
    this.signalProcessGroup('SIGKILL')
    await this.waitForClose(forceWaitMs)
  }

  /** 最近的有界诊断行副本；只包含辅助进程写出的非秘密诊断。 */
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
        this.handlers.onProtocolError('认证辅助进程的标准输出在一条记录中途结束。')
      }
    })
    this.child.stderr?.on('data', (chunk: Buffer) => this.consumeStderr(chunk))
    this.child.once('error', (error: Error) => {
      this.pushDiagnostic(`启动认证辅助进程失败：${error.message}`)
      if (spawned) {
        this.handlers.onExit({ code: null, signal: null })
        return
      }
      this.handlers.onSpawnFailure(error.message)
    })
    this.child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true
      this.lastExit = { code, signal }
      this.handlers.onExit(this.lastExit)
    })
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk)
    this.stdoutBuffer = this.emitCompleteLines(this.stdoutBuffer, (line) => this.handleLine(line))
    if (this.stdoutBuffer.length > AUTH_HELPER_MAX_RECORD_CHARS) {
      this.stdoutBuffer = ''
      this.handlers.onProtocolError('认证辅助进程输出了超长的单条记录。')
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

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.handlers.onProtocolError('认证辅助进程输出了无法解析的记录。')
      return
    }
    if (!isAuthHelperFrame(parsed)) {
      this.handlers.onProtocolError('认证辅助进程输出了形状不符的帧。')
      return
    }
    this.handlers.onFrame(parsed)
  }

  /** 只按 LF 分帧并去掉行尾可选 CR。 */
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

  /** Windows：用系统 taskkill 定向终止受管进程树，不依赖 PATH。 */
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

  private async writeChunk(payload: string): Promise<void> {
    const stdin = this.child.stdin
    if (stdin === null || stdin.destroyed || this.exited) {
      throw new Error('认证辅助进程的标准输入已不可用。')
    }
    if (stdin.write(payload, 'utf8')) return
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
