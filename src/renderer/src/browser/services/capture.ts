/** 内置浏览器截图、元素选择与取消，以及受管实例登记与独占控制权调用：保留桥接失败原因，不向网页暴露主进程能力。 */
import type { BrowserCaptureResult, BrowserElementPickResult } from '../../../../shared/browser-api'
import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAutoAttachPayload,
  BrowserBindRequest,
  BrowserBindResult,
  BrowserContentResult,
  BrowserControlState,
  BrowserInstanceRegistration,
  BrowserOperationResult,
  BrowserRegisterResult,
  BrowserSnapshotResult
} from '../../../../shared/browser-session-api'

export async function captureBrowser(webContentsId: number): Promise<BrowserCaptureResult> {
  if (!window.desktop) return { ok: false, error: '桌面截图接口不可用。' }
  try {
    return await window.desktop.captureBrowser(webContentsId)
  } catch (error) {
    return { ok: false, error: `桌面截图调用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function pickBrowserElement(webContentsId: number): Promise<BrowserElementPickResult> {
  if (!window.desktop) return { ok: false, error: '桌面元素选择接口不可用。' }
  try {
    return await window.desktop.pickBrowserElement(webContentsId)
  } catch (error) {
    return { ok: false, error: `元素选择调用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function cancelBrowserElementPick(webContentsId: number): Promise<void> {
  if (!window.desktop) return
  await window.desktop.cancelBrowserElementPick(webContentsId)
}

export async function registerBrowserInstance(
  registration: BrowserInstanceRegistration
): Promise<BrowserRegisterResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.registerBrowserInstance(registration)
  } catch (error) {
    return { ok: false, error: `浏览器实例登记失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function unregisterBrowserInstance(instanceId: string): Promise<BrowserOperationResult> {
  if (!window.desktop) return { ok: true }
  try {
    return await window.desktop.unregisterBrowserInstance(instanceId)
  } catch (error) {
    return { ok: false, error: `浏览器实例注销失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function bindBrowserSession(request: BrowserBindRequest): Promise<BrowserBindResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.bindBrowserSession(request)
  } catch (error) {
    return { ok: false, error: `会话绑定失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function releaseBrowserSession(
  instanceId: string,
  sessionId: string
): Promise<BrowserOperationResult> {
  if (!window.desktop) return { ok: true }
  try {
    return await window.desktop.releaseBrowserSession(instanceId, sessionId)
  } catch (error) {
    return { ok: false, error: `会话解绑失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function takeoverBrowser(instanceId: string, reason?: string): Promise<BrowserOperationResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.takeoverBrowser(instanceId, reason)
  } catch (error) {
    return { ok: false, error: `人工接管失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function resumeBrowser(instanceId: string): Promise<BrowserOperationResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.resumeBrowser(instanceId)
  } catch (error) {
    return { ok: false, error: `恢复控制失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function queryBrowserState(instanceId: string): Promise<BrowserControlState | null> {
  if (!window.desktop) return null
  try {
    return await window.desktop.queryBrowserState(instanceId)
  } catch {
    return null
  }
}

export async function takeBrowserSnapshot(instanceId: string): Promise<BrowserSnapshotResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.takeBrowserSnapshot(instanceId)
  } catch (error) {
    return { ok: false, error: `获取页面快照失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function getBrowserContent(instanceId: string): Promise<BrowserContentResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.getBrowserContent(instanceId)
  } catch (error) {
    return { ok: false, error: `获取页面正文失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function dispatchBrowserAction(request: BrowserActionRequest): Promise<BrowserActionResult> {
  if (!window.desktop) return { ok: false, error: '桌面浏览器接口不可用。' }
  try {
    return await window.desktop.dispatchBrowserAction(request)
  } catch (error) {
    return { ok: false, error: `派发交互动作失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 监听主进程派发的受管浏览器自动唤起与分屏绑定事件；返回取消订阅回调。 */
export function onBrowserAutoAttach(
  listener: (payload: BrowserAutoAttachPayload) => void
): () => void {
  if (!window.desktop) return () => {}
  return window.desktop.onBrowserAutoAttach(listener)
}
