/**
 * 只定义 Extension UI 子协议（Pi 的 extension_ui_request / extension_ui_response）的
 * IPC 通道、投影状态类型、dialog 响应请求与跨进程校验。
 *
 * 只映射官方 RPC 支持的九个 method；未知 method 在主进程丢弃，不进入契约。
 * Dialog 请求的 `timeout` 由 Pi 侧自动解析，Desktop 不计时。
 */
import type { DesktopErrorCode } from './desktop-api'

/** 快照查询与响应提交的固定通道；变更经单向事件广播。 */
export const EXTENSION_UI_STATE_CHANNEL = 'desktop:extension-ui-state'
export const EXTENSION_UI_RESPOND_CHANNEL = 'desktop:extension-ui-respond'
export const EXTENSION_UI_EVENT = 'desktop:extension-ui-changed'

/** Dialog 类 method：需要页面回应，未回应前 Pi 的 Agent run 一直等待。 */
export type ExtensionDialogMethod = 'select' | 'confirm' | 'input' | 'editor'

/** Fire-and-forget method：只更新展示状态，不需要响应。 */
export type ExtensionFireAndForgetMethod =
  | 'notify'
  | 'setStatus'
  | 'setWidget'
  | 'setTitle'
  | 'set_editor_text'

export type ExtensionUiMethod = ExtensionDialogMethod | ExtensionFireAndForgetMethod

/** Dialog 请求的页面投影；`timeoutMs` 是 Pi 侧期限（毫秒），Desktop 不计时，只用于展示。 */
export interface ExtensionDialogRequest {
  readonly id: string
  readonly method: ExtensionDialogMethod
  readonly title: string
  /** `select` 的候选；其他 method 为空数组。 */
  readonly options: readonly string[]
  /** `confirm` 的补充说明；其他 method 为 null。 */
  readonly message: string | null
  /** `input` 的占位提示；其他 method 为 null。 */
  readonly placeholder: string | null
  /** `editor` 的预填内容；其他 method 为 null。 */
  readonly prefill: string | null
  readonly timeoutMs: number | null
}

/** 通知条目；内容按不可信文本处理，只做纯文本插值。 */
export interface ExtensionNotifyEntry {
  readonly id: string
  readonly notifyType: 'info' | 'warning' | 'error'
  readonly message: string
}

/** `setStatus` 的单条状态；`text` 为空字符串表示该 key 已被清除，不进入投影。 */
export interface ExtensionStatusEntry {
  readonly key: string
  readonly text: string
}

/** Widget 放置位置；与官方子协议取值一致。 */
export type ExtensionWidgetPlacement = 'aboveEditor' | 'belowEditor'

/** `setWidget` 的展示状态；`lines` 为空数组表示该 placement 已被清除。 */
export interface ExtensionWidget {
  readonly placement: ExtensionWidgetPlacement
  readonly lines: readonly string[]
}

/** 当前代际的 Extension UI 展示状态；dialog 队列按到达顺序展示。 */
export interface ExtensionUiState {
  /** 无活动 Runtime 时为 null。 */
  readonly runtimeId: number | null
  readonly dialogs: readonly ExtensionDialogRequest[]
  readonly notifications: readonly ExtensionNotifyEntry[]
  readonly statuses: readonly ExtensionStatusEntry[]
  readonly widgets: readonly ExtensionWidget[]
  /** 最近一次 `set_editor_text` 的文本；null 表示没有待填充内容。 */
  readonly editorText: string | null
  /** 无效记录计数：未知 method、形状不符的请求只计数，不让页面报错。 */
  readonly invalidCount: number
}

/** 状态快照带代际与递增序号；渲染端按序丢弃过期快照。 */
export interface ExtensionUiSnapshot {
  readonly runtimeId: number | null
  readonly seq: number
  readonly state: ExtensionUiState
}

/** 页面提交的 dialog 响应：值、确认或取消，三者互斥；字段有效性由主进程按 method 校验。 */
export type ExtensionDialogResponseInput =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  | { readonly kind: 'cancelled' }

export type ExtensionUiErrorCode = DesktopErrorCode | 'EXTENSION_DIALOG_NOT_FOUND'

export type ExtensionUiResult =
  | { readonly ok: true; readonly data: ExtensionUiSnapshot }
  | {
    readonly ok: false
    readonly error: { readonly code: ExtensionUiErrorCode; readonly message: string }
  }

/** 渲染端可用的受限 Extension UI 桥接；订阅返回释放函数，页面卸载时必须调用。 */
export interface ExtensionUiApi {
  readonly getExtensionUiState: () => Promise<ExtensionUiResult>
  readonly respondExtensionDialog: (
    dialogId: string,
    response: ExtensionDialogResponseInput
  ) => Promise<ExtensionUiResult>
  readonly onExtensionUiChanged: (listener: (snapshot: ExtensionUiSnapshot) => void) => () => void
}

