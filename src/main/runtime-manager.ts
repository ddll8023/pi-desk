/**
 * 唯一 Runtime 的所有者：状态机、启停编排、受限业务操作与状态快照。
 *
 * 不管理 Pi Session 或消息；进程与管道操作交给 pi-process，IPC 契约与校验在
 * shared/runtime-api.ts。不接受页面传入的可执行文件路径或启动参数，旧 Runtime
 * 的异步结果不得覆盖新状态。
 */
import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  PromptDisposition,
  PromptResult,
  RuntimeErrorCode,
  RuntimeResult,
  RuntimeStatus
} from '../shared/runtime-api'
import { PiProcess, PiProcessError } from './pi-process'
import type { PiExitEvent } from './pi-process'
import { PiProtocol, toPromptDisposition, toRuntimeInfo } from './pi-protocol'

/** get_state 就绪等待期限；超时只结束等待，不证明 Pi 没有响应。 */
const READY_TIMEOUT_MS = 10_000

/** prompt 只等待 preflight 的期限；超时只结束等待，结果未知且不自动重发。 */
const PROMPT_TIMEOUT_MS = 30_000

/** prompt 文本上限，按 UTF-8 字节计。 */
const PROMPT_MAX_BYTES = 1_048_576

/** 失败时回传给页面的诊断行数上限。 */
const DIAGNOSTIC_TAIL_LINES = 6

