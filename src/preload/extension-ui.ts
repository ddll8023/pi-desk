/** Extension UI：preload 的 extension-ui 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  EXTENSION_UI_RESPOND_CHANNEL,
  EXTENSION_UI_STATE_CHANNEL,
  EXTENSION_UI_EVENT,
  isExtensionDialogResponseInput,
  isExtensionUiEvent,
  isExtensionUiResult
} from '../shared/extension-ui-api'
import type {
  ExtensionDialogResponseInput,
  ExtensionUiApi,
  ExtensionUiResult,
  ExtensionUiSnapshot
} from '../shared/extension-ui-api'

const INVALID_EXTENSION_UI_RESPONSE = '桌面接口返回了无法识别的 Extension UI 状态。'

function invalidExtensionUiResponse(): ExtensionUiResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_EXTENSION_UI_RESPONSE } }
}

export const extensionUiApi = {
  async getExtensionUiState(runId: number) {
    const response: unknown = await ipcRenderer.invoke(EXTENSION_UI_STATE_CHANNEL, runId)
    return isExtensionUiResult(response) ? response : invalidExtensionUiResponse()
  },

  async respondExtensionDialog(
    target: { readonly runId: number; readonly runtimeId: number },
    dialogId: string,
    response: ExtensionDialogResponseInput
  ) {
    // 只搬运已声明的字段；形态已在调用侧由 shared 校验函数保证。
    if (!isExtensionDialogResponseInput(response)) {
      return invalidExtensionUiResponse()
    }
    const request = {
      target: { runId: target.runId, runtimeId: target.runtimeId },
      dialogId,
      response
    }
    const wire: unknown = await ipcRenderer.invoke(EXTENSION_UI_RESPOND_CHANNEL, request)
    return isExtensionUiResult(wire) ? wire : invalidExtensionUiResponse()
  },

  onExtensionUiChanged(listener: (snapshot: ExtensionUiSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 快照载荷同样不可信：契约不符时丢弃，由下一次快照收敛。
      if (!isExtensionUiEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(EXTENSION_UI_EVENT, handler)
    return () => {
      ipcRenderer.off(EXTENSION_UI_EVENT, handler)
    }
  }
} satisfies ExtensionUiApi