// 与 desktop-api.ts 的共享错误码保持一致，再追加 Extension UI 专有错误码。
const EXTENSION_UI_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'TRUST_REQUIRED',
  'EXTENSION_DIALOG_NOT_FOUND'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const DIALOG_METHODS: readonly ExtensionDialogMethod[] = ['select', 'confirm', 'input', 'editor']

function isDialogMethod(value: unknown): value is ExtensionDialogMethod {
  return DIALOG_METHODS.includes(value as ExtensionDialogMethod)
}

const NOTIFY_TYPES: readonly string[] = ['info', 'warning', 'error']
const PLACEMENTS: readonly string[] = ['aboveEditor', 'belowEditor']

/** 字段字符上限只限制形状；内容语义由 Pi 侧给出，展示截断在投影层处理。 */
const MAX_TITLE_CHARS = 2_000
const MAX_TEXT_CHARS = 65_536
const MAX_OPTION_CHARS = 2_000
const MAX_KEY_CHARS = 256
const MAX_LIST_ITEMS = 128

/** 读取受控字符串数组；缺省返回空数组，条目超限返回 null。 */
function readStringArray(value: unknown, maxLength: number): readonly string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null
  const items: string[] = []
  for (const entry of value) {
    if (!isBoundedString(entry, maxLength)) return null
    items.push(entry)
  }
  return items
}

/** 读取可选字符串字段；缺省为 null，形状不符由调用方按整条丢弃处理。 */
function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  return isBoundedString(value, MAX_TEXT_CHARS) ? value : undefined
}

/**
 * 投影一条 `extension_ui_request`：按 method 拆出可展示对象。
 * 形状不符或字段超限返回 null，由调用方丢弃并计数。
 */
export function projectExtensionUiRequest(
  payload: Record<string, unknown>
): {
  readonly method: ExtensionUiMethod
  readonly id: string
  readonly dialog: ExtensionDialogRequest | null
  readonly notify: { readonly notifyType: ExtensionNotifyEntry['notifyType']; readonly message: string } | null
  readonly status: ExtensionStatusEntry | null
  readonly widget: ExtensionWidget | null
  readonly title: string | null
  readonly editorText: string | null
} | null {
  const id = payload.id
  if (!isBoundedString(id, MAX_KEY_CHARS) || id === '') return null
  const method = payload.method
  if (typeof method !== 'string') return null

  if (isDialogMethod(method)) {
    const title = payload.title === undefined
      ? ''
      : (isBoundedString(payload.title, MAX_TITLE_CHARS) ? payload.title : null)
    if (title === null) return null

    const options = method === 'select'
      ? readStringArray(payload.options, MAX_OPTION_CHARS)
      : []
    if (options === null) return null

    const message = method === 'confirm' ? readOptionalString(payload.message) : null
    if (message === undefined) return null

    const placeholder = method === 'input' ? readOptionalString(payload.placeholder) : null
    if (placeholder === undefined) return null

    const prefill = method === 'editor' ? readOptionalString(payload.prefill) : null
    if (prefill === undefined) return null

    const timeout = payload.timeout
    const timeoutMs = timeout === undefined || timeout === null
      ? null
      : (isCount(timeout) && timeout > 0 ? timeout : null)
    if (timeout !== undefined && timeout !== null && timeoutMs === null) return null

    return { method, id, dialog: { id, method, title, options, message, placeholder, prefill, timeoutMs }, notify: null, status: null, widget: null, title: null, editorText: null }
  }

  if (method === 'notify') {
    const message = readOptionalString(payload.message)
    if (message === undefined || message === null) return null
    const rawType = payload.notifyType === undefined ? 'info' : payload.notifyType
    if (typeof rawType !== 'string' || !NOTIFY_TYPES.includes(rawType)) return null
    return {
      method,
      id,
      dialog: null,
      notify: { notifyType: rawType as ExtensionNotifyEntry['notifyType'], message },
      status: null,
      widget: null,
      title: null,
      editorText: null
    }
  }

  if (method === 'setStatus') {
    const key = payload.statusKey
    if (!isBoundedString(key, MAX_KEY_CHARS) || key === '') return null
    if (payload.statusText !== undefined && payload.statusText !== null
      && !isBoundedString(payload.statusText, MAX_TEXT_CHARS)) return null
    // 官方语义：省略 statusText 表示清除该 key；投影用空字符串表达清除。
    const text = typeof payload.statusText === 'string' ? payload.statusText : ''
    return { method, id, dialog: null, notify: null, status: { key, text }, widget: null, title: null, editorText: null }
  }

  if (method === 'setWidget') {
    const placementRaw = payload.widgetPlacement === undefined ? 'aboveEditor' : payload.widgetPlacement
    if (typeof placementRaw !== 'string' || !PLACEMENTS.includes(placementRaw)) return null
    const lines = readStringArray(payload.widgetLines, MAX_TEXT_CHARS)
    if (lines === null) return null
    return {
      method,
      id,
      dialog: null,
      notify: null,
      status: null,
      widget: { placement: placementRaw as ExtensionWidgetPlacement, lines },
      title: null,
      editorText: null
    }
  }

  if (method === 'setTitle') {
    const title = readOptionalString(payload.title)
    if (title === undefined || title === null) return null
    return { method, id, dialog: null, notify: null, status: null, widget: null, title, editorText: null }
  }

  if (method === 'set_editor_text') {
    const text = readOptionalString(payload.text)
    if (text === undefined || text === null) return null
    return { method, id, dialog: null, notify: null, status: null, widget: null, title: null, editorText: text }
  }

  // 未知 method：不报错，由调用方丢弃并计数。
  return null
}

