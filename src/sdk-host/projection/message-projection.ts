/**
 * 维护当前会话代际的临时消息与工具投影，并按有界批次推送给渲染端。
 * 用户消息的来源身份由投影自己维护：展示用摘要身份，回退目标用官方会话条目 ID。
 *
 * 把 Pi 的会话事件（以及恢复会话时的历史消息）重建为页面要展示的消息内容块与工具执行条目，
 * 用户消息中的图片块以附件描述块（data URL 与估算字节）投影，超限附件降级为投影自己生成的说明块
 * （块上标 `notice`，界面可见但不计入用户输入），AI 消息记录客户端接收事件的生成计时与本次调用的
 * token 用量（缺失、形状不符或全零按未知，不推算）；
 * 上下文压缩按 `compaction_end` 与恢复会话时的历史 `compactionSummary` 记为第三种消息角色（`compaction`），
 * 只带摘要与压缩前后 token 数，不进入用户输入与回退目标；
 * 本轮响应计时挂在触发本轮的用户消息上：以该消息自带的时间戳起表（提交时刻），到 Agent 收敛
 * （`agent_settled`）收口，因此包含工具执行与等待；恢复的历史轮次没有结束时刻，一律留空不推算；
 * 不保存原始事件、不持久化、不管理 Session、不解析 response 信封与退出；工具条目的生命周期交给
 * tool-projection，本模块负责聚合、批次、序号与确认。渲染端长度校验失败、序号缺口或未确认窗口
 * 超限都收敛到快照重同步，投影不猜测渲染端缺少的内容。
 *
 * 展示上限只收缩 AI 侧内容：用户输入是用户自己写下的内容，不参与条数与总量收缩；超限时先丢弃旧
 * AI 消息的 Thinking 与工具参数文本，再把旧 AI 正文压成开头片段，最后才丢整条 AI 消息。
 * 单块超长仍按单块上限截断，与角色无关。任何收缩都在投影上标记（截断标记或丢弃计数），
 * 并让渲染端整表重同步，不伪装成完整内容。
 */
import type {
  MessageUsage,
  HistoryPage,
  SessionActivity,
  ProjectionBatch,
  ProjectionBlock,
  ProjectionBlockKind,
  ProjectionCompaction,
  ProjectionMessage,
  ProjectionSnapshot,
  ProjectionUpdate,
  ToolExecution,
  TurnTiming
} from '../../shared/runtime-api'
import { ToolProjection, serializeToolArguments } from './tool-projection'
import { parseImageAnnotationAttachments, readImageAnnotationMessage } from '../../shared/image-annotation'
import type { ImageAnnotationAttachment } from '../../shared/image-annotation'
import { toUserMessageIdentity } from './identity'
import type { UserMessageIdentity } from './identity'

/** 批次刷新节拍；消息开始与终态事件立即刷新，不受此限制。 */
const FLUSH_INTERVAL_MS = 100

/** 单批更新条数上限，达到即立即刷新。 */
const MAX_UPDATES_PER_BATCH = 64

/** 已发未确认批次窗口；超过后作废增量并要求渲染端重同步。 */
const MAX_UNACKED_BATCHES = 32

/** 单个内容块文本上限；超出按截断处理并在投影与界面标示。 */
const MAX_BLOCK_CHARS = 262_144

/** 投影保留图片附件的本体大小上限（估算字节）；超出只保留描述。 */
const MAX_IMAGE_ATTACHMENT_BYTES = 8_388_608

/**
 * 非用户消息（AI 消息与压缩记录）的条数上限；超出按从旧到新的顺序丢弃并计数。
 * 它是 DOM 体量的兜底，不是体积的主要约束：文本总量由 MAX_TOTAL_CHARS 控制，
 * 而过程细节与旧正文会先被收缩，因此每条旧消息的实际占用已经很小。
 */
const MAX_NON_USER_MESSAGES = 400

/**
 * 投影文本总量上限；超出按「过程细节 → AI 正文 → 整条 AI 消息」的顺序从旧到新收缩。
 * 用户消息不参与收缩：界面必须始终能看到全部用户输入。
 */
const MAX_TOTAL_CHARS = 4_194_304

/** 收缩后的旧 AI 正文保留字符数；只留开头并标截断，旧轮次仍可辨认。 */
const COMPACTED_TEXT_CHARS = 2_048

type ProjectedRole = 'user' | 'assistant' | 'compaction'

interface MutableBlock {
  readonly contentIndex: number
  kind: ProjectionBlockKind
  text: string
  truncated: boolean
  toolCallId: string | null
  toolName: string | null
  /** 图片附件描述；非图片块为 null。 */
  image: { readonly dataUrl: string; readonly mimeType: string; readonly bytes: number } | null
  /** 文本由投影自己生成（超限附件说明）时为 true；不是用户或模型的正文。 */
  notice: boolean
}

