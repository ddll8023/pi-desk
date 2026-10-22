/** 应用外壳的 IPC：应用信息（版本、平台、打包状态）与受控外链打开。外链只接受 http(s)；协议与凭据检查都在主进程，页面不能传入任意系统协议。 */

import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  APP_INFO_CHANNEL,
  OPEN_EXTERNAL_URL_CHANNEL,
  isOpenExternalUrlRequest
} from '../../shared/desktop-api'
import type { AppInfoResult, OpenExternalUrlResult } from '../../shared/desktop-api'
import { ExternalUrlError, openDocumentUrl } from '../shared/external-url'
import { handle, isTrustedCaller } from '../ipc/dispatch'

export function registerAppInfoHandler(pageUrl: string): void {
  handle(APP_INFO_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): AppInfoResult => {
    if (!isTrustedCaller(event, pageUrl)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
    }
    if (args.length !== 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '应用信息接口不接受参数。' } }
    }
    try {
      return {
        ok: true,
        data: {
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          platform: process.platform,
          arch: process.arch
        }
      }
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '暂时无法取得应用信息。' } }
    }
  })
}

/**
 * 外链打开：只接受一个 http(s) 地址。文件预览里的链接来自项目文件本身，因此不限定域名，
 * 但协议、长度与内嵌凭据由 `openDocumentUrl` 统一校验，失败原因直接回给页面。
 */
export function registerOpenExternalUrlHandler(pageUrl: string): void {
  handle(
    OPEN_EXTERNAL_URL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<OpenExternalUrlResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isOpenExternalUrlRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '外链打开只接受一个地址请求。' } }
      }
      try {
        await openDocumentUrl(args[0].url)
        return { ok: true }
      } catch (error) {
        const message = error instanceof ExternalUrlError
          ? error.message
          : '无法在系统浏览器中打开该地址。'
        return { ok: false, error: { code: 'INVALID_REQUEST', message } }
      }
    }
  )
}
