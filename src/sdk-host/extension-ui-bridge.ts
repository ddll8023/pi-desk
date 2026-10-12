/** SDK 扩展交互桥：持有可取消 Promise，按绑定隔离请求；回应只用于本次交互，不进入快照或日志。 */
import { randomUUID } from 'node:crypto'
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'
import { projectExtensionUiRequest } from '../shared/extension-ui-api'
import type { ExtensionDialogResponseInput } from '../shared/extension-ui-api'

interface PendingDialog {
  readonly method: 'select' | 'confirm' | 'input' | 'editor'
  readonly choices: ReadonlyMap<string, string> | null
  readonly settle: (response: ExtensionDialogResponseInput) => void
}
export interface ExtensionUiBridgeOptions {
  readonly bindingId: number
  readonly onRequest: (bindingId: number, payload: Record<string, unknown>) => void
  readonly onCancel: (bindingId: number, dialogId: string) => void
  readonly onWaitingChanged: () => void
  readonly onUnavailable: () => void
}
const MAX_DIALOGS = 8
const MAX_DISPLAY_CHARS = 4_000
/** 一次 notify 捕获最多保留的条数；只用于读取 MCP 状态，不影响通知列表。 */
const MAX_CAPTURED_NOTIFIES = 20

/** 展示文本只去除 ANSI 并截断；原始 select 值留在当前交互映射内。 */
function displayText(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').slice(0, MAX_DISPLAY_CHARS)
}

export class ExtensionUiBridge {
  readonly ui: ExtensionUIContext
  private readonly pending = new Map<string, PendingDialog>()
  private active = true
  private suspended = false
  private editorText = ''
  /** 一次性的 notify 文本捕获；非 null 时收到的 notify 副本也追加到该数组。 */
  private notifyCapture: string[] | null = null

  constructor(base: ExtensionUIContext, private readonly options: ExtensionUiBridgeOptions) {
    // 官方默认上下文保留 theme 和 TUI-only 的现有降级行为，不导入未公开的 SDK 深路径。
    this.ui = {
      ...base,
      select: async (title, choices, opts) => {
        const values = new Map(choices.map(value => [displayText(value), value]))
        if (values.size !== choices.length) throw this.unavailable('选项清洗后身份不唯一，无法安全显示。')
        const response = await this.dialog('select', { title: displayText(title), options: [...values.keys()] }, opts, values)
        return response.kind === 'value' ? values.get(response.value) : undefined
      },
      confirm: async (title, message, opts) => {
        const response = await this.dialog('confirm', { title: displayText(title), message: displayText(message) }, opts)
        return response.kind === 'confirm' && response.confirmed
      },
      input: async (title, placeholder, opts) => {
        const response = await this.dialog('input', { title: displayText(title), placeholder: displayText(placeholder ?? '') }, opts)
        return response.kind === 'value' ? response.value : undefined
      },
      editor: async (title, prefill) => {
        const response = await this.dialog('editor', { title: displayText(title), prefill: displayText(prefill ?? '') })
        return response.kind === 'value' ? response.value : undefined
      },
      notify: (message, type) => this.notify({ method: 'notify', message: displayText(message), notifyType: type ?? 'info' }),
      setStatus: (key, text) => this.notify({ method: 'setStatus', statusKey: key, statusText: displayText(text ?? '') }),
      setWidget: (key, content, opts) => {
        if (content === undefined || Array.isArray(content)) {
          this.notify({ method: 'setWidget', widgetKey: key, widgetLines: content?.map(displayText) ?? [],
            widgetPlacement: opts?.placement ?? 'aboveEditor' })
        }
      },
      setTitle: title => this.notify({ method: 'setTitle', title: displayText(title) }),
      setEditorText: text => {
        this.editorText = displayText(text)
        this.notify({ method: 'set_editor_text', text: this.editorText })
      },
      pasteToEditor: text => this.ui.setEditorText(text),
      getEditorText: () => this.editorText,
      // 没有桌面等价物的自定义 TUI 不能被当作已获批准的交互。
      custom: async () => { throw this.unavailable('桌面宿主不支持自定义 TUI 交互。') }
    }
  }

