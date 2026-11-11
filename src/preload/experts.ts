/** 专家资源管理的桥接：设置页的派生、删除与快速模式剔除清单；清单本身复用 sessions 域的读取。 */

import { ipcRenderer } from 'electron'
import {
  EXPERTS_DELETE_CHANNEL,
  EXPERTS_DERIVE_CHANNEL,
  EXPERTS_FAST_MODE_CHANNEL,
  isExpertDeleteResult,
  isExpertDeriveResult,
  isFastModeExclusionsResult
} from '../shared/experts-api'
import type {
  ExpertApi,
  ExpertDeleteRequest,
  ExpertDeleteResult,
  ExpertDeriveRequest,
  ExpertDeriveResult,
  FastModeExclusionsResult
} from '../shared/experts-api'

function invalidExpertResponse(): { readonly ok: false; readonly error: { readonly code: 'INVALID_RESPONSE'; readonly message: string } } {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的专家数据不符合契约。' } }
}

export const expertsApi: ExpertApi = {
  async deriveExpert(request: ExpertDeriveRequest): Promise<ExpertDeriveResult> {
    const payload: ExpertDeriveRequest = { builtinId: request.builtinId }
    const response: unknown = await ipcRenderer.invoke(EXPERTS_DERIVE_CHANNEL, payload)
    return isExpertDeriveResult(response) ? response : invalidExpertResponse()
  },

  async deleteExpert(request: ExpertDeleteRequest): Promise<ExpertDeleteResult> {
    const payload: ExpertDeleteRequest = { expertId: request.expertId }
    const response: unknown = await ipcRenderer.invoke(EXPERTS_DELETE_CHANNEL, payload)
    return isExpertDeleteResult(response) ? response : invalidExpertResponse()
  },

  async listFastModeExclusions(): Promise<FastModeExclusionsResult> {
    const response: unknown = await ipcRenderer.invoke(EXPERTS_FAST_MODE_CHANNEL)
    return isFastModeExclusionsResult(response) ? response : invalidExpertResponse()
  }
}
