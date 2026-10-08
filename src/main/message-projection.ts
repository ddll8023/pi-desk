/**
 * 维护当前 Runtime 代际的临时消息与工具投影，并按有界批次推送给渲染端。
 *
 * 把 Pi 的会话事件（以及恢复会话时的历史消息）重建为页面要展示的消息内容块与工具执行条目，
 * 不保存原始事件、不持久化、不管理 Session、不解析 response 信封与退出；工具条目的生命周期交给
 * tool-projection，本模块负责聚合、批次、序号与确认。渲染端长度校验失败、序号缺口或未确认窗口
 * 超限都收敛到快照重同步，投影不猜测渲染端缺少的内容；触及展示上限时显式截断并计数，不伪装成完整内容。
 */
import type {
  ProjectionBatch,
  ProjectionBlock,
  ProjectionBlockKind,
  ProjectionMessage,
  ProjectionSnapshot,
  ProjectionUpdate,
  ToolExecution
} from '../shared/runtime-api'
import { ToolProjection, serializeToolArguments } from './tool-projection'

/** 批次刷新节拍；消息开始与终态事件立即刷新，不受此限制。 */
const FLUSH_INTERVAL_MS = 100

/** 单批更新条数上限，达到即立即刷新。 */
const MAX_UPDATES_PER_BATCH = 64

/** 已发未确认批次窗口；超过后作废增量并要求渲染端重同步。 */
const MAX_UNACKED_BATCHES = 32

/** 单个内容块文本上限；超出按截断处理并在投影与界面标示。 */
const MAX_BLOCK_CHARS = 262_144

/** 投影保留的消息条数上限；超出丢弃最旧消息并计数。 */
const MAX_MESSAGES = 200

/** 投影文本总量上限；超出按从旧到新的顺序丢弃消息。 */
const MAX_TOTAL_CHARS = 4_194_304

type ProjectedRole = 'user' | 'assistant'

interface MutableBlock {
  readonly contentIndex: number
  kind: ProjectionBlockKind
  text: string
  truncated: boolean
  toolCallId: string | null
  toolName: string | null
}

interface MutableMessage {
  readonly id: string
  readonly role: ProjectedRole
  blocks: MutableBlock[]
  timestamp: number | null
  stopReason: string | null
  errorMessage: string | null
}

/** 投影上报给 Manager 的运行状态提示；只覆盖由事件可确定的字段。 */
export interface ProjectionStatusHint {
  readonly isStreaming?: boolean
  readonly messageCount?: number
}

