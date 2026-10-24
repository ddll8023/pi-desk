/**
 * SDK 宿主到既有页面契约的适配层：按会话运行注册表定位目标运行实例，把宿主与会话状态映射为
 * RuntimeStatus，把宿主失败分类映射为 Runtime/Session 错误码，转发投影批次与 Extension UI 快照，
 * 并向页面提供全部运行实例的粗粒度状态列表。
 *
 * 页面用二维身份寻址：`runId` 定位运行实例，`runtimeId` 固定发起时所见绑定代际；动作只在两者都
 * 与该实例当前状态一致时才发给宿主，不向旧目标转发。投影批次与 Extension UI 快照按来源实例转发，
 * 页面按来源会话分片保存，只有前台实例的内容进入展示；运行状态列表覆盖全部实例，只含低频字段。
 *
 * 状态映射要点：页面 `runtimeId` 是注册表分配的应用级绑定代际（能力清单、投影快照与投影批次都按
 * 绑定代际对齐）；宿主就绪只代表 SDK 已加载，只有会话绑定完成才对页面表示 `ready`。
 *
 * 前台选择由项目切换驱动：当前项目变化时切到该项目最近一次前台的实例，未命中则清空前台。
 * 项目切换只改执行实例的展示归属，不建立执行宿主、不重绑会话、不中断任何后台实例。
 * 前台实例不参与空闲回收：切走或清空前台后才重新计时。
 * 空会话释放是唯一例外：绑定还没有任何消息落盘的会话且完全空闲的实例，在让出前台或切换会话时
 * 直接解除占用——这类会话没有文件、无法从列表重开，保留只会留下「未命名会话」占位行。
 *
 * 查看历史不新增执行占用：优先复用原服务宿主，再借同项目执行宿主或只读池，不改变前台选择；
 * 池中宿主不登记运行实例，真正绑定时才被接管，进程内缓存与检查点因此可以继续复用。
 */
import { HOST_IDLE_RECLAIM_MS, SdkHostError, SDK_HOST_FAILURE_MESSAGES } from './sdk-host-manager'
import type { SdkHostErrorCode, SdkHostManager, SdkHostStatus } from './sdk-host-manager'
import { isSdkHostFailureCode, emptySdkSessionStatus } from '../../sdk-host/protocol'
import type {
  SdkInterruptConfirmation, SdkLogTarget, SdkSessionReference, SdkSessionStatus
} from '../../sdk-host/protocol'
import { SessionRunConflict } from './session-run-registry'
import type { LogHostHandle, LogHostPool } from './log-host-pool'
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
  RuntimeCompactRequest,
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
  RuntimeTarget,
  HistoryData,
  HistoryQuery,
  SessionUsage
} from '../../shared/runtime-api'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../../shared/extension-ui-api'
import type { SessionError, SessionErrorCode } from '../../shared/session-api'
import type { SessionRunState, SessionRunsSnapshot } from '../../shared/session-run-api'

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

/**
 * 目标不成立：实例不存在或退出未确认。动作一律不发送，
 * 也不用本地猜测的目标替代页面所指的运行实例。
 */
const TARGET_CHANGED_ERROR: RuntimeError = {
  code: 'RUNTIME_NOT_READY',
  message: '目标运行实例已变化或尚未就绪，未发送该操作。'
}

/** 目标实例存在但没有活动绑定；读取资源、提交与交互都要求已绑定会话。 */
const UNBOUND_ERROR: RuntimeError = {
  code: 'RUNTIME_NOT_READY',
  message: '目标运行实例尚未绑定会话，未发送该操作。'
}

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

/** 池租约与执行宿主的统一读取句柄；执行宿主的回收由读取收尾重新安排。 */
type LogReadLease = Pick<LogHostHandle, 'host' | 'release'>

/** 日志宿主记忆键：项目与会话都可能含任意字符，用 NUL 分隔避免拼接歧义。 */
function logHostKey(projectPath: string, sessionId: string): string {
  return `${projectPath}\u0000${sessionId}`
}

/** 日志宿主记忆条数上限：只需要覆盖最近查看过的会话。 */
const LOG_HOST_MEMORY = 32

/** 路径比较与注册表一致：Windows 折叠大小写，其他平台严格比较；用于实例能否跨项目复用。 */
function sameProjectPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
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
  runId: null,
  runtimeId: null,
  seq: 0,
  messages: [],
  tools: [],
  truncated: false,
  droppedMessages: 0,
  droppedTools: 0,
  history: { before: null, revision: 0 }
}

/** 会话状态直接提供模型身份、用量与速率；消息条数沿用投影的展示口径。 */
function mapInfo(session: SdkSessionStatus): RuntimeInfo {
  return {
    modelProvider: session.modelProvider,
    modelId: session.modelId,
    sessionId: session.sessionId,
    messageCount: session.messageCount,
    isStreaming: !session.isIdle,
    isCompacting: session.isCompacting,
    usage: session.usage,
    rate: session.rate
  }
}

/** 页面状态映射；故障码只用于可读提示，不代表可执行入口仍然有效。 */
function mapStatus(host: SdkHostStatus, session: SdkSessionStatus, runId: number): RuntimeStatus {
  // 宿主进程已释放但会话身份仍在：这是空闲回收后的挂起态，页面按「上次 Runtime 已关闭」展示。
  const suspended = host.hostId === null && session.sessionId !== null
  const state = suspended ? 'idle' : mapState(host.state, session)
  // 宿主级失败码更接近根因；宿主健康时它为空，仍回落到会话级原因。
  const failure = host.lastError ?? session.lastError
  return {
    state,
    runId,
    runtimeId: session.bindingId,
    sessionId: session.sessionId,
    info: state === 'ready' ? mapInfo(session) : null,
    sdkVersion: host.sdkVersion,
    lastError: failure === null ? null : `会话后端故障（${failure}）：请重新打开会话或重启应用。`
  }
}

