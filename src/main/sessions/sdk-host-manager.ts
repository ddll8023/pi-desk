/** 监督单个 SDK 宿主与内部会话请求，持有安全状态和交互镜像；不重放操作，页面契约映射在 sdk-runtime-bridge。 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { app, utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import {
  SDK_HOST_PROTOCOL_VERSION,
  isSdkHostFrame,
  isSdkHostEvent,
  isSdkHostRequest,
  isSdkSessionTarget,
  isSdkHostFailureCode,
  emptySdkSessionStatus
} from '../../sdk-host/protocol'
import type {
  SdkHostFrame, SdkHostRequest, SdkHostFailureCode, SdkHostEvent, SdkMcpCommandAction, SdkSessionStatus,
  SdkSessionReference, SdkSessionTarget, SdkSessionAction, SdkInterruptConfirmation, SdkSessionIdentity,
  SdkLogTarget
} from '../../sdk-host/protocol'
import type {
  AgentCapabilities, McpStatus, PiResources, ProjectionBatch, ProjectionSnapshot, PromptImageInput,
  RuntimeDiagnostics, HistoryData, HistoryQuery
} from '../../shared/runtime-api'
import { ExtensionUiManager } from './extension-ui-manager'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../../shared/extension-ui-api'
import { getPiAgentDir, getPiProcessEnvironment } from '../shared/pi-paths'
import { validatePromptInput } from './prompt-input'
import type { SdkHostRunRegistry } from './session-run-registry'

const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_RESPONSE_MS = 6_000
const SESSION_TIMEOUT_MS = 60_000
/**
 * 非幂等写（回退、会话生命周期）在首个等待期限后继续等待结果帧的追加窗口：
 * 结果帧是唯一权威结果，迟到回复仍能按真实状态收敛，不把慢操作提前判成结果未知。
 */
const WRITE_SETTLE_TIMEOUT_MS = 120_000
/** 手动压缩是整段操作（含一次摘要 LLM 调用），超时只放弃等待，不取消宿主侧压缩。 */
const COMPACT_TIMEOUT_MS = 600_000
const EXIT_GRACE_MS = 2_000
const KILL_WAIT_MS = 3_000
const RECOVERY_DELAY_MS = 750
/**
 * 宿主进程的空闲回收时限：执行实例与只读解析实例共用同一口径。
 * 内部常量，不做成用户可见设置；这是待实测的取值，不当作性能结论。
 */
export const HOST_IDLE_RECLAIM_MS = 5 * 60 * 1000
/** MCP 状态读取等待上限：`/mcp` 会等所有已启用服务器连接完成，比普通命令长。 */
const MCP_STATUS_TIMEOUT_MS = 60_000
/** MCP 登录需在浏览器完成授权；退出与重连不涉及浏览器交互。 */
const MCP_LOGIN_TIMEOUT_MS = 300_000
const MCP_LOGOUT_TIMEOUT_MS = 30_000
const MCP_RECONNECT_TIMEOUT_MS = 60_000
/** 会话状态字段与协议同序；被拒时只记录类型，便于对照校验失败的原因。 */
const STATUS_FIELDS = ['phase', 'bindingId', 'activityVersion', 'operationId', 'projectPath',
  'sessionId', 'sessionFile', 'isIdle', 'isCompacting', 'pendingMessages', 'isBashRunning', 'waitingDialogs',
  'needsHostRebuild', 'lastError'] as const

/**
 * 请求与其结果帧的固定对应；表是穷尽 Record，新增请求类型会在编译期暴露，
 * 避免把正常回复误判成协议失配（值 `null` 表示该类请求没有结果帧：
 * 反向授权由 authorizeTarget 直接 postMessage，不经 request() 等待）。
 */
const EXPECTED_REPLIES: Record<SdkHostRequest['type'], SdkHostFrame['type'] | null> = {
  initialize: 'ready',
  shutdown: 'closed',
  session: 'session-result',
  'session-abort': 'session-result',
  prompt: 'prompt-result',
  'set-model': 'session-result',
  rewind: 'rewind-result',
  compact: 'compact-result',
  capabilities: 'capabilities-result',
  resources: 'resources-result',
  diagnostics: 'diagnostics-result',
  'mcp-status': 'mcp-status-result',
  'mcp-command': 'mcp-command-result',
  'projection-snapshot': 'projection-result',
  history: 'history-result',
  'projection-ack': 'ack-result',
  'session-log': 'log-result',
  'ui-response': 'ui-result',
  'authorization-result': null
}

/**
 * 被拒消息只暴露可对照的结构线索：身份、键名与状态字段的实际类型，
 * 不搬运消息正文、会话路径或凭据，因此可以直接进主进程日志。
 */
function describeRejectedFrame(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return `非对象消息（${typeof value}）`
  const frame = value as Record<string, unknown>
  const requestId = frame.requestId === undefined ? '-' : String(frame.requestId).slice(0, 8)
  const identity = `type=${String(frame.type)} hostId=${String(frame.hostId)} seq=${String(frame.seq)} requestId=${requestId}`
  const keys = `keys=[${Object.keys(frame).join(',')}]`
  const status = frame.status
  if (typeof status !== 'object' || status === null || Array.isArray(status)) return `${identity} ${keys}`
  const fields = status as Record<string, unknown>
  const described = STATUS_FIELDS.map(field => {
    const item = fields[field]
    const kind = item === undefined ? 'undefined' : item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    return `${field}:${kind}`
  }).join(' ')
  return `${identity} ${keys} status{${described}}`
}

/** 展示消息到条目 ID 的镜像上限；超出丢弃最旧映射。 */
const MAX_ENTRY_MAPPINGS = 512
const MAX_AUTOMATIC_REBUILDS = 2
/** 宿主自身输出的诊断保留上限；只用于主进程日志，不进入 IPC 契约或页面。 */
const HOST_OUTPUT_TAIL_BYTES = 8 * 1024

/**
 * 宿主 stdout/stderr 的有界尾部缓冲：始终读空管道避免子进程阻塞，只保留最近一段用于失败诊断。
 * 内容可能包含宿主自身的堆栈或路径，因此只在主进程日志可见，不随结果帧上报。
 */
class HostOutputTail {
  private readonly chunks: Buffer[] = []
  private length = 0

  /** 追加并丢弃最旧的部分，保证缓冲不随运行时长增长。 */
  append(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.length += chunk.length
    while (this.length > HOST_OUTPUT_TAIL_BYTES && this.chunks.length > 1) {
      const oldest = this.chunks[0]
      if (oldest === undefined) break
      this.length -= oldest.length
      this.chunks.shift()
    }
  }