export interface ProjectionCallbacks {
  readonly onBatch: (batch: ProjectionBatch) => void
  readonly onStatusHint: (hint: ProjectionStatusHint) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只有这两类角色的消息进入展示投影；工具结果与其他角色由后续任务按需扩展。 */
function readRole(value: unknown): ProjectedRole | null {
  return value === 'user' || value === 'assistant' ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
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
  private flushTimer: NodeJS.Timeout | null = null
  private droppedMessages = 0
  private truncated = false
  private needsResync = false
  private disposed = false
  private readonly toolProjection: ToolProjection

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
        return
      case 'agent_settled':
        // 会话级忙碌状态以此收敛；仍未结束的工具条目标为未确认，同时把剩余增量立即送出。
        this.callbacks.onStatusHint({ isStreaming: false })
        this.toolProjection.settleRunning()
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
      default:
        // 队列、压缩、重试与 Extension UI 事件不进入展示投影。
        return
    }
  }

  /**
   * 以 `get_messages` 响应里的会话消息重建投影基准：每条消息按权威整条替换语义收录，
   * 用于恢复会话后的第一次同步。载荷缺少消息数组时返回 false（响应契约不符）。
   */
  seedHistory(payload: unknown): boolean {
    if (this.disposed) return false
    const messages = isRecord(payload) ? payload.messages : null
    if (!Array.isArray(messages)) return false

    // 历史消息与流式事件之间没有配对关系，每条各自成条。
    this.active = null
    for (const message of messages) this.applyAuthoritativeMessage(message, null)
    this.enforceLimits()
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
    this.flush()
    return true
  }

  /** 快照是渲染端重新同步的唯一基准。 */
  snapshot(): ProjectionSnapshot {
    const tools = this.toolProjection.snapshot()
    return {
      runtimeId: this.runtimeId,
      seq: this.seq,
      messages: this.messages.map((message) => this.toPublicMessage(message)),
      tools: tools.tools,
      truncated: this.truncated || tools.truncated,
      droppedMessages: this.droppedMessages,
      droppedTools: tools.droppedTools
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
    this.toolProjection.dispose()
  }

  private startMessage(value: unknown): void {
    if (!isRecord(value)) return
    const role = readRole(value.role)
    if (role === null) return

    const message = this.createMessage(role, value)
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
    if (target === null) return
    this.callbacks.onStatusHint({ messageCount: this.messages.length })
  }

  /**
   * 用权威完整消息整条替换目标消息；没有配对开始事件时仍然收录。
   * 缺省参数是配对中的活动消息，恢复会话时传入 null 表示每条历史消息各自成条。
   */
  private applyAuthoritativeMessage(
    value: unknown,
    active: MutableMessage | null
  ): MutableMessage | null {
    if (!isRecord(value)) return null
    const role = readRole(value.role)
    if (role === null) return null

    const target = active !== null && active.role === role ? active : this.createMessage(role, value)
    if (target !== active) {
      this.messages.push(target)
      this.enforceLimits()
    }
    target.blocks = this.buildBlocks(value.content)
    target.timestamp = typeof value.timestamp === 'number' ? value.timestamp : target.timestamp
    target.stopReason = typeof value.stopReason === 'string' ? value.stopReason : null
    target.errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : null
    this.queueUpdate({ kind: 'message', message: this.toPublicMessage(target) })
    return target
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
        toolName
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

  private buildBlocks(content: unknown): MutableBlock[] {
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
      }
      // 图片与其他内容块不进入展示投影。
    })
    return blocks
  }

  private createBlock(
    contentIndex: number,
    kind: ProjectionBlockKind,
    text: string,
    toolCallId: string | null,
    toolName: string | null
  ): MutableBlock {
    const truncated = text.length > MAX_BLOCK_CHARS
    if (truncated) this.truncated = true
    return {
      contentIndex,
      kind,
      text: truncated ? text.slice(0, MAX_BLOCK_CHARS) : text,
      truncated,
      toolCallId,
      toolName
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
    if (this.pending.length >= MAX_UPDATES_PER_BATCH) this.flush()
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

  /** 消息数或文本总量超限时从最旧开始丢弃；丢弃后渲染端必须整表重同步。 */
  private enforceLimits(): void {
    let dropped = 0
    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift()
      dropped += 1
    }

    let total = this.messages.reduce((sum, message) => sum + this.messageChars(message), 0)
    while (total > MAX_TOTAL_CHARS && this.messages.length > 1) {
      const removed = this.messages.shift()
      if (removed === undefined) break
      total -= this.messageChars(removed)
      dropped += 1
    }
    if (dropped === 0) return

    this.droppedMessages += dropped
    this.truncated = true
    this.needsResync = true
    this.flush()
  }

  private messageChars(message: MutableMessage): number {
    return message.blocks.reduce((sum, block) => sum + block.text.length, 0)
  }

  private createMessage(role: ProjectedRole, value: Record<string, unknown>): MutableMessage {
    return {
      id: this.nextMessageId(),
      role,
      blocks: this.buildBlocks(value.content),
      timestamp: typeof value.timestamp === 'number' ? value.timestamp : null,
      stopReason: typeof value.stopReason === 'string' ? value.stopReason : null,
      errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage : null
    }
  }

  private toPublicBlock(block: MutableBlock): ProjectionBlock {
    return {
      contentIndex: block.contentIndex,
      kind: block.kind,
      text: block.text,
      truncated: block.truncated,
      toolCallId: block.toolCallId,
      toolName: block.toolName
    }
  }

  private toPublicMessage(message: MutableMessage): ProjectionMessage {
    return {
      id: message.id,
      role: message.role,
      blocks: message.blocks.map((block) => this.toPublicBlock(block)),
      timestamp: message.timestamp,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage
    }
  }

  private nextMessageId(): string {
    this.messageSeed += 1
    return `m${this.messageSeed}`
  }
}
