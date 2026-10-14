/**
 * 会话列表、打开与重新加载编排的所有者：选择、新建、恢复与重载会话。
 *
 * 列表来自 Pi 管理的会话文件（session-store），按调用方显式给出的项目读取：侧栏按项目树展示会话，
 * 因此列表不再隐式取当前项目，但只接受已添加项目的规范路径。
 * 新建、打开、切换与重载都交给 SDK 宿主，由宿主在同一进程内替换会话，目标、归属与信任经本模块的
 * SDK 授权回路复核，授权依据是来源运行实例登记的归属项目，不是前台项目。
 * 多运行实例下打开其他会话不中断任何正在运行的会话；重载以目标会话自己的项目做信任复核。
 * 有活动操作而重载请求未确认时直接拒绝，不自动中断、不排队、不重放已提交的内容。
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
import { SdkHostError } from './sdk-host-manager'
import { sessionErrorOf } from './sdk-runtime-bridge'
import type { SdkRuntimeBridge } from './sdk-runtime-bridge'
import { SessionStorageError, listSessions, resolveSessionFile, resolveSdkSessionFile, getProjectSessionDir } from './session-store'
import { ProjectPathError, normalizeProjectPath } from './project-path'
import type { SessionRunSummary } from './session-run-registry'
import { isSdkSessionReference } from '../sdk-host/protocol'
import type { SdkHostFailureCode, SdkSessionReference, SdkSessionStatus, SdkSessionTarget } from '../sdk-host/protocol'

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
  /**
   * 当前项目来源、已添加项目范围与配置；只用于列表校验与界面上下文，不作为运行实例的授权依据。
   */
  readonly projects: ProjectManager
  /** 会话后端；列表之外的会话编排都经它提交。 */
  readonly sdk: SdkRuntimeBridge
  /** SDK 授权使用新鲜信任结果，不复用调用方传入的旧决定。 */
  readonly projectsTrust: import('./trust-manager').TrustManager
  /**
   * 运行实例归属查询：授权只认注册表登记的项目，不读前台选择；
   * 占用查询用于区分「会话由其他实例承载」与「列表已过期」。
   */
  readonly ownership: {
    isProjectActive(projectPath: string): boolean
    runOfSession(projectPath: string, sessionId: string): SessionRunSummary | null
  }
}

export class SessionManager {
  constructor(private readonly options: SessionManagerOptions) {}

  /**
   * SDK 内部目标授权：归属项目由调用方按来源运行实例给定，不读前台选择。
   * 无受保护资源但没有显式信任时按未信任建立，避免新出现的资源被隐式加载；
   * 异步读取前后都以注册表登记为准，前台切换不会改变已登记运行实例的授权范围。
   */
  async prepareSdkTarget(reference: SdkSessionReference, ownerProjectPath: string): Promise<SdkSessionTarget> {
    if (!isSdkSessionReference(reference)) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
    try {
      const projectPath = await normalizeProjectPath(ownerProjectPath)
      if (projectPath !== ownerProjectPath) throw new SdkTargetFailure('INVALID_SESSION_TARGET')
      const trust = await this.options.projectsTrust.refreshStatusOf(projectPath)
      if (trust.resources.length > 0 && trust.decision === null) throw new SdkTargetFailure('TRUST_REQUIRED')
      const identity = reference.kind === 'new' ? null : await resolveSdkSessionFile(projectPath, reference)
      if (!this.options.ownership.isProjectActive(projectPath)) throw new SdkTargetFailure('STALE_SESSION')
      return { projectPath, sessionDir: getProjectSessionDir(projectPath), trusted: trust.decision === 'trusted',
        sessionId: identity?.sessionId ?? null, sessionFile: identity?.sessionFile ?? null,
        fileStamp: identity?.fileStamp ?? null }
    } catch (error) {
      if (error instanceof SdkTargetFailure) throw error
      if (error instanceof SessionStorageError) throw new SdkTargetFailure('SESSION_NOT_FOUND')
      throw new SdkTargetFailure('AUTHORIZATION_FAILED')
    }
  }