  /** 等待数供生命周期守门，不把没有 streaming 当成没有用户等待。 */
  get waitingCount(): number { return this.pending.size }

  /**
   * 开始一次性捕获 notify 文本，返回结束函数并交出捕获结果。
   * 捕获期间 notify 照常转发给页面（不抑制展示），只额外保留副本供调用方读取。
   */
  beginNotifyCapture(): () => readonly string[] {
    const capture: string[] = []
    this.notifyCapture = capture
    return () => {
      if (this.notifyCapture === capture) this.notifyCapture = null
      return capture
    }
  }

  /** 只允许对应绑定的回应解除原 Promise；选择值必须属于当前候选。 */
  respond(bindingId: number, dialogId: string, response: ExtensionDialogResponseInput): boolean {
    if (!this.active || bindingId !== this.options.bindingId) return false
    const dialog = this.pending.get(dialogId)
    if (dialog === undefined) return false
    if (response.kind === 'confirm' && dialog.method !== 'confirm') return false
    if (response.kind === 'value' && (dialog.method === 'confirm'
      || (dialog.choices !== null && !dialog.choices.has(response.value)))) return false
    dialog.settle(response)
    return true
  }

  /** 中止解除实际等待；关闭期间新交互直接按取消值结束，不挂在退出任务后面。 */
  cancelPending(suspend = false): void {
    if (suspend) this.suspended = true
    for (const dialog of [...this.pending.values()]) dialog.settle({ kind: 'cancelled' })
  }

  /** 会话失效后旧 UI 引用既不能新发请求，也不能回应新绑定。 */
  invalidate(): void {
    this.active = false
    this.notifyCapture = null
    this.cancelPending(true)
    this.editorText = ''
  }

  /** 必要交互无法表达时通知执行所有者，不能让 SDK 将审批异常当成继续执行的许可。 */
  private unavailable(message: string): Error {
    this.options.onUnavailable()
    return new Error(message)
  }

  /** 展示更新没有回应 Promise，且只允许既有子协议支持的安全字段。 */
  private notify(payload: Record<string, unknown>): void {
    if (!this.active || this.suspended) return
    const message = { ...payload, id: randomUUID() }
    if (projectExtensionUiRequest(message) === null) return
    if (this.notifyCapture !== null && payload.method === 'notify' && typeof payload.message === 'string'
      && this.notifyCapture.length < MAX_CAPTURED_NOTIFIES) {
      this.notifyCapture.push(payload.message)
    }
    this.options.onRequest(this.options.bindingId, message)
  }

  /** 安装 signal、计时与等待记录后才发送，已中止或关闭的交互绝不再挂起。 */
  private dialog(
    method: PendingDialog['method'], payload: Record<string, unknown>, opts?: ExtensionUIDialogOptions,
    choices: ReadonlyMap<string, string> | null = null
  ): Promise<ExtensionDialogResponseInput> {
    if (!this.active || this.suspended || opts?.signal?.aborted) return Promise.resolve({ kind: 'cancelled' })
    if (this.pending.size >= MAX_DIALOGS) return Promise.reject(this.unavailable('扩展交互数量超过上限。'))
    const id = randomUUID()
    const timeout = opts?.timeout
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647)) {
      return Promise.reject(this.unavailable('扩展交互等待期限无效。'))
    }
    const request = { id, method, ...payload, ...(timeout === undefined ? {} : { timeout }) }
    if (projectExtensionUiRequest(request) === null) return Promise.reject(this.unavailable('扩展交互载荷无效。'))
    return new Promise(resolvePromise => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = (): void => settle({ kind: 'cancelled' })
      const settle = (response: ExtensionDialogResponseInput): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
        this.options.onCancel(this.options.bindingId, id)
        this.options.onWaitingChanged()
        resolvePromise(response)
      }
      this.pending.set(id, { method, choices, settle })
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      if (timeout !== undefined) timer = setTimeout(onAbort, timeout)
      this.options.onWaitingChanged()
      if (!settled) this.options.onRequest(this.options.bindingId, request)
    })
  }
}
