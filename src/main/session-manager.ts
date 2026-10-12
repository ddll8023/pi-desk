/**
 * 当前项目会话列表、打开与重新加载编排的所有者：选择、新建、恢复与重载会话。
 *
 * 列表来自 Pi 管理的会话文件（session-store）；新建、打开与切换默认交给 SDK 宿主，
 * 由宿主在同一进程内替换会话，目标、归属与信任经本模块的 SDK 授权回路复核。
 * 旧 RPC 链路只作为开发期显式退路（`legacyRpc`）：关闭旧进程后带参数重启，运行中不自动落回。
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
import { SdkHostError } from './sdk-host-manager'
import { sessionErrorOf } from './sdk-runtime-bridge'
import type { SdkRuntimeBridge } from './sdk-runtime-bridge'
import { SessionStorageError, listSessions, resolveSessionFile, resolveSdkSessionFile, getProjectSessionDir } from './session-store'
import { normalizeProjectPath } from './project-path'
import { isSdkSessionReference } from '../sdk-host/protocol'
import type { SdkHostFailureCode, SdkSessionReference, SdkSessionTarget } from '../sdk-host/protocol'

/** SDK 目标授权失败只返回分类，底层路径与配置异常不作为宿主通信载荷。 */
export class SdkTargetFailure extends Error {
  constructor(readonly code: SdkHostFailureCode) { super(code) }
}

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
  /** 旧 RPC 后端；只在开发期退路下承担会话主链。 */
  readonly runtime: RuntimeManager
  /** SDK 会话后端；默认的会话主链。 */
  readonly sdk: SdkRuntimeBridge
  /** 开发期显式退路：为真时仍走旧 RPC 关闭重启链，为假时一律走 SDK 宿主。 */
  readonly legacyRpc: boolean
  /** SDK 授权使用新鲜信任结果；既有 RPC 打开入口仍沿用调用方传入的决定。 */
  readonly projectsTrust: import('./trust-manager').TrustManager
}

export class SessionManager {
  constructor(private readonly options: SessionManagerOptions) {}

  /**
   * SDK 内部目标授权：当前项目与旧后端所有权在所有异步读取前后复核。
   * 无受保护资源但没有显式信任时按未信任建立，避免新出现的资源被隐式加载。
   */
  async prepareSdkTarget(reference: SdkSessionReference, expectedProjectPath: string | null): Promise<SdkSessionTarget> {
    if (!isSdkSessionReference(reference)) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
    const projectPath = this.options.projects.currentProjectPath()
    if (projectPath === null || (expectedProjectPath !== null && expectedProjectPath !== projectPath)) {
      throw new SdkTargetFailure('INVALID_SESSION_TARGET')
    }
    this.requireLegacyReleased()
    try {
      if (await normalizeProjectPath(projectPath) !== projectPath) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
      const trust = await this.options.projectsTrust.refreshStatusOf(projectPath)
      if (trust.resources.length > 0 && trust.decision === null) throw new SdkTargetFailure('TRUST_REQUIRED')
      const identity = reference.kind === 'new' ? null : await resolveSdkSessionFile(projectPath, reference)
      if (this.options.projects.currentProjectPath() !== projectPath) throw new SdkTargetFailure('STALE_SESSION')
      this.requireLegacyReleased()
      return { projectPath, sessionDir: getProjectSessionDir(projectPath), trusted: trust.decision === 'trusted',
        sessionId: identity?.sessionId ?? null, sessionFile: identity?.sessionFile ?? null,
        fileStamp: identity?.fileStamp ?? null }
    } catch (error) {
      if (error instanceof SdkTargetFailure) throw error
      if (error instanceof SessionStorageError) throw new SdkTargetFailure('SESSION_NOT_FOUND')
      throw new SdkTargetFailure('AUTHORIZATION_FAILED')
    }
  }

  /** failed 不证明旧进程已退出；只允许明确 idle 后才由 SDK 接管。 */
  private requireLegacyReleased(): void {
    const status = this.options.runtime.getStatus()
    if (!status.ok || status.data.state !== 'idle') throw new SdkTargetFailure('SESSION_OPERATION_CONFLICT')
  }

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
   * 新建与打开的公共门禁：按当前后端状态判断忙碌与幂等，再按后端分派实际切换。
   * 请求的会话与已就绪会话一致时幂等返回，不做无谓替换。
   */
  private async applyOpen(
    request: SessionOpenRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    const projectPath = this.requireProjectPath()
    const status = this.backendStatus()

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

    return this.options.legacyRpc
      ? this.openWithLegacyRpc(projectPath, request, trustDecision)
      : this.openWithSdk(projectPath, request)
  }

