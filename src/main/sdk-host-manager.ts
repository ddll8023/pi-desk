/** 监督单个 SDK 宿主与内部会话请求，持有安全状态和交互镜像；尚未切换页面主链，不重放操作。 */
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
} from '../sdk-host/protocol'
import type {
  SdkHostFrame, SdkHostRequest, SdkHostFailureCode, SdkHostEvent, SdkSessionStatus,
  SdkSessionReference, SdkSessionTarget, SdkSessionAction, SdkInterruptConfirmation, SdkSessionIdentity
} from '../sdk-host/protocol'
import type { AgentCapabilities, ProjectionBatch, ProjectionSnapshot, PromptImageInput } from '../shared/runtime-api'
import { ExtensionUiManager } from './extension-ui-manager'
import type { ExtensionDialogResponseInput, ExtensionUiSnapshot } from '../shared/extension-ui-api'
import { getPiAgentDir, getPiProcessEnvironment } from './pi-paths'
import { validatePromptInput } from './runtime-manager'

const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_RESPONSE_MS = 6_000
const SESSION_TIMEOUT_MS = 60_000
const EXIT_GRACE_MS = 2_000
const KILL_WAIT_MS = 3_000
const RECOVERY_DELAY_MS = 750
/** 展示消息到条目 ID 的镜像上限；超出丢弃最旧映射。 */
const MAX_ENTRY_MAPPINGS = 512
const MAX_AUTOMATIC_REBUILDS = 2

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
  reference: SdkSessionReference, expectedProjectPath: string | null
) => Promise<SdkSessionTarget>

interface PendingRequest {
  readonly type: SdkHostRequest['type']
  readonly timer: ReturnType<typeof setTimeout>
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
  SESSION_OPERATION_CONFLICT: '生命周期操作冲突，或旧 RPC 尚未释放会话所有权。',
  SESSION_CREATE_FAILED: 'SDK 会话创建失败；请以实际会话状态为准。',
  SESSION_BIND_FAILED: 'SDK 会话或必要交互绑定失败。',
  SESSION_CLOSE_FAILED: 'SDK 会话关闭未收敛。',
  SESSION_RECOVERY_REQUIRED: 'SDK 上下文不可继续复用，需要显式恢复基础设施。',
  AUTHORIZATION_FAILED: '无法安全确认会话目标与信任范围。',
  INTERACTION_INVALID: '扩展交互已失效或回应无效。'
}

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