  /** 单块超出上限时只取尾部；没有输出时返回空串。 */
  tail(): string {
    if (this.chunks.length === 0) return ''
    const joined = Buffer.concat(this.chunks)
    const start = Math.max(0, joined.length - HOST_OUTPUT_TAIL_BYTES)
    return joined.subarray(start).toString('utf8')
  }
}

export type SdkHostErrorCode = SdkHostFailureCode
  | 'HOST_ENTRY_MISSING' | 'HOST_START_FAILED' | 'HOST_PROTOCOL_ERROR'
  | 'HOST_TIMEOUT' | 'HOST_EXITED' | 'HOST_CLOSED' | 'HOST_STOP_TIMEOUT'

/** 宿主失败只暴露固定分类与安全文案，不携带环境、凭据或底层诊断报告。 */
export class SdkHostError extends Error {
  constructor(readonly code: SdkHostErrorCode, message: string) {
    super(message)
  }
}

export interface SdkHostStatus {
  readonly state: 'idle' | 'starting' | 'ready' | 'recovering' | 'stopping' | 'failed'
  readonly hostId: number | null
  readonly sdkVersion: string | null
  readonly lastError: SdkHostErrorCode | null
}

export type SdkSessionAuthority = (
  reference: SdkSessionReference, ownerProjectPath: string
) => Promise<SdkSessionTarget>

interface PendingRequest {
  readonly type: SdkHostRequest['type']
  /** 首个期限到期后换成追加窗口定时器，因此不是只读。 */
  timer: ReturnType<typeof setTimeout>
  readonly resolve: (frame: SdkHostFrame) => void
  readonly reject: (error: SdkHostError) => void
}

interface HostRecord {
  readonly child: UtilityProcess
  readonly hostId: number
  readonly agentDir: string
  readonly pending: Map<string, PendingRequest>
  readonly exitPromise: Promise<void>
  readonly resolveExit: () => void
  readonly authorizations: Set<string>
  readonly output: HostOutputTail
  eventSeq: number
  ready: boolean
  established: boolean
  exited: boolean
  intentionalExit: boolean
  closing: boolean
  closePromise: Promise<void> | null
}

const FAILURE_MESSAGES: Record<SdkHostFailureCode, string> = {
  SDK_LOAD_FAILED: '官方 SDK 加载失败；未创建活动会话。',
  AGENT_DIR_MISMATCH: 'SDK 与桌面端的 agent 目录不一致，已拒绝建立宿主。',
  HOST_NOT_READY: 'SDK 宿主尚未就绪或已开始关闭。',
  INVALID_SESSION_TARGET: '会话目标或项目归属已变化。',
  TRUST_REQUIRED: '项目资源需要新的信任决定。',
  SESSION_NOT_FOUND: '当前项目下找不到可接管的会话。',
  SESSION_BUSY: '当前操作尚未收敛，需要对应执行的中断确认。',
  STALE_SESSION: '该请求所属会话绑定已经失效。',
  SESSION_OPERATION_CONFLICT: '生命周期操作冲突，或该会话上已有未收敛的执行操作；请等它结束后重试，必要时重开会话或重启应用。',
  SESSION_CREATE_FAILED: 'SDK 会话创建失败；请以实际会话状态为准。',
  SESSION_BIND_FAILED: 'SDK 会话或必要交互绑定失败。',
  SESSION_CLOSE_FAILED: 'SDK 会话关闭未收敛。',
  SESSION_RECOVERY_REQUIRED: 'SDK 上下文不可继续复用，需要显式恢复基础设施。',
  AUTHORIZATION_FAILED: '无法安全确认会话目标与信任范围。',
  INTERACTION_INVALID: '扩展交互已失效或回应无效。'
}

/** 宿主失败分类的固定文案；映射层与运行实例调用点复用同一份字面量，不重复硬编码。 */
export const SDK_HOST_FAILURE_MESSAGES = FAILURE_MESSAGES

/** 入口与主进程产物保持固定相邻布局；页面不能指定脚本、参数或替代 SDK。 */
function getSdkHostEntryPath(): string {
  return resolve(__dirname, '..', 'sdk-host', 'index.mjs')
}

/** 目录身份比较不读取磁盘；两端使用同一绝对路径，不额外跟随符号链接。 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export interface SdkHostManagerOptions {
  /**
   * 应用级运行身份；由主进程注册表分配，宿主不自行编号。
   * 只读宿主先取池编号，被接管成运行实例时换成运行实例编号。
   */
  runId: number
  /** 运行实例登记与绑定代际分配；归属项目只以登记结果为准。只读宿主使用拒绝式实现。 */
  runs: SdkHostRunRegistry
}

/**
 * 只读宿主的登记端口：只解析会话文件，没有会话占用与绑定代际。
 * 任何会话动作都会先因缺少授权回路被拒绝，这里不给它伪造归属或编号。
 */
const READ_ONLY_RUNS: SdkHostRunRegistry = {
  projectOfRun: () => null,
  allocateGeneration: () => { throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET) },
  recordBinding: () => {},
  markUnconfirmed: () => {}
}

/** 只读宿主：用于查看会话历史，不承载会话；绑定前由执行链接管，接管后才接上授权回路。 */
export function createReadOnlyHost(options: { readonly hostId: number }): SdkHostManager {
  return new SdkHostManager({ runId: options.hostId, runs: READ_ONLY_RUNS })
}

export class SdkHostManager {
  private active: HostRecord | null = null
  private starting: Promise<SdkHostStatus> | null = null
  private wanted = false
  private shuttingDown = false
  private automaticRebuilds = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(status: SdkHostStatus) => void>()
  private authority: SdkSessionAuthority | null = null
  private sessionSnapshot = emptySdkSessionStatus()
  private sessionSubmission: string | null = null
  private uncertainOperationId: string | null = null
  private readonly sessionListeners = new Set<(status: SdkSessionStatus) => void>()
  private readonly projectionListeners = new Set<(batch: ProjectionBatch) => void>()
  private projection: ProjectionSnapshot | null = null
  private readonly entryIds = new Map<string, string>()
  private readonly uiListeners = new Set<(snapshot: ExtensionUiSnapshot) => void>()
  private readonly ui = new ExtensionUiManager({
    onSnapshot: snapshot => {
      for (const listener of [...this.uiListeners]) {
        try { listener(snapshot) } catch { /* 消费者异常不影响交互 Promise。 */ }
      }
    },
    // SDK 回应由 respondDialog 直接发送；此镜像不代替对话回应通道。
    onDialogResponse: () => {}
  })
  private snapshot: SdkHostStatus = {
    state: 'idle', hostId: null, sdkVersion: null, lastError: null
  }

  constructor(private readonly options: SdkHostManagerOptions) {}

