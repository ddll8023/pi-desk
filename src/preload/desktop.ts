/** 应用信息与外链打开：preload 的 desktop 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { APP_INFO_CHANNEL, OPEN_EXTERNAL_URL_CHANNEL, isAppInfoResult, isOpenExternalUrlResult } from '../shared/desktop-api'
import type { OpenExternalUrlRequest, OpenExternalUrlResult } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'

export const desktopApi = {
  async getAppInfo() {
    const response: unknown = await ipcRenderer.invoke(APP_INFO_CHANNEL)
    if (!isAppInfoResult(response)) {
      return {
        ok: false,
        error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的应用信息。' }
      }
    }
    return response
  },

  async openExternalUrl(request: OpenExternalUrlRequest): Promise<OpenExternalUrlResult> {
    const payload: OpenExternalUrlRequest = { url: request.url }
    const response: unknown = await ipcRenderer.invoke(OPEN_EXTERNAL_URL_CHANNEL, payload)
    return isOpenExternalUrlResult(response)
      ? response
      : { ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的外链打开结果。' } }
  }
} satisfies DesktopApi
