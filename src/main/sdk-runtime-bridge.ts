/**
 * SDK 宿主到既有页面契约的适配层：把宿主与会话状态映射为 RuntimeStatus，把宿主失败分类映射为
 * Runtime/Session 错误码，并转发投影批次与 Extension UI 快照。
 *
 * 页面继续消费既有形状与错误码，因此这里不新增来源标识，也不改共享契约；旧 RuntimeManager 只作为
 * 开发期显式退路保留，运行中不落回。
 *
 * 状态映射要点：页面 `runtimeId` 与宿主绑定代际同义（能力清单、投影快照与投影批次都按绑定编号对齐）；
 * 宿主就绪只代表 SDK 已加载，只有会话绑定完成才对页面表示 `ready`。
 */
import { SdkHostError } from './sdk-host-manager'
import type { SdkHostErrorCode, SdkHostManager, SdkHostStatus } from './sdk-host-manager'
import { isSdkHostFailureCode } from '../sdk-host/protocol'
import type { SdkInterruptConfirmation, SdkSessionReference, SdkSessionStatus } from '../sdk-host/protocol'
import type {
  CapabilitiesResult,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeInfo,
  RuntimeResult,
  RuntimeRewindRequest,
  RuntimeRewindResult,
  RuntimeSetModelRequest,
  RuntimeState,
  RuntimeStatus
} from '../shared/runtime-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../shared/extension-ui-api'
import type { SessionError, SessionErrorCode } from '../shared/session-api'

/** 页面 Runtime 通道可见的宿主失败分类；表是穷尽 Record，新增分类会在编译期暴露。 */
const RUNTIME_ERROR_CODES: Record<SdkHostErrorCode, RuntimeErrorCode> = {
  SDK_LOAD_FAILED: 'RUNTIME_SPAWN_FAILED',
  AGENT_DIR_MISMATCH: 'RUNTIME_SPAWN_FAILED',
  HOST_NOT_READY: 'RUNTIME_NOT_READY',
  INVALID_SESSION_TARGET: 'RUNTIME_NOT_READY',
  TRUST_REQUIRED: 'TRUST_REQUIRED',
  SESSION_NOT_FOUND: 'RUNTIME_NOT_READY',
  SESSION_BUSY: 'RUNTIME_COMMAND_REJECTED',
  STALE_SESSION: 'RUNTIME_NOT_READY',
  SESSION_OPERATION_CONFLICT: 'RUNTIME_COMMAND_REJECTED',
  SESSION_CREATE_FAILED: 'RUNTIME_SPAWN_FAILED',
  SESSION_BIND_FAILED: 'RUNTIME_SPAWN_FAILED',
  SESSION_CLOSE_FAILED: 'RUNTIME_EXITED',
  SESSION_RECOVERY_REQUIRED: 'RUNTIME_NOT_READY',
  AUTHORIZATION_FAILED: 'RUNTIME_NOT_READY',
  INTERACTION_INVALID: 'INVALID_REQUEST',
  HOST_ENTRY_MISSING: 'RUNTIME_SPAWN_FAILED',
  HOST_START_FAILED: 'RUNTIME_SPAWN_FAILED',
  HOST_PROTOCOL_ERROR: 'RUNTIME_PROTOCOL_ERROR',
  HOST_TIMEOUT: 'RUNTIME_TIMEOUT',
  HOST_EXITED: 'RUNTIME_EXITED',
  HOST_CLOSED: 'RUNTIME_EXITED',
  HOST_STOP_TIMEOUT: 'RUNTIME_EXITED'
}

/**
 * 会话通道沿用同一批分类，只把会话专有语义换成 Session 错误码：
 * 会话仍在执行必须落到 `SESSION_SWITCH_BLOCKED`，页面据此发起中断确认后重试。
 */
