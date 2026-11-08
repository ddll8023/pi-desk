/**
 * 标准模式的待办清单：一个状态型工具、一道写操作门禁，加一层按需回述。
 *
 * 状态只存在工具结果的 `details` 里，不落外部文件：清单随会话分支走，rewind 或 fork 之后
 * 自然回到当时那份清单，不需要额外的同步或清理。
 *
 * 清单是按轮的状态：门禁只认本轮提交的清单，分支上更早的清单跨过本轮用户消息就不算数；
 * 空清单是合法提交，用于显式清空，但门禁仍要求本轮存在非空清单。
 *
 * 防注意力衰减靠请求级回述而不是常驻系统提示：清单只在本轮首次写文件前被门禁要求一次，之后
 * 隔着几十个工具结果仍在上下文前部，最易被忽略。`context` 钩子每隔若干个工具结果在消息尾部
 * 追加一条请求级 `custom` 消息重述清单，把它重新顶到上下文末尾，代价只是那一小段 token。
 * 走 `context` 而不是 `before_agent_start` 的分段：改分段会让不接受 mid-conversation system
 * 的模型每次改动都全量重放提示，尾部追加不改前缀，缓存仍可复用。清单取自分支而非活动投影，
 * 因此压缩把旧工具结果摘要掉之后仍能回述。
 *
 * 门禁只拦文件写入类工具，不拦 `bash`：拦住命令会让首轮连只读探索都做不了，
 * 因此接受「首轮命令仍可改文件」这一残留风险。
 */
import type { ExtensionAPI, ExtensionFactory, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { SessionTodoItem, SessionTodoList } from '../shared/runtime-api'

/** 工具结果 details 多一个版本号；条目形状与渲染端共用同一份定义，不在这里重复声明。 */
export interface TodoListDetails extends SessionTodoList {
  readonly version: 1
}

export type TodoItem = SessionTodoItem

export const TODO_TOOL_NAME = 'todo_write'
const TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed']
/** 与工具清单口径一致：只有真正写文件的工具受门禁约束。 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['write', 'edit', 'multiedit', 'apply_patch'])
/**
 * 回述间隔：本轮每产生这么多个工具结果就重述一次清单。清单在模型里越放越靠前，
 * 间隔太密会把提醒变成噪音、诱发重复提交，太疏则起不到抗漂移的作用；模型一更新清单计数归零。
 */
const RECITE_INTERVAL = 3
/** 请求级回述的消息类型；`display: false` 与 `details.requestOnly` 表示它不落盘、不进界面。 */
const RECITE_CUSTOM_TYPE = 'todo-list.recitation.v1'
/** 回述首句：明确它不是用户新指令，避免模型把提醒当新消息重复回应。 */
const RECITE_PREFIX = '【自动回述】当前轮待办清单，不是用户的新消息，也不要回复它：据此刻状态校准进度，'
  + '某项开始或完成时立刻用 todo_write 重新提交整份清单。'
/** 三态标记只用于模型侧回述与工具回执，文字近似与界面胶囊的 待处理/进行中/已完成 对应。 */
const STATUS_MARKS: Readonly<Record<TodoItem['status'], string>> = {
  completed: '✓',
  in_progress: '▸',
  pending: '·'
}

/** Pi 只把 parameters 原样交给 provider 作为 JSON Schema，运行期不做 TypeBox 校验。 */
type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

const TODO_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      description: '完整待办清单；每次提交覆盖上一版，只提交变化项会丢掉其余条目。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: '一条可执行、可核对的待办。' },
          status: { type: 'string', enum: TODO_STATUSES, description: '默认 pending。' }
        }
      }
    }
  }
} as unknown as ToolParameters

/** 工具结果、回述与门禁提示共用的清单正文：标题只报进度，标记图例只出现一次。 */
function renderTodoList(items: readonly TodoItem[]): string {
  return `待办 ${doneCount(items)}/${items.length}（▸ 进行中、· 待处理、✓ 已完成）\n${renderTodoItems(items)}`
}

/** 逐行渲染条目，供回执复用：回执已有计数行，不再重复标题。 */
function renderTodoItems(items: readonly TodoItem[]): string {
  return items.map(item => `${STATUS_MARKS[item.status]} ${item.text}`).join('\n')
}

function doneCount(items: readonly TodoItem[]): number {
  return items.filter(item => item.status === 'completed').length
}

/** 分支上最近一次清单；`stopAtUser` 为真时按轮截断，跨过本轮用户消息就返回 null。 */
function latestTodoList(entries: readonly SessionEntry[], stopAtUser: boolean): TodoListDetails | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'message') continue
    const message = entry.message
    // 门禁按轮生效：新一轮必须先交自己的清单，不沿用上一轮。
    if (message.role === 'user') {
      if (stopAtUser) return null
      continue
    }
    if (message.role !== 'toolResult' || message.toolName !== TODO_TOOL_NAME) continue
    return parseTodoListDetails(message.details)
  }
  return null
}

/** 本轮最近一次的清单：门禁与回述都只认这一份。 */
export function readTodoList(entries: readonly SessionEntry[]): TodoListDetails | null {
  return latestTodoList(entries, true)
}

/** 分支上最近一次的清单，不按轮截断：只在门禁提示里作为上一轮的参考，不参与判定。 */
function readLastTodoList(entries: readonly SessionEntry[]): TodoListDetails | null {
  return latestTodoList(entries, false)
}

