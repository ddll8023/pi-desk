/**
 * 维护当前 Runtime 代际的 Extension UI 状态：dialog 请求队列、通知、状态条、widget 与编辑器填充文本。
 *
 * 只消费已分类的 `extension_ui_request` 记录与页面提交的 dialog 响应，按代际持有状态并广播快照；
 * 并为读取 MCP 状态提供一次性的 notify 文本捕获（捕获期间仍照常进入通知列表）；
 * 不持有进程，不解析其他记录族，dialog 响应写回由 RuntimeManager 借用其串行写入。随 Runtime 退出
 * 或切换清空，不持久化。`setTitle` 无桌面等价物，只计数不展示。
 */
import type {
  ExtensionDialogRequest,
  ExtensionDialogResponseInput,
  ExtensionNotifyEntry,
  ExtensionUiSnapshot,
  ExtensionUiState,
  ExtensionWidget
} from '../shared/extension-ui-api'
import { projectExtensionUiRequest } from '../shared/extension-ui-api'

/** 通知列表条数上限；超出丢弃最旧条目。 */
const MAX_NOTIFICATIONS = 10
/** 单条通知与状态、widget 行文本的上限；超出截断并如实使用截断文本。 */
const MAX_TEXT_CHARS = 4_000
/** status 条目数上限；超出丢弃最旧 key。 */
const MAX_STATUSES = 16
/** 每侧 widget 数量上限；官方语义每侧一个，超出丢弃最旧。 */
const MAX_WIDGETS_PER_PLACEMENT = 4
/** dialog 队列上限：防止异常 Extension 无限叠加请求。 */
const MAX_DIALOGS = 8
/** 一次 notify 捕获最多保留的条数；只用于读取 `/mcp` 状态，不影响通知列表。 */
const MAX_CAPTURED_NOTIFIES = 20

interface MutableDialog {
  readonly id: string
  readonly method: ExtensionDialogRequest['method']
  readonly title: string
  readonly options: readonly string[]
  readonly message: string | null
  readonly placeholder: string | null
  readonly prefill: string | null
  readonly timeoutMs: number | null
}

interface ExtensionUiCallbacks {
  /** 状态变化后的快照广播；由 RuntimeManager 接线到窗口。 */
  readonly onSnapshot: (snapshot: ExtensionUiSnapshot) => void
  /** dialog 响应写回；由 RuntimeManager 提供 Pi 管道写入。 */
  readonly onDialogResponse: (response: Record<string, unknown>) => void
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

export class ExtensionUiManager {
  private runtimeId: number | null = null
  private seq = 0
  private dialogs: MutableDialog[] = []
  private notifications: ExtensionNotifyEntry[] = []
  private statuses = new Map<string, string>()
  private widgets = new Map<string, ExtensionWidget>()
  private editorText: string | null = null
  private invalidCount = 0
  private notifySeed = 0
  private disposed = false
  /** 一次性的 notify 文本捕获；非 null 时收到的 notify 副本也追加到该数组。 */
  private notifyCapture: string[] | null = null

  constructor(private readonly callbacks: ExtensionUiCallbacks) {}

  /** 开始新代际：清空上一代际全部状态；序号继续递增，渲染端按序丢弃旧快照。 */
  beginGeneration(runtimeId: number | null): void {
    this.disposed = false
    this.runtimeId = runtimeId
    this.dialogs = []
    this.notifications = []
    this.statuses = new Map()
    this.widgets = new Map()
    this.editorText = null
    this.invalidCount = 0
    this.notifyCapture = null
    this.publish()
  }

  /**
   * 开始一次性捕获 notify 文本，返回结束函数并交出捕获结果。
   * 捕获期间 notify 照常进入快照与广播（不抑制展示），只额外保留副本供调用方读取；
   * 代际切换或 dispose 会丢弃未结束的捕获。
   */
  beginNotifyCapture(): () => readonly string[] {
    const capture: string[] = []
    this.notifyCapture = capture
    return () => {
      if (this.notifyCapture === capture) this.notifyCapture = null
      return [...capture]
    }
  }

  /** Runtime 代际结束：清空状态并发布空快照，之后的请求不再受理。 */
  dispose(): void {
    this.disposed = true
    this.beginGeneration(null)
  }

