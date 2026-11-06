/**
 * 标准模式的待办清单：一个状态型工具加一道写操作门禁。
 *
 * 状态只存在工具结果的 `details` 里，不落外部文件：清单随会话分支走，rewind 或 fork 之后
 * 自然回到当时那份清单，不需要额外的同步或清理。
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

/** 分支上最近一次清单；只认本工具的结果，缺条目或形状不符时按不存在处理。 */
export function readTodoList(entries: readonly SessionEntry[]): TodoListDetails | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'message') continue
    const message = entry.message
    if (message.role !== 'toolResult' || message.toolName !== TODO_TOOL_NAME) continue
    return parseTodoListDetails(message.details)
  }
  return null
}

/** 从工具结果的 `details` 解出清单；投影与门禁共用同一份解析，不接受空清单。 */
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
  return items.length === 0 ? null : { version: 1, items }
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
        + '每次提交覆盖上一版，全部条目都要带上。',
      promptSnippet: 'todo_write — 提交或更新本轮执行待办清单（标准模式写文件前必须先提交）',
      promptGuidelines: [
        '标准模式在第一次写文件之前先提交待办清单；一次提交完整清单，不要只交改动项。',
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
        if (normalized.length === 0) throw new Error('待办清单至少需要一条非空条目')
        const done = normalized.filter(item => item.status === 'completed').length
        const details: TodoListDetails = { version: 1, items: normalized }
        return {
          content: [{ type: 'text' as const, text: `已提交待办清单：${normalized.length} 项，已完成 ${done} 项。` }],
          details
        }
      }
    })

    pi.on('tool_call', (event, ctx) => {
      if (!WRITE_TOOL_NAMES.has(event.toolName)) return undefined
      const existing = readTodoList(ctx.sessionManager.getBranch())
      if (existing !== null && existing.items.length > 0) return undefined
      return {
        block: true,
        reason: '标准模式需要先提交待办清单：调用 todo_write 列出本次执行步骤后，再修改文件。'
      }
    })
  }
}