/**
 * 本轮最近一次提交之后又产生了多少个工具结果；本轮还没提交过清单时返回 null。
 * 回述按这个计数节流，而不是按时间或 token，同一批并行调用不会重复注入。
 */
function countToolResultsSinceTodo(entries: readonly SessionEntry[]): number | null {
  let count = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'user') return null
    if (message.role !== 'toolResult') continue
    if (message.toolName === TODO_TOOL_NAME) return count
    count += 1
  }
  return null
}

/**
 * 门禁提示：本轮没交清单时顺带给出上一轮清单，只作参考并要求重新提交，
 * 减少为新轮次重建上下文而重复探索；不改变「门禁只认本轮清单」的判定。
 */
function missingTodoReason(previous: TodoListDetails | null): string {
  const base = '标准模式需要先提交待办清单：调用 todo_write 列出本次执行步骤后，再修改文件。'
  if (previous === null || previous.items.length === 0) return base
  return `${base}\n上一轮清单仅供参考，本轮必须重新提交整份清单：\n${renderTodoList(previous.items)}`
}

/** 从工具结果的 `details` 解出清单；空清单是合法状态，表示本轮没有待办。 */
export function parseTodoListDetails(details: unknown): TodoListDetails | null {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return null
  const candidate = details as { version?: unknown; items?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.items)) return null
  const items: TodoItem[] = []
  for (const raw of candidate.items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { text?: unknown; status?: unknown }
    if (typeof item.text !== 'string' || item.text.trim() === '') continue
    const status = TODO_STATUSES.find(value => value === item.status) ?? 'pending'
    items.push({ text: item.text.trim(), status })
  }
  return { version: 1, items }
}

/**
 * 标准化会话的清单工具与门禁。快速模式不注册本扩展：既没有清单要求，模型也看不到这个工具。
 */
export function createTodoListExtension(): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: TODO_TOOL_NAME,
      label: '待办清单',
      description: '提交或更新本轮的执行待办清单。标准模式在执行文件改动前必须先提交一次；'
        + '每次提交覆盖上一版，全部条目都要带上。某项开始或完成时立即重新提交，不要攒到收尾。'
        + '清单只对当前轮有效；本轮没有待办时提交空清单清空。',
      promptSnippet: 'todo_write — 提交或更新本轮执行待办清单（标准模式写文件前必须先提交）',
      promptGuidelines: [
        '标准模式在第一次写文件之前先提交待办清单；一次提交完整清单，不要只交改动项。',
        '开始某一项或完成某一项时立即重新提交整份清单，让状态跟上实际进展，不要留到最后一次性更新。',
        '清单只对当前轮有效：新一轮必须重新提交，上一轮的清单不会替你过门禁；没有待办时提交空清单清空。',
        `清单每 ${RECITE_INTERVAL} 个工具结果会自动回述一次（标注「自动回述」）：它不是用户消息，不要回复它，`
          + '只需据此校准状态并在清单变化时重新提交。',
        '清单是执行步骤，不代替逐文件执行清单审批：需要用户确认的改动仍要在对话里单独列出。'
      ],
      parameters: TODO_PARAMETERS,
      execute: async (_toolCallId, params) => {
        const items = (params as { items?: unknown }).items
        const normalized: TodoItem[] = []
        if (Array.isArray(items)) {
          for (const raw of items) {
            if (typeof raw !== 'object' || raw === null) continue
            const item = raw as { text?: unknown; status?: unknown }
            const text = typeof item.text === 'string' ? item.text.trim() : ''
            if (text === '') continue
            const status = TODO_STATUSES.find(value => value === item.status) ?? 'pending'
            normalized.push({ text, status })
          }
        }
        if (normalized.length === 0) {
          const cleared: TodoListDetails = { version: 1, items: [] }
          return { content: [{ type: 'text' as const, text: '已清空待办清单。' }], details: cleared }
        }
        const done = doneCount(normalized)
        const details: TodoListDetails = { version: 1, items: normalized }
        // 回执里回显整份清单：提交本身就把最新清单落在上下文尾部，模型不必回翻调用参数。
        return {
          content: [{ type: 'text' as const, text: `已提交待办清单：${normalized.length} 项，已完成 ${done} 项。\n`
            + renderTodoItems(normalized) }],
          details
        }
      }
    })

    pi.on('tool_call', (event, ctx) => {
      if (!WRITE_TOOL_NAMES.has(event.toolName)) return undefined
      const branch = ctx.sessionManager.getBranch()
      const existing = readTodoList(branch)
      if (existing !== null && existing.items.length > 0) return undefined
      return { block: true, reason: missingTodoReason(readLastTodoList(branch)) }
    })

    /**
     * 请求级回述：只在清单存在、且本轮又走过整倍数个工具结果时追加一条请求级消息。
     * 不满足条件时返回 undefined，消息列表原样不动，缓存前缀也就不会被改写。
     */
    pi.on('context', (event, ctx) => {
      const branch = ctx.sessionManager.getBranch()
      const list = readTodoList(branch)
      if (list === null || list.items.length === 0) return undefined
      const stale = countToolResultsSinceTodo(branch)
      if (stale === null || stale === 0 || stale % RECITE_INTERVAL !== 0) return undefined
      const reminder = {
        role: 'custom' as const,
        customType: RECITE_CUSTOM_TYPE,
        content: `${RECITE_PREFIX}\n${renderTodoList(list.items)}`,
        display: false,
        details: { requestOnly: true, version: 1 },
        timestamp: Date.now()
      }
      return { messages: [...event.messages, reminder] }
    })
  }
}