  /**
   * 只读宿主被接管成运行实例：换上真实运行身份与登记端口。
   * 接管前的进程状态与解析缓存都保留，因此随后的绑定能直接命中宿主内的投影检查点。
   */
  adoptRun(runId: number, runs: SdkHostRunRegistry): void {
    this.options.runId = runId
    this.options.runs = runs
  }

  /** 查询仅返回已持有状态，绝不为了展示建立宿主。 */
  getStatus(): SdkHostStatus {
    return { ...this.snapshot }
  }
  /** 订阅生命周期结果；页面状态映射由 sdk-runtime-bridge 完成。 */
  onStatusChanged(listener: (status: SdkHostStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 主进程提供唯一目标授权；不让宿主自行决定项目、信任或任意路径。 */
  setSessionAuthority(authority: SdkSessionAuthority): void { this.authority = authority }

  /**
   * SDK 内部会话状态；页面可提交与否由映射层按 phase 判定。
   * 结果未知的写操作必须对页面收敛：不确定态非空期间按「需要显式恢复」覆盖宿主当前值；
   * 覆盖不可被宿主事件冲掉，随不确定态清除自动消失（下一次广播回到宿主真实状态）。
   */
  getSessionStatus(): SdkSessionStatus {
    if (this.uncertainOperationId === null) return { ...this.sessionSnapshot }
    return { ...this.sessionSnapshot, phase: 'blocked', needsHostRebuild: true,
      lastError: 'SESSION_RECOVERY_REQUIRED' }
  }

  /** 写操作调用方在用户确认前固定此身份，不能只传可能在新进程重用的绑定编号。 */
  getSessionIdentity(): SdkSessionIdentity {
    return { hostId: this.active?.hostId ?? null, bindingId: this.sessionSnapshot.bindingId }
  }

  /** 仅订阅 SDK 绑定状态；页面 Runtime 状态由映射层合成。 */
  onSessionChanged(listener: (status: SdkSessionStatus) => void): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  /** SDK 交互镜像查询不创建宿主或会话。 */
  getExtensionUiSnapshot(): ExtensionUiSnapshot { return this.ui.snapshot() }

  /** 交互订阅供页面广播；不与其他来源的广播混用。 */
  onExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  /** 投影批次订阅供页面广播；宿主失效后不再广播旧代际批次。 */
  onProjectionBatch(listener: (batch: ProjectionBatch) => void): () => void {
    this.projectionListeners.add(listener)
    return () => this.projectionListeners.delete(listener)
  }

  /**
   * 提交 Prompt：只表达接受、排队或已处理，不等待本轮结束；运行中不排队也不重发。
   * 文本与图片在进入宿主前完成校验，页面传入的其他字段一律丢弃。
   */
  async prompt(message: string, images: readonly PromptImageInput[]): Promise<'started' | 'queued' | 'handled'> {
    const validated = validatePromptInput(message, images)
    if (!validated.ok) throw new SdkHostError('INVALID_SESSION_TARGET', validated.message)
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'prompt', bindingId, message, images: validated.images }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'prompt-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 提交结果不符合契约。')
    return frame.disposition
  }

