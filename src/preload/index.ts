/** 为沙箱页面提供应用信息、Project 选择与列表、Session 列表与打开、界面偏好、Runtime 启停方法、Prompt 提交、中止、消息/工具投影与事件订阅，不暴露 Electron、任意 channel 或系统能力。 */
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
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  isSessionListResult
} from '../shared/session-api'
import type { SessionApi, SessionListResult, SessionOpenRequest } from '../shared/session-api'
import {
  RUNTIME_ABORT_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_START_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STOP_CHANNEL,
  RUNTIME_STATUS_EVENT,
  isProjectionBatch,
  isProjectionResult,
  isPromptResult,
  isRuntimeResult,
  isRuntimeStatus
} from '../shared/runtime-api'
import type {
  ProjectionBatch,
  ProjectionResult,
  PromptResult,
  RuntimeApi,
  RuntimeResult,
  RuntimeStartRequest,
  RuntimeStatus
} from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'
const INVALID_PROMPT_RESPONSE = '桌面接口返回了无法识别的 Prompt 结果。'
const INVALID_PROJECTION_RESPONSE = '桌面接口返回了无法识别的投影快照。'
const INVALID_PROJECT_PATH_RESPONSE = '桌面接口返回了无法识别的目录选择结果。'
const INVALID_PROJECT_LIST_RESPONSE = '桌面接口返回了无法识别的项目列表。'
const INVALID_SESSION_LIST_RESPONSE = '桌面接口返回了无法识别的会话列表。'
const INVALID_PREFERENCES_RESPONSE = '桌面接口返回了无法识别的界面偏好。'

function invalidRuntimeResponse(): RuntimeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RUNTIME_RESPONSE } }
}

function invalidPromptResponse(): PromptResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROMPT_RESPONSE } }
}

function invalidProjectionResponse(): ProjectionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECTION_RESPONSE } }
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

const desktop: DesktopApi & RuntimeApi & ProjectApi & SessionApi & PreferencesApi = {
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

  async getPreferences() {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_CHANNEL)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  async setUiPreferences(ui: UiPreferences) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request: UiPreferences = { sidebarCollapsed: ui.sidebarCollapsed }
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

  async sendPrompt(message: string) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROMPT_CHANNEL, { message })
    return isPromptResult(response) ? response : invalidPromptResponse()
  },

  async getRuntimeProjection() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROJECTION_CHANNEL)
    return isProjectionResult(response) ? response : invalidProjectionResponse()
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
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