export class SdkHostManager {
  private active: HostRecord | null = null
  private starting: Promise<SdkHostStatus> | null = null
  private hostIdSeed = 0
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
    // SDK 回应由 respondDialog 直接发送；此镜像不复用旧 RPC 管道。
    onDialogResponse: () => {}
  })
  private snapshot: SdkHostStatus = {
    state: 'idle', hostId: null, sdkVersion: null, lastError: null
  }

  /** 查询仅返回已持有状态，绝不为了展示建立宿主。 */
  getStatus(): SdkHostStatus {
    return { ...this.snapshot }
  }

  /** 订阅生命周期结果；会话与页面契约将在主链接入时单独适配。 */
  onStatusChanged(listener: (status: SdkHostStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 主进程提供唯一目标授权；不让宿主自行决定项目、信任或任意路径。 */
  setSessionAuthority(authority: SdkSessionAuthority): void { this.authority = authority }

  /** SDK 内部状态尚未映射到旧 Runtime 或页面 ready。 */
  getSessionStatus(): SdkSessionStatus { return { ...this.sessionSnapshot } }

  /** 写操作调用方在用户确认前固定此身份，不能只传可能在新进程重用的绑定编号。 */
  getSessionIdentity(): SdkSessionIdentity {
    return { hostId: this.active?.hostId ?? null, bindingId: this.sessionSnapshot.bindingId }
  }

  /** 仅订阅 SDK 绑定状态，不发送既有 Runtime 事件。 */
  onSessionChanged(listener: (status: SdkSessionStatus) => void): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  /** SDK 交互镜像查询不创建宿主或会话。 */
  getExtensionUiSnapshot(): ExtensionUiSnapshot { return this.ui.snapshot() }

  /** 交互订阅留给主链接入，不能与旧 RPC 广播混用。 */
  onExtensionUi(listener: (snapshot: ExtensionUiSnapshot) => void): () => void {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  /** 投影批次订阅留给主链接入；宿主失效后不再广播旧代际批次。 */
  onProjectionBatch(listener: (batch: ProjectionBatch) => void): () => void {
    this.projectionListeners.add(listener)
    return () => this.projectionListeners.delete(listener)
  }

  /**
   * 提交 Prompt：只表达接受、排队或已处理，不等待本轮结束；运行中不排队也不重发。
   * 文本与图片在进入宿主前已完成与旧链路相同的校验。
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
   * 回退对话分支：非幂等写操作，单飞且结果未知时保留限制，不自动重发。
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
        requestId, type: 'rewind', bindingId, messageId }, SESSION_TIMEOUT_MS)
      if (frame.type !== 'rewind-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 回退结果不符合契约。')
      return { cancelled: frame.cancelled, text: frame.text }
    } catch (error) {
      if (submitted && error instanceof SdkHostError && (error.code === 'HOST_TIMEOUT'
        || error.code === 'HOST_EXITED' || error.code === 'HOST_CLOSED')) this.uncertainOperationId = requestId
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

  /** 展示消息到官方条目 ID 的镜像：只在同一绑定代际内保留，宿主失效时清空。 */
  entryIdOf(messageId: string): string | null { return this.entryIds.get(messageId) ?? null }

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

  /** 确认只影响未确认窗口；确认失败不回退已展示内容。 */
  async ackProjection(seq: number): Promise<void> {
    const record = this.requireHost(true)
    const bindingId = this.sessionSnapshot.bindingId
    if (bindingId === null) throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'projection-ack', bindingId, seq }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'ack-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 投影确认不符合契约。')
  }

  /** 内部生命周期入口；目标校验与发送期间单飞，结果未知时不允许冲突写入。 */
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
        target = await this.authority(action === 'open' ? reference : { kind: 'new' }, null)
        if (!isSdkSessionTarget(target)) throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
      }
      if (this.active !== record || record.closing || expected.bindingId !== this.sessionSnapshot.bindingId) {
        throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      }
      submitted = true
      const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId, type: 'session', action, expectedBindingId: expected.bindingId, interrupt, target }, SESSION_TIMEOUT_MS)
      if (frame.type !== 'session-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 会话结果不符合契约。')
      return { status: this.getSessionStatus(), cancelled: frame.cancelled }
    } catch (error) {
      if (submitted && error instanceof SdkHostError && (error.code === 'HOST_TIMEOUT'
        || error.code === 'HOST_EXITED' || error.code === 'HOST_CLOSED')) this.uncertainOperationId = requestId
      if (error instanceof SdkHostError) throw error
      const code = this.authorizationFailure(error)
      throw new SdkHostError(code, FAILURE_MESSAGES[code])
    } finally {
      if (this.sessionSubmission === requestId) this.sessionSubmission = null
    }
  }

  /** 只读协调实际状态；不会为了补齐展示重新执行原操作。 */
  async refreshSessionStatus(): Promise<SdkSessionStatus> {
    const record = this.requireHost()
    const frame = await this.request(record, { version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
      requestId: randomUUID(), type: 'session-status' }, SESSION_TIMEOUT_MS)
    if (frame.type !== 'session-result') throw new SdkHostError('HOST_PROTOCOL_ERROR', 'SDK 会话状态不符合契约。')
    if (this.sessionSnapshot.operationId === null) this.uncertainOperationId = null
    return this.getSessionStatus()
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
        stdio: 'ignore',
        serviceName: 'Pi SDK Host'
      })
      let resolveExit: () => void = () => {}
      const exitPromise = new Promise<void>(resolvePromise => { resolveExit = resolvePromise })
      record = {
        child, hostId: ++this.hostIdSeed, agentDir, pending: new Map(),
        exitPromise, resolveExit, authorizations: new Set(), eventSeq: 0,
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
      // Electron 的 error 是 V8 fatal 报告，不是 child_process 的通用启动异常。
      child.on('error', () => {
        if (this.active !== current || current.exited || current.closing) return
        current.ready = false
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

  /** 请求只发送一次；超时结束等待，不证明操作未发生，也不解除进程所有权。 */
  private request(record: HostRecord, request: SdkHostRequest, timeoutMs: number): Promise<SdkHostFrame> {
    if (record.exited || this.active !== record || !isSdkHostRequest(request)
      || ((request.type === 'initialize' || request.type === 'session') && (record.closing || this.shuttingDown))) {
      return Promise.reject(new SdkHostError('HOST_CLOSED', 'SDK 宿主或请求已失效。'))
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(request.requestId)
        reject(new SdkHostError('HOST_TIMEOUT', 'SDK 宿主请求超时；未自动重发。'))
      }, timeoutMs)
      record.pending.set(request.requestId, {
        type: request.type, timer, resolve: resolvePromise, reject
      })
      try {
        record.child.postMessage(request)
      } catch {
        clearTimeout(timer)
        record.pending.delete(request.requestId)
        reject(new SdkHostError('HOST_EXITED', '无法向 SDK 宿主发送请求；未自动重发。'))
      }
    })
  }

  /** 只接受当前进程、当前代际及匹配请求的结果；迟到响应不触发重放。 */
  private handleFrame(record: HostRecord, value: unknown): void {
    if (this.active !== record || record.exited) return
    if (isSdkHostEvent(value)) {
      if (value.hostId !== record.hostId) this.failTransport(record)
      else this.handleEvent(record, value)
      return
    }
    if (!isSdkHostFrame(value) || value.hostId !== record.hostId) {
      this.failTransport(record)
      return
    }
    const pending = record.pending.get(value.requestId)
    if (pending === undefined && value.requestId !== this.uncertainOperationId) return
    if (pending !== undefined) {
      const expected = pending.type === 'initialize' ? 'ready' : pending.type === 'shutdown' ? 'closed'
        : pending.type === 'ui-response' ? 'ui-result' : 'session-result'
      if (value.type !== 'failed' && value.type !== expected) {
        this.failTransport(record)
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
    if (previous.bindingId !== status.bindingId || status.phase === 'invalid'
      || status.phase === 'empty' || status.phase === 'failed' || status.phase === 'blocked') {
      this.ui.beginGeneration(status.phase === 'invalid' || status.phase === 'empty'
        || status.phase === 'failed' || status.phase === 'blocked' ? null : status.bindingId)
    }
    if (this.uncertainOperationId !== null && previous.operationId === this.uncertainOperationId
      && status.operationId !== previous.operationId) this.uncertainOperationId = null
    this.publishSession()
  }

  /** 反向请求只做主进程授权；异步期间换代或关闭就丢弃，不重发目标操作。 */
  private async authorizeTarget(record: HostRecord, event: Extract<SdkHostEvent, { type: 'authorize-target' }>): Promise<void> {
    if (record.authorizations.has(event.requestId) || record.authorizations.size >= 8) {
      this.failTransport(record)
      return
    }
    record.authorizations.add(event.requestId)
    let target: SdkSessionTarget | null = null
    let error: SdkHostFailureCode | null = null
    try {
      if (this.authority === null || record.closing || event.bindingId !== this.sessionSnapshot.bindingId) {
        throw new SdkHostError('STALE_SESSION', FAILURE_MESSAGES.STALE_SESSION)
      }
      target = await this.authority(event.reference, event.projectPath)
      if (!isSdkSessionTarget(target)) throw new SdkHostError('INVALID_SESSION_TARGET', FAILURE_MESSAGES.INVALID_SESSION_TARGET)
    } catch (failure) { error = this.authorizationFailure(failure); target = null }
    finally { record.authorizations.delete(event.requestId) }
    if (this.active !== record || record.exited || record.closing
      || event.bindingId !== this.sessionSnapshot.bindingId) return
    try {
      record.child.postMessage({ version: SDK_HOST_PROTOCOL_VERSION, hostId: record.hostId,
        requestId: event.requestId, type: 'authorization-result', bindingId: event.bindingId, target, error } satisfies SdkHostRequest)
    } catch { this.failTransport(record) }
  }

  /** 只保留已声明分类，不把主进程文件系统异常文本发给扩展或页面。 */
  private authorizationFailure(error: unknown): SdkHostFailureCode {
    if (typeof error === 'object' && error !== null && 'code' in error && isSdkHostFailureCode(error.code)) return error.code
    return 'AUTHORIZATION_FAILED'
  }

  /** 宿主失效保留只读身份线索，实际执行入口和所有交互立即失效。 */
  private invalidateSession(): void {
    this.sessionSnapshot = { ...this.sessionSnapshot, phase: 'invalid', operationId: null,
      isIdle: false, waitingDialogs: 0, needsHostRebuild: true, lastError: 'HOST_NOT_READY' }
    this.projection = null
    this.entryIds.clear()
    this.ui.beginGeneration(null)
    this.publishSession()
  }

  /** 批次只转发给主链接入方；主进程不重算投影，也不重发旧代际批次。 */
  private publishProjection(batch: ProjectionBatch): void {
    for (const listener of [...this.projectionListeners]) {
      try { listener(batch) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /** SDK 状态订阅尚不接入页面 Runtime 广播。 */
  private publishSession(): void {
    const status = this.getSessionStatus()
    for (const listener of [...this.sessionListeners]) {
      try { listener({ ...status }) } catch { /* 展示消费者不能改变会话所有权。 */ }
    }
  }

  /** 协议失效先限制能力，再收回该宿主；不能继续信任一个仍存活的错误通道。 */
  private failTransport(record: HostRecord): void {
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
