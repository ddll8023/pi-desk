/** 专家资源管理的桥接：设置页的派生、读取与保存、删除、快速模式剔除清单、能力候选与默认能力基线；清单本身复用 sessions 域的读取。 */

import { ipcRenderer } from 'electron'
import {
  EXPERTS_CAPABILITIES_CHANNEL,
  EXPERTS_DELETE_CHANNEL,
  EXPERTS_DERIVE_CHANNEL,
  EXPERTS_FAST_MODE_CHANNEL,
  EXPERTS_READ_CHANNEL,
  EXPERTS_SAVE_CHANNEL,
  EXPERTS_SAVE_DEFAULTS_CHANNEL,
  isExpertCapabilitiesResult,
  isExpertDeleteResult,
  isExpertDeriveResult,
  isExpertEditableDefinitionResult,
  isExpertSaveDefaultsResult,
  isExpertSaveResult,
  isFastModeExclusionsResult
} from '../shared/experts-api'
import type {
  ExpertApi,
  ExpertCapabilitiesResult,
  ExpertDeleteRequest,
  ExpertDeleteResult,
  ExpertDeriveRequest,
  ExpertDeriveResult,
  ExpertReadRequest,
  ExpertReadResult,
  ExpertSaveDefaultsRequest,
  ExpertSaveDefaultsResult,
  ExpertSaveRequest,
  ExpertSaveResult,
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
  },

  async readExpertDefinition(request: ExpertReadRequest): Promise<ExpertReadResult> {
    const payload: ExpertReadRequest = { expertId: request.expertId }
    const response: unknown = await ipcRenderer.invoke(EXPERTS_READ_CHANNEL, payload)
    return isExpertEditableDefinitionResult(response) ? response : invalidExpertResponse()
  },

  async saveExpert(request: ExpertSaveRequest): Promise<ExpertSaveResult> {
    const payload: ExpertSaveRequest = {
      expertId: request.expertId,
      displayName: request.displayName,
      summary: request.summary,
      skillIds: [...request.skillIds],
      skillsMode: request.skillsMode,
      skillAddIds: [...request.skillAddIds],
      skillRemoveIds: [...request.skillRemoveIds],
      mcpMode: request.mcpMode,
      mcpServerIds: [...request.mcpServerIds],
      mcpAddIds: [...request.mcpAddIds],
      mcpRemoveIds: [...request.mcpRemoveIds],
      body: request.body
    }
    const response: unknown = await ipcRenderer.invoke(EXPERTS_SAVE_CHANNEL, payload)
    return isExpertSaveResult(response) ? response : invalidExpertResponse()
  },

  async listCapabilities(): Promise<ExpertCapabilitiesResult> {
    const response: unknown = await ipcRenderer.invoke(EXPERTS_CAPABILITIES_CHANNEL)
    return isExpertCapabilitiesResult(response) ? response : invalidExpertResponse()
  },

  async saveCapabilityDefaults(request: ExpertSaveDefaultsRequest): Promise<ExpertSaveDefaultsResult> {
    // 列表为 null 时必须原样传 null：它是「不限制」的唯一表达，不能被当成空数组。
    const payload: ExpertSaveDefaultsRequest = {
      skills: request.skills === null ? null : [...request.skills],
      mcpServers: request.mcpServers === null ? null : [...request.mcpServers]
    }
    const response: unknown = await ipcRenderer.invoke(EXPERTS_SAVE_DEFAULTS_CHANNEL, payload)
    return isExpertSaveDefaultsResult(response) ? response : invalidExpertResponse()
  }
}
