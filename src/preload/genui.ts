/** 生成式界面参数与 Extension UI：preload 的 genui 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { GENUI_PARAMS_CLEAR_CHANNEL, GENUI_PARAMS_GET_CHANNEL, GENUI_PARAMS_SAVE_CHANNEL, isGenuiParamsClearResult, isGenuiParamsGetResult, isGenuiParamsSaveResult } from '../shared/genui-params-api'
import { EXTENSION_UI_RESPOND_CHANNEL, EXTENSION_UI_STATE_CHANNEL, EXTENSION_UI_EVENT, isExtensionDialogResponseInput, isExtensionUiEvent, isExtensionUiResult } from '../shared/extension-ui-api'
import type { GenuiParamRecord, GenuiParamsClearResult, GenuiParamsGetResult, GenuiParamSaveRequest, GenuiParamsSaveResult } from '../shared/genui-params-api'
import type { ExtensionDialogResponseInput, ExtensionUiResult, ExtensionUiSnapshot } from '../shared/extension-ui-api'
import type { GenuiParamsApi } from '../shared/genui-params-api'
import type { ExtensionUiApi } from '../shared/extension-ui-api'

const INVALID_GENUI_PARAMS_GET_RESPONSE = '桌面接口返回了无法识别的界面参数记录。'
const INVALID_GENUI_PARAMS_SAVE_RESPONSE = '桌面接口返回了无法识别的界面参数保存结果。'
const INVALID_GENUI_PARAMS_CLEAR_RESPONSE = '桌面接口返回了无法识别的界面参数清除结果。'
const INVALID_EXTENSION_UI_RESPONSE = '桌面接口返回了无法识别的 Extension UI 状态。'

function invalidExtensionUiResponse(): ExtensionUiResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_EXTENSION_UI_RESPONSE } }
}

function invalidGenuiParamsGetResponse(): GenuiParamsGetResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GENUI_PARAMS_GET_RESPONSE } }
}

function invalidGenuiParamsSaveResponse(): GenuiParamsSaveResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GENUI_PARAMS_SAVE_RESPONSE } }
}

function invalidGenuiParamsClearResponse(): GenuiParamsClearResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GENUI_PARAMS_CLEAR_RESPONSE } }
}

export const genuiApi = {
  async getGenuiParams(): Promise<GenuiParamsGetResult> {
    const response: unknown = await ipcRenderer.invoke(GENUI_PARAMS_GET_CHANNEL)
    return isGenuiParamsGetResult(response) ? response : invalidGenuiParamsGetResponse()
  },

  async saveGenuiParam(request: GenuiParamSaveRequest): Promise<GenuiParamsSaveResult> {
    // 重建普通对象与取值表：响应式代理不能跨 contextBridge，只搬运已声明的字段。
    const record: GenuiParamRecord | null = request.record === null
      ? null
      : { revision: request.record.revision, updatedAt: request.record.updatedAt, values: { ...request.record.values } }
    const payload: GenuiParamSaveRequest = { documentId: request.documentId, record }
    const response: unknown = await ipcRenderer.invoke(GENUI_PARAMS_SAVE_CHANNEL, payload)
    return isGenuiParamsSaveResult(response) ? response : invalidGenuiParamsSaveResponse()
  },

  async clearGenuiParams(): Promise<GenuiParamsClearResult> {
    const response: unknown = await ipcRenderer.invoke(GENUI_PARAMS_CLEAR_CHANNEL)
    return isGenuiParamsClearResult(response) ? response : invalidGenuiParamsClearResponse()
  },

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
} satisfies GenuiParamsApi & ExtensionUiApi