/** 状态订阅去重：消息推送期间频繁变化的会话状态不需要重复广播给页面，运行实例与 SDK 版本变化必须广播。 */
function sameStatus(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.state === right.state
    && left.runId === right.runId
    && left.runtimeId === right.runtimeId
    && left.sessionId === right.sessionId
    && left.sdkVersion === right.sdkVersion
    && left.lastError === right.lastError
    && left.info?.sessionId === right.info?.sessionId
    && left.info?.isStreaming === right.info?.isStreaming
    && left.info?.isCompacting === right.info?.isCompacting
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

/** 速率按上一轮平均值比较。 */
function sameRate(left: OutputRate | undefined, right: OutputRate | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.average === right.average
}

/** 运行状态列表去重：只比较展示字段，顺序由注册表登记顺序决定。 */
function sameRuns(left: readonly SessionRunState[], right: readonly SessionRunState[]): boolean {
  if (left.length !== right.length) return false
  return left.every((run, index) => {
    const other = right[index]
    return other !== undefined
      && run.runId === other.runId
      && run.projectPath === other.projectPath
      && run.sessionId === other.sessionId
      && run.phase === other.phase
      && run.isForeground === other.isForeground
      && run.isStreaming === other.isStreaming
      && run.hasMessages === other.hasMessages
      && run.waitingDialogs === other.waitingDialogs
      && run.hostState === other.hostState
  })
}

/** 会话切换只表达目标与是否允许中断；身份与中断确认在提交前一刻由本层固定。 */
type SessionSwitchAction = 'new' | 'open' | 'reload'

/** 会话归属：调用方按来源会话给出项目与会话身份，本层只按它寻址运行实例。 */
interface SessionOwner {
  readonly projectPath: string
  readonly sessionId: string | null
}

/** 无前台运行实例时的页面状态：与宿主已建立但会话为空时一致。 */
const IDLE_STATUS: RuntimeStatus = {
  state: 'idle', runId: null, runtimeId: null, sessionId: null, info: null, sdkVersion: null, lastError: null
}

/**
 * 空闲回收宽限期：宿主空闲这段时间后释放进程，下一次需要宿主的动作再恢复。
 * 时限取 `HOST_IDLE_RECLAIM_MS`，与只读解析宿主共用，两处不会各写一个数而悄悄漂移。
 */

/** 无运行实例时的 Extension UI 快照：没有来源、没有代际也没有状态。 */
const EMPTY_EXTENSION_UI: ExtensionUiSnapshot = {
  runId: null,
  runtimeId: null,
  seq: 0,
  state: { runtimeId: null, dialogs: [], notifications: [], statuses: [], widgets: [], editorText: null, invalidCount: 0 }
}

export interface SdkRuntimeBridgeOptions {
  /** 会话运行注册表：运行身份、绑定代际与会话占用的唯一登记处。 */
  readonly runs: SessionRunRegistry<SdkHostManager>
  /** 宿主按需建立；运行身份由注册表分配，授权回路由组合根接线。 */
  readonly createHost: (runId: number) => SdkHostManager
  /**
   * 接上授权回路：新建宿主与从只读池接管宿主都走同一处接线，
   * 「查看」与「执行」因此共用一套进程而不会出现两种身份。
   */
  readonly prepareHost: (host: SdkHostManager) => void
  /** 只读宿主池：查看历史使用的解析进程，不属于运行实例，也不参与占用判定。 */
  readonly logHosts: LogHostPool
}

/**
 * 页面会话后端：按运行实例寻址；查询只读已持有状态，写操作只提交一次且不自动重发。
 * 目标不成立时按未就绪拒绝，不建立宿主也不伪造空结果。
 */
export class SdkRuntimeBridge {
  private readonly statusListeners = new Set<(status: RuntimeStatus) => void>()
  private readonly projectionListeners = new Set<(batch: ProjectionBatch) => void>()
  private readonly uiListeners = new Set<(snapshot: ExtensionUiSnapshot) => void>()
  private readonly runsListeners = new Set<(snapshot: SessionRunsSnapshot) => void>()
  private status: RuntimeStatus = IDLE_STATUS
  /** 上一次广播的运行实例状态列表；只比较展示字段。 */
  private runs: readonly SessionRunState[] = []
  /** 运行实例到事件订阅的映射：每个实例只在建立时挂接一次，停止时逐个释放。 */
  private readonly detachers = new Map<number, () => void>()
  /** 按运行实例的空闲回收计时器；到期后复核空闲并释放宿主进程。 */
  private readonly reclaimTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** 正在进行的回收：新的提交等它收敛后再恢复，不与释放竞争。 */
  private readonly reclaiming = new Map<number, Promise<void>>()
  private shuttingDown = false
  /** 前台选择序号：打开与重载提交时递增，用于不让先提交后完成的选择把前台改回旧目标。 */
  private selectionSeed = 0
  /** 按对象记住原服务宿主；读取与绑定都能复用，池身份移交后也不会留下过期编号。 */
  private readonly logHosts = new Map<string, SdkHostManager>()
  /** 只读池关闭只启动一次；立即接住拒绝并保留结果，关闭时统一等待。 */
  private logHostShutdown: Promise<PromiseSettledResult<void>> | null = null

  constructor(private readonly options: SdkRuntimeBridgeOptions) {}

  /** 前台运行实例的运行身份；没有前台实例时为 null。页面据此过滤事件来源。 */
  foregroundRunId(): number | null {
    return this.options.runs.foreground()?.runId ?? null
  }

  /**
   * 开始一次前台选择：返回本次选择的序号，提交方在完成后凭它判断自己是否已被更晚的选择取代。
   * 序号只在主进程内有效，不交给页面，因此页面不能影响前台的先后顺序。
   */
  beginSelection(): number {
    return ++this.selectionSeed
  }

  /**
   * 选择完成后的归属收敛：本次选择已被更晚的选择取代时，按登记把前台还给该项目最近一次前台的实例，
   * 不把前台留在本次目标上。这样慢请求完成时不会把用户已经切走的会话又拉回前台。
   */
  private settleSelection(selection: number, owner: SessionOwner): void {
    if (selection === this.selectionSeed) return
    this.focusProject(owner.projectPath)
  }

  /** 指定身份的运行实例；未知身份返回 null，查询不建立宿主。 */
  private runOf(runId: number): SessionRunRecord<SdkHostManager> | null {
    return this.options.runs.allRuns().find(run => run.runId === runId) ?? null
  }

  /**
   * 目标实例与绑定代际复核：实例必须存在且不是未确认退出，`runtimeId` 非空时必须与当前绑定一致。
   * 返回当前绑定编号（未绑定时为 null），让调用方区分「实例存在但尚未绑定」与「目标不成立」。
   */
  private matchedRun(target: RuntimeTarget): {
    readonly run: SessionRunRecord<SdkHostManager>
    readonly bindingId: number | null
  } | null {
    const run = this.runOf(target.runId)
    if (run === null || run.phase === 'unconfirmed') return null
    const bindingId = run.owner.getSessionStatus().bindingId
    if (target.runtimeId !== null && bindingId !== target.runtimeId) return null
    return { run, bindingId }
  }

  /** 宿主尚未建立或已失败：不再等待它的结果，也不再向它提交动作。 */
  private hostUnavailable(run: SessionRunRecord<SdkHostManager>): boolean {
    const host = run.owner.getStatus()
    return host.hostId === null || host.state === 'failed'
  }

  /** 前台实例的状态映射；没有前台实例时是空闲空基准。 */
  private foregroundStatus(): RuntimeStatus {
    const run = this.options.runs.foreground()
    if (run === null) return IDLE_STATUS
    return mapStatus(run.owner.getStatus(), run.owner.getSessionStatus(), run.runId)
  }

  /** 每个运行实例只挂接一次：状态、会话、投影与交互都按实例订阅，便于按实例释放。 */
  private attachRun(runId: number, host: SdkHostManager): void {
    this.detachers.get(runId)?.()
    const offStatus = host.onStatusChanged(status => {
      // 未确认退出的运行实例保留占用，未确认前不建立替代实例。
      if (status.state === 'failed') this.options.runs.markUnconfirmed(runId)
      this.publishStatus()
      this.scheduleReclaim(runId)
    })
    const offSession = host.onSessionChanged(() => {
      this.syncRunSession(runId)
      this.publishState()
      this.scheduleReclaim(runId)
    })
    const offProjection = host.onProjectionBatch(batch => this.forwardBatch(runId, batch))
    const offUi = host.onExtensionUi(snapshot => this.forwardUi(runId, snapshot))
    this.detachers.set(runId, () => {
      offStatus(); offSession(); offProjection(); offUi()
      this.cancelReclaim(runId)
    })
    this.publishState()
  }

  /**
   * 宿主侧会话替换（回退的 fork、扩展新建或切换会话）会换掉会话身份，登记必须跟上：
   * 只收敛运行中的实例，不干扰打开、关闭与未确认窗口；身份一致时不动作。
   */
  private syncRunSession(runId: number): void {
    const run = this.runOf(runId)
    if (run === null || run.phase !== 'running') return
    const status = run.owner.getSessionStatus()
    // 只采纳宿主已确认绑定的身份：替换过程中会先上报一次无会话，不能当作新占用。
    if (status.phase !== 'bound' || status.sessionId === run.sessionId) return
    this.options.runs.settleOpen(runId, status.sessionId)
  }

  /**
   * 空闲回收计时：只在真正空闲时安排，其他情况取消已有时计。
   * 当前显示的前台实例豁免回收，避免用户正在看的对话被挂起；它随前台切换交还资格。
   * 状态查询与投影读取不调用它，因此渲染不会无限延长宿主寿命。
   */
  private scheduleReclaim(runId: number): void {
    if (this.shuttingDown) return
    const run = this.runOf(runId)
    if (run === null || this.foregroundRunId() === runId || !run.owner.isIdleForReclaim()) {
      this.cancelReclaim(runId)
      return
    }
    if (this.reclaimTimers.has(runId)) return
    const timer = setTimeout(() => {
      this.reclaimTimers.delete(runId)
      void this.reclaimRun(runId)
    }, HOST_IDLE_RECLAIM_MS)
    this.reclaimTimers.set(runId, timer)
  }

  /** 取消该实例的回收计时；没有计时时无副作用。 */
  private cancelReclaim(runId: number): void {
    const timer = this.reclaimTimers.get(runId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.reclaimTimers.delete(runId)
  }

  /**
   * 空会话判定：绑定还没有任何消息落盘的会话且完全空闲（无排队、无独立 Bash、无等待交互）。
   * 这类会话在 Pi 侧尚未写入文件、无法从列表重开，保留运行实例绑定只会让侧栏留下永远无法打开的占位行。
   */
  private isEmptyBoundSession(run: SessionRunRecord<SdkHostManager>): boolean {
    const session = run.owner.getSessionStatus()
    if (session.phase !== 'bound' || session.sessionId === null) return false
    return session.messageCount === 0
      && session.isIdle
      && session.pendingMessages === 0
      && session.isBashRunning === false
      && session.waitingDialogs === 0
  }

  /**
   * 空会话释放：内容为零时解除占用不需要中断也不需要保留绑定；失败时退回常规空闲回收，
   * 由占用门禁如实报告，不在切换链路里重试。
   */
  private releaseIfEmpty(runId: number): void {
    const run = this.runOf(runId)
    if (run === null || this.shuttingDown) return
    if (run.phase !== 'running' || !this.isEmptyBoundSession(run)) return
    this.cancelReclaim(runId)
    void this.releaseRun(runId, false).then(result => {
      if (!result.ok) this.scheduleReclaim(runId)
    })
  }

  /** 清扫全部空会话实例：供会话切换前调用，释放后的空闲实例正好成为复用目标，不额外建宿主。 */
  private releaseEmptySessionRuns(): void {
    for (const run of this.options.runs.allRuns()) {
      if (run.runId === this.foregroundRunId()) continue
      this.releaseIfEmpty(run.runId)
    }
  }

  /** 显式需要宿主的动作：取消旧计时后重新起表，不让刚被使用的宿主立刻到期；前台实例因豁免不再起表。 */
  private keepAlive(runId: number): void {
    this.cancelReclaim(runId)
    this.scheduleReclaim(runId)
  }

  /**
   * 回收一个空闲实例：复核空闲后释放宿主进程，占用与会话身份保留，恢复由下一次动作触发。
   * 计时到期前它若已切到前台，放弃本次回收，交还给下一次前台切换重新计时。
   */
  private async reclaimRun(runId: number): Promise<void> {
    const run = this.runOf(runId)
    if (run === null || this.shuttingDown) return
    if (this.foregroundRunId() === runId) return
    const pending = (async () => {
      try {
        this.options.runs.beginClose(runId)
      } catch {
        return
      }
      let suspended = false
      try {
        suspended = await run.owner.suspend()
      } catch {
        // 关闭未确认：保留占用，不建立替代实例，交给下一次动作或应用退出收敛。
        this.options.runs.markUnconfirmed(runId)
        this.publishState()
        return
      }
      // 挂起成功与「有在途工作所以放弃回收」都要把登记收敛回运行中。
      this.options.runs.settleOpen(runId, run.owner.getSessionStatus().sessionId)
      this.publishState()
      if (!suspended) this.scheduleReclaim(runId)
    })()
    this.reclaiming.set(runId, pending)
    try {
      await pending
    } finally {
      if (this.reclaiming.get(runId) === pending) this.reclaiming.delete(runId)
    }
  }

  /** 等该实例正在进行的回收收敛；没有回收时立即返回，不与释放竞争。 */
  private async awaitReclaim(runId: number): Promise<void> {
    const pending = this.reclaiming.get(runId)
    if (pending !== undefined) await pending
  }

  /**
   * 该实例是否需要重新建立宿主：宿主进程已释放（空闲回收）或已失败，
   * 或宿主侧要求重建上下文。命中时必须重绑会话，不能只转前台。
   */
  private runNeedsRebind(run: SessionRunRecord<SdkHostManager>): boolean {
    const status = run.owner.getStatus()
    return status.hostId === null || status.state === 'failed'
      || run.owner.getSessionStatus().needsHostRebuild
  }

  /** 投影批次按来源实例转发；后台批次也交给页面，由页面更新来源会话的分片，不覆盖前台展示。 */
  private forwardBatch(runId: number, batch: ProjectionBatch): void {
    const payload: ProjectionBatch = { ...batch, runId }
    for (const listener of [...this.projectionListeners]) {
      try { listener(payload) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /** Extension UI 快照同样按来源实例转发；后台交互进入来源会话的分片，不抢占前台展示。 */
  private forwardUi(runId: number, snapshot: ExtensionUiSnapshot): void {
    const payload: ExtensionUiSnapshot = { ...snapshot, runId }
    for (const listener of [...this.uiListeners]) {
      try { listener(payload) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /**
   * 前台切换：先发布状态再补发该实例的交互快照，页面才能把这两类事件归到同一来源；
   * 顺序反过来时页面会因尚未得知新前台而丢弃快照。
   */
  focusRun(runId: number): void {
    const previous = this.foregroundRunId()
    this.options.runs.setForeground(runId)
    this.keepAlive(runId)
    // 旧前台随切换交还回收资格：空会话实例立即释放，其余按同一个宽限期起表。
    if (previous !== null && previous !== runId) this.releaseIfEmpty(previous)
    this.publishState()
    const run = this.runOf(runId)
    if (run !== null) this.forwardUi(runId, run.owner.getExtensionUiSnapshot())
  }

  /**
   * 前台实例跟随项目：命中该项目最近一次前台实例时切到它（与 `focusRun` 同一条顺序），
   * 该项目没有承载会话的实例时清空前台选择，页面回到该项目的空状态。
   * 不建立执行宿主、不重绑会话、不中断任何后台实例。
   */
  focusProject(projectPath: string): void {
    // 项目切换时预热只读解析宿主，不建立会话；后续绑定可接管池中仍可用的宿主。
    this.prepareProject(projectPath)
    const run = this.options.runs.foregroundRunOfProject(projectPath)
    if (run === null) {
      const previous = this.foregroundRunId()
      this.options.runs.clearForeground()
      // 没有可展示的实例时前台为空：刚离开的实例如果是空会话立即释放，其余交还回收资格。
      if (previous !== null) this.releaseIfEmpty(previous)
      this.publishState()
      return
    }
    this.focusRun(run.runId)
  }

  /**
   * 项目预热：为指定项目准备只读解析宿主，减少后续历史读取的冷启动开销。
   * 预热不建立会话、不登记运行实例；失败、被回收或应用退出都只是退回冷启动。
   */
  prepareProject(projectPath: string): void {
    if (this.shuttingDown) return
    this.options.logHosts.warm(projectPath)
  }

  /**
   * 会话日志读取：先复用该会话的原服务宿主，再借同项目执行宿主或只读池。
   * 只有宿主失效才换一个宿主重读一次；文件版本、游标与解析错误原样交还，不盲目重试。
   * 读取不改变执行占用，池租约或管理器读取计数保护在途请求，收尾后再安排自动回收。
   */
  async readSessionLog(target: SdkLogTarget): Promise<HistoryData> {
    const key = logHostKey(target.projectPath, target.sessionId)
    let excluded: SdkHostManager | null = null
    for (let attempt = 0; ; attempt += 1) {
      if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能读取会话历史。')
      const lease = this.acquireLogHost(target.projectPath, this.logHosts.get(key), excluded)
      try {
        const data = await lease.host.readSessionLog(target)
        if (!this.shuttingDown) this.rememberLogHost(target.projectPath, target.sessionId, lease.host)
        return data
      } catch (error) {
        if (this.logHosts.get(key) === lease.host) this.logHosts.delete(key)
        if (attempt > 0 || this.shuttingDown || !(error instanceof SdkHostError)
          || (error.code !== 'HOST_EXITED' && error.code !== 'HOST_CLOSED' && error.code !== 'HOST_NOT_READY')) throw error
        excluded = lease.host
      } finally {
        lease.release()
        // 池宿主可能在等待期间被接管：按当前对象归属重新安排，而不是沿用旧池编号。
        const run = this.options.runs.allRuns().find(candidate => candidate.owner === lease.host)
        if (run !== undefined) this.scheduleReclaim(run.runId)
      }
    }
  }

  /** 固定本次读取的宿主；未存活的执行宿主不因浏览其他历史而被重新启动。 */
  private acquireLogHost(projectPath: string, preferred: SdkHostManager | undefined, excluded: SdkHostManager | null): LogReadLease {
    let run: SessionRunRecord<SdkHostManager> | undefined
    if (preferred !== undefined && preferred !== excluded) {
      run = this.options.runs.allRuns().find(candidate => candidate.owner === preferred && this.canReadLog(candidate, projectPath))
      if (run === undefined) {
        const lease = this.options.logHosts.acquireExisting(projectPath, preferred)
        if (lease !== null) return lease
      }
    }
    run ??= this.borrowableRun(projectPath, excluded) ?? undefined
    if (run !== undefined) {
      this.cancelReclaim(run.runId)
      return { host: run.owner, release: () => {} }
    }
    return this.options.logHosts.acquire(projectPath, excluded ?? undefined)
  }

  /** 读取只借仍在同项目服务的宿主，回收中、关闭中与退出未确认的实例都不可借。 */
  private canReadLog(run: SessionRunRecord<SdkHostManager>, projectPath: string): boolean {
    if (run.projectPath === null || !sameProjectPath(run.projectPath, projectPath)
      || run.phase === 'closing' || run.phase === 'unconfirmed' || this.reclaiming.has(run.runId)) return false
    const state = run.owner.getStatus().state
    return state === 'ready' || state === 'starting'
  }

  /** 没有原服务宿主时先借该项目最近的前台实例，再借同项目其余可用实例。 */
  private borrowableRun(projectPath: string, excluded: SdkHostManager | null): SessionRunRecord<SdkHostManager> | null {
    const usable = (run: SessionRunRecord<SdkHostManager>): boolean =>
      run.owner !== excluded && this.canReadLog(run, projectPath)
    const foreground = this.options.runs.foregroundRunOfProject(projectPath)
    if (foreground !== null && usable(foreground)) return foreground
    return this.options.runs.allRuns().find(usable) ?? null
  }

  /** 只保留少量最近服务对象；接管改变登记身份但不改变对象，也不搬运进程内缓存。 */
  private rememberLogHost(projectPath: string, sessionId: string, host: SdkHostManager): void {
    const key = logHostKey(projectPath, sessionId)
    this.logHosts.delete(key)
    this.logHosts.set(key, host)
    while (this.logHosts.size > LOG_HOST_MEMORY) {
      const oldest = this.logHosts.keys().next().value
      if (oldest === undefined) break
      this.logHosts.delete(oldest)
    }
  }

  /**
   * 该会话最近服务日志读取的宿主：已经是运行实例时按常规复用判定；
   * 还在只读池里时把它接管成运行实例（登记身份、接上授权回路），
   * 这样绑定与查看落在同一个进程，宿主内的投影检查点才能被复用。
   */
  private logHostOf(owner: SessionOwner): SessionRunRecord<SdkHostManager> | null {
    if (owner.sessionId === null) return null
    const key = logHostKey(owner.projectPath, owner.sessionId)
    const origin = this.logHosts.get(key)
    if (origin === undefined) return null
    const run = this.options.runs.allRuns().find(candidate => candidate.owner === origin)
    if (run !== undefined) {
      if (this.canReuse(run, owner.projectPath)) return run
      this.logHosts.delete(key)
      return null
    }
    const host = this.options.logHosts.claim(owner.projectPath, origin)
    if (host === null) { this.logHosts.delete(key); return null }
    const runId = this.options.runs.allocateRunId()
    host.adoptRun(runId, this.options.runs)
    this.options.prepareHost(host)
    const record = this.options.runs.registerRun(runId, host)
    this.attachRun(runId, host)
    return record
  }

  /** 实例释放后清理它的来源记录，不能把已解除项目归属的宿主继续当作原服务来源。 */
  private forgetLogHosts(runId: number): void {
    const host = this.runOf(runId)?.owner
    for (const [key, value] of this.logHosts) {
      if (value === host) this.logHosts.delete(key)
    }
  }

  /**
   * 全部运行实例的粗粒度状态：只读注册表与各宿主已持有的状态，不建立宿主。
   * 页面据此展示后台会话的运行、等待与未确认状态；只读解析宿主不在此列。
   */
  listRunStates(): readonly SessionRunState[] {
    const foreground = this.foregroundRunId()
    return this.options.runs.allRuns().map(run => {
      const host = run.owner.getStatus()
      // 未建立或已失败的宿主没有可展示的会话活动，不把 failed 当作空闲执行。
      const usable = host.hostId !== null && host.state !== 'failed'
      const session = usable ? run.owner.getSessionStatus() : null
      return {
        runId: run.runId,
        projectPath: run.projectPath,
        sessionId: run.sessionId,
        phase: run.phase,
        isForeground: run.runId === foreground,
        isStreaming: session === null ? false : !session.isIdle,
        hasMessages: run.owner.getSessionStatus().messageCount > 0,
        waitingDialogs: session === null ? 0 : session.waitingDialogs,
        hostState: host.hostId === null || host.state === 'idle' ? 'none' : host.state
      }
    })
  }

  /** 运行状态订阅：列表内容变化时整体下发，页面自行按会话归集。 */
  onRunsChanged(listener: (snapshot: SessionRunsSnapshot) => void): () => void {
    this.runsListeners.add(listener)
    return () => this.runsListeners.delete(listener)
  }

  /**
   * 已占用会话的宿主：命中时由调用方转前台复用。退出未确认的实例仍保留占用，
   * 既不转前台也不允许重复接管，直到确认收敛。
   */
  private reuseOccupied(owner: SessionOwner): SessionRunRecord<SdkHostManager> | null {
    if (owner.sessionId === null) return null
    const occupied = this.options.runs.runOfSession(owner.projectPath, owner.sessionId)
    if (occupied === null) return null
    if (occupied.phase === 'unconfirmed') {
      throw new SdkHostError('SESSION_OPERATION_CONFLICT',
        '该会话的上一运行实例尚未确认退出，未重复接管；请等它收敛后重试。')
    }
    return occupied
  }

  /**
   * 运行实例选择与建立：已被占用或可承接的实例直接复用，都不命中才建立新宿主并切前台。
   * 应用退出编排开始后不再建立宿主。
   */
  private ensureRun(owner: SessionOwner): SessionRunRecord<SdkHostManager> {
    if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能建立 SDK 宿主。')
    const occupied = this.reuseOccupied(owner)
    if (occupied !== null) {
      this.focusRun(occupied.runId)
      return occupied
    }
    // 优先复用原日志宿主：首页与稳定活动分别校验复用，但都不能替代 SDK 打开会话文件。
    const preferred = this.logHostOf(owner)
    if (preferred !== null) {
      this.focusRun(preferred.runId)
      return preferred
    }
    const reusable = this.options.runs.allRuns().find(run => this.canReuse(run, owner.projectPath))
    if (reusable !== undefined) {
      this.focusRun(reusable.runId)
      return reusable
    }
    const runId = this.options.runs.allocateRunId()
    const host = this.options.createHost(runId)
    this.options.prepareHost(host)
    const record = this.options.runs.registerRun(runId, host)
    this.attachRun(runId, host)
    this.focusRun(runId)
    return record
  }

  /**
   * 可复用判定：实例没有未收敛的生命周期操作、宿主已就绪、空闲或仍在启动、且当前没有绑定会话。
   * 从只读池接管或刚建立的宿主往往还在启动，复用后由 `runSessionAction` 内的 `ensureStarted()`
   * 等它就绪，这样「展开项目后立刻点会话」不会另起第二个进程。仍承载其他项目会话的空绑定实例不复用，
   * 避免把闲宿主跨项目改绑。
   */
  private canReuse(run: SessionRunRecord<SdkHostManager>, projectPath: string): boolean {
    if (run.phase !== 'idle' && run.phase !== 'running') return false
    if (run.projectPath !== null && !sameProjectPath(run.projectPath, projectPath)) return false
    const host = run.owner.getStatus()
    if (host.state !== 'idle' && host.state !== 'ready' && host.state !== 'starting') return false
    return run.owner.getSessionStatus().bindingId === null
  }

  /** 状态查询不建立宿主，也不触发任何会话操作；只映射前台实例的当前状态。 */
  getStatus(): RuntimeResult {
    return { ok: true, data: this.foregroundStatus() }
  }

  /** 状态广播只在映射结果变化时发给页面；前台实例变化一定触发。 */
  onStatusChanged(listener: (status: RuntimeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** 投影批次按前台实例转发；主进程不重算投影。 */
  onProjectionBatch(listener: (batch: ProjectionBatch) => void): () => void {
    this.projectionListeners.add(listener)
    return () => this.projectionListeners.delete(listener)
  }

  /** Extension UI 快照按前台实例转发，与宿主镜像同源，不需要第二份状态机。 */
  onExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  /**
   * 释放一个运行实例的活动会话并保留宿主：宿主未建立或已失败时只解除占用，
   * 其余情况经 SDK 释放后再解除；释放未确认时保留占用并如实返回错误。
   */
  async releaseRun(runId: number, allowInterrupt: boolean): Promise<RuntimeResult> {
    const run = this.runOf(runId)
    if (run === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    // 释放与回收互斥：先等正在进行的回收收敛，再按登记结果决定释放路径。
    await this.awaitReclaim(runId)
    this.cancelReclaim(runId)
    if (this.hostUnavailable(run)) {
      // 没有存活宿主可等待，占用可以安全解除。
      this.options.runs.release(runId)
      this.forgetLogHosts(runId)
      this.publishRuns()
      return { ok: true, data: this.foregroundStatus() }
    }
    try {
      const current = run.owner.getSessionStatus()
      const interrupt: SdkInterruptConfirmation | null = allowInterrupt && current.bindingId !== null
        ? { bindingId: current.bindingId, activityVersion: current.activityVersion }
        : null
      this.options.runs.beginClose(runId)
      const result = await run.owner.runSessionAction('release', { kind: 'new' }, run.owner.getSessionIdentity(), interrupt)
      this.options.runs.release(runId)
      this.forgetLogHosts(runId)
      this.publishRuns()
      return { ok: true, data: mapStatus(run.owner.getStatus(), result.status, runId) }
    } catch (error) {
      this.options.runs.markUnconfirmed(runId)
      this.publishRuns()
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /**
   * 结束一个运行实例：先按中断式释放解除占用与会话绑定，再关闭它的宿主进程。
   * 释放未确认时占用保留、宿主不动，错误如实返回；会话历史文件始终不动。
   */
  async closeRun(runId: number): Promise<RuntimeResult> {
    const result = await this.releaseRun(runId, true)
    if (!result.ok) return result
    // 释放后实例已不再承载会话：前台若仍指向它，页面会把空闲槽位读成前台会话。
    if (this.foregroundRunId() === runId) {
      this.options.runs.clearForeground()
      this.publishState()
    }
    const run = this.runOf(runId)
    if (run === null || this.hostUnavailable(run)) return result
    try {
      await run.owner.suspend()
    } catch {
      // 宿主未确认关闭：占用已解除，空闲回收与应用退出链会继续收敛，不改写本次结束结果。
    }
    // 宿主状态属于运行实例列表的展示字段，挂起后补发一次，页面才不会显示成仍就绪。
    this.publishState()
    return result
  }

  /**
   * 该实例是否有在途工作：排队消息、独立 Bash、等待中的审批或扩展输入都算；
   * 宿主已失败时按无在途工作处理，因为已无法确认它是否仍在工作。
   */
  runHasPendingWork(runId: number): boolean {
    const run = this.runOf(runId)
    if (run === null || this.hostUnavailable(run)) return false
    const session = run.owner.getSessionStatus()
    return !session.isIdle
      || session.pendingMessages > 0
      || session.isBashRunning
      || session.waitingDialogs > 0
  }

  /** 前台实例的会话状态；没有前台实例时是空会话状态，与宿主未建立时一致。 */
  getSessionStatus(): SdkSessionStatus {
    return this.options.runs.foreground()?.owner.getSessionStatus() ?? emptySdkSessionStatus()
  }

  /** 指定实例的会话状态；未知实例返回 null，供编排层按实例复核绑定结果。 */
  sessionStatusOfRun(runId: number): SdkSessionStatus | null {
    return this.runOf(runId)?.owner.getSessionStatus() ?? null
  }

  /** 中止只作用于目标实例的当前绑定；目标不成立或未绑定时不做本地预检之外的动作。 */
  async abort(target: RuntimeTarget): Promise<RuntimeResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) return { ok: false, error: UNBOUND_ERROR }
    this.keepAlive(matched.run.runId)
    const host = matched.run.owner
    try {
      const status = await host.abortSession({ hostId: host.getSessionIdentity().hostId, bindingId: matched.bindingId })
      return { ok: true, data: mapStatus(host.getStatus(), status, matched.run.runId) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 提交只表达接受、排队或已处理；文本与图片仍由宿主再次校验。 */
  async prompt(
    target: RuntimeTarget,
    message: string,
    images: readonly PromptImageInput[]
  ): Promise<PromptResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) return { ok: false, error: UNBOUND_ERROR }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: { disposition: await matched.run.owner.prompt(message, images) } }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 可用模型清单直接来自目标实例的当前绑定；runtimeId 即绑定编号。 */
  async readCapabilities(target: RuntimeTarget): Promise<CapabilitiesResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: await matched.run.owner.readCapabilities() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 资源清单只读目标实例的当前绑定；未绑定时按未就绪返回，不向宿主发请求，也不伪造空清单。 */
  async readResources(target: RuntimeTarget): Promise<ResourcesResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) return { ok: false, error: UNBOUND_ERROR }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: await matched.run.owner.readResources() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 诊断只读目标实例当前绑定已持有的创建期诊断与 Extension 错误；
   * 实例存在但未绑定时返回空结果（`runtimeId: null`），不用错误冒充「没有诊断」。
   */
  async readDiagnostics(target: RuntimeTarget): Promise<RuntimeDiagnosticsResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) {
      return { ok: true, data: { runtimeId: null, stderrLines: [], extensionErrors: [] } }
    }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: await matched.run.owner.readDiagnostics() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** MCP 状态只读目标实例当前绑定内的固定 `/mcp` 命令；未绑定时按未就绪返回。 */
  async readMcpStatus(target: RuntimeTarget): Promise<McpStatusResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) return { ok: false, error: UNBOUND_ERROR }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: await matched.run.owner.readMcpStatus() }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** MCP 登录/退出/重连只提交受校验的动作与服务器名；命令文本与等待期限由宿主与主进程决定。 */
  async runMcpCommand(
    target: RuntimeTarget,
    action: McpCommandAction,
    serverName: string
  ): Promise<McpCommandResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) return { ok: false, error: UNBOUND_ERROR }
    this.keepAlive(matched.run.runId)
    try {
      return { ok: true, data: await matched.run.owner.runMcpCommand(action, serverName) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /** 模型切换只针对请求所固定的运行实例与绑定代际；身份不符时不发宿主请求。 */
  async setModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
    const matched = this.matchedRun({ runId: request.runId, runtimeId: request.runtimeId })
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    this.keepAlive(matched.run.runId)
    const host = matched.run.owner
    try {
      const status = await host.setSessionModel(request.provider, request.modelId)
      return { ok: true, data: mapStatus(host.getStatus(), status, matched.run.runId) }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /**
   * 手动压缩当前会话上下文：说明可选，压缩完成后才返回；
   * 失败原因由结果表达，实际压缩过程与结果以投影中的压缩记录为准。
   */
  async compact(request: RuntimeCompactRequest): Promise<RuntimeResult> {
    const matched = this.matchedRun({ runId: request.runId, runtimeId: request.runtimeId })
    if (matched === null || matched.run.owner.getSessionStatus().sessionId !== request.sessionId) {
      return { ok: false, error: TARGET_CHANGED_ERROR }
    }
    this.keepAlive(matched.run.runId)
    const host = matched.run.owner
    try {
      await host.compact(request.instructions)
      return { ok: true, data: mapStatus(host.getStatus(), host.getSessionStatus(), matched.run.runId) }
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
    const matched = this.matchedRun({ runId: request.runId, runtimeId: request.runtimeId })
    if (matched === null || matched.run.owner.getSessionStatus().sessionId !== request.sessionId) {
      return { ok: false, error: TARGET_CHANGED_ERROR }
    }
    this.keepAlive(matched.run.runId)
    const host = matched.run.owner
    try {
      const result = await host.rewind(request.messageId)
      // 宿主在结果帧之前已发布回退后的会话状态，因此这里读到的是权威实际状态。
      const status = mapStatus(host.getStatus(), host.getSessionStatus(), matched.run.runId)
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
   * 向目标实例现取基准快照；目标未绑定时返回该实例的空基准（无会话不等于读取失败），
   * 绑定后仍由宿主回答，不伪造内容。
   */
  async getProjection(target: RuntimeTarget): Promise<ProjectionResult> {
    const matched = this.matchedRun(target)
    if (matched === null) return { ok: false, error: TARGET_CHANGED_ERROR }
    if (matched.bindingId === null) {
      return { ok: true, data: { ...EMPTY_PROJECTION, runId: matched.run.runId } }
    }
    try {
      const snapshot = await matched.run.owner.refreshProjection()
      return { ok: true, data: { ...snapshot, runId: matched.run.runId } }
    } catch (error) {
      return { ok: false, error: runtimeErrorOf(error) }
    }
  }

  /**
   * 已接管会话的权威历史读取：页面只给项目与会话，这里按占用找到运行实例。
   * 未接管、尚未绑定或宿主正在收敛时返回 null，由调用方退回日志解析；
   * 读取期间换绑或换会话按失效报告，不把旧分支的内容写进当前展示。
   */
  async readBoundHistory(request: {
    readonly projectPath: string
    readonly sessionId: string
    readonly query: HistoryQuery
  }): Promise<HistoryData | null> {
    const occupied = this.options.runs.runOfSession(request.projectPath, request.sessionId)
    if (occupied === null) return null
    if (occupied.phase !== 'running') return null
    const before = occupied.owner.getSessionStatus()
    if (before.bindingId === null || before.sessionId !== request.sessionId
      || before.projectPath === null || !sameProjectPath(before.projectPath, request.projectPath)) return null
    this.cancelReclaim(occupied.runId)
    try {
      const data = await occupied.owner.readHistory(request.sessionId, request.query)
      const after = occupied.owner.getSessionStatus()
      if (after.bindingId !== before.bindingId || after.sessionId !== request.sessionId) {
        throw new SdkHostError('STALE_SESSION', SDK_HOST_FAILURE_MESSAGES.STALE_SESSION)
      }
      return data
    } finally {
      this.scheduleReclaim(occupied.runId)
    }
  }

  /** 确认只影响目标实例的未确认窗口；目标不成立或不属于该绑定的确认直接忽略。 */
  ackProjection(target: RuntimeTarget, seq: number): void {
    const matched = this.matchedRun(target)
    if (matched === null || matched.bindingId === null) return
    void matched.run.owner.ackProjection(seq).catch(() => {})
  }

  /** Extension UI 镜像查询不建立宿主或会话；未知实例返回空交互。 */
  getExtensionUiSnapshot(runId: number): ExtensionUiSnapshot {
    const run = this.runOf(runId)
    if (run === null) return EMPTY_EXTENSION_UI
    return { ...run.owner.getExtensionUiSnapshot(), runId }
  }

  /** 回应只在目标实例的当前绑定内提交；已失效或不存在的对话返回 null，其余失败由调用方转成错误结果。 */
  async respondExtensionDialog(
    target: { readonly runId: number; readonly runtimeId: number },
    dialogId: string,
    response: ExtensionDialogResponseInput
  ): Promise<ExtensionUiSnapshot | null> {
    const matched = this.matchedRun(target)
    if (matched === null || matched.bindingId === null) return null
    this.keepAlive(matched.run.runId)
    const host = matched.run.owner
    try {
      await host.respondDialog({ hostId: host.getSessionIdentity().hostId, bindingId: matched.bindingId }, dialogId, response)
    } catch (error) {
      if (error instanceof SdkHostError && (error.code === 'INTERACTION_INVALID' || error.code === 'STALE_SESSION')) return null
      throw error
    }
    return { ...host.getExtensionUiSnapshot(), runId: matched.run.runId }
  }

  /**
   * 会话切换提交：目标、归属项目与会话身份在提交前固定，调用方只表达目标与是否允许中断。
   * 已由某实例承载的命名会话只转前台复用，不重绑；其余情况先在选定的实例上登记占位，
   * 宿主侧实际重绑前的代际由主进程在授权应答中分配。
   */
  async switchSession(
    action: SessionSwitchAction,
    reference: SdkSessionReference,
    allowInterrupt: boolean,
    owner: SessionOwner,
    selection: number
  ): Promise<{ readonly cancelled: boolean; readonly runId: number }> {
    if (action !== 'reload') {
      // 切换前先清扫其他实例上的空会话占用：释放后的空闲实例正好成为本次切换的复用目标。
      this.releaseEmptySessionRuns()
      const occupied = this.reuseOccupied(owner)
      if (occupied !== null) {
        // 回收可能正在进行：等它收敛后再决定是复用还是重绑，不与释放竞争。
        await this.awaitReclaim(occupied.runId)
        if (!this.runNeedsRebind(occupied)) {
          this.focusRun(occupied.runId)
          this.settleSelection(selection, owner)
          return { cancelled: false, runId: occupied.runId }
        }
      }
    }

    const run = this.ensureRun(owner)
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
      this.publishState()
      this.settleSelection(selection, owner)
      return { cancelled: result.cancelled, runId: run.runId }
    } catch (error) {
      this.options.runs.failOpen(run.runId)
      this.publishRuns()
      throw error
    }
  }

  /** 退出编排入口：先阻止所有新建与恢复，再对全部运行实例启动关闭。 */
  beginShutdown(): void {
    this.shuttingDown = true
    for (const timer of this.reclaimTimers.values()) clearTimeout(timer)
    this.reclaimTimers.clear()
    for (const run of this.options.runs.allRuns()) run.owner.beginShutdown()
    // 立即把拒绝转为结果记录，避免等待运行实例关闭期间产生未处理拒绝，同时保留原始错误。
    this.logHostShutdown ??= Promise.allSettled([this.options.logHosts.shutdown()])
      .then(([result]) => result)
    this.publishRuns()
  }

  /** 等待全部宿主关闭，汇总运行实例与只读池的失败并抛出首个原始错误。 */
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
    const logHostResult = await this.logHostShutdown
    if (logHostResult?.status === 'rejected') failures.push(logHostResult.reason)
    if (failures.length > 0) throw failures[0]
  }

  /** 任一实例状态变化后的统一广播入口：前台状态与运行实例列表各自去重。 */
  private publishState(): void {
    this.publishStatus()
    this.publishRuns()
  }

  /** 映射结果变化时广播副本；订阅者异常不能改变宿主生命周期。 */
  private publishStatus(): void {
    const next = this.foregroundStatus()
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

  /** 运行实例列表变化时广播副本；列表只含粗粒度字段，流式期间不会逐条消息触发。 */
  private publishRuns(): void {
    const next = this.listRunStates()
    if (sameRuns(this.runs, next)) return
    this.runs = next
    const snapshot: SessionRunsSnapshot = { runs: next }
    for (const listener of [...this.runsListeners]) {
      try {
        listener(snapshot)
      } catch {
        /* 展示消费者故障不影响宿主监督。 */
      }
    }
  }
}
