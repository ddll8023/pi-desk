/** 只定义 Runtime 启停、状态、Prompt 提交与消息投影 IPC 的固定通道、事件名、结果类型与跨进程响应校验。 */
import type { DesktopErrorCode } from './desktop-api'

export const RUNTIME_START_CHANNEL = 'desktop:runtime-start'
export const RUNTIME_STOP_CHANNEL = 'desktop:runtime-stop'
export const RUNTIME_STATUS_CHANNEL = 'desktop:runtime-status'
export const RUNTIME_PROMPT_CHANNEL = 'desktop:runtime-prompt'
export const RUNTIME_PROJECTION_CHANNEL = 'desktop:runtime-projection'
export const RUNTIME_PROJECTION_ACK_CHANNEL = 'desktop:runtime-projection-ack'
/** 主进程到渲染进程的单向状态通知，payload 是 RuntimeStatus。 */
export const RUNTIME_STATUS_EVENT = 'desktop:runtime-status-changed'
/** 主进程到渲染进程的单向投影批次通知，payload 是 ProjectionBatch。 */
export const RUNTIME_PROJECTION_EVENT = 'desktop:runtime-projection-changed'

/** 启动请求只接受项目目录；其他启动参数一律不接受。 */
export interface RuntimeStartRequest {
  readonly projectPath: string
}

/**
 * `idle` 且 `runtimeId` 非空表示上一次 Runtime 已正常关闭；
 * `runtimeId` 仍为 null 表示从未启动。`failed` 表示异常退出或启动失败。
 */
export type RuntimeState = 'idle' | 'starting' | 'ready' | 'stopping' | 'failed'

/** 只投影页面需要的会话信息，不搬运 Pi 的完整状态或消息。 */
export interface RuntimeInfo {
  readonly model: string | null
  readonly thinkingLevel: string | null
  readonly sessionId: string | null
  readonly messageCount: number
  readonly isStreaming: boolean
}

export interface RuntimeStatus {
  readonly state: RuntimeState
  readonly runtimeId: number | null
  readonly info: RuntimeInfo | null
  readonly lastError: string | null
}

export type RuntimeErrorCode =
  | DesktopErrorCode
  | 'INVALID_PROJECT_PATH'
  | 'RUNTIME_ALREADY_RUNNING'
  | 'RUNTIME_NOT_READY'
  | 'RUNTIME_SPAWN_FAILED'
  | 'RUNTIME_EXITED'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_PROTOCOL_ERROR'
  | 'PROMPT_REJECTED'

export interface RuntimeError {
  readonly code: RuntimeErrorCode
  readonly message: string
}

export type RuntimeResult =
  | { readonly ok: true; readonly data: RuntimeStatus }
  | { readonly ok: false; readonly error: RuntimeError }

/** `handled` 表示被扩展或输入处理器消费，不表示本次一定启动了 Agent run。 */
export type PromptDisposition = 'started' | 'queued' | 'handled'

/** prompt 结果只表达请求被接受、排队或被处理，不等待 Agent 执行结束。 */
export type PromptResult =
  | { readonly ok: true; readonly data: { readonly disposition: PromptDisposition } }
  | { readonly ok: false; readonly error: RuntimeError }

/** 投影只重建页面要展示的内容块；图片、工具结果与诊断不进入展示投影。 */
export type ProjectionBlockKind = 'text' | 'thinking' | 'toolcall'

/** 块的 `text` 是当前完整内容；`truncated` 表示已按展示上限截断。 */
export interface ProjectionBlock {
  readonly contentIndex: number
  readonly kind: ProjectionBlockKind
  readonly text: string
  readonly truncated: boolean
  readonly toolCallId: string | null
  readonly toolName: string | null
}

/** `id` 由 Desktop 生成，不冒充 Pi 消息字段。 */
export interface ProjectionMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly ProjectionBlock[]
  readonly timestamp: number | null
  readonly stopReason: string | null
  readonly errorMessage: string | null
}

/**
 * `append` 携带追加后的块总长度；渲染端长度不符时必须换取快照，不能猜测补齐。
 * `block` 是权威块内容，`message` 是新消息或整条替换。
 */
export type ProjectionUpdate =
  | {
    readonly kind: 'append'
    readonly messageId: string
    readonly contentIndex: number
    readonly text: string
    readonly length: number
  }
  | { readonly kind: 'block'; readonly messageId: string; readonly block: ProjectionBlock }
  | { readonly kind: 'message'; readonly message: ProjectionMessage }

/** 重新订阅或失去同步时的唯一基准；没有活动 Runtime 时消息列表为空。 */
export interface ProjectionSnapshot {
  readonly runtimeId: number | null
  readonly seq: number
  readonly messages: readonly ProjectionMessage[]
  readonly truncated: boolean
  readonly droppedMessages: number
}

/** `resyncRequired` 表示增量已作废，渲染端应换取快照而不是继续应用本批更新。 */
export interface ProjectionBatch {
  readonly runtimeId: number
  readonly seq: number
  readonly updates: readonly ProjectionUpdate[]
  readonly resyncRequired: boolean
}

/** 应用确认只带已应用到的最高序号；确认失败只影响通知窗口。 */
export interface ProjectionAckRequest {
  readonly runtimeId: number
  readonly seq: number
}

