/** 为沙箱页面提供只读应用信息与 Runtime 启动方法，不暴露 Electron、任意 channel 或系统能力。 */
import { contextBridge, ipcRenderer } from 'electron'
import { APP_INFO_CHANNEL, isAppInfoResult } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import {
  RUNTIME_START_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  isRuntimeResult
} from '../shared/runtime-api'
import type { RuntimeApi, RuntimeResult, RuntimeStartRequest } from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'

function invalidRuntimeResponse(): RuntimeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RUNTIME_RESPONSE } }
}

const desktop: DesktopApi & RuntimeApi = {
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

  async startRuntime(projectPath: string) {
    const request: RuntimeStartRequest = { projectPath }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_START_CHANNEL, request)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async getRuntimeStatus() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_STATUS_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
