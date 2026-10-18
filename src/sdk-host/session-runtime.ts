/** 单活动 SDK 会话的生命周期所有者；只提供内部绑定，不提供 prompt、历史投影或页面 ready。 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AgentSession, AgentSessionEvent, AgentSessionRuntime, ExtensionCommandContextActions, ExtensionFactory, SessionStats } from '@earendil-works/pi-coding-agent'
import { ExtensionUiBridge } from './extension-ui-bridge'
import { createGenuiExtension, GENUI_EXTENSION_NAME } from '../extensions/genui'
import { MessageProjection } from '../projection/message-projection'
import { ActivityProjection } from '../projection/activity-projection'
import { historyEntryId, readBranchHistory } from '../projection/history-projection'
import { OutputRateTracker } from '../projection/output-rate'
import { SDK_HOST_PROTOCOL_VERSION } from './protocol'
import type {
  SdkHostFailureCode, SdkMcpCommandAction, SdkSessionAuthorization, SdkSessionReference, SdkSessionRequest,
  SdkSessionStatus, SdkSessionTarget
} from './protocol'
import type {
  AgentCapabilities, ExtensionErrorEntry, McpStatus, ModelSummary, OutputRate, PiResourceEntry, PiResources,
  ProjectionBatch, ProjectionSnapshot, PromptDisposition, RuntimeDiagnostics, SessionUsage, HistoryData, HistoryQuery
} from '../shared/runtime-api'
import type { ExtensionDialogResponseInput } from '../shared/extension-ui-api'

type Sdk = typeof import('@earendil-works/pi-coding-agent')
type RuntimeFactory = Parameters<Sdk['createAgentSessionRuntime']>[0]
interface RuntimeOptions {
  readonly hostId: number
  readonly agentDir: string
  readonly authorize: (reference: SdkSessionReference, bindingId: number | null, projectPath: string | null) => Promise<SdkSessionAuthorization>
  readonly onState: (status: SdkSessionStatus) => void
  readonly onUiRequest: (bindingId: number, payload: Record<string, unknown>) => void
  readonly onUiCancel: (bindingId: number, dialogId: string) => void
  readonly onProjectionBatch: (bindingId: number, batch: ProjectionBatch) => void
  readonly onEntryMap: (bindingId: number, messageId: string, entryId: string) => void
}
const SETTLE_TIMEOUT_MS = 5_000
/** 会话统计补读的最小间隔：状态推送频繁，不能每次取状态都遍历会话条目。 */
const USAGE_REFRESH_MS = 1_000
/**
 * 等待官方接受回执的兜底上限。
 *
 * 官方在扩展 input handler、凭据校验与 before_agent_start 钩子之后才回报接受结果，
 * 冷启动或首次连接供应商时可能明显超过一秒，因此这里的到期不是失败判定：
 * 只有到期且会话确实没有进入运行态，才可以按冲突收敛。
 */
const PROMPT_ACCEPT_TIMEOUT_MS = 30_000

/** 助手消息的事件身份；只有它参与速率结算与统计。 */
function isAssistantMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null
    && (message as { readonly role?: unknown }).role === 'assistant'
}

