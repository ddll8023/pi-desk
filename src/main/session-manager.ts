/**
 * 当前项目会话列表与打开、分叉编排的所有者：选择、新建、恢复与从历史条目分叉会话。
 *
 * 列表来自 Pi 管理的会话文件（session-store），打开与切换一律复用 RuntimeManager 的关闭链后再
 * 以新参数启动，不在同一进程内切换会话；分叉先发 fork 命令、复核新会话 id 后复用同一条打开链。
 * 有活动操作而请求未确认时直接拒绝，不自动中断、不排队、不重放已提交的内容。
 * IPC 契约与校验在 shared/session-api.ts。
 */
import type {
  ForkMessageListResult,
  ForkStartRequest,
  ForkStartResult,
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
   * 读取当前 Runtime 会话里可分叉的用户消息；只要求 Runtime 就绪，不触发切换。
   */
  async forkMessages(): Promise<ForkMessageListResult> {
    const status = this.runtimeStatus()
    if (status.state !== 'ready') {
      return {
        ok: false,
        error: { code: 'RUNTIME_NOT_READY', message: 'Runtime 尚未就绪，无法分叉会话。' }
      }
    }
    const outcome = await this.options.runtime.readForkMessages()
    if (outcome.ok) return { ok: true, data: { messages: outcome.messages } }
    return { ok: false, error: { code: outcome.code, message: outcome.message } }
  }

  /**
   * 从指定条目分叉：先向 Pi 发 fork（当前进程内产生新会话），再复用打开链重启式切换到新会话。
   * Extension 取消以专属错误码如实返回；切换前的中断守门与信任决定语义与会话打开完全一致。
   */
  async startFork(
    request: ForkStartRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<ForkStartResult> {
    try {
      return { ok: true, data: await this.applyFork(request, trustDecision) }
    } catch (error) {
      if (error instanceof SessionFailure && error.code === 'FORK_CANCELLED') {
        return { ok: false, error: { code: error.code, message: error.message } }
      }
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '分叉会话时发生未预期的内部错误。'
      })
    }
  }

  /** fork 编排：中断守门 → fork 命令 → 复核新会话 → 重启式切换 → 返回刷新后的列表。 */
  private async applyFork(
    request: ForkStartRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<{ sessionId: string; list: SessionList }> {
    const status = this.runtimeStatus()
    if (status.state !== 'ready') {
      throw new SessionFailure('RUNTIME_NOT_READY', 'Runtime 尚未就绪，无法分叉会话。')
    }
    if (status.info?.isStreaming === true && !request.allowInterrupt) {
      throw new SessionFailure(
        'FORK_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再分叉。'
      )
    }

    const entryId = request.entryId
    if (entryId.trim() === '') {
      throw new SessionFailure('FORK_NOT_FOUND', '分叉条目 id 不能为空。')
    }

    const forked = await this.options.runtime.requestFork(entryId)
    if (!forked.ok) {
      throw new SessionFailure(forked.cancelled ? 'FORK_CANCELLED' : forked.code, forked.message)
    }

    // fork 后 Pi 已切换到新会话；读取实际会话 id，不再沿用旧快照。
    const refreshed = this.options.runtime.getStatus()
    if (!refreshed.ok) {
      throw new SessionFailure('INTERNAL_ERROR', refreshed.error.message)
    }
    const newSessionId = refreshed.data.info?.sessionId
    if (typeof newSessionId !== 'string' || newSessionId === '') {
      throw new SessionFailure(
        'RUNTIME_PROTOCOL_ERROR',
        '分叉后无法取得新会话 id；会话已切换，请刷新列表后手动打开。'
      )
    }

    // 复用打开链完成重启式切换：先结束旧 Runtime，再以新会话 id 启动。
    const opened = await this.applyOpen({ sessionId: newSessionId, allowInterrupt: true }, trustDecision)
    return { sessionId: newSessionId, list: opened }
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
