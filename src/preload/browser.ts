/** 浏览器受限桥接：截图、元素选择与取消，以及受管实例登记与独占控制权桥接，结果经契约校验。 */
import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  BROWSER_CANCEL_PICK_CHANNEL,
  BROWSER_CAPTURE_CHANNEL,
  BROWSER_PICK_ELEMENT_CHANNEL,
  isBrowserCaptureResult,
  isBrowserElementPickResult
} from '../shared/browser-api'
import type { BrowserCaptureApi } from '../shared/browser-api'
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
  BROWSER_AUTO_ATTACH_EVENT,
  isBrowserActionResult,
  isBrowserAutoAttachPayload,
  isBrowserBindResult,
  isBrowserContentResult,
  isBrowserControlState,
  isBrowserOperationResult,
  isBrowserRegisterResult,
  isBrowserSnapshotResult
} from '../shared/browser-session-api'
import type { BrowserSessionApi } from '../shared/browser-session-api'

export const browserApi: BrowserCaptureApi & BrowserSessionApi = {
  async captureBrowser(webContentsId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_CAPTURE_CHANNEL, webContentsId)
    return isBrowserCaptureResult(result) ? result : { ok: false, error: '浏览器截图返回了无法识别的结果。' }
  },
  async pickBrowserElement(webContentsId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_PICK_ELEMENT_CHANNEL, webContentsId)
    return isBrowserElementPickResult(result) ? result : { ok: false, error: '元素选择返回了无法识别的结果。' }
  },
  async cancelBrowserElementPick(webContentsId) {
    await ipcRenderer.invoke(BROWSER_CANCEL_PICK_CHANNEL, webContentsId)
  },
  async registerBrowserInstance(registration) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_REGISTER_INSTANCE_CHANNEL, registration)
    return isBrowserRegisterResult(result) ? result : { ok: false, error: '实例登记返回了无法识别的结果。' }
  },
  async unregisterBrowserInstance(instanceId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_UNREGISTER_INSTANCE_CHANNEL, instanceId)
    return isBrowserOperationResult(result) ? result : { ok: false, error: '实例注销返回了无法识别的结果。' }
  },
  async bindBrowserSession(request) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_BIND_SESSION_CHANNEL, request)
    return isBrowserBindResult(result) ? result : { ok: false, error: '会话绑定返回了无法识别的结果。' }
  },
  async releaseBrowserSession(instanceId, sessionId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_RELEASE_SESSION_CHANNEL, instanceId, sessionId)
    return isBrowserOperationResult(result) ? result : { ok: false, error: '会话解绑返回了无法识别的结果。' }
  },
  async takeoverBrowser(instanceId, reason) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_TAKEOVER_CHANNEL, instanceId, reason)
    return isBrowserOperationResult(result) ? result : { ok: false, error: '人工接管返回了无法识别的结果。' }
  },
  async resumeBrowser(instanceId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_RESUME_CHANNEL, instanceId)
    return isBrowserOperationResult(result) ? result : { ok: false, error: '恢复控制返回了无法识别的结果。' }
  },
  async queryBrowserState(instanceId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_QUERY_STATE_CHANNEL, instanceId)
    return isBrowserControlState(result) ? result : null
  },
  async takeBrowserSnapshot(instanceId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_TAKE_SNAPSHOT_CHANNEL, instanceId)
    return isBrowserSnapshotResult(result) ? result : { ok: false, error: '页面快照返回了无法识别的结果。' }
  },
  async getBrowserContent(instanceId) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_GET_CONTENT_CHANNEL, instanceId)
    return isBrowserContentResult(result) ? result : { ok: false, error: '正文提取返回了无法识别的结果。' }
  },
  async dispatchBrowserAction(request) {
    const result: unknown = await ipcRenderer.invoke(BROWSER_DISPATCH_ACTION_CHANNEL, request)
    return isBrowserActionResult(result) ? result : { ok: false, error: '动作执行返回了无法识别的结果。' }
  },
  onBrowserAutoAttach(listener) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (isBrowserAutoAttachPayload(payload)) listener(payload)
    }
    ipcRenderer.on(BROWSER_AUTO_ATTACH_EVENT, handler)
    return () => {
      ipcRenderer.removeListener(BROWSER_AUTO_ATTACH_EVENT, handler)
    }
  }
}