  /**
   * SDK 主链：目标预检、信任判定与旧会话收敛都由宿主在替换前完成，
   * 这里只复核实际打开的会话；成功后的状态经事件收敛。
   */
  private async openWithSdk(projectPath: string, request: SessionOpenRequest): Promise<SessionList> {
    const switched = await this.options.sdk.switchSession(
      request.sessionId === null ? 'new' : 'open',
      request.sessionId === null ? { kind: 'new' } : { kind: 'id', sessionId: request.sessionId },
      request.allowInterrupt
    )
    if (switched.cancelled) {
      throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '会话切换被取消，当前会话保持不变。')
    }
    if (request.sessionId !== null && this.options.sdk.getSessionStatus().sessionId !== request.sessionId) {
      // 目标一致性由宿主预检保证；这里只复核实际打开的会话，不删除任何文件。
      throw new SessionFailure('SESSION_NOT_FOUND', '实际打开的会话与请求不一致；未改动任何已有文件。')
    }
    return listSessions(projectPath)
  }

  /** 开发期退路：结束旧 Runtime 后带会话参数重启一次。 */
  private async openWithLegacyRpc(
    projectPath: string,
    request: SessionOpenRequest,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    if (this.backendStatus().state === 'ready') {
      const stopped = await this.options.runtime.stop()
      if (!stopped.ok || stopped.data.state !== 'idle') {
        throw new SessionFailure(
          'SESSION_SWITCH_BLOCKED',
          '旧 Runtime 未确认退出，会话未切换；请先关闭 Runtime 后重试。'
        )
      }
    }

    const started = await this.options.runtime.start(projectPath, request.sessionId, trustDecision, false)
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
   * 重新加载 Pi 资源：SDK 主链在同一宿主内重建会话 services，
   * 开发期退路则以当前会话重启旧 Runtime；守门与打开链复用，
   * 但不做“同会话幂等返回”，因为目的正是重建进程/服务。
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

  /** 重载编排：守门后按当前后端重新绑定同一会话的能力。 */
  private async applyReload(
    allowInterrupt: boolean,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    const projectPath = this.requireProjectPath()
    const status = this.backendStatus()
    if (status.state === 'starting' || status.state === 'stopping') {
      throw new SessionFailure('SESSION_SWITCH_BLOCKED', 'Runtime 正在启动或关闭，请稍后再重新加载资源。')
    }
    if (status.state === 'ready' && status.info?.isStreaming === true && !allowInterrupt) {
      throw new SessionFailure(
        'SESSION_SWITCH_BLOCKED',
        '当前有正在运行的操作；确认后会先停止它再重新加载资源。'
      )
    }

    if (this.options.legacyRpc) return this.reloadWithLegacyRpc(projectPath, allowInterrupt, trustDecision)
    // 宿主按当前会话重建 services；会话已有消息但文件缺失时由宿主拒绝。
    const switched = await this.options.sdk.switchSession('reload', { kind: 'new' }, allowInterrupt)
    if (switched.cancelled) {
      throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '重新加载资源被取消，当前会话保持不变。')
    }
    return listSessions(projectPath)
  }

  /** 开发期退路：以当前会话 id 结束旧 Runtime 再启动（RPC 没有重载命令）。 */
  private async reloadWithLegacyRpc(
    projectPath: string,
    allowInterrupt: boolean,
    trustDecision: 'trusted' | 'untrusted' | null
  ): Promise<SessionList> {
    const status = this.backendStatus()
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

  /** 门禁与幂等判断都读当前后端的实际状态，两个后端不共用一份快照。 */
  private backendStatus(): RuntimeStatus {
    const result = this.options.legacyRpc
      ? this.options.runtime.getStatus()
      : this.options.sdk.getStatus()
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
    // 宿主与会话授权失败按固定分类映射；未知异常仍收敛为调用方的兜底错误。
    if (error instanceof SdkHostError || error instanceof SdkTargetFailure) {
      return { ok: false, error: sessionErrorOf(error) }
    }
    return { ok: false, error: fallback }
  }
}