interface MutableMessage {
  imageAnnotations?: readonly ImageAnnotationAttachment[]
  /** 来源身份只在主进程核对，不跨 IPC 暴露摘要。 */
  sourceIdentity: UserMessageIdentity | null
  /** 官方会话条目 ID；解析不到时为空，不用摘要或位置猜测。 */
  entryId?: string | null
  readonly id: string
  readonly role: ProjectedRole
  blocks: MutableBlock[]
  timestamp: number | null
  generation: ProjectionMessage['generation']
  /** 本次模型调用的用量；仅 AI 消息可能非 null。 */
  usage: MessageUsage | null
  /** 本轮响应计时；仅当前实时轮次的用户消息有值。 */
  turn: TurnTiming | null
  stopReason: string | null
  errorMessage: string | null
  /** 压缩记录；仅 `role === 'compaction'` 时非 null，此时块列表为空。 */
  compaction: ProjectionCompaction | null
  recoverable?: boolean
  turnEntryId?: string
}

/** 投影上报给 Manager 的运行状态提示；只覆盖由事件可确定的字段。 */
export interface ProjectionStatusHint {
  readonly isStreaming?: boolean
  readonly messageCount?: number
}

export interface ProjectionCallbacks {
  readonly onBatch: (batch: ProjectionBatch) => void
  readonly onStatusHint: (hint: ProjectionStatusHint) => void
  /** 交出刚结束的展示消息；条目 ID 由调用方在官方持久化边界之后回填。 */
  readonly onMessageEnded?: (messageId: string, role: ProjectedRole) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只有这两类角色的消息进入内容块投影；`toolResult` 消息只在恢复会话时用于补种工具条目，其他角色忽略。 */
function readRole(value: unknown): ProjectedRole | null {
  return value === 'user' || value === 'assistant' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** token 计数只接受有限数字；缺失或异常值保持 null，不当作 0 展示。 */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 单次模型调用的用量；缺失、形状不符或全零（失败调用）时整条按未知处理，
 * 不用 0 冒充一次真实调用。
 */
function readMessageUsage(value: unknown): MessageUsage | null {
  if (!isRecord(value)) return null
  const input = readCount(value.input)
  const output = readCount(value.output)
  const cacheRead = readCount(value.cacheRead)
  const cacheWrite = readCount(value.cacheWrite)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  return { input, output, cacheRead, cacheWrite }
}

export class MessageProjection {
  private readonly messages: MutableMessage[] = []
  private pending: ProjectionUpdate[] = []
  /** 已发出但未确认的批序号；只用于限制未确认窗口。 */
  private outstanding: number[] = []
  private seq = 0
  private messageSeed = 0
  /** 当前打开的消息；wire 消息没有 id，只能按开始/结束事件配对。 */
  private active: MutableMessage | null = null
  /** 当前正在计时的本轮所属用户消息；一轮收口或消息被丢弃后清空。 */
  private activeTurn: MutableMessage | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private droppedMessages = 0
  private truncated = false
  private needsResync = false
  private disposed = false
  private rebuilding = false
  private readonly toolProjection: ToolProjection
  private activity: SessionActivity | undefined
  private activitySignature = ''
  private historyBefore: string | null = null
  private historyRevision = 0

  constructor(
    private readonly runtimeId: number,
    private readonly callbacks: ProjectionCallbacks
  ) {
    // 工具条目与消息块解耦，但复用同一批次、序号与确认信封。
    this.toolProjection = new ToolProjection(MAX_BLOCK_CHARS, {
      onUpdate: (tool: ToolExecution) => {
        this.queueUpdate({ kind: 'tool', tool })
      }
    })
  }

  /** 应用一条已分类为会话事件的 Pi 记录；未知事件名与不展示的事件一律忽略。 */
  applySessionEvent(payload: Record<string, unknown>): void {
    if (this.disposed) return
    switch (payload.type) {
      case 'agent_start':
        this.callbacks.onStatusHint({ isStreaming: true })
        return
      case 'agent_end':
        this.callbacks.onStatusHint({ isStreaming: false })
        this.interruptActiveGeneration()
        this.flush()
        return
      case 'agent_settled':
        // 会话级忙碌状态以此收敛；缺少结束事件的消息停止计时，工具条目标为未确认。
        this.callbacks.onStatusHint({ isStreaming: false })
        this.interruptActiveGeneration()
        this.toolProjection.settleRunning()
        // 一轮到这里才真正结束：这时才收口本轮响应计时，包含全部工具执行。
        this.finishTurn()
        this.flush()
        return
      case 'message_start':
        this.startMessage(payload.message)
        this.flush()
        return
      case 'message_update':
        this.updateMessage(payload)
        this.scheduleFlush()
        return
      case 'message_end':
        this.endMessage(payload.message)
        this.flush()
        return
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end': {
        const toolEvent = this.toolProjection.apply(payload)
        // 工具开始与结束是低频终态事件，立即刷新；partial 更新只走批次节拍。
        if (toolEvent === 'start' || toolEvent === 'end') {
          this.flush()
        } else {
          this.scheduleFlush()
        }
        return
      }
      case 'compaction_end':
        // 压缩只在结束时进入时间线；进行中由页面的提示行表达，不建临时消息。
        this.appendCompaction(payload)
        this.flush()
        return
      default:
        // 队列、重试与 Extension UI 事件不进入展示投影。
        return
    }
  }

  /**
   * 追加一条压缩记录：成功、取消与失败都各自成条，不用空摘要冒充成功。
   * 摘要与 token 数只取事件已给的字段，缺失保持 null；时间用接收时刻，不推测 Pi 侧时刻。
   */
  private appendCompaction(payload: Record<string, unknown>): void {
    const reason = payload.reason === 'manual' || payload.reason === 'threshold' || payload.reason === 'overflow'
      ? payload.reason
      : null
    const result = isRecord(payload.result) ? payload.result : null
    const aborted = payload.aborted === true
    const errorMessage = readString(payload.errorMessage)
    // 既没有结果也不是取消/失败的终态事件没有可展示内容，不建空卡片。
    if (result === null && !aborted && errorMessage === null) return
    const message = this.createMessage('compaction', { timestamp: Date.now() })
    message.compaction = {
      reason,
      summary: result === null ? '' : readString(result.summary) ?? '',
      tokensBefore: result === null ? null : readCount(result.tokensBefore),
      tokensAfter: result === null ? null : readCount(result.estimatedTokensAfter),
      aborted,
      errorMessage
    }
    this.messages.push(message)
    this.enforceLimits()
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(message) })
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
  }

  /**
   * 以权威会话消息重建投影基准：每条消息按权威整条替换语义收录，
   * 并按 `toolResult` 消息补种工具条目，用于恢复会话后的第一次同步。
   * `entryIds` 与消息一一对应，给出官方会话条目 ID；缺省或对应项为空时保持未映射，
   * 不用摘要或位置猜测。载荷缺少消息数组时返回 false（响应契约不符）。
   */
  seedHistory(payload: unknown, entryIds: readonly (string | null)[] = []): boolean {
    if (this.disposed) return false
    const messages = isRecord(payload) ? payload.messages : null
    if (!Array.isArray(messages)) return false

    // 历史消息与流式事件之间没有配对关系，每条各自成条，进行中的轮次一并作废。
    this.active = null
    this.activeTurn = null
    for (let index = 0; index < messages.length; index += 1) {
      this.applyAuthoritativeMessage(messages[index], null, entryIds[index] ?? null)
    }
    this.seedHistoryTools(messages)
    this.enforceLimits()
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
    this.flush()
    return true
  }

  /** 历史页来自原始分支；只接纳有界展示副本，不改变模型上下文。 */
  seedProjectedHistory(page: HistoryPage): void {
    this.rebuilding = true
    try {
      this.historyBefore = page.before
      for (const message of page.messages) this.messages.push({ ...message,
        sourceIdentity: null, blocks: message.blocks.map(block => ({ ...block })) })
      for (const tool of page.tools) this.queueUpdate({ kind: 'tool', tool })
      this.enforceLimits()
    } finally { this.rebuilding = false }
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
  }

  /** 同一会话树切换分支时重建展示；保持批序号递增，旧历史缓存必须换代。 */
  replaceProjectedHistory(page: HistoryPage, revision: number): void {
    this.clearTimer()
    this.pending = []; this.outstanding = []; this.messages.length = 0
    this.active = null; this.activeTurn = null
    this.droppedMessages = 0; this.truncated = false
    this.toolProjection.reset()
    this.historyRevision = revision
    this.seedProjectedHistory(page)
    this.needsResync = true
    this.flush()
  }

  /** 累计活动与展示窗口分开；只有事实变化才下发。 */
  setActivity(activity: SessionActivity): void {
    const signature = JSON.stringify(activity)
    if (signature === this.activitySignature) return
    this.activity = activity
    this.activitySignature = signature
    this.queueUpdate({ kind: 'activity', activity })
    this.flush()
  }

  /** 官方条目 ID 只在解析成功后回填；同一展示消息以首次确认为准。 */
  assignEntryId(messageId: string, entryId: string, turnEntryId?: string): boolean {
    const message = this.messages.find(candidate => candidate.id === messageId)
    if (message === undefined || message.entryId !== undefined) return false
    message.entryId = entryId
    if (turnEntryId) message.turnEntryId = turnEntryId
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(message) })
    this.flush()
    return true
  }

  /** 成功压缩的来源由官方分支条目回填；失败或取消记录保持未映射。 */
  assignCompactionEntry(entryId: string, turnEntryId?: string): void {
    const message = this.messages.findLast(candidate => candidate.role === 'compaction' && candidate.entryId === undefined)
    if (message) this.assignEntryId(message.id, entryId, turnEntryId)
  }

  /** 取出某条展示消息的官方条目 ID；未映射或已裁剪时为空。 */
  entryIdOf(messageId: string): string | null {
    return this.messages.find(message => message.id === messageId)?.entryId ?? null
  }

  /** 在仍存在的投影内定位用户消息；被裁剪或未知内容不能作为回退目标。 */
  userMessageIdentity(messageId: string): UserMessageIdentity | null {
    return this.messages.find(message => message.id === messageId && message.role === 'user')?.sourceIdentity ?? null
  }

  /**
   * 回退后整表替换，序号和消息 ID 种子保持递增；旧增量不能泄漏到新历史。
   * `entryIds` 语义与 `seedHistory` 一致。
   */
  replaceHistory(payload: unknown, entryIds: readonly (string | null)[] = []): boolean {
    if (this.disposed || !isRecord(payload) || !Array.isArray(payload.messages)) return false
    this.clearTimer()
    this.pending = []
    this.outstanding = []
    this.messages.length = 0
    this.active = null
    this.activeTurn = null
    this.droppedMessages = 0
    this.truncated = false
    this.toolProjection.reset()
    this.rebuilding = true
    try {
      for (let index = 0; index < payload.messages.length; index += 1) {
        this.applyAuthoritativeMessage(payload.messages[index], null, entryIds[index] ?? null)
      }
      this.seedHistoryTools(payload.messages)
      this.enforceLimits()
    } finally {
      this.rebuilding = false
    }
    this.needsResync = true
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
    this.flush()
    return true
  }

  /**
   * 用 `get_messages` 里的 `toolResult` 消息补种工具条目：参数取自同一 `toolCallId` 的
   * `toolcall` 块，结果与错误状态取自该条消息；`toolResult` 本身不进入消息块投影。
   */
  private seedHistoryTools(messages: readonly unknown[]): void {
    // 参数文本已由消息块承载，先按 toolCallId 收集，不重复解析消息结构。
    const argsByToolCallId = new Map<string, string>()
    for (const message of this.messages) {
      for (const block of message.blocks) {
        if (block.kind === 'toolcall' && block.toolCallId !== null && block.text !== '') {
          argsByToolCallId.set(block.toolCallId, block.text)
        }
      }
    }

    for (const message of messages) {
      if (!isRecord(message) || message.role !== 'toolResult') continue
      const toolCallId = readString(message.toolCallId)
      if (toolCallId === null || toolCallId === '') continue

      this.toolProjection.seedResult({
        toolCallId,
        toolName: readString(message.toolName),
        isError: message.isError === true,
        argsText: argsByToolCallId.get(toolCallId) ?? null,
        result: message,
        // 历史只留下结束时刻；开始时刻不编造，界面因此不显示耗时。
        endedAt: typeof message.timestamp === 'number' ? message.timestamp : null
      })
    }
  }

  /**
   * 快照是渲染端重新同步的唯一基准，因此必须与序号对应：
   * 先把待发增量结算出去，否则快照正文会超前于它携带的 seq，
   * 接收端随后重放这些增量就会重复追加同一段文本。
   */
  snapshot(): ProjectionSnapshot {
    if (this.pending.length > 0) this.flush()
    const tools = this.toolProjection.snapshot()
    const keptTools = new Set(tools.tools.map(tool => tool.toolCallId))
    return {
      runtimeId: this.runtimeId,
      seq: this.seq,
      messages: this.messages.map(message => {
        const projected = this.toPublicMessage(message)
        const missingTools = tools.droppedTools > 0 && message.blocks.some(block => block.kind === 'toolcall'
          && block.toolCallId !== null && !keptTools.has(block.toolCallId))
        return missingTools ? { ...projected, recoverable: true } : projected
      }),
      tools: tools.tools,
      truncated: this.truncated || tools.truncated,
      droppedMessages: this.droppedMessages,
      droppedTools: tools.droppedTools,
      ...(this.activity ? { activity: this.activity } : {}),
      history: { before: this.historyBefore, revision: this.historyRevision }
    }
  }

  /** 记录渲染端已应用到的最高序号；序号不属于本代际时忽略。 */
  ack(runtimeId: number, seq: number): void {
    if (this.disposed || runtimeId !== this.runtimeId) return
    this.outstanding = this.outstanding.filter((value) => value > seq)
  }

  /** Runtime 代际结束时清空投影与定时器；之后的调用不再产生批次。 */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.pending = []
    this.outstanding = []
    this.messages.length = 0
    this.active = null
    this.activeTurn = null
    this.toolProjection.dispose()
  }

  private startMessage(value: unknown): void {
    if (!isRecord(value)) return
    const role = readRole(value.role)
    if (role === null) return

    // 新开始事件不能让上一条未配对的消息一直计时。
    this.interruptActiveGeneration()
    // 第二个用户消息到来时旧轮必须收口，不能让两个气泡同时显示还在响应。
    if (role === 'user') this.finishTurn()
    const message = this.createMessage(role, value)
    if (role === 'assistant') {
      message.generation = { phase: 'running', startedAt: Date.now(), endedAt: null }
    } else {
      // 起点用消息自带的时间戳（Pi 在提交时写入）；缺失时才用当前时刻，不编造时间戳。
      message.turn = { startedAt: message.timestamp ?? Date.now(), endedAt: null }
      this.activeTurn = message
    }
    this.messages.push(message)
    this.active = message
    this.enforceLimits()
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(message) })
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
  }

  private endMessage(value: unknown): void {
    const active = this.active
    this.active = null
    const target = this.applyAuthoritativeMessage(value, active)
    if (target !== active && active !== null && this.finishGeneration(active, 'interrupted')) {
      this.queueUpdate({ kind: 'message', message: this.toPublicMessage(active) })
    }
    if (target === null) return
    this.callbacks.onMessageEnded?.(target.id, target.role)
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
  }

  /**
   * 收口本轮响应计时。消息已被展示上限丢弃时不再发增量：渲染端的快照里已经没有它，
   * 补发增量反而会让它重新出现在末尾。
   */
  private finishTurn(): void {
    const message = this.activeTurn
    this.activeTurn = null
    const timing = message?.turn ?? null
    if (message === null || timing === null || timing.endedAt !== null) return
    if (!this.messages.includes(message)) return
    message.turn = { startedAt: timing.startedAt, endedAt: Math.max(timing.startedAt, Date.now()) }
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(message) })
  }

  /** 只结束有开始事件的生成计时；系统时钟回拨时不产生负耗时。 */
  private finishGeneration(message: MutableMessage, phase: 'completed' | 'interrupted'): boolean {
    const generation = message.generation
    if (generation?.phase !== 'running') return false
    message.generation = {
      phase,
      startedAt: generation.startedAt,
      endedAt: Math.max(generation.startedAt, Date.now())
    }
    return true
  }

  /** 事件配对被打断或 Agent 已收敛时，停止活动消息的计时但不编造正文终态。 */
  private interruptActiveGeneration(): void {
    const active = this.active
    this.active = null
    if (active !== null && this.finishGeneration(active, 'interrupted')) {
      this.queueUpdate({ kind: 'message', message: this.toPublicMessage(active) })
    }
  }

  /**
   * 用权威完整消息整条替换目标消息；没有配对开始事件时仍然收录。
   * 缺省参数是配对中的活动消息，恢复会话时传入 null 表示每条历史消息各自成条。
   */
  private applyAuthoritativeMessage(
    value: unknown,
    active: MutableMessage | null,
    entryId: string | null = null
  ): MutableMessage | null {
    if (!isRecord(value)) return null
    // 独立资料消息只补充所属图片，不新建用户轮次，也不借用它的历史条目身份。
    if (value.role === 'custom') {
      this.applyImageAnnotations(value)
      return null
    }
    // 历史压缩条目带自己的摘要与压缩前 token 数；触发原因与压缩后 token 数条目里没有，保持 null。
    if (value.role === 'compactionSummary') return this.applyCompactionSummary(value, entryId)
    const role = readRole(value.role)
    if (role === null) return null

    const target = active !== null && active.role === role ? active : this.createMessage(role, value)
    if (entryId !== null) target.entryId = entryId
    if (target !== active) {
      this.messages.push(target)
      this.enforceLimits()
    }
    target.sourceIdentity = toUserMessageIdentity(value)
    target.blocks = this.buildBlocks(value.content, role)
    target.timestamp = typeof value.timestamp === 'number' ? value.timestamp : target.timestamp
    target.usage = role === 'assistant' ? readMessageUsage(value.usage) : null
    target.stopReason = typeof value.stopReason === 'string' ? value.stopReason : null
    target.errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : null
    const interrupted = target.stopReason === 'aborted' || target.stopReason === 'error'
    this.finishGeneration(target, interrupted ? 'interrupted' : 'completed')
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(target) })
    return target
  }

  /** 自定义资料紧随本轮用户消息；不跨过助手回复去猜测另一条消息的归属。 */
  private applyImageAnnotations(value: unknown): void {
    const feedback = readImageAnnotationMessage(value)
    const target = this.messages.at(-1)
    if (feedback === null || target?.role !== 'user') return
    const imageCount = target.blocks.filter(block => block.image !== null || block.notice).length
    if (imageCount !== feedback.imageCount) return
    target.imageAnnotations = feedback.attachments
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(target) })
  }

  /** 历史压缩条目按整条收录；与实时压缩记录共用同一展示形状，顺序按基线给定的位置。 */
  private applyCompactionSummary(value: Record<string, unknown>, entryId: string | null): MutableMessage {
    const message = this.createMessage('compaction', value)
    message.compaction = {
      reason: null,
      summary: readString(value.summary) ?? '',
      tokensBefore: readCount(value.tokensBefore),
      tokensAfter: null,
      aborted: false,
      errorMessage: null
    }
    if (entryId !== null) message.entryId = entryId
    this.messages.push(message)
    this.enforceLimits()
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(message) })
    return message
  }

  private updateMessage(payload: Record<string, unknown>): void {
    const message = this.active
    if (message === null || message.role !== 'assistant') return
    const event = payload.assistantMessageEvent
    if (!isRecord(event)) return

    const contentIndex = event.contentIndex
    if (typeof contentIndex !== 'number' || !Number.isInteger(contentIndex) || contentIndex < 0) return

    switch (event.type) {
      case 'text_start':
        this.ensureBlock(message, contentIndex, 'text')
        return
      case 'thinking_start':
        this.ensureBlock(message, contentIndex, 'thinking')
        return
      case 'toolcall_start':
        this.ensureBlock(message, contentIndex, 'toolcall', readString(event.id), readString(event.toolName))
        return
      case 'text_delta':
        this.appendDelta(message, contentIndex, 'text', event.delta)
        return
      case 'thinking_delta':
        this.appendDelta(message, contentIndex, 'thinking', event.delta)
        return
      case 'toolcall_delta':
        this.appendDelta(message, contentIndex, 'toolcall', event.delta)
        return
      case 'text_end':
        this.replaceBlockText(message, contentIndex, 'text', event.content)
        return
      case 'thinking_end':
        this.replaceBlockText(message, contentIndex, 'thinking', event.content)
        return
      case 'toolcall_end':
        this.replaceToolBlock(message, contentIndex, event.toolCall)
        return
      default:
        // start/done/error 由 message_start 与 message_end 表达，不改变内容块。
        return
    }
  }

  /** 建块或补齐工具标识；新建的块必须整块下发，渲染端不凭增量创建块。 */
  private ensureBlock(
    message: MutableMessage,
    contentIndex: number,
    kind: ProjectionBlockKind,
    toolCallId: string | null = null,
    toolName: string | null = null
  ): MutableBlock {
    const existing = message.blocks.find((block) => block.contentIndex === contentIndex)
    if (existing === undefined) {
      const block: MutableBlock = {
        contentIndex,
        kind,
        text: '',
        truncated: false,
        toolCallId,
        toolName,
        image: null,
        notice: false
      }
      message.blocks.push(block)
      message.blocks.sort((left, right) => left.contentIndex - right.contentIndex)
      this.queueUpdate({ kind: 'block', messageId: message.id, block: this.toPublicBlock(block) })
      return block
    }

    let patched = false
    if (existing.toolCallId === null && toolCallId !== null) {
      existing.toolCallId = toolCallId
      patched = true
    }
    if (existing.toolName === null && toolName !== null) {
      existing.toolName = toolName
      patched = true
    }
    if (patched) this.queueUpdate({ kind: 'block', messageId: message.id, block: this.toPublicBlock(existing) })
    return existing
  }

  private appendDelta(
    message: MutableMessage,
    contentIndex: number,
    kind: ProjectionBlockKind,
    delta: unknown
  ): void {
    const block = this.ensureBlock(message, contentIndex, kind)
    if (typeof delta !== 'string' || delta === '' || block.truncated) return

    const next = block.text + delta
    if (next.length > MAX_BLOCK_CHARS) {
      block.text = next.slice(0, MAX_BLOCK_CHARS)
      block.truncated = true
      this.truncated = true
      this.queueUpdate({ kind: 'block', messageId: message.id, block: this.toPublicBlock(block) })
      return
    }
    block.text = next
    this.queueUpdate({ kind: 'append', messageId: message.id, contentIndex, text: delta, length: next.length })
  }

  private replaceBlockText(
    message: MutableMessage,
    contentIndex: number,
    kind: ProjectionBlockKind,
    content: unknown
  ): void {
    const block = this.ensureBlock(message, contentIndex, kind)
    this.publishBlock(message, block, typeof content === 'string' ? content : null)
  }

  private replaceToolBlock(message: MutableMessage, contentIndex: number, toolCall: unknown): void {
    const block = this.ensureBlock(message, contentIndex, 'toolcall')
    if (isRecord(toolCall)) {
      const id = readString(toolCall.id)
      const name = readString(toolCall.name)
      if (id !== null) block.toolCallId = id
      if (name !== null) block.toolName = name
      this.publishBlock(message, block, serializeToolArguments(toolCall.arguments))
      return
    }
    this.publishBlock(message, block, null)
  }

  /** 下发权威块内容；传入空值表示只同步工具标识等其它字段。 */
  private publishBlock(message: MutableMessage, block: MutableBlock, text: string | null): void {
    if (text !== null) {
      if (text.length > MAX_BLOCK_CHARS) {
        block.text = text.slice(0, MAX_BLOCK_CHARS)
        block.truncated = true
        this.truncated = true
      } else {
        block.text = text
      }
    }
    this.queueUpdate({ kind: 'block', messageId: message.id, block: this.toPublicBlock(block) })
  }

  private buildBlocks(content: unknown, role: ProjectedRole = 'assistant'): MutableBlock[] {
    if (typeof content === 'string') return [this.createBlock(0, 'text', content, null, null)]
    if (!Array.isArray(content)) return []

    const blocks: MutableBlock[] = []
    content.forEach((entry, index) => {
      if (!isRecord(entry)) return
      if (entry.type === 'text' && typeof entry.text === 'string') {
        blocks.push(this.createBlock(index, 'text', entry.text, null, null))
        return
      }
      if (entry.type === 'thinking' && typeof entry.thinking === 'string') {
        blocks.push(this.createBlock(index, 'thinking', entry.thinking, null, null))
        return
      }
      if (entry.type === 'toolCall') {
        blocks.push(this.createBlock(
          index,
          'toolcall',
          serializeToolArguments(entry.arguments) ?? '',
          readString(entry.id),
          readString(entry.name)
        ))
        return
      }
      // 图片块只对用户消息投影为附件描述；超过大小上限的附件只保留文字描述，不做其他二次限制。
      if (entry.type === 'image' && role === 'user'
        && typeof entry.data === 'string' && entry.data !== ''
        && typeof entry.mimeType === 'string' && entry.mimeType !== '') {
        blocks.push(this.createImageBlock(index, entry.data, entry.mimeType))
      }
      // 其他内容块不进入展示投影。
    })
    return blocks
  }

  /**
   * 图片附件块：text 不承载本体，估算字节数按 base64 长度换算；超过大小上限只保留说明文案、
   * 不保留本体，并把该块标为投影自己生成的说明（`notice`），供界面区分开用户文本。
   */
  private createImageBlock(contentIndex: number, data: string, mimeType: string): MutableBlock {
    const bytes = Math.floor(data.length * 3 / 4)
    const tooLarge = bytes > MAX_IMAGE_ATTACHMENT_BYTES
    return {
      contentIndex,
      kind: 'text',
      text: tooLarge ? `[图片附件 ${mimeType}，约 ${bytes} 字节，超出展示上限]` : '',
      truncated: false,
      toolCallId: null,
      toolName: null,
      image: tooLarge ? null : { dataUrl: `data:${mimeType};base64,${data}`, mimeType, bytes },
      notice: tooLarge
    }
  }

  private createBlock(
    contentIndex: number,
    kind: ProjectionBlockKind,
    text: string,
    toolCallId: string | null,
    toolName: string | null,
    image: MutableBlock['image'] = null
  ): MutableBlock {
    const truncated = text.length > MAX_BLOCK_CHARS
    if (truncated) this.truncated = true
    return {
      contentIndex,
      kind,
      text: truncated ? text.slice(0, MAX_BLOCK_CHARS) : text,
      truncated,
      toolCallId,
      toolName,
      image,
      // 消息内容里的文本都来自用户或模型，只有附件占位走 createImageBlock。
      notice: false
    }
  }

  /** 相邻的同一块追加合并为一条；同一 `toolCallId` 的未发出条目更新只保留最新一份。 */
  private queueUpdate(update: ProjectionUpdate): void {
    if (update.kind === 'tool') {
      const incoming = update.tool
      const index = this.pending.findIndex((candidate) => (
        candidate.kind === 'tool' && candidate.tool.toolCallId === incoming.toolCallId
      ))
      if (index >= 0) {
        this.pending[index] = update
      } else {
        this.pending.push(update)
      }
    } else {
      // 块校正与整条替换的相对顺序不能被追加合并越过。
      const last = this.pending[this.pending.length - 1]
      if (update.kind === 'append' && last !== undefined && last.kind === 'append'
        && last.messageId === update.messageId && last.contentIndex === update.contentIndex) {
        this.pending[this.pending.length - 1] = {
          kind: 'append',
          messageId: update.messageId,
          contentIndex: update.contentIndex,
          text: last.text + update.text,
          length: update.length
        }
      } else {
        this.pending.push(update)
      }
    }
    if (!this.rebuilding && this.pending.length >= MAX_UPDATES_PER_BATCH) this.flush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, FLUSH_INTERVAL_MS)
    // 未决批次不阻止应用退出。
    this.flushTimer.unref()
  }

  private clearTimer(): void {
    if (this.flushTimer === null) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  /** 发出下一批；未确认窗口已满或投影被裁剪时改为只发重同步标记。 */
  private flush(): void {
    this.clearTimer()
    if (this.disposed) return

    if (this.needsResync || this.outstanding.length >= MAX_UNACKED_BATCHES) {
      // 累计增量已作废：渲染端必须以快照为准。
      this.needsResync = false
      this.pending = []
      this.outstanding = []
      this.emit([], true)
      return
    }
    if (this.pending.length === 0) return

    const updates = this.pending.splice(0, MAX_UPDATES_PER_BATCH)
    this.emit(updates, false)
    if (this.pending.length > 0) this.scheduleFlush()
  }

  private emit(updates: readonly ProjectionUpdate[], resyncRequired: boolean): void {
    this.seq += 1
    this.outstanding.push(this.seq)
    this.callbacks.onBatch({
      runtimeId: this.runtimeId,
      seq: this.seq,
      updates,
      resyncRequired
    })
  }

  /**
   * 条数或文本总量超限时收缩 AI 侧内容，用户输入原样保留。
   * 顺序固定：先丢旧 AI 的过程细节，再压缩旧 AI 正文，最后才丢整条 AI 消息；
   * 每一步都改动了已下发的消息，因此任何一步生效都要让渲染端整表重同步。
   */
  private enforceLimits(): void {
    let changed = this.dropNonUserOverflow()
    if (this.totalChars() > MAX_TOTAL_CHARS) changed = this.shrinkProcessDetail() || changed
    if (this.totalChars() > MAX_TOTAL_CHARS) changed = this.compactAssistantText() || changed
    if (this.totalChars() > MAX_TOTAL_CHARS) changed = this.dropOldestNonUser() || changed
    if (!changed) return
    // 回答被整条移出窗口时，用户消息仍提供本轮原文回读入口。
    for (const message of this.messages) if (message.role === 'user') message.recoverable = true
    this.needsResync = true
    this.flush()
  }

  /** 条数上限只约束 AI 侧消息：用户消息有多少条都保留。 */
  private dropNonUserOverflow(): boolean {
    let dropped = 0
    let count = 0
    for (const message of this.messages) {
      if (message.role !== 'user') count += 1
    }
    while (count > MAX_NON_USER_MESSAGES) {
      const index = this.oldestDroppableIndex()
      if (index < 0) break
      this.messages.splice(index, 1)
      dropped += 1
      count -= 1
    }
    if (dropped === 0) return false
    this.droppedMessages += dropped
    this.truncated = true
    return true
  }

  /**
   * 丢弃旧 AI 消息的响应过程：Thinking 整块去掉，工具调用只保留名称与状态（参数文本清空）。
   * 界面本来就把 Thinking 与工具调用各自折叠展示，这部分体积最不影响阅读；工具条目本身由 ToolProjection 自己限界。
   * 正在生成的消息不收缩：流式事件还会继续往它的块里追加，改它只会让块反复重建。
   */
  private shrinkProcessDetail(): boolean {
    let total = this.totalChars()
    let changed = false
    for (const message of this.messages) {
      if (total <= MAX_TOTAL_CHARS) break
      if (message.role !== 'assistant' || message === this.active) continue
      const kept: MutableBlock[] = []
      for (const block of message.blocks) {
        if (block.kind === 'thinking') {
          total -= block.text.length
          changed = true
          continue
        }
        if (block.kind === 'toolcall' && block.text !== '') {
          total -= block.text.length
          block.text = ''
          block.truncated = true
          changed = true
        }
        kept.push(block)
      }
      if (kept.length !== message.blocks.length) message.blocks = kept
    }
    // 块被改动（思考丢弃或参数清空）也算收缩，顶部提示要能说出来。
    if (changed) this.truncated = true
    return changed
  }

  /** 旧 AI 正文只留开头：回答仍可辨认，长文体积不再无界；正在生成的消息同样不动。 */
  private compactAssistantText(): boolean {
    let total = this.totalChars()
    let changed = false
    for (const message of this.messages) {
      if (total <= MAX_TOTAL_CHARS) break
      if (message.role !== 'assistant' || message === this.active) continue
      for (const block of message.blocks) {
        if (block.kind !== 'text' || block.text.length <= COMPACTED_TEXT_CHARS) continue
        total -= block.text.length - COMPACTED_TEXT_CHARS
        block.text = block.text.slice(0, COMPACTED_TEXT_CHARS)
        block.truncated = true
        changed = true
      }
    }
    if (changed) this.truncated = true
    return changed
  }

  /** 最后手段：丢弃最旧的 AI 消息，用户输入与其余回答保持不动。 */
  private dropOldestNonUser(): boolean {
    let total = this.totalChars()
    let dropped = 0
    while (total > MAX_TOTAL_CHARS) {
      const index = this.oldestDroppableIndex()
      if (index < 0) break
      const removed = this.messages[index]
      if (removed === undefined) break
      this.messages.splice(index, 1)
      total -= this.messageChars(removed)
      dropped += 1
    }
    if (dropped === 0) return false
    this.droppedMessages += dropped
    this.truncated = true
    return true
  }

  /** 最旧的、可以丢弃的非用户消息；用户输入与正在生成的消息永远不是候选。 */
  private oldestDroppableIndex(): number {
    return this.messages.findIndex((message) => message.role !== 'user' && message !== this.active)
  }

  private totalChars(): number {
    let total = 0
    for (const message of this.messages) total += this.messageChars(message)
    return total
  }

  private messageChars(message: MutableMessage): number {
    const blocks = message.blocks.reduce((sum, block) => sum + block.text.length, 0)
    // 压缩摘要同样占展示体积，参与总量上限，避免长摘要把整段历史挤出。
    return blocks + (message.compaction?.summary.length ?? 0)
  }

  private createMessage(role: ProjectedRole, value: Record<string, unknown>): MutableMessage {
    const annotations = role === 'user' ? parseImageAnnotationAttachments(value.imageAnnotations) : null
    return {
      ...(annotations === null || annotations.length === 0 ? {} : { imageAnnotations: annotations }),
      sourceIdentity: toUserMessageIdentity(value),
      id: this.nextMessageId(),
      role,
      blocks: this.buildBlocks(value.content, role),
      timestamp: typeof value.timestamp === 'number' ? value.timestamp : null,
      generation: null,
      usage: role === 'assistant' ? readMessageUsage(value.usage) : null,
      turn: null,
      stopReason: typeof value.stopReason === 'string' ? value.stopReason : null,
      errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : null,
      compaction: null
    }
  }

  private toPublicBlock(block: MutableBlock): ProjectionBlock {
    return {
      contentIndex: block.contentIndex,
      kind: block.kind,
      text: block.text,
      truncated: block.truncated,
      toolCallId: block.toolCallId,
      toolName: block.toolName,
      image: block.image,
      notice: block.notice
    }
  }

  private toPublicMessage(message: MutableMessage): ProjectionMessage {
    return {
      ...(message.imageAnnotations === undefined ? {} : { imageAnnotations: message.imageAnnotations }),
      id: message.id,
      role: message.role,
      blocks: message.blocks.map((block) => this.toPublicBlock(block)),
      timestamp: message.timestamp,
      generation: message.generation,
      usage: message.usage,
      turn: message.turn,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      compaction: message.compaction,
      entryId: message.entryId ?? null,
      recoverable: message.recoverable === true || message.blocks.some(block => block.truncated),
      ...(message.turnEntryId ? { turnEntryId: message.turnEntryId } : {})
    }
  }

  private nextMessageId(): string {
    this.messageSeed += 1
    return `m${this.messageSeed}`
  }
}