/** 助手消息的累计输出 token；未上报或形状不符时按未知处理，不猜造。 */
function readAssistantOutput(message: unknown): number | null {
  if (typeof message !== 'object' || message === null) return null
  const usage = (message as { readonly usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return null
  const output = (usage as { readonly output?: unknown }).output
  return typeof output === 'number' && Number.isFinite(output) && output >= 0 ? output : null
}

/** 模型身份只在有非空取值时投影；官方尚未选定模型时保持 null。 */
function readModelIdentity(model: { readonly provider?: unknown; readonly id?: unknown } | undefined): {
  readonly provider: string | null
  readonly id: string | null
} {
  const provider = typeof model?.provider === 'string' && model.provider !== '' ? model.provider : null
  const id = typeof model?.id === 'string' && model.id !== '' ? model.id : null
  return { provider, id }
}

/** 官方统计到页面用量的投影：缺失的累计值按 0，未知的上下文占用保持 null。 */
function toSessionUsage(stats: SessionStats): SessionUsage {
  const context = stats.contextUsage
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
    context: context === undefined ? null : {
      tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent
    }
  }
}

/** 只用固定分类跨出宿主，原始 SDK 异常可能带敏感配置。 */
export class SdkSessionFailure extends Error {
  constructor(readonly code: SdkHostFailureCode) { super(code) }
}

/** 只比较已经明确的绝对身份，项目规范形式仍由主进程负责。 */
function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * 把 SDK 事件归一为与 RPC 事件相同的形状后再送入投影：不搬运原始 partial/
 * 大型对象，只保留展示所需的增量字段。
 */
function toProjectionEvent(event: AgentSessionEvent): Record<string, unknown> | null {
  if (event.type !== 'message_update') return event as unknown as Record<string, unknown>
  const raw = event.assistantMessageEvent as Record<string, unknown>
  // 事件联合不保证 message 为助手消息；用量缺失时不伪造字段。
  const usage = 'usage' in event.message ? event.message.usage : undefined
  const { partial: _partial, ...rest } = raw
  if (raw.type === 'toolcall_start') {
    const partial = raw.partial as { content?: { type?: string; id?: string; name?: string }[] } | undefined
    const toolCall = partial?.content?.[raw.contentIndex as number]
    if (toolCall?.type !== 'toolCall' || typeof toolCall.id !== 'string' || typeof toolCall.name !== 'string') {
      return null
    }
    return { type: 'message_update', usage,
      assistantMessageEvent: { ...rest, id: toolCall.id, toolName: toolCall.name } }
  }
  return { type: 'message_update', usage, assistantMessageEvent: rest }
}

/** 有限等待不取消底层任务；调用方必须保留受阻状态，不能据此重复操作。 */
function bounded<T>(task: Promise<T>): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')), SETTLE_TIMEOUT_MS)
    void task.then(value => { clearTimeout(timer); resolvePromise(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** 资源清单条目上限；超出截断并如实标记，不伪装成完整清单。 */
const RESOURCE_ENTRY_LIMIT = 500

/** 诊断展示行数与 Extension 错误条数上限；超出只保留最近的部分。 */
const DIAGNOSTIC_VIEW_LINES = 20
const EXTENSION_ERROR_LIMIT = 20
/** 单条 Extension 错误文本上限：旧路径没有上限，这里收紧以免超长文本进入 IPC。 */
const EXTENSION_ERROR_MESSAGE_LIMIT = 2_000
/** SDK 诊断级别到展示前缀；级别是穷尽联合。 */
const DIAGNOSTIC_PREFIXES: Readonly<Record<'info' | 'warning' | 'error', string>> = {
  info: '提示', warning: '警告', error: '错误'
}

/** `/mcp` 是读取 MCP 状态的唯一固定命令；命令文本不接受页面传入。 */
const MCP_STATUS_PROMPT = '/mcp'

/** MCP 命令文本由宿主拼出；动作与服务器名都已由主进程校验。 */
function mcpCommandPrompt(action: SdkMcpCommandAction, serverName: string): string {
  return `/mcp ${action} ${serverName}`
}

/** 资源条目的来源字段；非字符串或空串一律为 null，不用空串冒充来源信息。 */
interface ResourceSourceFields {
  readonly path?: unknown
  readonly scope?: unknown
  readonly origin?: unknown
  readonly baseDir?: unknown
}

/** 资源条目的来源信息取自官方 `sourceInfo`；缺失字段保持 null。 */
function sourceFields(info: ResourceSourceFields): Pick<PiResourceEntry, 'path' | 'scope' | 'origin' | 'baseDir'> {
  return {
    path: optionalText(info.path),
    scope: optionalText(info.scope),
    origin: optionalText(info.origin),
    baseDir: optionalText(info.baseDir)
  }
}

/** 只接受非空字符串；其余取值按未知处理。 */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 会话已加载资源到页面清单的映射：扩展命令、提示词与技能三类，
 * 技能名补齐 `skill:` 前缀（页面按该前缀把技能与斜杠命令分开搜索）。
 * 名称为空的条目直接丢弃：页面契约要求非空名称，不用空名冒充一条资源。
 */
function sessionResources(session: AgentSession): PiResourceEntry[] {
  const entries: PiResourceEntry[] = []
  for (const command of session.extensionRunner.getRegisteredCommands()) {
    const name = optionalText(command.invocationName)
    if (name === null) continue
    entries.push({ kind: 'extension', name,
      description: optionalText(command.description), ...sourceFields(command.sourceInfo) })
  }
  for (const template of session.promptTemplates) {
    const name = optionalText(template.name)
    if (name === null) continue
    entries.push({ kind: 'prompt', name,
      description: optionalText(template.description), ...sourceFields(template.sourceInfo) })
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    const name = optionalText(skill.name)
    if (name === null) continue
    entries.push({ kind: 'skill', name: `skill:${name}`,
      description: optionalText(skill.description), ...sourceFields(skill.sourceInfo) })
  }
  return entries
}

export class SdkSessionRuntime {
  private runtime: AgentSessionRuntime | null = null
  private session: AgentSession | null = null
  private bridge: ExtensionUiBridge | null = null
  private projection: MessageProjection | null = null
  private activity: ActivityProjection | null = null
  private historyTail: string | null = null
  private historyRevision = 0
  private unsubscribe: (() => void) | null = null
  private target: SdkSessionTarget | null = null
  /** 准备目标与实际活动项目分开，前置钩子取消时不能把旧对象改称新目标。 */
  private factoryTarget: SdkSessionTarget | null = null
  /** 主进程注册表为该次重绑分配的应用级绑定代际；绑定成功前为空。 */
  private pendingGeneration: number | null = null
  private creationSeed = 0
  private currentCreation: number | null = null
  private readonly creations = new WeakMap<AgentSession, number>()
  /** 刚结束的展示消息等待官方条目落盘；只保留一条，不无界缓存消息对象。 */
  private pendingEntryLookup: { readonly messageId: string; readonly message: unknown } | null = null
  /** 本条事件对应的消息对象；只在单次事件处理内有效。 */
  private lastEndedMessage: unknown = null
  private bindingId: number | null = null
  private activityVersion = 0
  private lastBusy = false
  private lastQueueCount = 0
  private operationId: string | null = null
  private operationDone: Promise<void> | null = null
  private closing = false
  private phase: SdkSessionStatus['phase'] = 'empty'
  private lastError: SdkHostFailureCode | null = null
  private needsHostRebuild = false
  private valid = false
  /** 速率结算与用量缓存都只属于当前绑定；换代或失效时一并清空。 */
  private rate: OutputRateTracker | null = null
  private rateSnapshot: OutputRate = { average: null }
  private usage: SessionUsage | null = null
  private usageReadAt = 0
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  /** 投影上报的展示消息条数；未绑定时为 0。 */
  private projectedMessageCount = 0
  /** 当前代际收到的 Extension 运行时错误；绑定换代时清空。 */
  private extensionErrors: ExtensionErrorEntry[] = []
  /** Prompt 提交与 MCP 调用互斥：同一时刻只允许一个 prompt 请求。 */
  private promptInFlight = false

  constructor(private readonly sdk: Sdk, private readonly options: RuntimeOptions) {}

  /** 实际对象与绑定状态分别表达；未取得历史基准时仍不会生成可提交状态。 */
  getStatus(): SdkSessionStatus {
    const session = this.session
    const model = readModelIdentity(session?.model)
    return {
      phase: this.phase, bindingId: this.bindingId, activityVersion: this.activityVersion,
      operationId: this.operationId, projectPath: this.target?.projectPath ?? null,
      sessionId: session?.sessionId ?? null, sessionFile: session?.sessionFile ?? null,
      isIdle: this.operationId === null && !this.isBusy(), pendingMessages: session?.pendingMessageCount ?? 0,
      isCompacting: session?.isCompacting ?? false,
      isBashRunning: session?.isBashRunning ?? false, waitingDialogs: this.bridge?.waitingCount ?? 0,
      needsHostRebuild: this.needsHostRebuild, lastError: this.lastError,
      modelProvider: model.provider, modelId: model.id, messageCount: this.projectedMessageCount,
      usage: this.usage, rate: this.rateSnapshot
    }
  }

  /** 根生命周期操作互斥；不排队改写用户已经固定的目标。 */
  async execute(request: SdkSessionRequest): Promise<{ status: SdkSessionStatus; cancelled: boolean }> {
    if (this.closing) throw new SdkSessionFailure('HOST_NOT_READY')
    if (request.expectedBindingId !== this.bindingId) throw new SdkSessionFailure('STALE_SESSION')
    if (this.operationId !== null) throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    if (this.needsHostRebuild) throw new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')
    const initialActivity = this.activityVersion
    const confirmed = request.interrupt !== null && request.interrupt.bindingId === this.bindingId
      && request.interrupt.activityVersion === initialActivity
    if (this.isBusy() && !confirmed) throw new SdkSessionFailure('SESSION_BUSY')
    this.operationId = request.requestId
    this.phase = 'preparing'
    this.lastError = null
    let finish: () => void = () => {}
    this.operationDone = new Promise<void>(resolvePromise => { finish = resolvePromise })
    this.publish()
    let cancelled = false
    try {
      if (request.action !== 'release') {
        if (request.target === null) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
        const reference: SdkSessionReference = request.action === 'open' && request.target.sessionFile !== null
          ? { kind: 'file', sessionFile: request.target.sessionFile } : { kind: 'new' }
        const authorized = await this.options.authorize(reference, this.bindingId, request.target.projectPath)
        const fresh = authorized.target
        if (!samePath(fresh.projectPath, request.target.projectPath)
          || fresh.trusted !== request.target.trusted
          || (request.action === 'open' && (fresh.sessionId !== request.target.sessionId
            || fresh.fileStamp !== request.target.fileStamp))) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
        await this.precheck(fresh)
        // 授权等待期间出现的新执行不在旧中断确认范围内。
        if (this.activityVersion !== initialActivity && this.isBusy()) throw new SdkSessionFailure('SESSION_BUSY')
        if (this.isBusy()) {
          if (!confirmed) throw new SdkSessionFailure('SESSION_BUSY')
          await this.settleCurrent()
        }
        if (this.closing) throw new SdkSessionFailure('HOST_NOT_READY')
        // 代际紧邻实际重绑前固定；取消确认或前置检查失败时不会建立绑定。
        this.pendingGeneration = authorized.generation
        if (request.action === 'reload') await this.reload(fresh)
        else {
          this.factoryTarget = fresh
          if (request.action === 'open') {
            if (fresh.sessionFile === null) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
            if (this.runtime !== null && this.valid) {
              const result = await this.runtime.switchSession(fresh.sessionFile, { cwdOverride: fresh.projectPath })
              cancelled = result.cancelled
            } else await this.createInitial(this.sdk.SessionManager.open(fresh.sessionFile, fresh.sessionDir, fresh.projectPath))
          } else if (this.runtime !== null && this.valid && samePath(this.runtime.cwd, fresh.projectPath)) {
            const result = await this.runtime.newSession()
            cancelled = result.cancelled
          } else {
            await this.closeCurrent()
            await this.createInitial(this.sdk.SessionManager.create(fresh.projectPath, fresh.sessionDir))
          }
        }
      } else {
        if (this.isBusy()) await this.settleCurrent()
        await this.closeCurrent()
      }
    } catch (error) {
      const failure = error instanceof SdkSessionFailure ? error : new SdkSessionFailure('SESSION_CREATE_FAILED')
      this.lastError = failure.code
      if (this.needsHostRebuild) this.phase = 'blocked'
      else this.phase = this.valid ? 'bound' : 'failed'
      throw failure
    } finally {
      this.operationId = null
      this.operationDone = null
      if (this.phase === 'preparing') this.phase = this.valid ? 'bound' : 'empty'
      finish()
      this.publish()
    }
    return { status: this.getStatus(), cancelled }
  }

  /** 中止与 UI 回应不占生命周期锁，必须能解除正在等待它们的操作。 */
  async abort(bindingId: number): Promise<void> {
    if (bindingId !== this.bindingId || this.session === null) throw new SdkSessionFailure('STALE_SESSION')
    try { await this.settleCurrent() } catch {
      this.needsHostRebuild = true
      this.phase = 'blocked'
      this.lastError = 'SESSION_RECOVERY_REQUIRED'
      this.publish()
      throw new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')
    }
    this.publish()
  }

  /** 投影快照只在已绑定代际有效；未绑定时返回 null，不由宿主凭空造空基准。 */
  getProjection(bindingId: number): ProjectionSnapshot | null {
    if (bindingId !== this.bindingId || this.projection === null) return null
    this.refreshActivity()
    return this.projection.snapshot()
  }

  /** 只读取当前绑定、当前会话的原始分支，不接受历史文件路径。 */
  readHistory(bindingId: number, sessionId: string, query: HistoryQuery, revision: number): HistoryData {
    const session = this.requireBoundSession(bindingId)
    this.refreshActivity()
    if (session.sessionManager.getSessionId() !== sessionId || revision !== this.historyRevision) throw new SdkSessionFailure('STALE_SESSION')
    try { return readBranchHistory(session.sessionManager.getBranch(), query, bindingId) }
    catch { throw new SdkSessionFailure('STALE_SESSION') }
  }

  private refreshActivity(): void {
    if (this.session === null || this.target === null || this.activity === null) return
    const branch = this.session.sessionManager.getBranch()
    if (this.historyTail !== null && !branch.some(entry => entry.id === this.historyTail) && this.bindingId !== null) {
      this.historyRevision++
      this.pendingEntryLookup = null
      const page = readBranchHistory(branch, { kind: 'page', before: null }, this.bindingId)
      if (page.kind !== 'text') this.projection?.replaceProjectedHistory(page, this.historyRevision)
    }
    this.historyTail = branch.at(-1)?.id ?? null
    this.projection?.setActivity(this.activity.refresh(branch, this.target.projectPath))
  }

  /** 确认只影响未确认窗口；不属于当前代际的确认直接忽略。 */
  ackProjection(bindingId: number, seq: number): void {
    if (bindingId !== this.bindingId) return
    this.projection?.ack(bindingId, seq)
  }

  /**
   * 提交只返回接受、排队或已处理：本轮完成由官方事件表达，不把回答结束当作提交成功。
   * 运行中不排队，保持桌面既有语义；图片只按线格式转交官方输入。
   *
   * 接受回执可能晚于扩展钩子与凭据校验，因此等待期限只是兜底：
   * 到期时若会话已在运行，说明 Prompt 已被接受，只按已开始回报，不误报冲突。
   */
  async submit(bindingId: number, message: string, images: readonly { readonly data: string; readonly mimeType: string }[]): Promise<'started' | 'queued' | 'handled'> {
    const session = this.requireBoundSession(bindingId)
    if (this.needsHostRebuild || this.operationId !== null) throw new SdkSessionFailure('SESSION_BUSY')
    if (this.promptInFlight || this.isBusy()) throw new SdkSessionFailure('SESSION_BUSY')
    let disposition: 'started' | 'queued' | 'handled' | null = null
    let rejection: unknown = null
    let reportAccepted: () => void = () => {}
    const accepted = new Promise<void>(resolvePromise => { reportAccepted = resolvePromise })
    this.promptInFlight = true
    try {
      const prompt = session.prompt(message, {
        images: images.map(image => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
        source: 'rpc',
        // 接受结果与拒绝都以官方回调为准；原始错误不外传，只映射到既有分类。
        preflightResult: value => { disposition = value; reportAccepted() }
      })
      // 执行失败与结果未知都不重发，由状态与事件收敛。
      await Promise.race([accepted, prompt.then(() => undefined, (error: unknown) => { rejection = error }),
        new Promise<void>(resolvePromise => setTimeout(resolvePromise, PROMPT_ACCEPT_TIMEOUT_MS))])
      void prompt.catch(() => {})
    } finally {
      this.promptInFlight = false
    }
    if (disposition !== null) {
      this.publish()
      return disposition
    }
    // 官方明确拒绝：不等满窗口、不重发，分类保持在既有集合内。
    if (rejection !== null) throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    // 兜底到期但会话已在运行：回执只是晚到，按已开始回报，避免误报冲突并保留草稿。
    if (this.isBusy()) {
      this.publish()
      return 'started'
    }
    throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
  }

  /** 模型切换以官方实际状态为准；凭据不足由官方拒绝，不在宿主内旁路校验。 */
  async setModel(bindingId: number, provider: string, modelId: string): Promise<void> {
    const session = this.requireBoundSession(bindingId)
    if (this.operationId !== null || this.isBusy()) throw new SdkSessionFailure('SESSION_BUSY')
    if (this.needsHostRebuild) throw new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')
    const model = session.modelRuntime.getModel(provider, modelId)
    if (model === undefined) throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    this.operationId = randomUUID()
    this.publish()
    try {
      await session.setModel(model)
    } catch {
      throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    } finally {
      this.operationId = null
      this.publish()
    }
  }

  /**
   * 回退对话分支：只接受已映射且确为官方用户消息条目的目标；
   * 回退由官方生命周期收敛（中止、失效、重绑与基准重建），失败保持真实状态且不自动重复。
   */
  async rewind(bindingId: number, messageId: string): Promise<{ cancelled: boolean; text: string | null }> {
    const session = this.requireBoundSession(bindingId)
    if (this.operationId !== null || this.needsHostRebuild) throw new SdkSessionFailure('SESSION_BUSY')
    if (this.isBusy()) throw new SdkSessionFailure('SESSION_BUSY')
    const entryId = historyEntryId(messageId) ?? this.projection?.entryIdOf(messageId) ?? null
    const entry = entryId === null ? undefined : session.sessionManager.getBranch().find(candidate => candidate.id === entryId)
    if (entry === undefined || entry.type !== 'message' || entry.message.role !== 'user') {
      throw new SdkSessionFailure('STALE_SESSION')
    }
    this.operationId = randomUUID()
    this.phase = 'preparing'
    let finish: () => void = () => {}
    this.operationDone = new Promise<void>(resolvePromise => { finish = resolvePromise })
    this.publish()
    try {
      // 分叉会替换当前绑定，因此同样要先经注册表授权并取得新的绑定代际。
      const authorized = await this.options.authorize({ kind: 'new' }, this.bindingId, this.target?.projectPath ?? null)
      this.factoryTarget = authorized.target
      this.pendingGeneration = authorized.generation
      const result = await this.runtimeRequired().fork(entry.id, { position: 'before' })
      return { cancelled: result.cancelled, text: result.selectedText ?? null }
    } catch (error) {
      this.lastError = error instanceof SdkSessionFailure ? error.code : 'SESSION_CREATE_FAILED'
      if (!this.valid) this.needsHostRebuild = true
      throw error instanceof SdkSessionFailure ? error : new SdkSessionFailure('SESSION_CREATE_FAILED')
    } finally {
      this.operationId = null
      this.operationDone = null
      this.phase = this.needsHostRebuild ? 'blocked' : this.valid ? 'bound' : 'empty'
      finish()
      this.publish()
    }
  }

  /**
   * 手动压缩上下文：只在会话空闲时发起，避免从文本命令里静默中断正在执行的轮次。
   * 说明文本交给 Pi 作为摘要聚焦条件；摘要与终态由投影中的压缩记录表达，因此这里不返回内容。
   * 官方拒绝（上下文太小、刚压缩过、被取消）按冲突码收敛，页面不重复播报通用文案。
   */
  async compact(bindingId: number, instructions: string | null): Promise<void> {
    const session = this.requireBoundSession(bindingId)
    if (this.operationId !== null || this.needsHostRebuild) throw new SdkSessionFailure('SESSION_BUSY')
    if (this.isBusy()) throw new SdkSessionFailure('SESSION_BUSY')
    try {
      await session.compact(instructions ?? undefined)
    } catch (error) {
      throw error instanceof SdkSessionFailure ? error : new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    }
  }

  /**
   * 当前绑定的可用模型清单：只读该会话的模型目录，失败以 `modelsError` 表达，
   * 不返回伪造的空清单。展示名、上下文窗口与图片输入能力缺失时保持 null。
   */
  capabilities(bindingId: number): AgentCapabilities {
    const session = this.requireBoundSession(bindingId)
    const models: ModelSummary[] = []
    let modelsError: string | null = null
    try {
      for (const model of session.modelRuntime.getAvailableSnapshot()) {
        models.push({
          provider: model.provider,
          id: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : null,
          contextWindow: typeof model.contextWindow === 'number'
            && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : null,
          imageInput: Array.isArray(model.input) ? model.input.includes('image') : null
        })
      }
    } catch {
      modelsError = '无法读取当前会话的模型目录。'
    }
    return { runtimeId: bindingId, models, modelsError }
  }

  /**
   * 当前绑定会话已加载的资源清单：只读内存中的扩展命令、提示词与技能，
   * 不重新扫描磁盘、不建立第二份资源模型；读取失败以 `error` 表达，不返回伪造的空清单。
   */
  readResources(bindingId: number): PiResources {
    const session = this.requireBoundSession(bindingId)
    try {
      const entries = sessionResources(session)
      const truncated = entries.length > RESOURCE_ENTRY_LIMIT
      return { runtimeId: bindingId, entries: truncated ? entries.slice(0, RESOURCE_ENTRY_LIMIT) : entries,
        truncated, error: null }
    } catch {
      return { runtimeId: bindingId, entries: [], truncated: false,
        error: '无法读取当前会话已加载的资源清单。' }
    }
  }

  /**
   * 当前绑定会话的诊断：SDK 创建期诊断（settings 与资源加载告警）与已收集的 Extension 运行时错误。
   * 只读已持有数据，不为查询新建执行上下文；宿主进程自身的输出不进入本通道。
   */
  readDiagnostics(bindingId: number): RuntimeDiagnostics {
    this.requireBoundSession(bindingId)
    const lines: string[] = []
    for (const entry of this.runtime?.diagnostics ?? []) {
      const message = optionalText(entry.message)
      if (message === null) continue
      lines.push(`${DIAGNOSTIC_PREFIXES[entry.type]}：${message}`)
    }
    return { runtimeId: bindingId, stderrLines: lines.slice(-DIAGNOSTIC_VIEW_LINES),
      extensionErrors: this.extensionErrors.map(entry => ({ ...entry })) }
  }

  /** MCP 状态读取：固定命令 `/mcp` 的 notify 文本就是状态清单。 */
  async readMcpStatus(bindingId: number): Promise<McpStatus> {
    return this.runMcpPrompt(bindingId, MCP_STATUS_PROMPT)
  }

  /** MCP 登录/退出/重连：命令文本固定；浏览器授权与回调地址输入仍走既有 Extension UI 通道。 */
  async runMcpCommand(bindingId: number, action: SdkMcpCommandAction, serverName: string): Promise<McpStatus> {
    return this.runMcpPrompt(bindingId, mcpCommandPrompt(action, serverName))
  }

  /**
   * MCP 调用与页面提交共用同一条路径：官方 mcp 扩展在非 TUI 模式下用 notify 输出结果，
   * 而扩展命令是在 preflight 之前完成的，因此捕获窗口结束时文本已齐。
   * 期限由主进程的请求等待负责，这里不设第二套超时；超时后命令仍在运行、结果未知且不重发。
   */
  private async runMcpPrompt(bindingId: number, message: string): Promise<McpStatus> {
    const session = this.requireBoundSession(bindingId)
    if (this.needsHostRebuild) throw new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')
    if (this.operationId !== null || this.promptInFlight || this.isBusy()) {
      throw new SdkSessionFailure('SESSION_BUSY')
    }
    const bridge = this.bridge
    if (bridge === null) throw new SdkSessionFailure('SESSION_BIND_FAILED')
    let disposition: PromptDisposition | null = null
    let messages: readonly string[] = []
    const endCapture = bridge.beginNotifyCapture()
    this.promptInFlight = true
    try {
      await session.prompt(message, { source: 'rpc', preflightResult: value => { disposition = value } })
    } catch {
      throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    } finally {
      this.promptInFlight = false
      messages = endCapture()
    }
    if (disposition === null) throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    return { disposition, messages }
  }

  /** 解析不到条目时保持未映射，不用摘要或位置猜测回退目标。 */
  private resolvePendingEntry(bindingId: number): void {
    const pending = this.pendingEntryLookup
    this.pendingEntryLookup = null
    const session = this.session
    if (pending === null || session === null || bindingId !== this.bindingId || this.projection === null) return
    const branch = session.sessionManager.getBranch()
    const index = branch.findLastIndex(candidate => candidate.type === 'message' && candidate.message === pending.message)
    const entry = branch[index]
    if (entry === undefined) return
    const turn = branch.slice(0, index + 1).findLast(candidate => candidate.type === 'message' && candidate.message.role === 'user')
    if (this.projection.assignEntryId(pending.messageId, entry.id, turn?.id ?? branch[0]?.id)) {
      this.options.onEntryMap(bindingId, pending.messageId, entry.id)
    }
  }

  /** 只有仍有效且绑定一致的会话可以接受提交或模型切换。 */
  private requireBoundSession(bindingId: number): AgentSession {
    if (bindingId !== this.bindingId || this.session === null || !this.valid) {
      throw new SdkSessionFailure('STALE_SESSION')
    }
    return this.session
  }

  /** 旧交互只作用于原绑定，无效回应不会消耗另一个 Promise。 */
  respond(bindingId: number, dialogId: string, response: ExtensionDialogResponseInput): boolean {
    return this.bridge?.respond(bindingId, dialogId, response) ?? false
  }

  /** 进程关闭先同步停止新交互，再等待已提交生命周期任务收敛，不自动重做会话操作。 */
  async shutdown(): Promise<void> {
    this.closing = true
    this.bridge?.cancelPending(true)
    try {
      await bounded((async () => {
        if (this.operationDone !== null) await this.operationDone
        await this.settleCurrent()
        await this.closeCurrent()
      })())
    } catch {
      this.needsHostRebuild = true
      this.phase = 'blocked'
      this.lastError = 'SESSION_CLOSE_FAILED'
      this.publish()
      throw new SdkSessionFailure('SESSION_CLOSE_FAILED')
    }
  }

  /** SDK 的空闲状态之外，还检查队列、独立 Bash 和由宿主持有的交互。 */
  private isBusy(): boolean {
    return this.session !== null && (!this.session.isIdle || this.session.pendingMessageCount > 0
      || this.session.isBashRunning || (this.bridge?.waitingCount ?? 0) > 0)
  }

  /** 同步读取执行变化；低层 agent_end 不能直接把会话标成空闲。 */
  private publish(): void {
    const busy = this.isBusy()
    const queueCount = this.session?.pendingMessageCount ?? 0
    if ((busy && !this.lastBusy) || queueCount !== this.lastQueueCount) this.activityVersion += 1
    this.lastBusy = busy
    this.lastQueueCount = queueCount
    this.options.onState(this.getStatus())
  }

  /** 预检不使用持久化 SDK manager，避免把检查变成迁移或初始化文件。 */
  private async precheck(target: SdkSessionTarget): Promise<void> {
    if (!isAbsolute(target.projectPath) || !isAbsolute(target.sessionDir)
      || !samePath(target.sessionDir, resolve(this.options.agentDir, 'sessions',
        `--${target.projectPath.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`))) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    const cwd = await realpath(target.projectPath)
    if (!samePath(cwd, target.projectPath) || !(await stat(cwd)).isDirectory()) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    if (target.sessionFile === null) return
    const filePath = await realpath(target.sessionFile)
    const directory = await realpath(target.sessionDir)
    if (!samePath(filePath, target.sessionFile) || !samePath(dirname(filePath), directory)) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    const before = await stat(filePath, { bigint: true })
    const stamp = (info: typeof before): string => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    if (!before.isFile() || stamp(before) !== target.fileStamp) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    const entries = this.sdk.parseSessionEntries(await readFile(filePath, 'utf8'))
    const header = entries.find(entry => entry.type === 'session')
    if (header?.type !== 'session' || header.id !== target.sessionId
      || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || !samePath(await realpath(header.cwd), target.projectPath)
      || (header.version !== undefined && header.version > this.sdk.CURRENT_SESSION_VERSION)) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    const preview = this.sdk.SessionManager.inMemory(target.projectPath, undefined, entries)
    preview.buildSessionContext()
    if (stamp(await stat(filePath, { bigint: true })) !== target.fileStamp) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
  }

  /** services 每次重建；项目 provider 不注册进全局查询容器。 */
  private readonly createRuntime: RuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const target = this.factoryTarget
    if (target === null || !samePath(cwd, target.projectPath) || !samePath(agentDir, this.options.agentDir)) {
      throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    }
    const creation = ++this.creationSeed
    // 只守住有效绑定与必要交互，不引入新的权限规则；工具调用仍由 SDK 管线处理。
    const bindingGuard: ExtensionFactory = pi => {
      pi.on('tool_call', () => {
        if (!this.valid || this.currentCreation !== creation || this.needsHostRebuild
          || this.operationId !== null || this.closing) {
          return { block: true, reason: '桌面会话绑定或必要交互不可用，未执行工具。' }
        }
        return undefined
      })
    }
    try {
      const settingsManager = this.sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: target.trusted })
      const services = await this.sdk.createAgentSessionServices({ cwd, agentDir, settingsManager,
        resourceLoaderOptions: { extensionFactories: [
          { name: 'codemode', factory: this.sdk.createCodemodeExtension(), builtin: true, replaceable: true },
          { name: 'tool-search', factory: this.sdk.createToolSearchExtension(), builtin: true, replaceable: true },
          { name: 'mcp', factory: this.sdk.createMcpExtension(), builtin: true, replaceable: true },
          // 生成式 UI 是产品内置能力，与上述内置扩展同形态注册；工厂自身不抛异常。
          // 用户关掉开关时直接不注册，而不是注册后再报错：这样模型完全看不到这几个工具。
          ...(target.genui
            ? [{ name: GENUI_EXTENSION_NAME, factory: createGenuiExtension(), builtin: true, replaceable: true }]
            : []),
          bindingGuard
        ] } })
      if (this.closing) throw new SdkSessionFailure('HOST_NOT_READY')
      // 无法证明失败扩展不是审批机制，保守阻止绑定，不静默丢掉策略后开放执行。
      if (services.resourceLoader.getExtensions().errors.length > 0) throw new SdkSessionFailure('SESSION_BIND_FAILED')
      const scope = await this.sdk.resolveModelScopeWithDiagnostics(settingsManager.getEnabledModels() ?? [], services.modelRuntime)
      const result = await this.sdk.createAgentSessionFromServices({ services, sessionManager,
        scopedModels: scope.scopedModels, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }) })
      if (this.closing) {
        result.session.dispose()
        throw new SdkSessionFailure('HOST_NOT_READY')
      }
      this.creations.set(result.session, creation)
      return { ...result, services, diagnostics: services.diagnostics }
    } catch (error) {
      this.needsHostRebuild = true
      throw error instanceof SdkSessionFailure ? error : new SdkSessionFailure('SESSION_CREATE_FAILED')
    }
  }

  /** 初次建立与释放后的建立使用官方 factory；不会为预检创建第二个 Agent。 */
  private async createInitial(manager: AgentSession['sessionManager'], reason: 'startup' | 'reload' = 'startup'): Promise<void> {
    const target = this.factoryTarget
    if (target === null) throw new SdkSessionFailure('INVALID_SESSION_TARGET')
    this.runtime = await this.sdk.createAgentSessionRuntime(this.createRuntime, {
      cwd: target.projectPath, agentDir: this.options.agentDir, sessionManager: manager,
      ...(reason === 'reload' ? { sessionStartEvent: { type: 'session_start' as const, reason: 'reload' as const } } : {})
    })
    this.runtime.setBeforeSessionInvalidate(() => this.invalidateCurrent())
    this.runtime.setRebindSession(session => this.bind(session))
    await this.bind(this.runtime.session)
  }

  /** 订阅先于 bindExtensions，启动钩子触发的事件和弹窗不能丢失。 */
  private async bind(session: AgentSession): Promise<void> {
    this.valid = false
    this.session = session
    this.target = this.factoryTarget
    this.currentCreation = this.creations.get(session) ?? null
    this.phase = 'preparing'
    this.lastError = null
    this.extensionErrors = []
    // 绑定代际只能来自主进程注册表；缺失时不自行编号，按绑定失败收敛。
    const generation = this.pendingGeneration
    this.pendingGeneration = null
    if (generation === null) {
      this.needsHostRebuild = true
      this.phase = 'blocked'
      this.lastError = 'SESSION_BIND_FAILED'
      this.publish()
      throw new SdkSessionFailure('SESSION_BIND_FAILED')
    }
    this.bindingId = generation
    this.activityVersion += 1
    const bindingId = this.bindingId
    try {
      if (this.closing || this.currentCreation === null) throw new SdkSessionFailure('STALE_SESSION')
      this.sdk.initTheme(session.settingsManager.getTheme(), false)
      const projection = new MessageProjection(bindingId, {
        onBatch: batch => this.options.onProjectionBatch(bindingId, batch),
        // SDK 会话状态是执行态的权威来源，不再由展示事件反推 isStreaming；消息条数仍取投影。
        onStatusHint: hint => {
          if (hint.messageCount === undefined) return
          this.projectedMessageCount = hint.messageCount
        },
        onMessageEnded: messageId => {
          const message = this.lastEndedMessage
          if (message !== null) this.pendingEntryLookup = { messageId, message }
          this.lastEndedMessage = null
          queueMicrotask(() => this.resolvePendingEntry(bindingId))
        }
      })
      // 展示历史与模型上下文分开；官方当前分支是历史唯一来源，不自行重建会话树。
      const branch = session.sessionManager.getBranch()
      const page = readBranchHistory(branch, { kind: 'page', before: null }, bindingId)
      if (page.kind === 'text') throw new SdkSessionFailure('SESSION_BIND_FAILED')
      projection.seedProjectedHistory(page)
      this.projection = projection
      this.activity = new ActivityProjection()
      this.historyTail = null
      this.historyRevision = 0
      this.refreshActivity()
      // 速率结算随绑定建立：订阅方只在仍是当前绑定时改写快照。
      const rate = new OutputRateTracker(snapshot => {
        if (this.rate !== rate) return
        this.rateSnapshot = snapshot
        this.publish()
      })
      this.rate = rate
      this.rateSnapshot = { average: null }
      this.usage = null
      this.bridge = new ExtensionUiBridge(session.extensionRunner.getUIContext(), {
        bindingId, onRequest: this.options.onUiRequest, onCancel: this.options.onUiCancel,
        onWaitingChanged: () => this.publish(), onUnavailable: () => this.blockUnavailableInteraction()
      })
      this.unsubscribe = session.subscribe(event => this.onSdkEvent(session, bindingId, event))
    } catch {
      this.needsHostRebuild = true
      this.lastError = 'SESSION_BIND_FAILED'
      this.phase = 'blocked'
      this.publish()
      throw new SdkSessionFailure('SESSION_BIND_FAILED')
    }
    this.publish()
    const actions: ExtensionCommandContextActions = {
      waitForIdle: () => session.waitForIdle(),
      newSession: options => this.extensionAction(async () => this.runtimeRequired().newSession(options)),
      switchSession: (path, options) => this.extensionAction(async () => {
        const authorized = await this.options.authorize({ kind: 'file', sessionFile: path }, this.bindingId, this.target?.projectPath ?? null)
        await this.precheck(authorized.target)
        this.factoryTarget = authorized.target
        this.pendingGeneration = authorized.generation
        return this.runtimeRequired().switchSession(authorized.target.sessionFile ?? path, { ...options, cwdOverride: authorized.target.projectPath })
      }),
      fork: (entryId, options) => this.extensionAction(async () => this.runtimeRequired().fork(entryId, options)),
      navigateTree: (entryId, options) => this.extensionAction(async () => {
        if (session !== this.session || session.sessionManager.getEntry(entryId) === undefined) throw new SdkSessionFailure('STALE_SESSION')
        return session.navigateTree(entryId, options)
      }),
      reload: async () => {
        const result = await this.extensionAction(async () => {
          const authorized = await this.options.authorize({ kind: 'new' }, this.bindingId, this.target?.projectPath ?? null)
          this.pendingGeneration = authorized.generation
          await this.reload(authorized.target)
          return { cancelled: false }
        })
        if (result.cancelled) throw new SdkSessionFailure('SESSION_BUSY')
      }
    }
    try {
      if (this.bridge === null) throw new SdkSessionFailure('SESSION_BIND_FAILED')
      await session.bindExtensions({ uiContext: this.bridge.ui, mode: 'rpc', commandContextActions: actions,
        abortHandler: () => { void this.abort(bindingId).catch(() => {}) },
        shutdownHandler: () => this.requestExtensionRelease(bindingId),
        onError: error => {
          // tool_call 失败意味着必要交互无法表达；其他扩展错误不静默当作已获批准。
          if (error.event === 'tool_call' || !this.valid) this.blockUnavailableInteraction()
          else { this.lastError = 'SESSION_BIND_FAILED'; this.publish() }
          // 只留来源、事件与截断后的消息；堆栈可能带路径与凭据，不进入页面。
          const message = optionalText(error.error)
          if (message === null) return
          this.extensionErrors.push({ path: optionalText(error.extensionPath), event: optionalText(error.event),
            error: message.slice(0, EXTENSION_ERROR_MESSAGE_LIMIT) })
          if (this.extensionErrors.length > EXTENSION_ERROR_LIMIT) this.extensionErrors.shift()
        } })
      if (this.closing || this.session !== session || this.needsHostRebuild) throw new SdkSessionFailure('STALE_SESSION')
      this.valid = true
      this.phase = 'bound'
      this.publish()
      // 绑定完成即补读一次会话统计：恢复历史时页面同样需要已有用量，不能等下一次输出。
      this.scheduleUsageRefresh()
    } catch {
      this.valid = false
      this.needsHostRebuild = true
      this.phase = 'blocked'
      this.lastError = 'SESSION_BIND_FAILED'
      this.bridge?.invalidate()
      this.publish()
      throw new SdkSessionFailure('SESSION_BIND_FAILED')
    }
  }

  /** 扩展动作沿用同一互斥所有者；拒绝生命周期钩子递归替换，不把任务排在自己后面。 */
  private async extensionAction<T extends { cancelled: boolean }>(action: () => Promise<T>): Promise<T | { cancelled: true }> {
    if (this.operationId !== null) throw new SdkSessionFailure('SESSION_OPERATION_CONFLICT')
    if (!this.valid || this.closing || this.needsHostRebuild) throw new SdkSessionFailure('STALE_SESSION')
    const bindingId = this.bindingId
    const activityVersion = this.activityVersion
    if (this.isBusy()) {
      const accepted = await this.bridge?.ui.confirm('停止当前操作？', '此扩展操作会改变当前会话；不会撤销项目文件。')
      if (!accepted) return { cancelled: true }
      if (bindingId !== this.bindingId || activityVersion !== this.activityVersion
        || this.operationId !== null) throw new SdkSessionFailure('STALE_SESSION')
    }
    this.operationId = randomUUID()
    this.phase = 'preparing'
    let finish: () => void = () => {}
    this.operationDone = new Promise<void>(resolvePromise => { finish = resolvePromise })
    this.publish()
    try {
      const authorized = await this.options.authorize({ kind: 'new' }, this.bindingId, this.target?.projectPath ?? null)
      if (bindingId !== this.bindingId || this.closing || this.needsHostRebuild
        || (this.isBusy() && activityVersion !== this.activityVersion)) throw new SdkSessionFailure('STALE_SESSION')
      this.factoryTarget = authorized.target
      this.pendingGeneration = authorized.generation
      await this.settleCurrent()
      return await action()
    } catch (error) {
      this.lastError = error instanceof SdkSessionFailure ? error.code : 'SESSION_CREATE_FAILED'
      if (!this.valid) this.needsHostRebuild = true
      throw error instanceof SdkSessionFailure ? error : new SdkSessionFailure('SESSION_CREATE_FAILED')
    } finally {
      this.operationId = null
      this.operationDone = null
      this.phase = this.needsHostRebuild ? 'blocked' : this.valid ? 'bound' : 'empty'
      finish()
      this.refreshActivity()
      this.publish()
    }
  }

  /** 扩展请求的 shutdown 释放原绑定，不把宿主永久设为退出态；不等待自身所在钩子。 */
  private requestExtensionRelease(bindingId: number): void {
    this.bridge?.cancelPending(true)
    const pending = this.operationDone
    void (async () => {
      if (pending !== null) await bounded(pending)
      if (bindingId !== this.bindingId || this.closing || !this.valid) return
      await this.execute({ version: SDK_HOST_PROTOCOL_VERSION, hostId: this.options.hostId, requestId: randomUUID(),
        type: 'session', action: 'release', expectedBindingId: bindingId,
        interrupt: { bindingId, activityVersion: this.activityVersion }, target: null })
    })().catch(() => {
      if (bindingId !== this.bindingId) return
      this.needsHostRebuild = true
      this.phase = 'blocked'
      this.lastError = 'SESSION_CLOSE_FAILED'
      this.publish()
    })
  }

  /** 回退等动作只能使用真实有效的 runtime，不能拿旧销毁指针充当活动对象。 */
  private runtimeRequired(): AgentSessionRuntime {
    if (this.runtime === null || !this.valid) throw new SdkSessionFailure('STALE_SESSION')
    return this.runtime
  }

  /** 只维护真实执行状态，不从低层事件拼造 Agent 队列或自动恢复语义。 */
  private onSdkEvent(session: AgentSession, bindingId: number, event: AgentSessionEvent): void {
    if (this.session !== session || this.bindingId !== bindingId) return
    // 结束事件在投影消费前记录对象身份，供条目落盘后按同一性定位。
    this.lastEndedMessage = event.type === 'message_end' ? event.message : null
    const projected = toProjectionEvent(event)
    // 形状不合约定的增量不进入展示；基准仍可由快照重建，不用它反推消息内容。
    if (projected !== null) {
      this.activity?.observe(projected)
      this.projection?.applySessionEvent(projected)
    }
    this.lastEndedMessage = null
    if (event.type === 'agent_start' || event.type === 'compaction_start'
      || event.type === 'summarization_retry_attempt_start') this.activityVersion += 1
    // 速率只依据官方事件：平均值取助手消息自身的 usage，统计不从展示增量反推。
    if (event.type === 'message_start') {
      if (isAssistantMessage(event.message)) this.rate?.begin(Date.now())
    } else if (event.type === 'message_update') {
      this.scheduleUsageRefresh()
    } else if (event.type === 'message_end') {
      if (isAssistantMessage(event.message)) this.rate?.settle(readAssistantOutput(event.message), Date.now())
      this.scheduleUsageRefresh()
    }
    if (event.type !== 'message_update' && event.type !== 'tool_execution_update') {
      this.publish()
      // 官方会在订阅回调返回后完成条目追加；不读取尚未落入分支的临时结果。
      queueMicrotask(() => {
        if (this.session !== session || this.bindingId !== bindingId) return
        if (event.type === 'compaction_end' && event.result) {
          const branch = session.sessionManager.getBranch()
          const entry = branch.findLast(candidate => candidate.type === 'compaction')
          const turn = branch.findLast(candidate => candidate.type === 'message' && candidate.message.role === 'user')
          if (entry) this.projection?.assignCompactionEntry(entry.id, turn?.id ?? branch[0]?.id)
        }
        this.refreshActivity()
      })
    }
  }

  /**
   * 会话累计用量按最小间隔补读一次：官方统计可能遍历条目，读一次缓存一次；
   * 读取失败保留上一次已确认的统计，不用空值或全零覆盖展示。
   */
  private scheduleUsageRefresh(): void {
    if (this.session === null || this.usageTimer !== null) return
    const wait = Math.max(0, USAGE_REFRESH_MS - (Date.now() - this.usageReadAt))
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null
      this.usageReadAt = Date.now()
      const session = this.session
      if (session === null || !this.valid) return
      try {
        this.usage = toSessionUsage(session.getSessionStats())
      } catch {
        return
      }
      this.publish()
    }, wait)
  }

  /** 统计补读定时器只属于当前绑定；换代或关闭时必须停掉。 */
  private clearUsageTimer(): void {
    if (this.usageTimer !== null) clearTimeout(this.usageTimer)
    this.usageTimer = null
  }

  /** 审批或必要交互不可用时先限制执行，再由 SDK 中止；不伪造工具成功或重放请求。 */
  private blockUnavailableInteraction(): void {
    this.needsHostRebuild = true
    this.phase = 'blocked'
    this.lastError = 'SESSION_BIND_FAILED'
    this.bridge?.cancelPending(true)
    if (this.session !== null) void this.session.abort().catch(() => {})
    this.publish()
  }

  /** 官方失效钩子同步解绑，不让旧 SDK 事件或 UI 引用覆盖下一绑定。 */
  private invalidateCurrent(): void {
    this.valid = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.bridge?.invalidate()
    this.bridge = null
    // 投影随绑定代际失效：旧批次不得升到新会话；展示统计同样不能跨代际残留。
    this.projection?.dispose()
    this.projection = null
    this.activity = null
    this.historyTail = null
    this.rate?.reset()
    this.rate = null
    this.rateSnapshot = { average: null }
    this.clearUsageTimer()
    this.usage = null
    this.projectedMessageCount = 0
    this.session = null
    this.currentCreation = null
    this.phase = 'invalid'
    this.publish()
  }

  /** 取消实际交互与 SDK 工作，队列明确清理；等待独立 Bash 真正结束。 */
  private async settleCurrent(): Promise<void> {
    const session = this.session
    if (session === null) return
    this.bridge?.cancelPending()
    session.clearQueue()
    session.abortBash()
    let polling = true
    try {
      await bounded((async () => {
        await session.abort()
        while (polling && (!session.isIdle || session.isBashRunning || session.pendingMessageCount > 0)) {
          await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 25))
        }
      })())
    } catch {
      this.needsHostRebuild = true
      this.phase = 'blocked'
      throw new SdkSessionFailure('SESSION_RECOVERY_REQUIRED')
    } finally { polling = false }
  }

  /** 资源重载重建 services；有会话消息却丢失文件时拒绝把它伪装成空会话。 */
  private async reload(fresh: SdkSessionTarget): Promise<void> {
    const session = this.session
    if (session === null || !this.valid) throw new SdkSessionFailure('STALE_SESSION')
    let manager = session.sessionManager
    if (session.sessionFile !== undefined && existsSync(session.sessionFile)) {
      const authorized = await this.options.authorize({ kind: 'file', sessionFile: session.sessionFile }, this.bindingId, fresh.projectPath)
      fresh = authorized.target
      this.pendingGeneration = authorized.generation
      await this.precheck(fresh)
      manager = this.sdk.SessionManager.open(fresh.sessionFile ?? session.sessionFile, fresh.sessionDir, fresh.projectPath)
    } else if (session.messages.some(message => message.role === 'user' || message.role === 'assistant')) {
      throw new SdkSessionFailure('SESSION_NOT_FOUND')
    }
    this.bridge?.cancelPending()
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' })
    this.invalidateCurrent()
    session.dispose()
    this.runtime = null
    this.factoryTarget = fresh
    await this.createInitial(manager, 'reload')
  }

  /** 释放会话不关闭宿主；无有效旧会话时不再次调用销毁对象的 shutdown 钩子。 */
  private async closeCurrent(): Promise<void> {
    if (this.runtime !== null && this.session !== null) {
      this.bridge?.cancelPending(true)
      try { await this.runtime.dispose() } catch {
        this.needsHostRebuild = true
        throw new SdkSessionFailure('SESSION_CLOSE_FAILED')
      }
    }
    this.invalidateCurrent()
    this.runtime = null
    this.target = null
    this.bindingId = null
    this.phase = this.operationId === null ? 'empty' : 'preparing'
    this.publish()
  }
}
