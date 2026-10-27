/** 认证、Codex 额度、自定义供应商与 Pi 默认模型：preload 的 providers 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL, PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL, isPiDefaultModelResult } from '../shared/pi-settings-api'
import {
  MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
  MODELS_CONFIG_FETCH_ENDPOINT_MODELS_CHANNEL,
  MODELS_CONFIG_GET_CHANNEL,
  MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
  isModelsConfigDeleteRequest,
  isModelsConfigFetchEndpointModelsRequest,
  isModelsConfigFetchEndpointModelsResult,
  isModelsConfigResult,
  isModelsConfigSaveRequest
} from '../shared/models-config-api'
import { AUTH_CODEX_USAGE_CHANNEL, isAuthCodexUsageResult, AUTH_FLOW_EVENT, AUTH_LOGIN_CANCEL_CHANNEL, AUTH_LOGIN_RESPOND_CHANNEL, AUTH_LOGIN_START_CHANNEL, AUTH_LOGOUT_CHANNEL, AUTH_OPEN_URL_CHANNEL, AUTH_REFRESH_MODELS_CHANNEL, AUTH_STATUS_CHANNEL, isAuthFlowResult, isAuthFlowSnapshot, isAuthLogoutResult, isAuthRefreshModelsResult, isAuthStatusResult } from '../shared/auth-api'
import type { PiDefaultModelResult } from '../shared/pi-settings-api'
import type {
  ModelsConfigDeleteRequest,
  ModelsConfigFetchEndpointModelsRequest,
  ModelsConfigFetchEndpointModelsResult,
  ModelsConfigResult,
  ModelsConfigSaveRequest
} from '../shared/models-config-api'
import type { AuthCodexUsageResult, AuthFlowResult, AuthFlowSnapshot, AuthLogoutResult, AuthMethod, AuthRefreshModelsResult, AuthStatusResult } from '../shared/auth-api'
import type { ModelIdentity } from '../shared/runtime-api'
import type { PiSettingsApi } from '../shared/pi-settings-api'
import type { ModelsConfigApi } from '../shared/models-config-api'
import type { AuthApi } from '../shared/auth-api'

const INVALID_MODELS_CONFIG_RESPONSE = '桌面接口返回了无法识别的自定义供应商配置。'
const INVALID_AUTH_STATUS_RESPONSE = '桌面接口返回了无法识别的认证状态。'
const INVALID_AUTH_FLOW_RESPONSE = '桌面接口返回了无法识别的登录流程状态。'

function invalidModelsConfigResponse(): ModelsConfigResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MODELS_CONFIG_RESPONSE } }
}

function invalidAuthStatusResponse(): AuthStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AUTH_STATUS_RESPONSE, detail: null } }
}

function invalidAuthFlowResponse(): AuthFlowResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AUTH_FLOW_RESPONSE, detail: null } }
}

function invalidAuthLogoutResponse(): AuthLogoutResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AUTH_STATUS_RESPONSE, detail: null } }
}

function invalidAuthRefreshModelsResponse(): AuthRefreshModelsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的模型刷新结果。', detail: null } }
}

export const providersApi = {
  async getPiDefaultModel(): Promise<PiDefaultModelResult> {
    const response: unknown = await ipcRenderer.invoke(PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL)
    return isPiDefaultModelResult(response) ? response : {
      ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的 Pi 默认模型。' }
    }
  },

  async setPiDefaultModel(model: ModelIdentity): Promise<PiDefaultModelResult> {
    const request = { provider: model.provider, modelId: model.modelId }
    const response: unknown = await ipcRenderer.invoke(PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL, request)
    return isPiDefaultModelResult(response) ? response : {
      ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的 Pi 默认模型。' }
    }
  },

  async getModelsConfig(): Promise<ModelsConfigResult> {
    const response: unknown = await ipcRenderer.invoke(MODELS_CONFIG_GET_CHANNEL)
    return isModelsConfigResult(response) ? response : invalidModelsConfigResponse()
  },

  async saveModelsConfigProvider(request: ModelsConfigSaveRequest): Promise<ModelsConfigResult> {
    const payload: ModelsConfigSaveRequest = { providerId: request.providerId, json: request.json }
    if (!isModelsConfigSaveRequest(payload)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '供应商配置参数格式不正确。' } }
    }
    const response: unknown = await ipcRenderer.invoke(MODELS_CONFIG_SAVE_PROVIDER_CHANNEL, payload)
    return isModelsConfigResult(response) ? response : invalidModelsConfigResponse()
  },

  async deleteModelsConfigProvider(request: ModelsConfigDeleteRequest): Promise<ModelsConfigResult> {
    const payload: ModelsConfigDeleteRequest = { providerId: request.providerId }
    if (!isModelsConfigDeleteRequest(payload)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '供应商标识格式不正确。' } }
    }
    const response: unknown = await ipcRenderer.invoke(MODELS_CONFIG_DELETE_PROVIDER_CHANNEL, payload)
    return isModelsConfigResult(response) ? response : invalidModelsConfigResponse()
  },

  async fetchEndpointModels(request: ModelsConfigFetchEndpointModelsRequest): Promise<ModelsConfigFetchEndpointModelsResult> {
    if (!isModelsConfigFetchEndpointModelsRequest(request)) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '探测端点模型参数格式不正确。' } }
    }
    const response: unknown = await ipcRenderer.invoke(MODELS_CONFIG_FETCH_ENDPOINT_MODELS_CHANNEL, request)
    return isModelsConfigFetchEndpointModelsResult(response) ? response : {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的模型探测结果。' }
    }
  },

  async getAuthStatus(): Promise<AuthStatusResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_STATUS_CHANNEL)
    return isAuthStatusResult(response) ? response : invalidAuthStatusResponse()
  },

  async getAuthCodexUsage(refresh: boolean): Promise<AuthCodexUsageResult> {
    if (typeof refresh !== 'boolean') {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '额度刷新参数必须是布尔值。', detail: null } }
    }
    const response: unknown = await ipcRenderer.invoke(AUTH_CODEX_USAGE_CHANNEL, { refresh })
    return isAuthCodexUsageResult(response) ? response : {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的 Codex 额度。', detail: null }
    }
  },

  async startAuthLogin(providerId: string, method: AuthMethod): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_START_CHANNEL, { providerId, method })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async respondAuthLogin(flowId: string, promptId: string, value: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_RESPOND_CHANNEL, { flowId, promptId, value })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async cancelAuthLogin(flowId: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_CANCEL_CHANNEL, { flowId })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async openAuthFlowUrl(flowId: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_OPEN_URL_CHANNEL, { flowId })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async logoutAuthProvider(providerId: string): Promise<AuthLogoutResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGOUT_CHANNEL, { providerId })
    return isAuthLogoutResult(response) ? response : invalidAuthLogoutResponse()
  },

  async refreshAuthProviderModels(providerId?: string): Promise<AuthRefreshModelsResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_REFRESH_MODELS_CHANNEL, { providerId })
    return isAuthRefreshModelsResult(response) ? response : invalidAuthRefreshModelsResponse()
  },

  onAuthFlowChanged(listener: (snapshot: AuthFlowSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 流程载荷同样不可信：契约不符时丢弃，由下一次快照收敛。
      if (!isAuthFlowSnapshot(payload)) return
      listener(payload)
    }
    ipcRenderer.on(AUTH_FLOW_EVENT, handler)
    return () => {
      ipcRenderer.off(AUTH_FLOW_EVENT, handler)
    }
  }
} satisfies PiSettingsApi & ModelsConfigApi & AuthApi
