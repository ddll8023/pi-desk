/**
 * SDK 宿主到既有页面契约的适配层：按会话运行注册表定位当前运行实例，把宿主与会话状态映射为
 * RuntimeStatus，把宿主失败分类映射为 Runtime/Session 错误码，并转发投影批次与 Extension UI 快照。
 *
 * 页面继续消费既有形状与错误码，因此这里不新增来源标识，也不改共享契约。
 *
 * 状态映射要点：页面 `runtimeId` 是注册表分配的应用级绑定代际（能力清单、投影快照与投影批次都按
 * 绑定代际对齐）；宿主就绪只代表 SDK 已加载，只有会话绑定完成才对页面表示 `ready`。
 */
import { SdkHostError, SDK_HOST_FAILURE_MESSAGES } from './sdk-host-manager'
import type { SdkHostErrorCode, SdkHostManager, SdkHostStatus } from './sdk-host-manager'
import { isSdkHostFailureCode, emptySdkSessionStatus } from '../sdk-host/protocol'
import type {
  SdkInterruptConfirmation, SdkSessionIdentity, SdkSessionReference, SdkSessionStatus
} from '../sdk-host/protocol'
import { SessionRunConflict } from './session-run-registry'
import type { SessionRunRecord, SessionRunRegistry } from './session-run-registry'
import type {
  CapabilitiesResult,
  McpCommandAction,
  McpCommandResult,
  McpStatusResult,
  OutputRate,
  ProjectionBatch,
  ProjectionResult,
  ProjectionSnapshot,
  PromptImageInput,
  PromptResult,
  ResourcesResult,
  RuntimeDiagnosticsResult,
  RuntimeError,
  RuntimeErrorCode,
  RuntimeInfo,
  RuntimeResult,
  RuntimeRewindRequest,
  RuntimeRewindResult,
  RuntimeSetModelRequest,
  RuntimeState,
  RuntimeStatus,
  SessionUsage
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

/**
 * 无活动绑定时页面期望的空基准：与页面既有空投影形状一致，
 * 页面把 `runtimeId: null` 当作有效空基准（不触发换代冲突）。
 */
const EMPTY_PROJECTION: ProjectionSnapshot = {
  runtimeId: null,
  seq: 0,
  messages: [],
  tools: [],
  truncated: false,
  droppedMessages: 0,
  droppedTools: 0
}

/** 会话状态直接提供模型身份、用量与速率；消息条数沿用投影的展示口径。 */
function mapInfo(session: SdkSessionStatus): RuntimeInfo {
  return {
    modelProvider: session.modelProvider,
    modelId: session.modelId,
    sessionId: session.sessionId,
    messageCount: session.messageCount,
    isStreaming: !session.isIdle,
    usage: session.usage,
    rate: session.rate
  }
}

/** 页面状态映射；故障码只用于可读提示，不代表可执行入口仍然有效。 */
function mapStatus(host: SdkHostStatus, session: SdkSessionStatus): RuntimeStatus {
  const state = mapState(host.state, session)
  // 宿主级失败码更接近根因；宿主健康时它为空，仍回落到会话级原因。
  const failure = host.lastError ?? session.lastError
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
    && left.info?.modelProvider === right.info?.modelProvider
    && left.info?.modelId === right.info?.modelId
    && left.info?.messageCount === right.info?.messageCount
    // 用量与速率是对象：按值比较，否则每次统计刷新都会被当成新状态广播。
    && sameUsage(left.info?.usage ?? null, right.info?.usage ?? null)
    && sameRate(left.info?.rate, right.info?.rate)
}

/** 用量按每个数值字段比较；未知与全零必须区分。 */
function sameUsage(left: SessionUsage | null, right: SessionUsage | null): boolean {
  if (left === null || right === null) return left === right
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
    && left.cost === right.cost
    && left.context?.tokens === right.context?.tokens
    && left.context?.contextWindow === right.context?.contextWindow
    && left.context?.percent === right.context?.percent
}

/** 速率按实时值与上一轮平均值比较。 */
function sameRate(left: OutputRate | undefined, right: OutputRate | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.live === right.live && left.average === right.average
}

/** 会话切换只表达目标与是否允许中断；身份与中断确认在提交前一刻由本层固定。 */
type SessionSwitchAction = 'new' | 'open' | 'reload'

/** 无运行实例时的页面状态：与宿主已建立但会话为空时一致。 */
const IDLE_STATUS: RuntimeStatus = { state: 'idle', runtimeId: null, info: null, lastError: null }

/** 宿主状态未建立时的空基线；与宿主初始快照一致。 */
const IDLE_HOST_STATUS: SdkHostStatus = { state: 'idle', hostId: null, sdkVersion: null, lastError: null }

/** 无运行实例时的 Extension UI 快照：没有代际也没有状态。 */
const EMPTY_EXTENSION_UI: ExtensionUiSnapshot = {
  runtimeId: null,
  seq: 0,
  state: { runtimeId: null, dialogs: [], notifications: [], statuses: [], widgets: [], editorText: null, invalidCount: 0 }
}

export interface SdkRuntimeBridgeOptions {
  /** 会话运行注册表：运行身份、绑定代际与会话占用的唯一登记处。 */
  readonly runs: SessionRunRegistry<SdkHostManager>
  /** 宿主按需建立；运行身份由注册表分配，授权回路由组合根接线。 */
  readonly createHost: (runId: number) => SdkHostManager
}

/**
 * 页面会话后端：按注册表定位当前运行实例；查询只读已持有状态，写操作只提交一次且不自动重发。
 * 没有运行实例时按未就绪收敛，不建立宿主也不伪造空结果。
 */
export class SdkRuntimeBridge {
  private readonly statusListeners = new Set<(status: RuntimeStatus) => void>()
  private readonly projectionListeners = new Set<(batch: ProjectionBatch) => void>()
  private readonly uiListeners = new Set<(snapshot: ExtensionUiSnapshot) => void>()
  private status: RuntimeStatus = IDLE_STATUS
  /** 无运行实例时对外仍报告空交互状态，不保留上一位运行实例的交互。 */
  private lastUi: ExtensionUiSnapshot = EMPTY_EXTENSION_UI
  private detachRun: (() => void) | null = null
  private shuttingDown = false

  constructor(private readonly options: SdkRuntimeBridgeOptions) {}

  /** 当前唯一运行实例的宿主；宿主可跨项目复用，因此按实例数而不是项目判定。 */
  private hostOf(): SdkHostManager | null {
    return this.options.runs.activeRun()?.owner ?? null
  }

  /**
   * 宿主动作入口：没有运行实例时按未就绪抛出，与旧实现中「宿主未建立」的行为一致。
   * 只读状态与身份查询不走这里，避免在 IPC 层产生未捕获异常。
   */
  private get host(): SdkHostManager {
    const host = this.hostOf()
    if (host === null) throw new SdkHostError('HOST_NOT_READY', SDK_HOST_FAILURE_MESSAGES.HOST_NOT_READY)
    return host
  }

  /** 宿主状态；没有运行实例时返回空闲基线。 */
  private currentHostStatus(): SdkHostStatus {
    return this.hostOf()?.getStatus() ?? IDLE_HOST_STATUS
  }

  /** 会话状态；没有运行实例时返回空会话状态，保持既有就绪判定不变。 */
  private currentSessionStatus(): SdkSessionStatus {
    return this.hostOf()?.getSessionStatus() ?? emptySdkSessionStatus()
  }

  /** 调用方固定的宿主与绑定身份；没有运行实例时两者都是 null。 */
  private currentSessionIdentity(): SdkSessionIdentity {
    return this.hostOf()?.getSessionIdentity() ?? { hostId: null, bindingId: null }
  }

  /** 宿主在启动、重绑与投影换代时都会经这里重新发布页面状态。 */
  private attachRun(runId: number, host: SdkHostManager): void {
    this.detachRun?.()
    const offStatus = host.onStatusChanged(status => {
      // 未确认退出的运行实例保留占用，未确认前不建立替代实例。
      if (status.state === 'failed') this.options.runs.markUnconfirmed(runId)
      this.publishStatus()
    })
    const offSession = host.onSessionChanged(() => this.publishStatus())
    const offProjection = host.onProjectionBatch(batch => {
      for (const listener of [...this.projectionListeners]) {
        try { listener(batch) } catch { /* 展示消费者不能改变会话所有权。 */ }
      }
    })
    const offUi = host.onExtensionUi(snapshot => {
      this.lastUi = snapshot
      for (const listener of [...this.uiListeners]) {
        try { listener(snapshot) } catch { /* 展示消费者不能改变会话所有权。 */ }
      }
    })
    this.detachRun = () => { offStatus(); offSession(); offProjection(); offUi() }
    this.publishStatus()
  }

  /** 运行实例按需建立：宿主可跨项目复用，且在退出编排开始后不再建立。 */
  private ensureRun(): SessionRunRecord<SdkHostManager> {
    if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能建立 SDK 宿主。')
    const existing = this.options.runs.activeRun()
    if (existing !== null) return existing
    const runId = this.options.runs.allocateRunId()
    const host = this.options.createHost(runId)
    const record = this.options.runs.registerRun(runId, host)
    this.options.runs.setForeground(runId)
    this.attachRun(runId, host)
    return record
  }

  /** 状态查询不建立宿主，也不触发任何会话操作；按当前运行实例即时映射，不返回缓存。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: mapStatus(this.currentHostStatus(), this.currentSessionStatus()) }
  }

  /** 状态广播只在映射结果变化时发给页面。 */
  onStatusChanged(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** 投影批次按运行实例转发；主进程不重算投影。 */
  onProjectionBatch(listener: (batch: ProjectionBatch) => void): () => void {
    this.projectionListeners.add(listener)
    return () => this.projectionListeners.delete(listener)
  }

  /** Extension UI 快照按运行实例转发，与宿主镜像同源，不需要第二份状态机。 */
  onExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  /**
   * 只释放活动会话并保留宿主；没有运行实例或宿主已失败时幂等返回当前状态，不新建宿主。
   * 释放前登记关闭中，释放未确认时保留占用，不用乐观成功掩盖未知结果。
   */
  async stop(): Promise<RuntimeResult> {
    const run = this.options.runs.activeRun()
    if (run === null) return this.getStatus()
    const hostStatus = run.owner.getStatus()
    if (hostStatus.hostId === null || hostStatus.state === 'failed') return this.getStatus()
    try {
      const current = run.owner.getSessionStatus()
      const interrupt = current.bindingId === null
        ? null : { bindingId: current.bindingId, activityVersion: current.activityVersion }
      this.options.runs.beginClose(run.runId)
      const result = await run.owner.runSessionAction('release', { kind: 'new' }, run.owner.getSessionIdentity(), interrupt)
      this.options.runs.release(run.runId)
      return { ok: true, data: mapStatus(run.owner.getStatus(), result.status) }
    } catch (error) {
      this.options.runs.markUnconfirmed(run.runId)
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 中止只作用于当前绑定；未绑定时按未就绪返回，不做本地预检。 */
  async abort(): Promise<RuntimeResult> {
    const session = this.currentSessionStatus()
    if (session.bindingId === null || session.phase !== 'bound') {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: 'Runtime 尚未就绪，无法中止当前操作。' } }
    }
    try {
      const host = this.host
      const status = await host.abortSession({ hostId: host.getSessionIdentity().hostId, bindingId: session.bindingId })
      return { ok: true, data: mapStatus(host.getStatus(), status) }
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

  /** 资源清单只读当前绑定；未绑定时按未就绪返回，不向宿主发请求，也不伪造空清单。 */
  async readResources(): Promise<ResourcesResult> {
    if (this.currentSessionStatus().bindingId === null) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话尚未就绪，无法读取资源清单。' } }
    }
    try {
      return { ok: true, data: await this.host.readResources() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 诊断只读当前绑定已持有的创建期诊断与 Extension 错误；
   * 无活动绑定时返回空结果（`runtimeId: null`），不用错误冒充「没有诊断」。
   */
  async readDiagnostics(): Promise<RuntimeDiagnosticsResult> {
    if (this.currentSessionStatus().bindingId === null) {
      return { ok: true, data: { runtimeId: null, stderrLines: [], extensionErrors: [] } }
    }
    try {
      return { ok: true, data: await this.host.readDiagnostics() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** MCP 状态只读当前绑定内的固定 `/mcp` 命令；未绑定时按未就绪返回。 */
  async readMcpStatus(): Promise<McpStatusResult> {
    if (this.currentSessionStatus().bindingId === null) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话尚未就绪，无法读取 MCP 状态。' } }
    }
    try {
      return { ok: true, data: await this.host.readMcpStatus() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** MCP 登录/退出/重连只提交受校验的动作与服务器名；命令文本与等待期限由宿主与主进程决定。 */
  async runMcpCommand(action: McpCommandAction, serverName: string): Promise<McpCommandResult> {
    if (this.currentSessionStatus().bindingId === null) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话尚未就绪，无法执行 MCP 操作。' } }
    }
    try {
      return { ok: true, data: await this.host.runMcpCommand(action, serverName) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 模型切换只针对页面所见的绑定代际；身份不符时不发宿主请求。 */
  async setModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
    if (this.currentSessionStatus().bindingId !== request.runtimeId) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话已切换，未向旧目标发送该操作。' } }
    }
    try {
      const host = this.host
      const status = await host.setSessionModel(request.provider, request.modelId)
      return { ok: true, data: mapStatus(host.getStatus(), status) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /**
   * 回退只回退对话分支：目标消息由宿主按投影身份定位，结果未知时标记 `blocked`，
   * 页面据此停止后续写操作，不自动重发；宿主侧追加窗口内到达的结果帧仍按真实结果返回。
   * `text` 在未取消时按页面契约补空串（页面不消费该字段）。
   */
  async rewind(request: RuntimeRewindRequest): Promise<RuntimeRewindResult> {
    const session = this.currentSessionStatus()
    if (session.bindingId !== request.runtimeId || session.sessionId !== request.sessionId) {
      return { ok: false, error: { code: 'RUNTIME_NOT_READY', message: '会话已切换，未向旧目标发送回退。' } }
    }
    try {
      const host = this.host
      const result = await host.rewind(request.messageId)
      // 宿主在结果帧之前已发布回退后的会话状态，因此这里读到的是权威实际状态。
      const status = mapStatus(host.getStatus(), host.getSessionStatus())
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
      const failure = runtimeErrorOf(error)
      // 结果未知会停止页面后续写入，文案必须给出唯一的恢复动作。
      return {
        ok: false,
        error: blocked
          ? { code: failure.code,
              message: `${failure.message} 回退结果未知；请重新打开会话恢复操作，不会自动重复回退。` }
          : failure,
        blocked
      }
    }
  }

  /**
   * 向宿主现取基准快照；未绑定时返回空基准（无会话不等于读取失败），
   * 绑定后仍由宿主回答，不伪造内容。
   */
  async getProjection(): Promise<ProjectionResult> {
    if (this.currentSessionStatus().bindingId === null) return { ok: true, data: EMPTY_PROJECTION }
    try {
      return { ok: true, data: await this.host.refreshProjection() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 确认只影响未确认窗口；不属于当前绑定的确认直接忽略。 */
  ackProjection(runtimeId: number, seq: number): void {
    if (this.currentSessionStatus().bindingId !== runtimeId) return
    void this.host.ackProjection(seq).catch(() => {})
  }

  /** Extension UI 镜像查询不建立宿主或会话；没有运行实例时是空交互。 */
  getExtensionUiSnapshot(): ExtensionUiSnapshot {
    return this.lastUi
  }

  /** 回应只在当前绑定内提交；已失效或不存在的对话返回 null，其余失败由调用方转成错误结果。 */
  async respondExtensionDialog(
    dialogId: string,
    response: ExtensionDialogResponseInput
  ): Promise<ExtensionUiSnapshot | null> {
    const identity = this.currentSessionIdentity()
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
    return this.currentSessionStatus()
  }

  /**
   * 会话切换提交：目标、归属项目与会话身份在提交前固定，调用方只表达目标与是否允许中断。
   * 打开前先在注册表登记占位，宿主侧实际重绑前的代际由主进程在授权应答中分配。
   */
  async switchSession(
    action: SessionSwitchAction,
    reference: SdkSessionReference,
    allowInterrupt: boolean,
    owner: { readonly projectPath: string; readonly sessionId: string | null }
  ): Promise<{ readonly cancelled: boolean }> {
    const run = this.ensureRun()
    try {
      this.options.runs.beginOpen(run.runId, owner.projectPath, owner.sessionId)
    } catch (error) {
      if (error instanceof SessionRunConflict) {
        throw new SdkHostError('SESSION_OPERATION_CONFLICT',
          '该会话或项目已有未收敛的运行实例，未重复接管；请等它结束后重试。')
      }
      throw error
    }
    const host = run.owner
    try {
      if (host.getSessionStatus().needsHostRebuild) await host.resetSessionHost()
      const current = host.getSessionStatus()
      const interrupt: SdkInterruptConfirmation | null = allowInterrupt && current.bindingId !== null
        ? { bindingId: current.bindingId, activityVersion: current.activityVersion }
        : null
      const result = await host.runSessionAction(action, reference, host.getSessionIdentity(), interrupt)
      this.options.runs.settleOpen(run.runId, host.getSessionStatus().sessionId)
      return { cancelled: result.cancelled }
    } catch (error) {
      this.options.runs.failOpen(run.runId)
      throw error
    }
  }

  /** 退出编排入口：先阻止所有新建与恢复，再对全部运行实例启动关闭。 */
  beginShutdown(): void {
    this.shuttingDown = true
    for (const run of this.options.runs.allRuns()) run.owner.beginShutdown()
  }

  /** 关闭全部宿主；任一未确认退出时如实抛出，不把关闭失败当作成功。 */
  async shutdown(): Promise<void> {
    this.beginShutdown()
    const failures: unknown[] = []
    await Promise.all(this.options.runs.allRuns().map(async run => {
      try {
        await run.owner.shutdown()
      } catch (error) {
        failures.push(error)
      }
    }))
    const failure = failures[0]
    if (failure !== undefined) throw failure
  }

  /** 映射结果变化时广播副本；订阅者异常不能改变宿主生命周期。 */
  private publishStatus(): void {
    const next = mapStatus(this.currentHostStatus(), this.currentSessionStatus())
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