  /** 应用一条 `extension_ui_request` 记录；形状不符或未知 method 只计数。 */
  applyRequest(payload: Record<string, unknown>): void {
    if (this.disposed || this.runtimeId === null) return
    const projected = projectExtensionUiRequest(payload)
    if (projected === null) {
      this.invalidCount += 1
      this.publish()
      return
    }

    if (projected.dialog !== null) {
      if (this.dialogs.length >= MAX_DIALOGS) {
        this.invalidCount += 1
        this.publish()
        return
      }
      // 同 id 重复投递按一次处理。
      if (this.dialogs.some((dialog) => dialog.id === projected.id)) return
      this.dialogs.push(projected.dialog)
      this.publish()
      return
    }

    if (projected.notify !== null) {
      this.notifySeed += 1
      const message = truncate(projected.notify.message, MAX_TEXT_CHARS)
      this.notifications.push({
        id: `ext-notify-${this.notifySeed}`,
        notifyType: projected.notify.notifyType,
        message
      })
      if (this.notifications.length > MAX_NOTIFICATIONS) this.notifications.shift()
      if (this.notifyCapture !== null && this.notifyCapture.length < MAX_CAPTURED_NOTIFIES) {
        this.notifyCapture.push(message)
      }
      this.publish()
      return
    }

    if (projected.status !== null) {
      const { key, text } = projected.status
      if (text === '') {
        this.statuses.delete(key)
      } else {
        this.statuses.delete(key)
        this.statuses.set(key, truncate(text, MAX_TEXT_CHARS))
        while (this.statuses.size > MAX_STATUSES) {
          const oldest = this.statuses.keys().next().value
          if (oldest === undefined) break
          this.statuses.delete(oldest)
          this.invalidCount += 1
        }
      }
      this.publish()
      return
    }

    if (projected.widget !== null) {
      const { placement, lines } = projected.widget
      const key = placement
      if (lines.length === 0) {
        this.widgets.delete(key)
      } else {
        const widget: ExtensionWidget = {
          placement,
          lines: lines.map((line) => truncate(line, MAX_TEXT_CHARS))
        }
        this.widgets.delete(key)
        this.widgets.set(key, widget)
        while (this.widgets.size > MAX_WIDGETS_PER_PLACEMENT * 2) {
          const oldest = this.widgets.keys().next().value
          if (oldest === undefined) break
          this.widgets.delete(oldest)
          this.invalidCount += 1
        }
      }
      this.publish()
      return
    }

    if (projected.editorText !== null) {
      this.editorText = truncate(projected.editorText, MAX_TEXT_CHARS)
      this.publish()
      return
    }

    // `setTitle` 没有桌面等价物：作为已识别的有效记录处理，不更新任何展示状态。
  }

  /**
   * 提交 dialog 响应：id 必须在队列中，响应形态必须与 method 匹配。
   * 校验通过即出队并把 wire 响应交给回调写回 Pi；写回失败由管道关闭路径收敛。
   */
  respond(
    dialogId: string,
    response: ExtensionDialogResponseInput
  ): { ok: true; snapshot: ExtensionUiSnapshot } | { ok: false; message: string } {
    if (this.disposed) {
      return { ok: false, message: '没有活动 Runtime，无法回应 Extension 对话。' }
    }
    const index = this.dialogs.findIndex((dialog) => dialog.id === dialogId)
    if (index < 0) {
      return { ok: false, message: '该 Extension 对话已结束或不存在。' }
    }
    const dialog = this.dialogs[index]
    if (dialog === undefined) {
      return { ok: false, message: '该 Extension 对话已结束或不存在。' }
    }

    const acceptsValue = dialog.method === 'select' || dialog.method === 'input' || dialog.method === 'editor'
    if (response.kind === 'value' && !acceptsValue) {
      return { ok: false, message: '该对话不接受文本值。' }
    }
    if (response.kind === 'confirm' && dialog.method !== 'confirm') {
      return { ok: false, message: '只有确认对话接受确认响应。' }
    }

    let wire: Record<string, unknown>
    if (response.kind === 'cancelled') {
      wire = { type: 'extension_ui_response', id: dialog.id, cancelled: true }
    } else if (response.kind === 'confirm') {
      wire = { type: 'extension_ui_response', id: dialog.id, confirmed: response.confirmed }
    } else {
      wire = { type: 'extension_ui_response', id: dialog.id, value: response.value }
    }

    this.dialogs.splice(index, 1)
    this.callbacks.onDialogResponse(wire)
    this.publish()
    return { ok: true, snapshot: this.snapshot() }
  }

  /** 当前快照；无代际时 runtimeId 为 null 且状态为空。 */
  snapshot(): ExtensionUiSnapshot {
    const state: ExtensionUiState = {
      runtimeId: this.runtimeId,
      dialogs: this.dialogs.map((dialog) => ({ ...dialog })),
      notifications: [...this.notifications],
      statuses: [...this.statuses].map(([key, text]) => ({ key, text })),
      widgets: [...this.widgets.values()],
      editorText: this.editorText,
      invalidCount: this.invalidCount
    }
    return { runtimeId: this.runtimeId, seq: this.seq, state }
  }

  /** 已应用的最高序号；供渲染端判断过期快照。 */
  get currentSeq(): number {
    return this.seq
  }

  private publish(): void {
    this.seq += 1
    this.callbacks.onSnapshot(this.snapshot())
  }
}