const SESSION_ERROR_CODES: Record<SdkHostErrorCode, SessionErrorCode> = {
  ...RUNTIME_ERROR_CODES,
  INVALID_SESSION_TARGET: 'INVALID_PROJECT_PATH',
  AUTHORIZATION_FAILED: 'INVALID_PROJECT_PATH',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_BUSY: 'SESSION_SWITCH_BLOCKED'
}

/** 未携带管理器文案的分类（如目标授权失败）只给安全默认文案。 */
const BARE_FAILURE_TEXT = '会话后端拒绝了该目标或授权。'

/** 只接受已声明的失败分类；未声明分类的异常按内部错误收敛，不向页面搬运原始文本。 */
function hostFailure(error: unknown): { readonly code: SdkHostErrorCode; readonly message: string } | null {
  if (error instanceof SdkHostError) return { code: error.code, message: error.message }
  if (typeof error === 'object' && error !== null && 'code' in error && isSdkHostFailureCode(error.code)) {
    return { code: error.code, message: BARE_FAILURE_TEXT }
  }
  return null
}

/** 运行通道失败结果；页面只看到固定分类与受控文案。 */
export function runtimeErrorOf(error: unknown): RuntimeError {
  const failure = hostFailure(error)
  if (failure === null) return { code: 'INTERNAL_ERROR', message: '会话后端发生未预期的内部错误。' }
  return { code: RUNTIME_ERROR_CODES[failure.code], message: failure.message }
}

/** 会话通道失败结果；由会话编排复用同一批分类。 */
export function sessionErrorOf(error: unknown): SessionError {
  const failure = hostFailure(error)
  if (failure === null) return { code: 'INTERNAL_ERROR', message: '会话后端发生未预期的内部错误。' }
  return { code: SESSION_ERROR_CODES[failure.code], message: failure.message }
}

/** 宿主状态与会话阶段共同决定页面状态：绑定的会话才表示可提交。 */
function mapState(host: SdkHostStatus['state'], session: SdkSessionStatus): RuntimeState {
  if (host === 'starting' || host === 'recovering') return 'starting'
  if (host === 'stopping') return 'stopping'
  if (host === 'failed') return 'failed'
  if (host === 'idle') return 'idle'
  if (session.phase === 'bound') return 'ready'
  if (session.phase === 'empty') return 'idle'
  if (session.phase === 'blocked' || session.phase === 'failed') return 'failed'
  // preparing 与 invalid 都是切换过程中的瞬态，按启动中展示而不是报故障。
  return 'starting'
}

/** SDK 会话状态不提供模型身份、用量与消息条数；这些字段留空由页面按未知展示。 */
function mapInfo(session: SdkSessionStatus): RuntimeInfo {
  return {
    modelProvider: null,
    modelId: null,
    sessionId: session.sessionId,
    messageCount: 0,
    isStreaming: !session.isIdle,
    usage: null,
    rate: { live: null, average: null }
  }
}

/** 页面状态映射；故障码只用于可读提示，不代表可执行入口仍然有效。 */
function mapStatus(host: SdkHostStatus, session: SdkSessionStatus): RuntimeStatus {
  const state = mapState(host.state, session)
  const failure = session.lastError ?? host.lastError
  return {
    state,
    runtimeId: session.bindingId,
    info: state === 'ready' ? mapInfo(session) : null,
    lastError: failure === null ? null : `会话后端故障（${failure}）：请重新打开会话或重启应用。`
  }
}

/** 状态订阅去重：消息推送期间频繁变化的会话状态不需要重复广播给页面。 */
function sameStatus(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.state === right.state
    && left.runtimeId === right.runtimeId
    && left.lastError === right.lastError
    && left.info?.sessionId === right.info?.sessionId
    && left.info?.isStreaming === right.info?.isStreaming
}

/** 会话切换只表达目标与是否允许中断；身份与中断确认在提交前一刻由本层固定。 */
type SessionSwitchAction = 'new' | 'open' | 'reload'

/**
 * 页面会话后端：查询只读已持有状态，写操作只提交一次且不自动重发；
 * 身份不符时直接拒绝，不把旧目标的动作送到新代际。
 */
