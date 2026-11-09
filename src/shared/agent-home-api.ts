/**
 * 桌面自有 Pi agent 目录与首启导入的受限接口。
 * 页面只能读状态并触发一次导入，不能指定源目录、目标路径，也不能读取任何配置文件内容。
 */
export const AGENT_HOME_STATE_CHANNEL = 'desktop:agent-home-state'
export const AGENT_HOME_IMPORT_CHANNEL = 'desktop:agent-home-import'

export type AgentHomeImportItemId = 'settings' | 'models' | 'mcp' | 'npm' | 'sessions'
export type AgentHomeImportItemState = 'copied' | 'existing' | 'missing' | 'failed'
export type AgentHomeImportState = 'idle' | 'running' | 'done' | 'partial' | 'skipped'

export interface AgentHomeImportItem {
  readonly id: AgentHomeImportItemId
  readonly state: AgentHomeImportItemState
  /** 失败原因或缺失项说明；没有可报告内容时为 null，不含文件正文。 */
  readonly detail: string | null
}

export interface AgentHomeImportSnapshot {
  readonly source: string
  readonly target: string
  readonly state: AgentHomeImportState
  readonly items: readonly AgentHomeImportItem[]
  readonly message: string | null
}

export interface AgentHomeSnapshot {
  /** 产品自己的运行时目录：凭据、设置、模型、MCP、会话与已装包都在这里。 */
  readonly productDir: string
  /** 终端 CLI 的目录，只读加载 `AGENTS.md` 与 `skills/`，也是首启导入的源。 */
  readonly sharedDir: string
  readonly sharedDirExists: boolean
  /** `PI_CODING_AGENT_DIR` 已把产品指向别处时，隔离与导入都不生效。 */
  readonly explicitDirectory: boolean
  readonly imported: AgentHomeImportSnapshot
}

export type AgentHomeErrorCode = 'FORBIDDEN' | 'INVALID_REQUEST' | 'INTERNAL_ERROR' | 'BUSY'
  | 'BRIDGE_UNAVAILABLE' | 'INVALID_RESPONSE'
export type AgentHomeResult = { readonly ok: true; readonly data: AgentHomeSnapshot }
  | { readonly ok: false; readonly error: { readonly code: AgentHomeErrorCode; readonly message: string } }

export interface AgentHomeApi {
  readonly getAgentHomeState: () => Promise<AgentHomeResult>
  readonly importSharedAgent: () => Promise<AgentHomeResult>
}

const IMPORT_ITEM_IDS: readonly string[] = ['settings', 'models', 'mcp', 'npm', 'sessions']
const IMPORT_ITEM_STATES: readonly string[] = ['copied', 'existing', 'missing', 'failed']
const IMPORT_STATES: readonly string[] = ['idle', 'running', 'done', 'partial', 'skipped']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\u0000')
}

function nullableText(value: unknown, limit: number): value is string | null {
  return value === null || text(value, limit)
}

function isImportItem(value: unknown): value is AgentHomeImportItem {
  return record(value)
    && IMPORT_ITEM_IDS.includes(String(value.id)) && IMPORT_ITEM_STATES.includes(String(value.state))
    && nullableText(value.detail, 300)
    && Object.keys(value).length === 3
}

function isImportSnapshot(value: unknown): value is AgentHomeImportSnapshot {
  return record(value) && text(value.source, 1024) && text(value.target, 1024)
    && IMPORT_STATES.includes(String(value.state)) && nullableText(value.message, 300)
    && Array.isArray(value.items) && value.items.length <= IMPORT_ITEM_IDS.length
    && value.items.every(isImportItem)
    && Object.keys(value).length === 5
}

export function isAgentHomeSnapshot(value: unknown): value is AgentHomeSnapshot {
  return record(value) && text(value.productDir, 1024) && text(value.sharedDir, 1024)
    && typeof value.sharedDirExists === 'boolean' && typeof value.explicitDirectory === 'boolean'
    && isImportSnapshot(value.imported)
    && Object.keys(value).length === 5
}

export function isAgentHomeResult(value: unknown): value is AgentHomeResult {
  if (!record(value)) return false
  if (value.ok === true) return isAgentHomeSnapshot(value.data)
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && ['FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'BUSY', 'BRIDGE_UNAVAILABLE', 'INVALID_RESPONSE']
      .includes(String(value.error.code))
}