export type ProjectionResult =
  | { readonly ok: true; readonly data: ProjectionSnapshot }
  | { readonly ok: false; readonly error: RuntimeError }

export interface RuntimeApi {
  readonly startRuntime: (projectPath: string) => Promise<RuntimeResult>
  readonly stopRuntime: () => Promise<RuntimeResult>
  readonly getRuntimeStatus: () => Promise<RuntimeResult>
  readonly sendPrompt: (message: string) => Promise<PromptResult>
  readonly getRuntimeProjection: () => Promise<ProjectionResult>
  /** 确认已应用到的最高序号；即发即忘，结果不影响页面。 */
  readonly ackRuntimeProjection: (runtimeId: number, seq: number) => void
  /** 订阅状态变化；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeStatusChanged: (listener: (status: RuntimeStatus) => void) => () => void
  /** 订阅投影批次；返回释放函数，页面卸载时必须调用。 */
  readonly onRuntimeProjectionChanged: (listener: (batch: ProjectionBatch) => void) => () => void
}

// 与 desktop-api.ts 的共享错误码保持一致，再追加 Runtime 启动与运行专有错误码。
const RUNTIME_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'INVALID_PROJECT_PATH',
  'RUNTIME_ALREADY_RUNNING',
  'RUNTIME_NOT_READY',
  'RUNTIME_SPAWN_FAILED',
  'RUNTIME_EXITED',
  'RUNTIME_TIMEOUT',
  'RUNTIME_PROTOCOL_ERROR',
  'PROMPT_REJECTED'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return value === 'idle' || value === 'starting' || value === 'ready'
    || value === 'stopping' || value === 'failed'
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!isRecord(value)) return false
  return (value.model === null || typeof value.model === 'string')
    && (value.thinkingLevel === null || typeof value.thinkingLevel === 'string')
    && (value.sessionId === null || typeof value.sessionId === 'string')
    && typeof value.messageCount === 'number'
    && typeof value.isStreaming === 'boolean'
}

export function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value) || !isRuntimeState(value.state)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (value.lastError !== null && typeof value.lastError !== 'string') return false
  return value.info === null || isRuntimeInfo(value.info)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isRuntimeResult(value: unknown): value is RuntimeResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isRuntimeStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

function isPromptDisposition(value: unknown): value is PromptDisposition {
  return value === 'started' || value === 'queued' || value === 'handled'
}

function isProjectionBlockKind(value: unknown): value is ProjectionBlockKind {
  return value === 'text' || value === 'thinking' || value === 'toolcall'
}

function isProjectionBlock(value: unknown): value is ProjectionBlock {
  if (!isRecord(value)) return false
  return typeof value.contentIndex === 'number'
    && Number.isInteger(value.contentIndex)
    && isProjectionBlockKind(value.kind)
    && typeof value.text === 'string'
    && typeof value.truncated === 'boolean'
    && (value.toolCallId === null || typeof value.toolCallId === 'string')
    && (value.toolName === null || typeof value.toolName === 'string')
}

function isProjectionMessage(value: unknown): value is ProjectionMessage {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && (value.role === 'user' || value.role === 'assistant')
    && Array.isArray(value.blocks)
    && value.blocks.every(isProjectionBlock)
    && (value.timestamp === null || typeof value.timestamp === 'number')
    && (value.stopReason === null || typeof value.stopReason === 'string')
    && (value.errorMessage === null || typeof value.errorMessage === 'string')
}

function isProjectionUpdate(value: unknown): value is ProjectionUpdate {
  if (!isRecord(value)) return false
  if (value.kind === 'message') return isProjectionMessage(value.message)
  if (typeof value.messageId !== 'string') return false
  if (value.kind === 'block') return isProjectionBlock(value.block)
  return value.kind === 'append'
    && typeof value.contentIndex === 'number'
    && Number.isInteger(value.contentIndex)
    && typeof value.text === 'string'
    && typeof value.length === 'number'
    && Number.isInteger(value.length)
    && value.length >= 0
}

function isProjectionSnapshot(value: unknown): value is ProjectionSnapshot {
  if (!isRecord(value)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) return false
  if (!Array.isArray(value.messages) || !value.messages.every(isProjectionMessage)) return false
  return typeof value.truncated === 'boolean'
    && typeof value.droppedMessages === 'number'
    && Number.isInteger(value.droppedMessages)
    && value.droppedMessages >= 0
}

/** 批次校验失败时渲染端直接丢弃；序号缺口由快照重同步收敛。 */
export function isProjectionBatch(value: unknown): value is ProjectionBatch {
  if (!isRecord(value)) return false
  if (typeof value.runtimeId !== 'number') return false
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq <= 0) return false
  if (!Array.isArray(value.updates) || !value.updates.every(isProjectionUpdate)) return false
  return typeof value.resyncRequired === 'boolean'
}

// prompt 的成功数据只认三个合法 disposition；其他取值按响应契约不符处理。
export function isPromptResult(value: unknown): value is PromptResult {
  if (!isRecord(value)) return false

  if (value.ok === true) {
    return isRecord(value.data) && isPromptDisposition(value.data.disposition)
  }
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}

// 投影快照是重同步的唯一基准，跨进程返回同样只放行本契约。
export function isProjectionResult(value: unknown): value is ProjectionResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isProjectionSnapshot(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && RUNTIME_ERROR_CODES.includes(code)
}