export class SdkRuntimeBridge {
  private readonly statusListeners = new Set<(status: RuntimeStatus) => void>()
  private status: RuntimeStatus

  constructor(private readonly host: SdkHostManager) {
    this.status = mapStatus(host.getStatus(), host.getSessionStatus())
    // 宿主就绪与会话绑定是两个来源，任一变化都可能改变页面状态。
    host.onStatusChanged(() => this.publishStatus())
    host.onSessionChanged(() => this.publishStatus())
  }

  /** 状态查询不建立宿主，也不触发任何会话操作；按宿主当前镜像即时映射，不返回缓存。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: mapStatus(this.host.getStatus(), this.host.getSessionStatus()) }
  }

  /** 状态广播只在映射结果变化时发送给页面。 */
  onStatusChanged(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** 投影批次只转发宿主已定序的批次，主进程不重算投影。 */
  onProjectionBatch(listener: (batch: ProjectionBatch) => void): () => void {
    return this.host.onProjectionBatch(listener)
  }

  /** Extension UI 快照与宿主镜像同源，不需要第二份状态机。 */
  onExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
    return this.host.onExtensionUi(listener)
  }

  /** 建立宿主并新建会话；目标项目与信任由主进程校验后进入宿主授权回路。 */
  async start(): Promise<RuntimeResult> {
    try {
      const switched = await this.switchSession('new', { kind: 'new' }, false)
      if (switched.cancelled) {
        return { ok: false, error: { code: 'RUNTIME_COMMAND_REJECTED', message: '新建会话被取消，当前会话保持不变。' } }
      }
      return this.getStatus()
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 只释放活动会话并保留宿主；宿主未建立或已失败时幂等返回当前状态，不新建宿主。 */
  async stop(): Promise<RuntimeResult> {
    const host = this.host.getStatus()
    if (host.hostId === null || host.state === 'failed') return this.getStatus()
    try {
      const current = this.host.getSessionStatus()
      const interrupt = current.bindingId === null
        ? null : { bindingId: current.bindingId, activityVersion: current.activityVersion }
      const result = await this.host.runSessionAction('release', { kind: 'new' }, this.host.getSessionIdentity(), interrupt)
      return { ok: true, data: mapStatus(this.host.getStatus(), result.status) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 中止只作用于当前绑定；未绑定时按未就绪返回，不做本地预检。 */
  async abort(): Promise<RuntimeResult> {
    const session = this.host.getSessionStatus()
    if (session.bindingId === null || session.phase !== 'bound') {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: 'Runtime 尚未就绪，无法中止当前操作。' } }
    }
    try {
      const status = await this.host.abortSession({ hostId: this.host.getSessionIdentity().hostId, bindingId: session.bindingId })
      return { ok: true, data: mapStatus(this.host.getStatus(), status) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 提交只表达接受、排队或已处理；文本与图片仍由宿主再次校验。 */
  async prompt(message: string, images: readonly PromptImageInput[]): Promise<PromptResult> {
    try {
      return { ok: true, data: { disposition: await this.host.prompt(message, images) } }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 可用模型清单直接来自当前绑定；runtimeId 即绑定编号。 */
  async readCapabilities(): Promise<CapabilitiesResult> {
    try {
      return { ok: true, data: await this.host.readCapabilities() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 模型切换只针对页面所见的绑定代际；身份不符时不发宿主请求。 */
  async setModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
    if (this.host.getSessionStatus().bindingId !== request.runtimeId) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话已切换，未向旧目标发送该操作。' } }
    }
    try {
      const status = await this.host.setSessionModel(request.provider, request.modelId)
      return { ok: true, data: mapStatus(this.host.getStatus(), status) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /**
   * 回退只回退对话分支：目标消息由宿主按投影身份定位，结果未知时标记 `blocked`，
   * 页面据此停止后续写操作，不自动重发。`text` 在未取消时按页面契约补空串（页面不消费该字段）。
   */
  async rewind(request: RuntimeRewindRequest): Promise<RuntimeRewindResult> {
    const session = this.host.getSessionStatus()
    if (session.bindingId !== request.runtimeId || session.sessionId !== request.sessionId) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话已切换，未向旧目标发送回退。' } }
    }
    try {
      const result = await this.host.rewind(request.messageId)
      // 宿主在结果帧之前已发布回退后的会话状态，因此这里读到的是权威实际状态。
      const status = mapStatus(this.host.getStatus(), this.host.getSessionStatus())
      return {
        ok: true,
        data: {
          status,
          cancelled: result.cancelled,
          text: result.cancelled ? null : (result.text ?? '')
        }
      }
    } catch (error) {
      const blocked = error instanceof SdkHostError
        && (error.code === 'HOST_TIMEOUT' || error.code === 'HOST_EXITED' || error.code === 'HOST_CLOSED')
      return { ok: false, error: runtimeErrorOf(error), blocked }
    }
  }

  /** 向宿主现取基准快照；未绑定时返回错误，不伪造空投影。 */
  async getProjection(): Promise<ProjectionResult> {
    try {
      return { ok: true, data: await this.host.refreshProjection() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 确认只影响未确认窗口；不属于当前绑定的确认直接忽略。 */
  ackProjection(runtimeId: number, seq: number): void {
    if (this.host.getSessionStatus().bindingId !== runtimeId) return
    void this.host.ackProjection(seq).catch(() => {})
  }

  /** Extension UI 镜像查询不建立宿主或会话。 */
  getExtensionUiSnapshot(): ExtensionUiSnapshot {
    return this.host.getExtensionUiSnapshot()
  }

  /** 回应只在当前绑定内提交；已失效或不存在的对话返回 null，其余失败由调用方转成错误结果。 */
  async respondExtensionDialog(
    dialogId: string,
    response: ExtensionDialogResponseInput
  ): Promise<ExtensionUiSnapshot | null> {
    const identity = this.host.getSessionIdentity()
    if (identity.bindingId === null) return null
    try {
      await this.host.respondDialog({ hostId: identity.hostId, bindingId: identity.bindingId }, dialogId, response)
    } catch (error) {
      if (error instanceof SdkHostError && (error.code === 'INTERACTION_INVALID' || error.code === 'STALE_SESSION')) return null
      throw error
    }
    return this.host.getExtensionUiSnapshot()
  }

  /** 会话切换后的实际绑定状态；会话编排用它复核打开结果。 */
  getSessionStatus(): SdkSessionStatus {
    return this.host.getSessionStatus()
  }

  /**
   * 会话切换提交：身份与中断确认在提交前一刻固定，调用方只表达目标与是否允许中断。
   * 需要重建的宿主上下文先换成空基础设施，不重放上次失败的动作。
   */
  async switchSession(
    action: SessionSwitchAction,
    reference: SdkSessionReference,
    allowInterrupt: boolean
  ): Promise<{ readonly cancelled: boolean }> {
    if (this.host.getSessionStatus().needsHostRebuild) await this.host.resetSessionHost()
    const current = this.host.getSessionStatus()
    const interrupt: SdkInterruptConfirmation | null = allowInterrupt && current.bindingId !== null
      ? { bindingId: current.bindingId, activityVersion: current.activityVersion }
      : null
    const result = await this.host.runSessionAction(action, reference, this.host.getSessionIdentity(), interrupt)
    return { cancelled: result.cancelled }
  }

  /** 映射结果变化时广播副本；订阅者异常不能改变宿主生命周期。 */
  private publishStatus(): void {
    const next = mapStatus(this.host.getStatus(), this.host.getSessionStatus())
    if (sameStatus(next, this.status)) return
    this.status = next
    for (const listener of [...this.statusListeners]) {
      try {
        listener({ ...next })
      } catch {
        /* 消费者故障不影响宿主监督。 */
      }
    }
  }
}