/** 状态变化订阅者；只在主进程内使用，不进 IPC 契约。 */
export type RuntimeStatusListener = (status: RuntimeStatus) => void

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
  private readonly listeners = new Set<RuntimeStatusListener>()
  /** 是否由主动关闭触发：用于区分正常关闭与异常退出。 */
  private stopRequested = false

  /** 订阅状态变化；返回释放函数。单个订阅者异常不影响 Runtime 状态。 */
  onStatusChanged(listener: RuntimeStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 启动唯一 Runtime；重复启动被拒绝，不做隐式重启。 */
  async start(projectPath: string): Promise<RuntimeResult> {
    try {
      return { ok: true, data: await this.launch(projectPath) }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '启动 Runtime 时发生未预期的内部错误。')
      // 由主动关闭引发的启动失败不覆盖关闭后的快照，但仍如实返回本次启动失败。
      if (!this.stopRequested) {
        this.publish({ ...this.snapshot, state: 'failed', info: null, lastError: failure.message })
      }
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /** 状态快照查询只读，不触发进程操作。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: { ...this.snapshot } }
  }

  /**
   * 提交 prompt 并返回请求接受或拒绝结果；不等待 Agent 执行结束。
   * busy、无模型与凭据问题一律由 Pi 的拒绝表达，主进程不做本地 streaming 预检。
   */
  async prompt(message: string): Promise<PromptResult> {
    try {
      return { ok: true, data: { disposition: await this.submitPrompt(message) } }
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure('INTERNAL_ERROR', '提交 Prompt 时发生未预期的内部错误。')
      // 请求失败不改写 Runtime 快照；进程真的退出时由退出路径负责收敛状态。
      return { ok: false, error: { code: failure.code, message: failure.message } }
    }
  }

  /**
   * 关闭当前 Runtime：停止接受新请求、关闭 stdin、等待退出，超时后按平台定向终止。
   * 关闭是幂等动作，没有 Runtime 时直接返回当前快照。
   */
  async stop(): Promise<RuntimeResult> {
    const runtime = this.active
    if (runtime === null) {
      return { ok: true, data: { ...this.snapshot } }
    }

    this.stopRequested = true
    this.publish({ state: 'stopping', runtimeId: runtime.runtimeId, info: null, lastError: null })
    await runtime.process.stop()

    if (this.active !== null && this.active.runtimeId === runtime.runtimeId) {
      // 进程未在期限内确认退出：按失败收敛，并解除归属以免留下无主 Runtime。
      this.active = null
      this.publish({
        state: 'failed',
        runtimeId: runtime.runtimeId,
        info: null,
        lastError: '关闭 Runtime 超时，未能确认相关 Pi 进程已退出。'
      })
    }
    return { ok: true, data: { ...this.snapshot } }
  }

  /** 应用退出时使用同一条关闭链；调用方负责在总预算内强制退出应用。 */
  async shutdown(): Promise<void> {
    await this.stop()
  }

  private async launch(projectPath: string): Promise<RuntimeStatus> {
    if (this.active !== null) {
      throw new RuntimeFailure(
        'RUNTIME_ALREADY_RUNNING',
        this.snapshot.state === 'stopping'
          ? 'Runtime 正在关闭，请稍后再启动。'
          : '已经有 Runtime 在运行；请先结束当前 Runtime。'
      )
    }

    this.stopRequested = false
    const projectDirectory = await this.checkProjectPath(projectPath)
    const runtimeId = (this.runtimeIdSeed += 1)
    this.publish({ state: 'starting', runtimeId, info: null, lastError: null })

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

      this.publish({ state: 'ready', runtimeId, info, lastError: null })
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

  /** 校验 prompt 文本并发送；只返回 disposition，不做本地 busy 判定。 */
  private async submitPrompt(message: string): Promise<PromptDisposition> {
    const runtime = this.active
    if (runtime === null || this.snapshot.state !== 'ready') {
      throw new RuntimeFailure('RUNTIME_NOT_READY', 'Runtime 尚未就绪，无法提交 Prompt；请先启动 Runtime。')
    }
    if (message.trim() === '') {
      throw new RuntimeFailure('INVALID_REQUEST', 'Prompt 内容不能为空。')
    }
    if (Buffer.byteLength(message, 'utf8') > PROMPT_MAX_BYTES) {
      throw new RuntimeFailure('INVALID_REQUEST', `Prompt 内容超过 ${PROMPT_MAX_BYTES} 字节上限。`)
    }

    const outcome = await runtime.protocol.request(
      { type: 'prompt', message },
      (line) => runtime.process.write(line),
      PROMPT_TIMEOUT_MS
    )

    if (outcome.status === 'timeout') {
      throw new RuntimeFailure(
        'RUNTIME_TIMEOUT',
        `Pi 在 ${PROMPT_TIMEOUT_MS} 毫秒内没有回应本次 Prompt；结果未知，不会自动重发。`
      )
    }
    if (outcome.status === 'closed') {
      throw new RuntimeFailure(
        'RUNTIME_EXITED',
        this.describeFailure(
          runtime.process.exitEvent,
          runtime.process,
          outcome.reason,
          'Pi 进程在本次 Prompt 期间结束了标准输入。'
        )
      )
    }
    if (!outcome.response.success) {
      throw new RuntimeFailure(
        'PROMPT_REJECTED',
        `Pi 拒绝了本次 Prompt：${outcome.response.error ?? '未提供错误信息'}`
      )
    }

    const disposition = toPromptDisposition(outcome.response.data)
    if (disposition === null) {
      throw new RuntimeFailure('RUNTIME_PROTOCOL_ERROR', 'prompt 响应缺少约定的 disposition 字段。')
    }
    return disposition
  }

  /** 退出结果只在该 Runtime 仍是当前代际时生效。 */
  private handleExit(runtimeId: number, event: PiExitEvent): void {
    const runtime = this.active
    if (runtime === null || runtime.runtimeId !== runtimeId) return
    this.active = null
    if (this.stopRequested) {
      // 主动关闭：进程按请求结束，回到 idle 并保留本次运行时标识。
      this.publish({ state: 'idle', runtimeId, info: null, lastError: null })
      return
    }
    this.publish({
      state: 'failed',
      runtimeId,
      info: null,
      lastError: this.describeFailure(event, runtime.process, null)
    })
  }

  /** 写入快照并通知订阅者；所有状态变化都必须经过这里。 */
  private publish(next: RuntimeStatus): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next })
      } catch {
        // 通知失败不改变 Runtime 状态。
      }
    }
  }

  /** 把退出事件、诊断尾巴与等待收敛原因合并成一条可展示的错误信息。 */
  private describeFailure(
    event: PiExitEvent | null,
    piProcess: PiProcess | null,
    reason: string | null,
    missingExitMessage = 'Pi 进程在就绪前结束。'
  ): string {
    const parts: string[] = []
    parts.push(event === null ? missingExitMessage : describeExit(event))
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
