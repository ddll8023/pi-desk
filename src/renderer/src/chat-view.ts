/**
 * 把 Runtime 投影映射为聊天区渲染项：块按 contentIndex 排序、工具调用块按 toolCallId 关联执行条目、
 * 失败文案只取投影已给的字段。
 *
 * 不重建消息、不猜测缺失内容，也不保存历史；投影快照与批次仍是唯一来源。投影按消息 copy-on-write
 * （只替换被改动的消息与工具条目对象），因此这里缓存上一次的渲染项：消息对象与其工具条目对象都没变
 * 时直接复用，避免每个批次都重建整段历史的块对象；缓存只保留仍在投影里的消息，不持有已丢弃内容。
 * 工具卡片所需的字段原样来自投影，本模块不计算耗时也不整理非文本内容；Diff 与工具专属 UI 留到后续阶段。
 */
import type { ProjectionBlock, ProjectionMessage, ToolExecution } from '../../shared/runtime-api'

/** 工具调用块的渲染项；`execution` 为 null 表示该工具调用没有对应执行条目（尚未到达或历史中没有结果）。 */
export interface ChatToolBlock {
  readonly kind: 'toolcall'
  readonly key: string
  readonly toolName: string
  readonly execution: ToolExecution | null
}

export interface ChatTextBlock {
  readonly kind: 'text'
  readonly key: string
  readonly text: string
  readonly truncated: boolean
}

export interface ChatThinkingBlock {
  readonly kind: 'thinking'
  readonly key: string
  readonly text: string
  readonly truncated: boolean
}

export type ChatBlock = ChatTextBlock | ChatThinkingBlock | ChatToolBlock

export interface ChatMessageView {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly ChatBlock[]
  /** 整条消息的失败文案；非 null 时界面按错误提示展示。 */
  readonly failure: string | null
  readonly time: string | null
}

/** 一条消息引用到的工具条目；复用判定要求工具条目对象也未变化。 */
interface ToolRef {
  readonly toolCallId: string
  readonly execution: ToolExecution | undefined
}

interface CacheEntry {
  readonly source: ProjectionMessage
  readonly toolRefs: readonly ToolRef[]
  readonly view: ChatMessageView
}

interface BuiltMessage {
  readonly view: ChatMessageView
  readonly toolRefs: readonly ToolRef[]
}

export interface ChatViewCache {
  /** 把投影映射为渲染项；未变化的条目复用上一次的结果。 */
  toMessages(messages: readonly ProjectionMessage[], tools: readonly ToolExecution[]): ChatMessageView[]
}

/** Pi 的停止原因里只有这两类属于失败；其他取值不为凑文案而冒充错误。 */
const FAILURE_STOP_REASONS: Readonly<Record<string, string>> = {
  error: 'Agent 响应以错误结束。',
  aborted: '本次操作已中止。'
}

const UNKNOWN_TOOL_NAME = '未知工具'

/** 每个组件实例持有自己的缓存；缓存不跨实例共享，也不进全局状态。 */
export function createChatViewCache(): ChatViewCache {
  let entries = new Map<string, CacheEntry>()

  return {
    toMessages(messages, tools) {
      const toolsById = new Map(tools.map((tool) => [tool.toolCallId, tool]))
      const kept = new Map<string, CacheEntry>()
      const views = messages.map((message) => {
        const cached = entries.get(message.id)
        if (cached !== undefined && isReusable(cached, message, toolsById)) {
          kept.set(message.id, cached)
          return cached.view
        }

        const built = buildMessageView(message, toolsById)
        kept.set(message.id, { source: message, toolRefs: built.toolRefs, view: built.view })
        return built.view
      })
      // 只保留当前仍存在的消息，避免缓存继续持有已被投影丢弃的大块文本。
      entries = kept
      return views
    }
  }
}

/** 消息对象未替换，且它引用的每个工具条目仍是同一个对象时，可以直接复用。 */
function isReusable(
  entry: CacheEntry,
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>
): boolean {
  if (entry.source !== message) return false
  for (const ref of entry.toolRefs) {
    if (toolsById.get(ref.toolCallId) !== ref.execution) return false
  }
  return true
}

function buildMessageView(
  message: ProjectionMessage,
  toolsById: ReadonlyMap<string, ToolExecution>
): BuiltMessage {
  const toolRefs: ToolRef[] = []
  // 投影本身按 contentIndex 排序；这里再排一次，保证渲染顺序不依赖上游的插入方式。
  const blocks = [...message.blocks]
    .sort((left, right) => left.contentIndex - right.contentIndex)
    .map((block) => toChatBlock(message.id, block, toolsById, toolRefs))

  return {
    view: {
      id: message.id,
      role: message.role,
      blocks,
      failure: messageFailureText(message),
      time: formatMessageTime(message.timestamp)
    },
    toolRefs
  }
}

function toChatBlock(
  messageId: string,
  block: ProjectionBlock,
  toolsById: ReadonlyMap<string, ToolExecution>,
  toolRefs: ToolRef[]
): ChatBlock {
  const key = `${messageId}-${block.contentIndex}`
  if (block.kind === 'text') {
    return { kind: 'text', key, text: block.text, truncated: block.truncated }
  }
  if (block.kind === 'thinking') {
    return { kind: 'thinking', key, text: block.text, truncated: block.truncated }
  }

  const execution = block.toolCallId === null ? undefined : toolsById.get(block.toolCallId)
  if (block.toolCallId !== null) toolRefs.push({ toolCallId: block.toolCallId, execution })
  return {
    kind: 'toolcall',
    key,
    toolName: firstNonEmpty(block.toolName, execution?.toolName) ?? UNKNOWN_TOOL_NAME,
    execution: execution ?? null
  }
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** 只按投影字段判断失败：`errorMessage` 优先，其次是可识别的停止原因。 */
function messageFailureText(message: ProjectionMessage): string | null {
  if (message.role !== 'assistant') return null
  const explicit = firstNonEmpty(message.errorMessage)
  if (explicit !== null) return explicit
  if (message.stopReason === null) return null
  return FAILURE_STOP_REASONS[message.stopReason] ?? null
}

/** 消息时间来自 Pi 的时间戳；缺失时返回 null，界面不编造时间。 */
function formatMessageTime(timestamp: number | null): string | null {
  if (timestamp === null) return null
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}
