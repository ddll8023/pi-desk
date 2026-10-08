/**
 * 唯一 Runtime 的所有者：状态机、启动与就绪判定、状态快照。
 *
 * 不管理 Pi Session 或消息，不实现平台定向进程树终止与关闭期限编排，也不接受
 * 页面传入的可执行文件路径或启动参数。旧 Runtime 的异步结果不得覆盖新状态。
 */
import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { RuntimeErrorCode, RuntimeResult, RuntimeStatus } from '../shared/runtime-api'
import { PiProcess, PiProcessError } from './pi-process'
import type { PiExitEvent } from './pi-process'
import { PiProtocol, toRuntimeInfo } from './pi-protocol'

/** get_state 就绪等待期限；超时只结束等待，不证明 Pi 没有响应。 */
const READY_TIMEOUT_MS = 10_000

/** 失败时回传给页面的诊断行数上限。 */
const DIAGNOSTIC_TAIL_LINES = 6

interface ActiveRuntime {
  readonly runtimeId: number
  readonly projectPath: string
  readonly process: PiProcess
  readonly protocol: PiProtocol
}

/** 可分类的 Runtime 操作失败，由 start 统一转换为结果对象。 */
class RuntimeFailure extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function describeExit(event: PiExitEvent): string {
  if (event.code !== null) return `Pi 进程已退出（退出码 ${event.code}）。`
  if (event.signal !== null) return `Pi 进程被信号 ${event.signal} 结束。`
  return 'Pi 进程已退出。'
}

export class RuntimeManager {
  private runtimeIdSeed = 0
  private active: ActiveRuntime | null = null
  private snapshot: RuntimeStatus = { state: 'idle', runtimeId: null, info: null, lastError: null }

  /** 启动唯一 Runtime；重复启动被拒绝，不做隐式重启。 */
  async start(projectPath: string): Promise<RuntimeResult> {
    try {
      return { ok: true, data: await this.launch(projectPath) }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '启动 Runtime 时发生未预期的内部错误。')
      this.snapshot = { ...this.snapshot, state: 'failed', info: null, lastError: failure.message }
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /** 状态快照查询只读，不触发进程操作。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: { ...this.snapshot } }
  }

  /** 应用退出时的最小回收；完整关闭编排由后续任务补齐。 */
  async shutdown(): Promise<void> {
    const runtime = this.active
    this.active = null
    if (runtime === null) return
    await runtime.process.stop()
  }

  private async launch(projectPath: string): Promise<RuntimeStatus> {
    if (this.active !== null) {
      throw new RuntimeFailure('RUNTIME_ALREADY_RUNNING', '已经有 Runtime 在运行；请先结束当前 Runtime。')
    }

    const projectDirectory = await this.checkProjectPath(projectPath)
    const runtimeId = (this.runtimeIdSeed += 1)
    this.snapshot = { state: 'starting', runtimeId, info: null, lastError: null }

    let exitEvent: PiExitEvent | null = null
    let spawnFailure: string | null = null
    let protocolError: string | null = null

    const protocol = new PiProtocol({
      onProtocolError: (message) => {
        protocolError ??= message
      },
      onRecord: () => {
        // 第一阶段只消费 response；会话事件与 Extension UI 由后续任务接入。
      },
      onUnmatchedResponse: () => {
        // 无 pending 可匹配的 response 不致命，例如 Pi 自行回报的解析错误。
      }
    })

    let piProcess: PiProcess | null = null
    try {
      piProcess = PiProcess.start({
        projectPath: projectDirectory,
        handlers: {
          onStdoutLine: (line) => protocol.handleLine(line),
          onProtocolError: (message) => {
            protocolError ??= message
          },
          onSpawnFailure: (message) => {
            spawnFailure ??= message
            protocol.failAll(message)
          },
          onExit: (event) => {
            exitEvent = event
            protocol.failAll(describeExit(event))
            this.handleExit(runtimeId, event)
          }
        }
      })

      const runtime: ActiveRuntime = {
        runtimeId,
        projectPath: projectDirectory,
        process: piProcess,
        protocol
      }
      this.active = runtime

      const outcome = await protocol.request(
        { type: 'get_state' },
        (line) => runtime.process.write(line),
        READY_TIMEOUT_MS
      )

      if (outcome.status === 'timeout') {
        throw new RuntimeFailure('RUNTIME_TIMEOUT', `Pi 在 ${READY_TIMEOUT_MS} 毫秒内没有返回 get_state 响应。`)
      }
      if (outcome.status === 'closed') {
        if (spawnFailure !== null) {
          throw new RuntimeFailure('RUNTIME_SPAWN_FAILED', `无法启动 Pi：${spawnFailure}`)
        }
        throw new RuntimeFailure('RUNTIME_EXITED', this.describeFailure(exitEvent, piProcess, outcome.reason))
      }
      if (protocolError !== null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', protocolError)
      }
      if (!outcome.response.success) {
        throw new RuntimeFailure(
          'RUNTIME_PROTOCOL_ERROR',
          `Pi 拒绝了 get_state：${outcome.response.error ?? '未提供错误信息'}`
        )
      }

      const info = toRuntimeInfo(outcome.response.data)
      if (info === null) {
        throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'get_state 响应缺少约定的会话字段。')
      }

      this.snapshot = { state: 'ready', runtimeId, info, lastError: null }
      return { ...this.snapshot }
    } catch (error) {
      // 只回收本次启动创建的进程，不触碰既有 Runtime。
      if (piProcess !== null) {
        if (this.active?.runtimeId === runtimeId) {
          this.active = null
        }
        await piProcess.stop()
      }
      if (error instanceof PiProcessError) {
        throw new RuntimeFailure('RUNTIME_SPAWN_FAILED', error.message)
      }
      throw error
    }
  }

