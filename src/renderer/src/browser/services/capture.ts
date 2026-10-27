/** 内置浏览器截图、元素选择与取消调用：保留桥接失败原因，不向网页暴露主进程能力。 */
import type { BrowserCaptureResult, BrowserElementPickResult } from '../../../../shared/browser-api'

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