  /**
   * 指定项目的会话列表；只接受已添加项目的规范路径，不要求它是当前项目。
   * 未添加的目录一律拒绝，页面不能借列表接口探测任意目录。
   */
  async list(projectPath: string): Promise<SessionListResult> {
    try {
      const requested = await normalizeProjectPath(projectPath)
      if (!await this.options.projects.hasProject(requested)) {
        throw new SessionFailure('INVALID_PROJECT_PATH', '只能读取已添加项目的会话。')
      }
      return { ok: true, data: await listSessions(requested) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '读取会话列表时发生未预期的内部错误。'
      })
    }
  }

  /** 打开或新建会话；成功时返回更新后的列表。 */
  async open(request: SessionOpenRequest): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyOpen(request) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '打开会话时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 新建与打开的公共门禁：请求的会话与前台实例已就绪会话一致时幂等返回，其余交给会话后端。
   * 多运行实例下打开其他会话不会中断任何正在运行的会话，因此这里不再要求中断确认；
   * `allowInterrupt` 仍在契约中保留，供后端在必须改变现有绑定且用户已确认时使用。
   */
  private async applyOpen(request: SessionOpenRequest): Promise<SessionList> {
    const projectPath = this.requireProjectPath()
    const status = this.backendStatus()

    if (request.sessionId !== null && status.state === 'ready'
      && status.info?.sessionId === request.sessionId) {
      return listSessions(projectPath)
    }
    // 已由某个运行实例承载的会话交给后端转前台复用：此时会话文件可能尚未落盘，不能当作列表过期。
    if (request.sessionId !== null && !this.isSessionOccupied(projectPath, request.sessionId)
      && await resolveSessionFile(projectPath, request.sessionId) === null) {
      throw new SessionFailure('SESSION_NOT_FOUND', '当前项目下找不到该会话；列表可能已过期。')
    }

    return this.openWithSdk(projectPath, request)
  }

  /** 该会话是否已由某个运行实例占用；占用覆盖打开中与未确认退出，与会话文件是否已落盘无关。 */
  private isSessionOccupied(projectPath: string, sessionId: string): boolean {
    return this.options.ownership.runOfSession(projectPath, sessionId) !== null
  }

  /**
   * SDK 主链：目标预检、信任判定与旧会话收敛都由宿主在替换前完成，
   * 这里只复核实际打开的会话；成功后的状态经事件收敛。
   */
  private async openWithSdk(projectPath: string, request: SessionOpenRequest): Promise<SessionList> {
    const switched = await this.options.sdk.switchSession(
      request.sessionId === null ? 'new' : 'open',
      request.sessionId === null ? { kind: 'new' } : { kind: 'id', sessionId: request.sessionId },
      request.allowInterrupt,
      { projectPath, sessionId: request.sessionId }
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

  /**
   * 重新加载 Pi 资源：宿主在同一进程内重建会话 services；守门与打开链复用，
   * 但不做“同会话幂等返回”，因为目的正是重建服务。
   */
  async reload(allowInterrupt: boolean): Promise<SessionOpenResult> {
    try {
      return { ok: true, data: await this.applyReload(allowInterrupt) }
    } catch (error) {
      return this.failure(error, {
        code: 'INTERNAL_ERROR',
        message: '重新加载 Pi 资源时发生未预期的内部错误。'
      })
    }
  }

  /**
   * 重载编排：目标是前台运行实例当前绑定的会话，目标与会话身份在提交前固定。
   * 信任按被重载会话的归属项目复核，避免用前台项目代替它的授权范围。
   */
  private async applyReload(allowInterrupt: boolean): Promise<SessionList> {
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

    // 宿主按目标会话重建 services；会话已有消息但文件缺失时由宿主拒绝。
    const bound = this.boundSessionOfForeground()
    if (bound === null) {
      throw new SessionFailure('RUNTIME_NOT_READY', '当前没有可重新加载的会话。')
    }
    const trust = await this.options.projectsTrust.refreshStatusOf(bound.projectPath)
    if (trust.resources.length > 0 && trust.decision === null) {
      throw new SessionFailure('TRUST_REQUIRED', '该会话所属项目包含需要信任决定的资源。')
    }
    const switched = await this.options.sdk.switchSession('reload', { kind: 'new' }, allowInterrupt,
      { projectPath: bound.projectPath, sessionId: bound.sessionId })
    if (switched.cancelled) {
      throw new SessionFailure('RUNTIME_COMMAND_REJECTED', '重新加载资源被取消，当前会话保持不变。')
    }
    return listSessions(projectPath)
  }

  /**
   * 前台运行实例当前绑定的会话；没有前台实例、尚未绑定或未登记归属项目时返回 null，
   * 调用方据此按未就绪拒绝，不用前台项目或本地缓存代替目标。
   */
  private boundSessionOfForeground(): {
    readonly projectPath: string
    readonly sessionId: string | null
  } | null {
    const runId = this.options.sdk.foregroundRunId()
    if (runId === null) return null
    const status: SdkSessionStatus | null = this.options.sdk.sessionStatusOfRun(runId)
    if (status === null || status.bindingId === null || status.projectPath === null) return null
    return { projectPath: status.projectPath, sessionId: status.sessionId }
  }

  private requireProjectPath(): string {
    const projectPath = this.options.projects.currentProjectPath()
    if (projectPath === null) {
      throw new SessionFailure('INVALID_PROJECT_PATH', '尚未选择项目，无法读取会话。')
    }
    return projectPath
  }

  /** 门禁与幂等判断都读会话后端的实际状态，不使用第二份快照。 */
  private backendStatus(): RuntimeStatus {
    const result = this.options.sdk.getStatus()
    if (!result.ok) {
      throw new SessionFailure('INTERNAL_ERROR', '无法读取 Runtime 状态。')
    }
    return result.data
  }

  private failure(error: unknown, fallback: SessionError): { ok: false; error: SessionError } {
    if (error instanceof SessionFailure) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    if (error instanceof ProjectPathError) {
      return { ok: false, error: { code: 'INVALID_PROJECT_PATH', message: error.message } }
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