function isDialogRequest(value: unknown): value is ExtensionDialogRequest {
  if (!isRecord(value)) return false
  if (!isDialogMethod(value.method)) return false
  if (!isBoundedString(value.id, MAX_KEY_CHARS) || value.id === '') return false
  if (!isBoundedString(value.title, MAX_TITLE_CHARS)) return false
  if (!Array.isArray(value.options) || !value.options.every((option) => isBoundedString(option, MAX_OPTION_CHARS))) return false
  if (value.message !== null && !isBoundedString(value.message, MAX_TEXT_CHARS)) return false
  if (value.placeholder !== null && !isBoundedString(value.placeholder, MAX_TEXT_CHARS)) return false
  if (value.prefill !== null && !isBoundedString(value.prefill, MAX_TEXT_CHARS)) return false
  return value.timeoutMs === null || (isCount(value.timeoutMs) && value.timeoutMs > 0)
}

function isNotifyEntry(value: unknown): value is ExtensionNotifyEntry {
  if (!isRecord(value)) return false
  return isBoundedString(value.id, MAX_KEY_CHARS)
    && value.id !== ''
    && typeof value.notifyType === 'string'
    && NOTIFY_TYPES.includes(value.notifyType)
    && isBoundedString(value.message, MAX_TEXT_CHARS)
}

function isStatusEntry(value: unknown): value is ExtensionStatusEntry {
  if (!isRecord(value)) return false
  return isBoundedString(value.key, MAX_KEY_CHARS)
    && value.key !== ''
    && isBoundedString(value.text, MAX_TEXT_CHARS)
}

function isWidget(value: unknown): value is ExtensionWidget {
  if (!isRecord(value)) return false
  return typeof value.placement === 'string'
    && PLACEMENTS.includes(value.placement)
    && Array.isArray(value.lines)
    && value.lines.every((line) => isBoundedString(line, MAX_TEXT_CHARS))
}

function isExtensionUiState(value: unknown): value is ExtensionUiState {
  if (!isRecord(value)) return false
  if (value.runtimeId !== null && !(typeof value.runtimeId === 'number' && Number.isInteger(value.runtimeId))) return false
  if (!Array.isArray(value.dialogs) || !value.dialogs.every(isDialogRequest)) return false
  if (!Array.isArray(value.notifications) || !value.notifications.every(isNotifyEntry)) return false
  if (!Array.isArray(value.statuses) || !value.statuses.every(isStatusEntry)) return false
  if (!Array.isArray(value.widgets) || !value.widgets.every(isWidget)) return false
  if (value.editorText !== null && !isBoundedString(value.editorText, MAX_TEXT_CHARS)) return false
  return isCount(value.invalidCount)
}

/** 快照校验；跨进程返回与事件载荷都只放行本契约。 */
export function isExtensionUiSnapshot(value: unknown): value is ExtensionUiSnapshot {
  if (!isRecord(value)) return false
  if (value.runtimeId !== null && typeof value.runtimeId !== 'number') return false
  if (!isCount(value.seq)) return false
  return isExtensionUiState(value.state)
}

/** 事件载荷校验；契约不符时渲染端丢弃，由快照重同步。 */
export function isExtensionUiEvent(value: unknown): value is ExtensionUiSnapshot {
  return isExtensionUiSnapshot(value)
}

/** 响应提交结果校验；沙箱桥接只放行本契约。 */
export function isExtensionUiResult(value: unknown): value is ExtensionUiResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isExtensionUiSnapshot(value.data)

  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && EXTENSION_UI_ERROR_CODES.includes(code)
}

/** 只接受三种互斥响应形态之一；字段与 method 的匹配由主进程校验。 */
export function isExtensionDialogResponseInput(value: unknown): value is ExtensionDialogResponseInput {
  if (!isRecord(value)) return false
  if (value.kind === 'cancelled') return Object.keys(value).length === 1
  if (value.kind === 'value') {
    return Object.keys(value).length === 2
      && isBoundedString(value.value, MAX_TEXT_CHARS)
      && value.value !== ''
  }
  if (value.kind === 'confirm') {
    return Object.keys(value).length === 2 && typeof value.confirmed === 'boolean'
  }
  return false
}