  /** 退出结果只在该 Runtime 仍是当前代际时生效。 */
  private handleExit(runtimeId: number, event: PiExitEvent): void {
    const runtime = this.active
    if (runtime === null || runtime.runtimeId !== runtimeId) return
    this.active = null
    this.snapshot = {
      state: 'failed',
      runtimeId,
      info: null,
      lastError: this.describeFailure(event, runtime.process, null)
    }
  }

  /** 把退出事件、诊断尾巴与等待收敛原因合并成一条可展示的错误信息。 */
  private describeFailure(
    event: PiExitEvent | null,
    piProcess: PiProcess | null,
    reason: string | null
  ): string {
    const parts: string[] = []
    parts.push(event === null ? 'Pi 进程在就绪前结束。' : describeExit(event))
    if (reason !== null && reason.trim() !== '') parts.push(reason)
    const diagnostics = (piProcess?.readDiagnostics() ?? []).slice(-DIAGNOSTIC_TAIL_LINES)
    if (diagnostics.length > 0) parts.push(`最近诊断：${diagnostics.join(' | ')}`)
    return parts.join(' ')
  }

  /** 项目目录必须是存在的绝对目录，主进程不接受相对路径或其他启动参数。 */
  private async checkProjectPath(projectPath: unknown): Promise<string> {
    if (typeof projectPath !== 'string' || projectPath.trim() === '' || projectPath.includes('\u0000')) {
      throw new RuntimeFailure('INVALID_PROJECT_PATH', '项目目录必须是非空的绝对路径。')
    }
    const trimmed = projectPath.trim()
    if (!isAbsolute(trimmed)) {
      throw new RuntimeFailure('INVALID_PROJECT_PATH', '项目目录必须是绝对路径。')
    }
    const absolute = resolve(trimmed)

    let stats: Stats
    try {
      stats = await stat(absolute)
    } catch {
      throw new RuntimeFailure('INVALID_PROJECT_PATH', `项目目录不存在：${absolute}`)
    }
    if (!stats.isDirectory()) {
      throw new RuntimeFailure('INVALID_PROJECT_PATH', `项目路径不是目录：${absolute}`)
    }
    return absolute
  }
}
