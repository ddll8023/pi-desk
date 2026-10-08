/** 为沙箱页面提供唯一只读桌面方法，不暴露 Electron、任意 channel 或系统能力。 */
import { contextBridge, ipcRenderer } from 'electron'
import { APP_INFO_CHANNEL, isAppInfoResult } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'

const desktop: DesktopApi = {
  async getAppInfo() {
    const response: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL)
    if (!isAppInfoResult(response)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的应用信息。' }
      }
    }
    return response
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
