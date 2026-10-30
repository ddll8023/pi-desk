/** 内置浏览器截图与元素选择：只允许可信主窗口操作其所属的受限 webview。 */
import { webContents } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import {
  BROWSER_CANCEL_PICK_CHANNEL,
  BROWSER_CAPTURE_CHANNEL,
  BROWSER_PICK_ELEMENT_CHANNEL,
  isBrowserElementContext
} from '../../shared/browser-api'
import type { BrowserCaptureResult, BrowserElementPickResult } from '../../shared/browser-api'
import {
  BROWSER_BIND_SESSION_CHANNEL,
  BROWSER_DISPATCH_ACTION_CHANNEL,
  BROWSER_GET_CONTENT_CHANNEL,
  BROWSER_QUERY_STATE_CHANNEL,
  BROWSER_REGISTER_INSTANCE_CHANNEL,
  BROWSER_RELEASE_SESSION_CHANNEL,
  BROWSER_RESUME_CHANNEL,
  BROWSER_TAKE_SNAPSHOT_CHANNEL,
  BROWSER_TAKEOVER_CHANNEL,
  BROWSER_UNREGISTER_INSTANCE_CHANNEL,
  isBrowserActionRequest,
  isBrowserBindRequest,
  isBrowserInstanceRegistration
} from '../../shared/browser-session-api'
import type {
  BrowserActionResult,
  BrowserBindResult,
  BrowserContentResult,
  BrowserControlState,
  BrowserOperationResult,
  BrowserRegisterResult,
  BrowserSnapshotResult
} from '../../shared/browser-session-api'
import { browserSessionService } from '../services'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { ELEMENT_PICKER_CANCEL, ELEMENT_PICKER_CHECK, ELEMENT_PICKER_START, ELEMENT_PICKER_WORLD } from './element-picker'

interface PickOperation { cancelled: boolean }
const picking = new Map<number, PickOperation>()