  /** 会话内模型切换：以宿主实际状态为准，超时或退出时结果未知且不自动重发。 */
  async setSessionModel(provider: string, modelId: string): Promise<SdkSessionStatus> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'set-model', bindingId, provider, modelId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'session-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 模型切换结果不符合契约。')
    return this.getSessionStatus()
  }

  /**
   * 回退对话分支：非幂等写操作，单飞且结果未知时保留限制，不自动重发；
   * 首个等待期限后仍保留结果帧等待，追加窗口内到达即按真实结果返回。
   * 目标消息必须属于当前绑定，主进程不接受页面提交任意条目或会话路径。
   */
  async rewind(messageId: string): Promise<{ cancelled: boolean; text: string | null }> {
    if (this.sessionSubmission !== null || this.uncertainOperationId !== null) {
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', FAILURE_MESSAGES.SESSION_OPERATION_CONFLICT)
    }
    const requestId = randomUUID()
    this.sessionSubmission = requestId
    let submitted = false
    try {
      const record = this.requireHost(true)
      const bindingId = this.sessionSnapshot.bindingId
      if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      if (this.sessionSnapshot.needsHostRebuild || !this.sessionSnapshot.isIdle) {
        throw new SdkHostError('SESSION_BUSY', FAILURE_MESSAGES.SESSION_BUSY)
      }
      submitted = true
      const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId, type: 'rewind', bindingId, messageId }, SESSION_TIMEOUT_MS, WRITE_SETTLE_TIMEOUT_MS)
      if (frame.type !== 'rewind-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 回退结果不符合契约。')
      return { cancelled: frame.cancelled, text: frame.text }
    } catch (error) {
      if (submitted && error instanceof SdkHostError && (error.code === 'HOST_TIMEOUT'
        || error.code === 'HOST_EXITED' || error.code === 'HOST_CLOSED')) {
        this.uncertainOperationId = requestId
        // 未知态必须立刻对页面可见，不等宿主下一次状态事件。
        this.publishSession()
      }
      if (error instanceof SdkHostError) throw error
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', FAILURE_MESSAGES.SESSION_OPERATION_CONFLICT)
    } finally {
      if (this.sessionSubmission === requestId) this.sessionSubmission = null
    }
  }

  /**
   * 手动压缩当前会话上下文：非幂等且耗时（含一次摘要 LLM 调用），
   * 单飞且结果未知时不再重发；实际压缩过程与结果由投影中的压缩记录表达。
   * 超时不取消宿主侧压缩，也不把会话标成“需要恢复”：压缩不改变绑定或文件身份。
   */
  async compact(instructions: string | null): Promise<void> {
    if (this.sessionSubmission !== null || this.uncertainOperationId !== null) {
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', FAILURE_MESSAGES.SESSION_OPERATION_CONFLICT)
    }
    const requestId = randomUUID()
    this.sessionSubmission = requestId
    try {
      const record = this.requireHost(true)
      const bindingId = this.sessionSnapshot.bindingId
      if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      if (this.sessionSnapshot.needsHostRebuild || !this.sessionSnapshot.isIdle) {
        throw new SdkHostError('SESSION_BUSY', FAILURE_MESSAGES.SESSION_BUSY)
      }
      const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId, type: 'compact', bindingId, instructions }, COMPACT_TIMEOUT_MS)
      if (frame.type !== 'compact-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 压缩结果不符合契约。')
    } catch (error) {
      if (error instanceof SdkHostError) throw error
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', FAILURE_MESSAGES.SESSION_OPERATION_CONFLICT)
    } finally {
      if (this.sessionSubmission === requestId) this.sessionSubmission = null
    }
  }

  /** 只读当前绑定的模型清单；失败原因由结果表达，超时或失效时不返回伪造空清单。 */
  async readCapabilities(): Promise<AgentCapabilities> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'capabilities', bindingId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'capabilities-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 能力清单不符合契约。')
    return frame.capabilities
  }

  /** 只读当前绑定会话已加载的资源清单；读取失败由结果的 `error` 表达，超时或失效时不返回伪造空清单。 */
  async readResources(): Promise<PiResources> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'resources', bindingId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'resources-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 资源清单不符合契约。')
    return frame.resources
  }

  /** 只读当前绑定会话的创建期诊断与已收集的 Extension 错误；超时或失效时不返回伪造空诊断。 */
  async readDiagnostics(): Promise<RuntimeDiagnostics> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'diagnostics', bindingId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'diagnostics-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 诊断结果不符合契约。')
    return frame.diagnostics
  }

  /** 固定命令 `/mcp` 的状态读取；通知文本在宿主内捕获，超时不重发。 */
  async readMcpStatus(): Promise<McpStatus> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'mcp-status', bindingId }, MCP_STATUS_TIMEOUT_MS)
    if (frame.type !== 'mcp-status-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'MCP 状态结果不符合契约。')
    return frame.status
  }

  /** MCP 登录/退出/重连：命令文本由宿主拼出，等待期限按动作区分。 */
  async runMcpCommand(action: SdkMcpCommandAction, serverName: string): Promise<McpStatus> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const timeout = action === 'login'
      ? MCP_LOGIN_TIMEOUT_MS
      : action === 'reconnect' ? MCP_RECONNECT_TIMEOUT_MS : MCP_LOGOUT_TIMEOUT_MS
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'mcp-command', bindingId, action, serverName }, timeout)
    if (frame.type !== 'mcp-command-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'MCP 命令结果不符合契约。')
    return frame.status
  }

  /** 展示消息到官方条目 ID 的镜像：只在同一绑定代际内保留，宿主失效时清空。 */
  entryIdOf(messageId: string): string | null { return this.entryIds.get(messageId) ?? null }

  /** 历史读取固定会话与绑定；等待期间换代即拒绝旧结果。游标是否属于当前分支由宿主复核。 */
  async readHistory(sessionId: string, query: HistoryQuery): Promise<HistoryData> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null || this.sessionSnapshot.sessionId !== sessionId) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'history', bindingId, sessionId, query }, SESSION_TIMEOUT_MS)
    if (this.active !== record || this.sessionSnapshot.bindingId !== bindingId || this.sessionSnapshot.sessionId !== sessionId) {
      throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    }
    if (frame.type !== 'history-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', '历史读取结果不符合契约。')
    return frame.data
  }

  /** 镜像的最新投影快照；未取得时为 null，不由主进程凭空造空基准。 */
  getProjection(): ProjectionSnapshot | null { return this.projection }

  /** 取基准快照与确认增量：超时或失效时保留旧镜像，不假装已同步。 */
  async refreshProjection(): Promise<ProjectionSnapshot> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'projection-snapshot', bindingId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'projection-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 投影快照不符合契约。')
    if (this.sessionSnapshot.bindingId === bindingId) this.projection = frame.projection
    return frame.projection
  }

  /**
   * 会话日志读取：不需要活动绑定，也不建立 AgentSession；宿主未启动时先启动再解析。
   * 页、轮次与原文续段共用同一条读取链。失败按已声明分类抛错，不返回空历史冒充「没有内容」。
   */
  async readSessionLog(target: SdkLogTarget): Promise<HistoryData> {
    await this.ensureStarted()
    const record = this.requireHost()
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'session-log', target }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'log-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 日志读取结果不符合契约。')
    return frame.data
  }

  /** 确认只影响未确认窗口；确认失败不回退已展示内容。 */
  async ackProjection(seq: number): Promise<void> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'projection-ack', bindingId, seq }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'ack-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 投影确认不符合契约。')
  }

  /**
   * 内部生命周期入口；目标校验与发送期间单飞，结果未知时不允许冲突写入。
   * 与回退同用追加等待窗口：迟到结果帧仍返回真实状态，不提前判未知。
   */
  async runSessionAction(
    action: SdkSessionAction, reference: SdkSessionReference,
    expected: SdkSessionIdentity, interrupt: SdkInterruptConfirmation | null = null
  ): Promise<{ status: SdkSessionStatus; cancelled: boolean }> {
    if (this.sessionSubmission !== null || this.uncertainOperationId !== null) {
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', FAILURE_MESSAGES.SESSION_OPERATION_CONFLICT)
    }
    const requestId = randomUUID()
    this.sessionSubmission = requestId
    let submitted = false
    try {
      await this.ensureStarted()
      const record = this.requireHost()
      if ((expected.hostId !== null && expected.hostId !== record.hostId)
        || (expected.hostId === null && expected.bindingId !== null)
        || expected.bindingId !== this.sessionSnapshot.bindingId) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      if (this.sessionSnapshot.needsHostRebuild) throw new SdkHostError('SESSION_RECOVERY_REQUIRED', FAILURE_MESSAGES.SESSION_RECOVERY_REQUIRED)
      let target: SdkSessionTarget | null = null
      if (action !== 'release') {
        if (this.authority === null || (action === 'open' && reference.kind === 'new')) {
          throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
        }
        target = await this.authority(action === 'open' ? reference : { kind: 'new' },
          this.requireOwnerProject())
        if (!isSdkSessionTarget(target)) throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
      }
      if (this.active !== record || record.closing || expected.bindingId !== this.sessionSnapshot.bindingId) {
        throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      }
      submitted = true
      const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId, type: 'session', action, expectedBindingId: expected.bindingId, interrupt, target }, SESSION_TIMEOUT_MS, WRITE_SETTLE_TIMEOUT_MS)
      if (frame.type !== 'session-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 会话结果不符合契约。')
      return { status: this.getSessionStatus(), cancelled: frame.cancelled }
    } catch (error) {
      if (submitted && error instanceof SdkHostError && (error.code === 'HOST_TIMEOUT'
        || error.code === 'HOST_EXITED' || error.code === 'HOST_CLOSED')) {
        this.uncertainOperationId = requestId
        // 未知态必须立刻对页面可见，不等宿主下一次状态事件。
        this.publishSession()
      }
      if (error instanceof SdkHostError) throw error
      const code = this.authorizationFailure(error)
      throw new SdkHostError(code, FAILURE_MESSAGES[code])
    } finally {
      if (this.sessionSubmission === requestId) this.sessionSubmission = null
    }
  }

  /** 中止绕过生命周期提交锁，且只能作用于指定绑定。 */
  async abortSession(expected: SdkSessionIdentity & { readonly bindingId: number }): Promise<SdkSessionStatus> {
    const record = this.requireSessionHost(expected)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'session-abort', bindingId: expected.bindingId }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'session-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 中止结果不符合契约。')
    return this.getSessionStatus()
  }

  /** SDK 确认回应后才移除镜像；选择候选、method 和绑定身份在两端都复核。 */
  async respondDialog(expected: SdkSessionIdentity & { readonly bindingId: number }, dialogId: string, response: ExtensionDialogResponseInput): Promise<void> {
    const record = this.requireSessionHost(expected)
    const bindingId = expected.bindingId
    const snapshot = this.ui.snapshot()
    const dialog = snapshot.state.dialogs.find(item => item.id === dialogId)
    if (snapshot.runtimeId !== bindingId || dialog === undefined
      || (response.kind === 'confirm' && dialog.method !== 'confirm')
      || (response.kind === 'value' && (dialog.method === 'confirm'
        || (dialog.method === 'select' && !dialog.options.includes(response.value))))) {
      throw new SdkHostError('INTERACTION_INVALID', FAILURE_MESSAGES.INTERACTION_INVALID)
    }
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'ui-response', bindingId: expected.bindingId, dialogId, response }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'ui-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 交互结果不符合契约。')
    if (this.sessionSnapshot.bindingId === bindingId) this.ui.dismissDialog(dialogId)
  }

  /** 仅供显式恢复：结束不可复用宿主后建立空基础设施，不打开会话或重复原请求。 */
  async resetSessionHost(): Promise<SdkHostStatus> {
    if (!this.sessionSnapshot.needsHostRebuild && this.uncertainOperationId === null) {
      throw new SdkHostError('SESSION_OPERATION_CONFLICT', '当前没有需要重建的 SDK 上下文。')
    }
    const record = this.active
    if (record !== null) await this.closeHost(record)
    this.uncertainOperationId = null
    this.automaticRebuilds = 0
    return this.ensureStarted()
  }

  /** 只取得真实存活的宿主；控制回应可以在关闭协商期间帮助解除等待。 */
  private requireHost(control = false): HostRecord {
    const record = this.active
    if (record === null || record.exited || (!control && (!record.ready || record.closing || this.shuttingDown))) {
      throw new SdkHostError('HOST_NOT_READY', FAILURE_MESSAGES.HOST_NOT_READY)
    }
    return record
  }

  /** 归属项目只来自注册表登记结果；未登记时不允许授权任何目标。 */
  private requireOwnerProject(): string {
    const ownerProjectPath = this.options.runs.projectOfRun(this.options.runId)
    if (ownerProjectPath === null) throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
    return ownerProjectPath
  }

  /** 控制请求同样需要固定宿主与绑定，关闭协商期间仍可解除原上下文等待。 */
  private requireSessionHost(expected: SdkSessionIdentity & { readonly bindingId: number }): HostRecord {
    const record = this.requireHost(true)
    if (record.hostId !== expected.hostId || this.sessionSnapshot.bindingId !== expected.bindingId) {
      throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    }
    return record
  }

  /** 首次实际需求才建立宿主；并发调用共用同一握手，显式重试只重建基础设施。 */
  ensureStarted(): Promise<SdkHostStatus> {
    if (this.shuttingDown) {
      return Promise.reject(new SdkHostError('HOST_CLOSED', '应用正在退出，不能建立 SDK 宿主。'))
    }
    if (!app.isReady()) {
      return Promise.reject(new SdkHostError('HOST_NOT_READY', 'Electron 尚未就绪，不能建立 SDK 宿主。'))
    }
    this.wanted = true
    if (this.active?.ready && !this.active.closing) return Promise.resolve(this.getStatus())
    if (this.starting !== null) return this.starting
    if (this.active !== null) {
      return Promise.reject(new SdkHostError('HOST_NOT_READY', '旧 SDK 宿主尚未确认退出，不能建立第二个宿主。'))
    }
    this.cancelRecovery()
    if (this.snapshot.state === 'failed') this.automaticRebuilds = 0
    return this.startOnce()
  }

  /**
   * 空闲回收：关闭宿主进程但保留管理器可重用（不进入退出状态，也不解除占用）。
   * 会话身份与投影线索保留在快照里，下一次需要宿主的动作经 `ensureStarted()` 重建进程并重绑会话。
   * 有在途提交或结果未知时不回收（返回 false），由调用方重新计时；关闭未确认时抛错，不假装成功。
   */
  async suspend(): Promise<boolean> {
    if (this.shuttingDown) throw new SdkHostError('HOST_CLOSED', '应用正在退出，不能回收 SDK 宿主。')
    const record = this.active
    if (record === null) return true
    if (this.sessionSubmission !== null || this.uncertainOperationId !== null) return false
    this.cancelRecovery()
    // 先把宿主状态收回到空闲：否则关闭过程中的会话失效会被页面读成「正在启动」。
    this.publish({ state: 'idle', hostId: null, sdkVersion: null, lastError: null })
    await this.closeHost(record)
    // 绑定代际属于已释放的进程：清掉它，避免页面把挂起态读成仍然绑定。
    this.invalidateSession(true)
    return true
  }

  /**
   * 是否适合回收：镜像空闲、无在途提交、无结果未知，也不处于需要重建上下文的状态。
   * 只读已推送的状态，不向宿主发请求；等待用户下一条消息属于空闲，等待审批与排队不属于。
   */
  isIdleForReclaim(): boolean {
    const record = this.active
    if (record === null || record.exited || !record.ready || record.closing) return false
    if (this.sessionSubmission !== null || this.uncertainOperationId !== null) return false
    const session = this.sessionSnapshot
    if (session.needsHostRebuild) return false
    if (session.operationId !== null) return false
    if (session.pendingMessages > 0 || session.isBashRunning || session.waitingDialogs > 0) return false
    return session.isIdle
  }

  /** 退出意图同步生效，避免等待其他关闭链时仍安排宿主恢复。 */
  beginShutdown(): void {
    this.shuttingDown = true
    this.wanted = false
    this.cancelRecovery()
    if (this.active !== null) this.active.intentionalExit = true
  }

  /** 只关闭应用拥有的宿主；关闭回应与真正退出分别等待。 */
  async shutdown(): Promise<void> {
    this.beginShutdown()
    const record = this.active
    if (record !== null) {
      this.publish({ ...this.snapshot, state: 'stopping' })
      try {
        await this.closeHost(record)
      } catch (error) {
        this.publish({ state: 'failed', hostId: record.hostId, sdkVersion: null,
          lastError: 'HOST_STOP_TIMEOUT' })
        throw error
      }
    }
    this.publish({ state: 'idle', hostId: null, sdkVersion: null, lastError: null })
  }

  /** 单飞在微任务执行前登记，状态订阅者的重入也不会创建另一个进程。 */
  private startOnce(): Promise<SdkHostStatus> {
    if (this.starting !== null) return this.starting
    const pending = Promise.resolve().then(() => this.startHost()).finally(() => {
      if (this.starting === pending) this.starting = null
    })
    this.starting = pending
    return pending
  }

  /** 创建进程并完成应用级握手；spawn 不代表 SDK 已加载。 */
  private async startHost(): Promise<SdkHostStatus> {
    let record: HostRecord | null = null
    try {
      if (this.shuttingDown || !this.wanted) {
        throw new SdkHostError('HOST_CLOSED', 'SDK 宿主建立请求已取消。')
      }
      if (this.active !== null) {
        throw new SdkHostError('HOST_NOT_READY', '旧 SDK 宿主尚未确认退出。')
      }
      const entryPath = getSdkHostEntryPath()
      if (!existsSync(entryPath)) {
        throw new SdkHostError('HOST_ENTRY_MISSING', '未找到 SDK 宿主构建产物 out/sdk-host/index.mjs。')
      }
      const agentDir = getPiAgentDir()
      const env = getPiProcessEnvironment()
      // utilityProcess 不是认证 helper 的 ELECTRON_RUN_AS_NODE 子进程。
      delete env.ELECTRON_RUN_AS_NODE
      const child = utilityProcess.fork(entryPath, [], {
        env,
        cwd: app.isPackaged ? process.resourcesPath : dirname(entryPath),
        // 管道而不是 ignore：宿主崩溃原因只能从它自身的输出取得，且必须持续读空。
        stdio: 'pipe',
        serviceName: 'Pi SDK Host'
      })
      let resolveExit: () => void = () => {}
      const exitPromise = new Promise<void>(resolvePromise => { resolveExit = resolvePromise })
      record = {
        child, hostId: this.options.runId, agentDir, pending: new Map(),
        exitPromise, resolveExit, authorizations: new Set(), output: new HostOutputTail(), eventSeq: 0,
        ready: false, established: false, exited: false,
        intentionalExit: false, closing: false, closePromise: null
      }
      const current = record
      this.active = current
      this.sessionSnapshot = emptySdkSessionStatus()
      this.uncertainOperationId = null
      this.ui.beginGeneration(null)
      child.on('message', (value: unknown) => this.handleFrame(current, value))
      child.once('exit', () => this.handleExit(current))
      child.stdout?.on('data', (chunk: Buffer) => current.output.append(chunk))
      child.stderr?.on('data', (chunk: Buffer) => current.output.append(chunk))
      // Electron 的 error 是 V8 fatal 报告，不是 child_process 的通用启动异常。
      child.on('error', () => {
        if (this.active !== current || current.exited || current.closing) return
        current.ready = false
        this.reportHostFailure(current, 'HOST_EXITED', '宿主发生不可恢复错误')
        this.invalidateSession()
        this.failPending(current, new SdkHostError('HOST_EXITED', 'SDK 宿主发生不可恢复错误。'))
        this.publish({ state: 'failed', hostId: current.hostId, sdkVersion: null,
          lastError: 'HOST_EXITED' })
      })
      this.publish({ state: 'starting', hostId: current.hostId, sdkVersion: null, lastError: null })
      const frame = await this.request(current, {
        version: SDK_HOST_PROTOCOL_VERSION, hostId: current.hostId,
        requestId: randomUUID(), type: 'initialize', agentDir
      }, READY_TIMEOUT_MS)
      if (frame.type !== 'ready') {
        throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 宿主初始化响应不符合契约。')
      }
      if (this.active !== current || current.exited || current.closing || this.shuttingDown) {
        throw new SdkHostError('HOST_CLOSED', 'SDK 宿主在初始化期间已失效。')
      }
      if (!isAbsolute(frame.agentDir) || !samePath(frame.agentDir, current.agentDir)) {
        throw new SdkHostError('AGENT_DIR_MISMATCH', FAILURE_MESSAGES.AGENT_DIR_MISMATCH)
      }
      current.established = true
      current.ready = true
      this.publish({ state: 'ready', hostId: current.hostId,
        sdkVersion: frame.sdkVersion, lastError: null })
      if (this.shuttingDown || current.closing || this.active !== current || !current.ready) {
        throw new SdkHostError('HOST_CLOSED', 'SDK 宿主在就绪交接期间已失效。')
      }
      return this.getStatus()
    } catch (error) {
      let failure = error instanceof SdkHostError ? error
        : new SdkHostError('HOST_START_FAILED', '无法建立 SDK 宿主。')
      if (record !== null) {
        this.reportHostFailure(record, failure.code, '宿主建立或握手失败')
        try { await this.closeHost(record) } catch {
          failure = new SdkHostError('HOST_STOP_TIMEOUT', '旧 SDK 宿主未确认退出，已阻止新宿主建立。')
        }
      }
      if (!this.shuttingDown) {
        this.publish({ state: 'failed', hostId: record?.hostId ?? null,
          sdkVersion: null, lastError: failure.code })
      }
      throw failure
    }
  }

  /**
   * 请求只发送一次；超时结束等待，不证明操作未发生，也不解除进程所有权。
   * `settleMs > 0` 时首个期限到期不判未知，而是保留等待者继续等迟到结果帧，
   * 只有追加窗口也到期才拒绝；`settleMs = 0` 保持单期限语义。
   */
  private request(record: HostRecord, request: SdkHostRequest, timeoutMs: number, settleMs = 0): Promise<SdkHostFrame> {
    if (record.exited || this.active !== record || !isSdkHostRequest(request)
      || ((request.type === 'initialize' || request.type === 'session') && (record.closing || this.shuttingDown))) {
      return Promise.reject(new SdkHostError('HOST_CLOSED', 'SDK 宿主或请求已失效。'))
    }
    return new Promise((resolvePromise, reject) => {
      const failTimeout = (): void => {
        record.pending.delete(request.requestId)
        reject(new SdkHostError('HOST_TIMEOUT', 'SDK 宿主请求超时；未自动重发。'))
      }
      const firstDeadline = (): void => {
        if (settleMs <= 0) { failTimeout(); return }
        const pending = record.pending.get(request.requestId)
        if (pending === undefined) return
        pending.timer = setTimeout(failTimeout, settleMs)
      }
      const pending: PendingRequest = {
        type: request.type, timer: setTimeout(firstDeadline, timeoutMs), resolve: resolvePromise, reject
      }
      record.pending.set(request.requestId, pending)
      try {
        record.child.postMessage(request)
      } catch {
        clearTimeout(pending.timer)
        record.pending.delete(request.requestId)
        reject(new SdkHostError('HOST_EXITED', '无法向 SDK 宿主发送请求；未自动重发。'))
      }
    })
  }

  /** 只接受当前进程、当前代际及匹配请求的结果；迟到响应不触发重放。 */
  private handleFrame(record: HostRecord, value: unknown): void {
    if (this.active !== record || record.exited) return
    if (isSdkHostEvent(value)) {
      if (value.hostId !== record.hostId) this.failTransport(record, `事件身份不符：${describeRejectedFrame(value)}`)
      else this.handleEvent(record, value)
      return
    }
    if (!isSdkHostFrame(value) || value.hostId !== record.hostId) {
      this.failTransport(record, `不是已声明的宿主帧：${describeRejectedFrame(value)}`)
      return
    }
    const pending = record.pending.get(value.requestId)
    if (pending === undefined && value.requestId !== this.uncertainOperationId) return
    if (pending !== undefined) {
      const expected = EXPECTED_REPLIES[pending.type]
      if (expected !== null && value.type !== 'failed' && value.type !== expected) {
        this.failTransport(record, `请求 ${pending.type} 期望 ${expected}，收到：${describeRejectedFrame(value)}`)
        return
      }
    }
    if (value.type === 'session-result') {
      this.applySessionState(record, value.status, value.seq)
      if (this.uncertainOperationId === value.requestId) this.uncertainOperationId = null
    }
    if (pending === undefined) return
    record.pending.delete(value.requestId)
    clearTimeout(pending.timer)
    if (value.type === 'failed') {
      pending.reject(new SdkHostError(value.code, FAILURE_MESSAGES[value.code]))
    } else {
      pending.resolve(value)
    }
  }

  /** 同一宿主事件按序消费；UI 与状态使用同一水位，不接受旧绑定的交互。 */
  private handleEvent(record: HostRecord, event: SdkHostEvent): void {
    if (event.type === 'authorize-target') {
      void this.authorizeTarget(record, event)
      return
    }
    if (event.seq <= record.eventSeq) return
    if (event.type === 'session-state') {
      this.applySessionState(record, event.status, event.seq)
      return
    }
    record.eventSeq = event.seq
    if (event.bindingId !== this.sessionSnapshot.bindingId) return
    if (event.type === 'ui-request') this.ui.applyRequest(event.payload)
    else if (event.type === 'ui-cancel') this.ui.dismissDialog(event.dialogId)
    else if (event.type === 'entry-map') {
      // 映射有界：超出上限时丢弃最旧条目，不无限保留展示身份。
      if (this.entryIds.size >= MAX_ENTRY_MAPPINGS) {
        const oldest = this.entryIds.keys().next().value
        if (oldest !== undefined) this.entryIds.delete(oldest)
      }
      this.entryIds.set(event.messageId, event.entryId)
    } else this.publishProjection(event.batch)
  }

  /** 全量状态与事件共享水位，迟到完成结果只能同步实际状态，不能覆盖更新的绑定。 */
  private applySessionState(record: HostRecord, status: SdkSessionStatus, seq: number): void {
    if (this.active !== record || record.exited || seq < record.eventSeq) return
    const previous = this.sessionSnapshot
    record.eventSeq = seq
    this.sessionSnapshot = { ...status }
    // 绑定代际由注册表分配，这里只记录宿主实际报告的代际，供后续来源校验对照。
    this.options.runs.recordBinding(this.options.runId, status.bindingId)
    if (previous.bindingId !== status.bindingId || status.phase === 'invalid'
      || status.phase === 'empty' || status.phase === 'failed' || status.phase === 'blocked') {
      this.ui.beginGeneration(status.phase === 'invalid' || status.phase === 'empty'
        || status.phase === 'failed' || status.phase === 'blocked' ? null : status.bindingId)
    }
    // 宿主当前不再报告该操作在执行即视为已收敛，不依赖中间是否见过开始事件。
    if (this.uncertainOperationId !== null
      && status.operationId !== this.uncertainOperationId) this.uncertainOperationId = null
    this.publishSession()
  }

  /** 反向请求只做主进程授权；异步期间换代或关闭就丢弃，不重发目标操作。 */
  private async authorizeTarget(record: HostRecord, event: Extract<SdkHostEvent, { type: 'authorize-target' }>): Promise<void> {
    if (record.authorizations.has(event.requestId) || record.authorizations.size >= 8) {
      this.failTransport(record, `反向授权请求重复或超出上限：${describeRejectedFrame(event)}`)
      return
    }
    record.authorizations.add(event.requestId)
    let target: SdkSessionTarget | null = null
    let error: SdkHostFailureCode | null = null
    let generation: number | null = null
    try {
      if (this.authority === null || record.closing || event.bindingId !== this.sessionSnapshot.bindingId) {
        throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      }
      // 归属项目只取注册表登记值；宿主自报的项目仅做一致性复核，不作为授权依据。
      const ownerProjectPath = this.requireOwnerProject()
      if (event.projectPath !== null && !samePath(event.projectPath, ownerProjectPath)) {
        throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      }
      target = await this.authority(event.reference, ownerProjectPath)
      if (!isSdkSessionTarget(target)) throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
      // 代际紧邻实际重绑前分配；授权失败不分配，编号缺口不影响唯一性。
      generation = this.options.runs.allocateGeneration(this.options.runId)
    } catch (failure) { error = this.authorizationFailure(failure); target = null; generation = null }
    finally { record.authorizations.delete(event.requestId) }
    if (this.active !== record || record.exited || record.closing
      || event.bindingId !== this.sessionSnapshot.bindingId) return
    try {
      record.child.postMessage({ version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId: event.requestId, type: 'authorization-result', bindingId: event.bindingId,
        target, error, generation } satisfies SdkHostRequest)
    } catch { this.failTransport(record, '无法向宿主发送授权结果') }
  }

  /** 只保留已声明分类，不把主进程文件系统异常文本发给扩展或页面。 */
  private authorizationFailure(error: unknown): SdkHostFailureCode {
    if (typeof error === 'object' && error !== null && 'code' in error && isSdkHostFailureCode(error.code)) return error.code
    return 'AUTHORIZATION_FAILED'
  }

  /**
   * 宿主失效保留只读身份线索，实际执行入口和所有交互立即失效。
   * 失败原因由宿主状态的 `lastError` 携带（同一次失败已经发布）：会话侧不复制、
   * 也不用“未就绪”顶替崩溃，避免页面把真实原因读成 HOST_NOT_READY。
   */
  private invalidateSession(dropBinding = false): void {
    this.sessionSnapshot = { ...this.sessionSnapshot, phase: 'invalid', operationId: null,
      bindingId: dropBinding ? null : this.sessionSnapshot.bindingId,
      isIdle: false, isCompacting: false, waitingDialogs: 0, needsHostRebuild: true, lastError: null }
    this.projection = null
    this.entryIds.clear()
    this.ui.beginGeneration(null)
    this.publishSession()
  }

  /** 批次只转发给订阅方；主进程不重算投影，也不重发旧代际批次。 */
  private publishProjection(batch: ProjectionBatch): void {
    for (const listener of [...this.projectionListeners]) {
      try { listener(batch) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /** SDK 状态先广播给订阅方，再由映射层决定页面状态。 */
  private publishSession(): void {
    const status = this.getSessionStatus()
    for (const listener of [...this.sessionListeners]) {
      try { listener({ ...status }) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /** 协议失效先限制能力，再收回该宿主；不能继续信任一个仍存活的错误通道。 */
  private failTransport(record: HostRecord, detail: string): void {
    this.reportHostFailure(record, 'HOST_PROTOCOL_ERROR', detail)
    this.options.runs.markUnconfirmed(this.options.runId)
    this.invalidateSession()
    record.ready = false
    record.intentionalExit = true
    this.failPending(record, new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 宿主通信不符合内部契约。'))
    this.publish({ state: 'failed', hostId: record.hostId, sdkVersion: null,
      lastError: 'HOST_PROTOCOL_ERROR' })
    void this.closeHost(record, false).catch(() => {
      this.publish({ state: 'failed', hostId: record.hostId, sdkVersion: null,
        lastError: 'HOST_STOP_TIMEOUT' })
    })
  }

  /** 只有真实 exit 才解除所有权；正常关闭与异常退出使用同一 pending 收敛入口。 */
  private handleExit(record: HostRecord): void {
    if (record.exited) return
    record.exited = true
    this.failPending(record, new SdkHostError('HOST_EXITED', 'SDK 宿主已退出。'))
    record.resolveExit()
    if (this.active !== record) return
    this.active = null
    record.authorizations.clear()
    if (!record.intentionalExit && !this.shuttingDown) {
      // 未确认退出的运行实例保留占用，未确认前不建立替代实例。
      this.options.runs.markUnconfirmed(this.options.runId)
      this.reportHostFailure(record, 'HOST_EXITED', '宿主进程已退出但未确认关闭')
    }
    this.invalidateSession()
    if (record.intentionalExit || this.shuttingDown) return
    this.publish({ state: 'failed', hostId: record.hostId, sdkVersion: null, lastError: 'HOST_EXITED' })
    // 首次初始化失败不重发初始化；已建立宿主的崩溃可有限重建基础设施。
    if (record.established) this.scheduleRecovery()
  }

  /** 自动恢复预算不在每次 ready 后清零，避免短时间反复崩溃形成永久循环。 */
  private scheduleRecovery(): void {
    if (!this.wanted || this.shuttingDown || this.active !== null || this.recoveryTimer !== null) return
    if (this.automaticRebuilds >= MAX_AUTOMATIC_REBUILDS) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      if (this.shuttingDown || !this.wanted || this.active !== null) return
      this.automaticRebuilds += 1
      void this.startOnce().catch(() => this.scheduleRecovery())
    }, RECOVERY_DELAY_MS)
    this.publish({ ...this.snapshot, state: 'recovering' })
  }

  /** 主动关闭与显式建立取消尚未执行的恢复安排。 */
  private cancelRecovery(): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  /** 幂等关闭：失败也不丢弃仍存活的记录；没有确认 exit 就不允许替代宿主。 */
  private closeHost(record: HostRecord, graceful = true): Promise<void> {
    if (record.exited) return Promise.resolve()
    if (record.closePromise !== null) return record.closePromise
    record.closing = true
    record.intentionalExit = true
    record.ready = false
    this.failPending(record, new SdkHostError('HOST_CLOSED', 'SDK 宿主正在关闭。'))
    const pending = this.finishClose(record, graceful).finally(() => {
      if (record.closePromise === pending) record.closePromise = null
    })
    record.closePromise = pending
    return pending
  }

  /** 尽力协商关闭，然后定向结束受管 utilityProcess；kill 返回值不等于退出确认。 */
  private async finishClose(record: HostRecord, graceful: boolean): Promise<void> {
    if (graceful) {
      try {
        await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION,
          hostId: record.hostId, requestId: randomUUID(), type: 'shutdown' }, SHUTDOWN_RESPONSE_MS)
      } catch {
        // 协商失败仍保留原进程记录，继续等待或定向关闭。
      }
      if (await this.waitForExit(record, EXIT_GRACE_MS)) return
    }
    if (record.exited) return
    try { record.child.kill() } catch { /* 只以 exit 判断是否真的退出。 */ }
    if (!await this.waitForExit(record, KILL_WAIT_MS)) {
      throw new SdkHostError('HOST_STOP_TIMEOUT', 'SDK 宿主未确认退出，不能建立替代宿主。')
    }
  }

  /** 有限等待进程退出，成功与超时都会清理本次等待定时器。 */
  private waitForExit(record: HostRecord, timeoutMs: number): Promise<boolean> {
    if (record.exited) return Promise.resolve(true)
    return new Promise(resolvePromise => {
      const timer = setTimeout(() => resolvePromise(false), timeoutMs)
      void record.exitPromise.then(() => {
        clearTimeout(timer)
        resolvePromise(true)
      })
    })
  }

  /**
   * 宿主级失败只在主进程日志留一条可对照的记录：原因码沿用既定分类，原始输出只有有界尾部。
   * 页面与 IPC 结果仍只拿到分类与固定文案，不搬运宿主输出。
   */
  private reportHostFailure(record: HostRecord, code: SdkHostErrorCode, detail: string): void {
    const tail = record.output.tail().trimEnd()
    const output = tail === '' ? '（宿主没有输出）' : `\n${tail}`
    console.error(`[sdk-host] hostId=${record.hostId} agentDir=${record.agentDir} ${code}：${detail}${output}`)
  }

  /** 逐项清理定时器与等待者，不把原请求移交给新宿主。 */
  private failPending(record: HostRecord, error: SdkHostError): void {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    record.pending.clear()
  }

  /** 广播副本，订阅者异常不能改变宿主生命周期。 */
  private publish(status: SdkHostStatus): void {
    this.snapshot = status
    for (const listener of [...this.listeners]) {
      try { listener({ ...status }) } catch { /* 消费者故障不影响监督。 */ }
    }
  }
}
