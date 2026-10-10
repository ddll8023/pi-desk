/**
 * 当前项目会话列表、打开与重新加载编排的所有者：选择、新建、恢复与重启式重载会话。
 *
 * 列表来自 Pi 管理的会话文件（session-store），打开与切换一律复用 RuntimeManager 的关闭链后再
 * 以新参数启动，不在同一进程内切换会话；
 * 重新加载资源只是“允许同会话重启”的同一条链（RPC 没有重载命令）。
 * 有活动操作而请求未确认时直接拒绝，不自动中断、不排队、不重放已提交的内容。
 * IPC 契约与校验在 shared/session-api.ts。
 */
import type {
  SessionError,
  SessionErrorCode,
  SessionList,
  SessionListResult,
  SessionOpenRequest,
  SessionOpenResult
} from '../shared/session-api'
import type { RuntimeStatus } from '../shared/runtime-api'
import type { ProjectManager } from './project-manager'
import type { RuntimeManager } from './runtime-manager'
import { SessionStorageError, listSessions, resolveSessionFile } from './session-store'

/** 可分类的会话操作失败；由公共方法统一转换为结果对象。 */
class SessionFailure extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface SessionManagerOptions {
  /** 当前项目来源；会话归属与 cwd 复核都以它为准。 */
  readonly projects: ProjectManager
  /** Runtime 的所有者；切换会话只使用既有关闭链与启动入口。 */
  readonly runtime: RuntimeManager
}

export class SessionManager {
  constructor(private readonly options: SessionManagerOptions) {}

  /** 当前项目的会话列表；不要求项目目录仍然存在。 */
  async list(): Promise<SessionListResult> {
    try {
      const projectPath = this.requireProjectPath()
      return { ok: true, data: await listSessions(projectPath) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取会话列表时发生未预期的内部错误。'
      })
    }
  }

  /** 打开或新建会话；成功时返回更新后的列表。`trustDecision` 来自主进程的信任探测。 */
  async open(
    request: SessionOpenRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyOpen(request, trustDecision) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '打开会话时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 先校验目标会话属于当前项目，再结束旧 Runtime，最后带会话参数启动新的 Runtime。
   * 请求的会话与已就绪 Runtime 一致时幂等返回，不做无谓重启。
   */
  private async applyOpen(
    request: SessionOpenRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    const projectPath = this.requireProjectPath()
    const status = this.runtimeStatus()

    if (status.state === 'starting' || status.state === 'stopping') {
      throw new SessionFailure('SESSION_SWITCH_BLOCKED', 'Runtime 正在启动或关闭，请稍后再切换会话。')
    }
    if (status.state === 'ready' && status.info?.isStreaming === true && !request.allowInterrupt) {
      throw new SessionFailure(
        'SESSION_SWITCH_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再切换会话。'
      )
    }
    if (request.sessionId !== null && status.state === 'ready'
      && status.info?.sessionId === request.sessionId) {
      return listSessions(projectPath)
    }
    if (request.sessionId !== null
      && await resolveSessionFile(projectPath, request.sessionId) === null) {
      throw new SessionFailure('SESSION_NOT_FOUND', '当前项目下找不到该会话；列表可能已过期。')
    }

    if (status.state === 'ready') {
      const stopped = await this.options.runtime.stop()
      if (!stopped.ok || stopped.data.state !== 'idle') {
        throw new SessionFailure(
          'SESSION_SWITCH_BLOCKED',
          '旧 Runtime 未确认退出，会话未切换；请先关闭 Runtime 后重试。'
        )
      }
    }

    const started = await this.options.runtime.start(projectPath, request.sessionId, trustDecision)
    if (!started.ok) throw new SessionFailure(started.error.code, started.error.message)
    if (request.sessionId !== null && started.data.info?.sessionId !== request.sessionId) {
      // `--session-id` 在会话缺失时会新建，因此必须复核实际打开的会话；不删除任何文件。
      throw new SessionFailure(
        'SESSION_NOT_FOUND',
        'Pi 打开的会话与请求不一致；可能新建了一个会话，未改动任何已有文件。'
      )
    }

    return listSessions(projectPath)
  }

  /**
   * 重新加载 Pi 资源：以当前会话重启 Runtime。RPC 没有重载命令（`/reload` 只在 TUI 内建），
   * 资源只在进程启动时读取，因此唯一的重载方式就是重启；守门与打开链完全复用，
   * 但不做“同会话幂等返回”，因为目的正是重建进程。
   */
  async reload(
    allowInterrupt: boolean,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyReload(allowInterrupt, trustDecision) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '重新加载 Pi 资源时发生未预期的内部错误。'
      })
    }
  }

  /** 重载编排：守门 → 结束旧 Runtime → 以同一会话 id 启动 → 返回刷新后的列表。 */
  private async applyReload(
    allowInterrupt: boolean,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    const projectPath = this.requireProjectPath()
    const status = this.runtimeStatus()
    if (status.state === 'starting' || status.state === 'stopping') {
      throw new SessionFailure('SESSION_SWITCH_BLOCKED', 'Runtime 正在启动或关闭，请稍后再重新加载资源。')
    }
    if (status.state === 'ready' && status.info?.isStreaming === true && !allowInterrupt) {
      throw new SessionFailure(
        'SESSION_SWITCH_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再重新加载资源。'
      )
    }
    // 会话 id 只来自本代际快照；取不到时交给 Pi 新建，不猜造其他会话。
    const sessionId = status.info?.sessionId ?? null
    if (status.state === 'ready') {
      const stopped = await this.options.runtime.stop()
      if (!stopped.ok || stopped.data.state !== 'idle') {
        throw new SessionFailure(
          'SESSION_SWITCH_BLOCKED',
          '旧 Runtime 未确认退出，资源未重新加载；请先关闭 Runtime 后重试。'
        )
      }
    }

    const started = await this.options.runtime.start(projectPath, sessionId, trustDecision)
    if (!started.ok) throw new SessionFailure(started.error.code, started.error.message)
    if (sessionId !== null && started.data.info?.sessionId !== sessionId) {
      // 会话不存在时 `--session-id` 会新建，因此必须复核；不删除任何文件。
      throw new SessionFailure(
        'SESSION_NOT_FOUND',
        '重载后 Pi 打开的会话与请求不一致；可能新建了一个会话，未改动任何已有文件。'
      )
    }

    return listSessions(projectPath)
  }

  private requireProjectPath(): string {
    const projectPath = this.options.projects.currentProjectPath()
    if (projectPath === null) {
      throw new SessionFailure('INVALID_PROJECT_PATH', '尚未选择项目，无法读取会话。')
    }
    return projectPath
  }

  private runtimeStatus(): RuntimeStatus {
    const result = this.options.runtime.getStatus()
    if (!result.ok) {
      throw new SessionFailure('INTERNAL_ERROR', '无法读取 Runtime 状态。')
    }
    return result.data
  }

  private failure(error: unknown, fallback: SessionError): { ok: false; error: SessionError } {
    if (error instanceof SessionFailure) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    if (error instanceof SessionStorageError) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } }
    }
    return { ok: false, error: fallback }
  }
}
