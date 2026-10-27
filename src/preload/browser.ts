/** 浏览器受限桥接：截图、元素选择与取消只传递 webview 标识，截图与元素结果经契约校验。 */
import { ipcRenderer } from 'electron'
import { BROWSER_CANCEL_PICK_CHANNEL, BROWSER_CAPTURE_CHANNEL, BROWSER_PICK_ELEMENT_CHANNEL, isBrowserCaptureResult, isBrowserElementPickResult } from '../shared/browser-api'
import type { BrowserCaptureApi } from '../shared/browser-api'

export const browserApi: BrowserCaptureApi = {
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
  }
}
