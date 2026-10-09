/** 为沙箱页面提供应用信息、Project 选择与列表、Session 列表与打开、分叉消息读取与分叉发起、Project Trust 查询与决定、界面偏好、Runtime 启停与 Agent 能力控制、手动压缩、Prompt 提交、中止、消息/工具投影与事件订阅、Extension UI 状态读取、对话响应与快照订阅，不暴露 Electron、任意 channel 或系统能力。 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { APP_INFO_CHANNEL, isAppInfoResult } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import {
  PREFERENCES_GET_CHANNEL,
  PREFERENCES_SET_UI_CHANNEL,
  isPreferencesResult
} from '../shared/preferences-api'
import type { PreferencesApi, PreferencesResult, UiPreferences } from '../shared/preferences-api'
import {
  PROJECT_CHOOSE_DIRECTORY_CHANNEL,
  PROJECT_LIST_CHANNEL,
  PROJECT_SET_CURRENT_CHANNEL,
  isProjectListResult,
  isProjectPathResult
} from '../shared/project-api'
import type {
  ProjectApi,
  ProjectListResult,
  ProjectPathResult,
  ProjectSetCurrentRequest
} from '../shared/project-api'
import {
  FORK_MESSAGES_CHANNEL,
  FORK_START_CHANNEL,
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  isForkMessageListResult,
  isForkStartResult,
  isSessionListResult
} from '../shared/session-api'
import type {
  ForkMessageListResult,
  ForkStartRequest,
  ForkStartResult,
  SessionApi,
  SessionListResult,
  SessionOpenRequest
} from '../shared/session-api'
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
import {
  TRUST_DECIDE_CHANNEL,
  TRUST_STATUS_CHANNEL,
  isTrustDecisionResult,
  isTrustStatusResult
} from '../shared/trust-api'
import type {
  TrustApi,
  TrustDecisionInput,
  TrustDecisionResult,
  TrustStatusResult
} from '../shared/trust-api'
import {
  RUNTIME_ABORT_CHANNEL,
  RUNTIME_CAPABILITIES_CHANNEL,
  RUNTIME_COMPACT_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_SET_MODEL_CHANNEL,
  RUNTIME_SET_THINKING_LEVEL_CHANNEL,
  RUNTIME_START_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STOP_CHANNEL,
  RUNTIME_STATUS_EVENT,
  isCapabilitiesResult,
  isCompactResultResult,
  isProjectionBatch,
  isProjectionResult,
  isPromptResult,
  isRuntimeResult,
  isRuntimeStatus
} from '../shared/runtime-api'
import type {
  CapabilitiesResult,
  CompactResultResult,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  RuntimeApi,
  RuntimeResult,
  RuntimeStartRequest,
  RuntimeStatus,
  SetModelRequest,
  SetThinkingLevelRequest
} from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'
const INVALID_PROMPT_RESPONSE = '桌面接口返回了无法识别的 Prompt 结果。'
const INVALID_PROJECTION_RESPONSE = '桌面接口返回了无法识别的投影快照。'
const INVALID_CAPABILITIES_RESPONSE = '桌面接口返回了无法识别的 Agent 能力结果。'
const INVALID_PROJECT_PATH_RESPONSE = '桌面接口返回了无法识别的目录选择结果。'
const INVALID_PROJECT_LIST_RESPONSE = '桌面接口返回了无法识别的项目列表。'
const INVALID_SESSION_LIST_RESPONSE = '桌面接口返回了无法识别的会话列表。'
const INVALID_PREFERENCES_RESPONSE = '桌面接口返回了无法识别的界面偏好。'
const INVALID_TRUST_RESPONSE = '桌面接口返回了无法识别的信任状态。'
const INVALID_EXTENSION_UI_RESPONSE = '桌面接口返回了无法识别的 Extension UI 状态。'

function invalidExtensionUiResponse(): ExtensionUiResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_EXTENSION_UI_RESPONSE } }
}

function invalidRuntimeResponse(): RuntimeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RUNTIME_RESPONSE } }
}

function invalidPromptResponse(): PromptResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROMPT_RESPONSE } }
}

function invalidProjectionResponse(): ProjectionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECTION_RESPONSE } }
}

function invalidCapabilitiesResponse(): CapabilitiesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_CAPABILITIES_RESPONSE } }
}

function invalidProjectPathResponse(): ProjectPathResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_PATH_RESPONSE } }
}

function invalidProjectListResponse(): ProjectListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_LIST_RESPONSE } }
}

function invalidSessionResponse(): SessionListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_SESSION_LIST_RESPONSE } }
}

function invalidPreferencesResponse(): PreferencesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PREFERENCES_RESPONSE } }
}

function invalidTrustResponse(): TrustStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TRUST_RESPONSE } }
}

const desktop: DesktopApi & RuntimeApi & ProjectApi & SessionApi & PreferencesApi & TrustApi & ExtensionUiApi = {
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

  async chooseProjectDirectory() {
    const response: unknown = await ipcRenderer.invoke(PROJECT_CHOOSE_DIRECTORY_CHANNEL)
    return isProjectPathResult(response) ? response : invalidProjectPathResponse()
  },

  async listProjects() {
    const response: unknown = await ipcRenderer.invoke(PROJECT_LIST_CHANNEL)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async setCurrentProject(path: string, allowInterrupt: boolean) {
    const request: ProjectSetCurrentRequest = { path, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_SET_CURRENT_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async listSessions() {
    const response: unknown = await ipcRenderer.invoke(SESSION_LIST_CHANNEL)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  async openSession(sessionId: string | null, allowInterrupt: boolean) {
    const request: SessionOpenRequest = { sessionId, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(SESSION_OPEN_CHANNEL, request)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  async getForkMessages(): Promise<ForkMessageListResult> {
    const response: unknown = await ipcRenderer.invoke(FORK_MESSAGES_CHANNEL)
    if (isForkMessageListResult(response)) return response
    return {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的分叉消息列表。' }
    }
  },

  async startFork(entryId: string, allowInterrupt: boolean): Promise<ForkStartResult> {
    const request: ForkStartRequest = { entryId, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(FORK_START_CHANNEL, request)
    if (isForkStartResult(response)) return response
    return {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的分叉结果。' }
    }
  },

  async getTrustStatus() {
    const response: unknown = await ipcRenderer.invoke(TRUST_STATUS_CHANNEL)
    return isTrustStatusResult(response) ? response : invalidTrustResponse()
  },

  async decideTrust(projectPath: string, decision: TrustDecisionInput) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request = { projectPath, decision }
    const response: unknown = await ipcRenderer.invoke(TRUST_DECIDE_CHANNEL, request)
    return isTrustDecisionResult(response) ? response : invalidTrustResponse()
  },

  async getPreferences() {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_CHANNEL)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  async setUiPreferences(ui: UiPreferences) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request: UiPreferences = { sidebarCollapsed: ui.sidebarCollapsed, theme: ui.theme }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_UI_CHANNEL, request)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  async startRuntime(projectPath: string) {
    const request: RuntimeStartRequest = { projectPath }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_START_CHANNEL, request)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async getRuntimeStatus() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_STATUS_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async stopRuntime() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_STOP_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async abortRuntime() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_ABORT_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async sendPrompt(message: string, images?: readonly PromptImageInput[]) {
    // 只搬运已声明的字段；图片附件逐字段重建，不带页面传入的其他内容。
    const payloadImages = (images ?? []).map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      data: image.data
    }))
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROMPT_CHANNEL, {
      message,
      ...(payloadImages.length > 0 ? { images: payloadImages } : {})
    })
    return isPromptResult(response) ? response : invalidPromptResponse()
  },

  async getRuntimeProjection() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROJECTION_CHANNEL)
    return isProjectionResult(response) ? response : invalidProjectionResponse()
  },

  async getRuntimeCapabilities() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_CAPABILITIES_CHANNEL)
    return isCapabilitiesResult(response) ? response : invalidCapabilitiesResponse()
  },

  async setRuntimeModel(request: SetModelRequest) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const payload: SetModelRequest = { provider: request.provider, modelId: request.modelId }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_SET_MODEL_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async setRuntimeThinkingLevel(request: SetThinkingLevelRequest) {
    const payload: SetThinkingLevelRequest = { level: request.level }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_SET_THINKING_LEVEL_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async compactRuntime(): Promise<CompactResultResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_COMPACT_CHANNEL)
    // compact 成功数据不是 RuntimeStatus，不能用 invalidRuntimeResponse 作回退。
    if (isCompactResultResult(response)) return response
    return {
      ok: false,
      error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的压缩结果。' }
    }
  },

  ackRuntimeProjection(runtimeId: number, seq: number) {
    // 应用确认失败只影响通知窗口，不应产生未处理的拒绝。
    void ipcRenderer
      .invoke(RUNTIME_PROJECTION_ACK_CHANNEL, { runtimeId, seq })
      .catch(() => undefined)
  },

  onRuntimeStatusChanged(listener: (status: RuntimeStatus) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：不符合契约时直接丢弃。
      if (!isRuntimeStatus(payload)) return
      listener(payload)
    }
    ipcRenderer.on(RUNTIME_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.off(RUNTIME_STATUS_EVENT, handler)
    }
  },

  onRuntimeProjectionChanged(listener: (batch: ProjectionBatch) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 批次同样不可信：契约不符时丢弃，序号缺口由快照重同步收敛。
      if (!isProjectionBatch(payload)) return
      listener(payload)
    }
    ipcRenderer.on(RUNTIME_PROJECTION_EVENT, handler)
    return () => {
      ipcRenderer.off(RUNTIME_PROJECTION_EVENT, handler)
    }
  },

  async getExtensionUiState() {
    const response: unknown = await ipcRenderer.invoke(EXTENSION_UI_STATE_CHANNEL)
    return isExtensionUiResult(response) ? response : invalidExtensionUiResponse()
  },

  async respondExtensionDialog(dialogId: string, response: ExtensionDialogResponseInput) {
    // 只搬运已声明的字段；形态已在调用侧由 shared 校验函数保证。
    if (!isExtensionDialogResponseInput(response)) {
      return invalidExtensionUiResponse()
    }
    const request = { dialogId, response }
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
}

contextBridge.exposeInMainWorld('desktop', desktop)