/** 不能凭页面提交的 ID 访问其他窗口或普通 webContents。 */
function browserTarget(event: IpcMainInvokeEvent, args: unknown[], pageUrl: string): WebContents | null {
  if (!isTrustedCaller(event, pageUrl)) return null
  const id = args[0]
  if (args.length !== 1 || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null
  const target = webContents.fromId(id)
  return target && !target.isDestroyed() && target.getType() === 'webview' && target.hostWebContents === event.sender
    ? target : null
}

async function pickerScript(target: WebContents, code: string): Promise<unknown> {
  return target.executeJavaScriptInIsolatedWorld(ELEMENT_PICKER_WORLD, [{ code }])
}

async function cancelPick(target: WebContents): Promise<void> {
  const operation = picking.get(target.id)
  if (!operation) return
  operation.cancelled = true
  if (!target.isDestroyed()) {
    try { await pickerScript(target, ELEMENT_PICKER_CANCEL) } catch { /* 导航或销毁也会结束页面内监听。 */ }
  }
}

export function registerBrowserHandlers(pageUrl: string): void {
  handle(BROWSER_CAPTURE_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserCaptureResult> => {
    const target = browserTarget(event, args, pageUrl)
    if (!target) return { ok: false, error: '浏览器页面不存在、参数无效或不属于当前窗口。' }
    try {
      const image = await target.capturePage()
      if (target.isDestroyed() || image.isEmpty()) return { ok: false, error: '网页截图为空或页面已关闭。' }
      return { ok: true, dataUrl: image.toDataURL() }
    } catch (error) {
      return { ok: false, error: `网页截图失败：${error instanceof Error ? error.message : String(error)}` }
    }
  })

  handle(BROWSER_CANCEL_PICK_CHANNEL, async (event, ...args: unknown[]): Promise<void> => {
    const target = browserTarget(event, args, pageUrl)
    if (target) await cancelPick(target)
  })

  handle(BROWSER_PICK_ELEMENT_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserElementPickResult> => {
    const target = browserTarget(event, args, pageUrl)
    if (!target) return { ok: false, error: '浏览器页面不存在、参数无效或不属于当前窗口。' }
    if (picking.has(target.id)) return { ok: false, error: '当前页面已有元素选取操作。' }
    const operation: PickOperation = { cancelled: false }
    picking.set(target.id, operation)
    const cancelForNavigation = (): void => { void cancelPick(target) }
    target.on('did-start-navigation', cancelForNavigation)
    target.on('destroyed', cancelForNavigation)
    try {
      const selected = await pickerScript(target, ELEMENT_PICKER_START)
      if (operation.cancelled || target.isDestroyed()) return { ok: false, error: '元素选择已取消。', cancelled: true }
      if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
        return { ok: false, error: '网页返回了无法识别的元素信息。' }
      }
      const result = selected as Record<string, unknown>
      if (result.ok === false) return { ok: false, error: typeof result.error === 'string' ? result.error : '元素选择失败。', cancelled: result.cancelled === true }
      if (result.ok !== true || !isBrowserElementContext(result.element)) return { ok: false, error: '网页返回了无效的元素信息。' }
      const image = await target.capturePage()
      if (operation.cancelled || target.isDestroyed()) return { ok: false, error: '元素选择已取消。', cancelled: true }
      const comparison = await target.capturePage()
      if (operation.cancelled || target.isDestroyed()) return { ok: false, error: '元素选择已取消。', cancelled: true }
      const unchanged = await pickerScript(target, ELEMENT_PICKER_CHECK)
      if (operation.cancelled || unchanged !== true || image.isEmpty() || comparison.isEmpty()
        || !image.toPNG().equals(comparison.toPNG())) return { ok: false, error: '采集期间页面发生变化，请重新选择。' }
      return { ok: true, dataUrl: image.toDataURL(), element: result.element }
    } catch (error) {
      return operation.cancelled
        ? { ok: false, error: '元素选择已取消。', cancelled: true }
        : { ok: false, error: `元素选择失败：${error instanceof Error ? error.message : String(error)}` }
    } finally {
      target.removeListener('did-start-navigation', cancelForNavigation)
      target.removeListener('destroyed', cancelForNavigation)
      if (!target.isDestroyed()) {
        try { await pickerScript(target, ELEMENT_PICKER_CANCEL) } catch { /* 页面已导航时无遗留监听。 */ }
      }
      if (picking.get(target.id) === operation) picking.delete(target.id)
    }
  })

  handle(BROWSER_REGISTER_INSTANCE_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserRegisterResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const payload = args[0]
    if (!isBrowserInstanceRegistration(payload)) return { ok: false, error: '实例登记参数不符合契约。' }
    return browserSessionService.registerInstance(payload, event.sender)
  })

  handle(BROWSER_UNREGISTER_INSTANCE_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserOperationResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const instanceId = args[0]
    if (typeof instanceId !== 'string' || !instanceId) return { ok: false, error: '实例标识无效。' }
    return browserSessionService.unregisterInstance(instanceId)
  })

  handle(BROWSER_BIND_SESSION_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserBindResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const payload = args[0]
    if (!isBrowserBindRequest(payload)) return { ok: false, error: '会话绑定参数不符合契约。' }
    return browserSessionService.bindSession(payload)
  })

  handle(BROWSER_RELEASE_SESSION_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserOperationResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const [instanceId, sessionId] = args
    if (typeof instanceId !== 'string' || typeof sessionId !== 'string') return { ok: false, error: '解绑参数无效。' }
    return browserSessionService.releaseSession(instanceId, sessionId)
  })

  handle(BROWSER_TAKEOVER_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserOperationResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const [instanceId, reason] = args
    if (typeof instanceId !== 'string') return { ok: false, error: '实例标识无效。' }
    const optReason = typeof reason === 'string' ? reason : undefined
    return browserSessionService.takeover(instanceId, optReason)
  })

  handle(BROWSER_RESUME_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserOperationResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const instanceId = args[0]
    if (typeof instanceId !== 'string') return { ok: false, error: '实例标识无效。' }
    return browserSessionService.resume(instanceId)
  })

  handle(BROWSER_QUERY_STATE_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserControlState | null> => {
    if (!isTrustedCaller(event, pageUrl)) return null
    const instanceId = args[0]
    if (typeof instanceId !== 'string') return null
    return browserSessionService.queryControlState(instanceId)
  })

  handle(BROWSER_TAKE_SNAPSHOT_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserSnapshotResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const instanceId = args[0]
    if (typeof instanceId !== 'string' || !instanceId) return { ok: false, error: '实例标识无效。' }
    return browserSessionService.takeSnapshot(instanceId)
  })

  handle(BROWSER_GET_CONTENT_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserContentResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const instanceId = args[0]
    if (typeof instanceId !== 'string' || !instanceId) return { ok: false, error: '实例标识无效。' }
    return browserSessionService.getContent(instanceId)
  })

  handle(BROWSER_DISPATCH_ACTION_CHANNEL, async (event, ...args: unknown[]): Promise<BrowserActionResult> => {
    if (!isTrustedCaller(event, pageUrl)) return { ok: false, error: '非受信任调用来源。' }
    const payload = args[0]
    if (!isBrowserActionRequest(payload)) return { ok: false, error: '动作请求参数不符合契约。' }
    return browserSessionService.dispatchAction(payload)
  })
}
