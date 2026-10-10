/** 为沙箱页面提供应用信息、Project 选择/添加/移除/列表、项目文件检索、Session、Project Trust、偏好、Runtime、Pi 资源、认证与 Extension 等受限接口，不暴露 Electron、任意 channel 或系统能力。 */
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
  PROJECT_ADD_CHANNEL,
  PROJECT_CHOOSE_DIRECTORY_CHANNEL,
  PROJECT_LIST_CHANNEL,
  PROJECT_REMOVE_CHANNEL,
  PROJECT_SET_CURRENT_CHANNEL,
  isProjectListResult,
  isProjectPathResult
} from '../shared/project-api'
import type {
  ProjectAddRequest,
  ProjectApi,
  ProjectListResult,
  ProjectPathResult,
  ProjectRemoveRequest,
  ProjectSetCurrentRequest
} from '../shared/project-api'
import {
  PROJECT_FILE_SEARCH_CHANNEL,
  isProjectFileSearchResult
} from '../shared/project-file-api'
import type { ProjectFileApi, ProjectFileSearchResult } from '../shared/project-file-api'
import {
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  SESSION_RELOAD_CHANNEL,
  isSessionListResult
} from '../shared/session-api'
import type {
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
  AUTH_FLOW_EVENT,
  AUTH_LOGIN_CANCEL_CHANNEL,
  AUTH_LOGIN_RESPOND_CHANNEL,
  AUTH_LOGIN_START_CHANNEL,
  AUTH_LOGOUT_CHANNEL,
  AUTH_OPEN_URL_CHANNEL,
  AUTH_STATUS_CHANNEL,
  isAuthFlowResult,
  isAuthFlowSnapshot,
  isAuthLogoutResult,
  isAuthStatusResult
} from '../shared/auth-api'
import type {
  AuthApi,
  AuthFlowResult,
  AuthFlowSnapshot,
  AuthLogoutResult,
  AuthMethod,
  AuthStatusResult
} from '../shared/auth-api'
import {
  RUNTIME_ABORT_CHANNEL,
  RUNTIME_CAPABILITIES_CHANNEL,
  RUNTIME_SET_MODEL_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_MCP_COMMAND_CHANNEL,
  RUNTIME_MCP_CONFIG_CHANNEL,
  RUNTIME_MCP_INSPECT_ABORT_CHANNEL,
  RUNTIME_MCP_INSPECT_CHANNEL,
  RUNTIME_MCP_STATUS_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_RESOURCES_CHANNEL,
  RUNTIME_RESOURCE_PREVIEW_CHANNEL,
  RUNTIME_START_CHANNEL,
  RUNTIME_START_SAFE_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STOP_CHANNEL,
  RUNTIME_STATUS_EVENT,
  isCapabilitiesResult,
  isMcpCommandResult,
  isMcpConfigResult,
  isMcpInspectionResult,
  isMcpInspectAbortResult,
  isMcpStatusResult,
  isProjectionBatch,
  isProjectionResult,
  isPromptResult,
  isResourcesResult,
  isResourcePreviewRequest,
  isResourcePreviewResult,
  isRuntimeDiagnosticsResult,
  isRuntimeResult,
  isRuntimeStatus
} from '../shared/runtime-api'
import type {
  CapabilitiesResult,
  McpCommandAction,
  McpCommandResult,
  McpConfigResult,
  McpInspectionResult,
  McpInspectAbortResult,
  McpStatusResult,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  ResourcesResult,
  ResourcePreviewResult,
  RuntimeApi,
  RuntimeDiagnosticsResult,
  RuntimeResult,
  RuntimeSetModelRequest,
  RuntimeStartRequest,
  RuntimeStatus
} from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'
const INVALID_PROMPT_RESPONSE = '桌面接口返回了无法识别的 Prompt 结果。'
const INVALID_PROJECTION_RESPONSE = '桌面接口返回了无法识别的投影快照。'
const INVALID_CAPABILITIES_RESPONSE = '桌面接口返回了无法识别的模型列表结果。'
const INVALID_PROJECT_PATH_RESPONSE = '桌面接口返回了无法识别的目录选择结果。'
const INVALID_PROJECT_LIST_RESPONSE = '桌面接口返回了无法识别的项目列表。'
const INVALID_PROJECT_FILE_RESPONSE = '桌面接口返回了无法识别的文件检索结果。'
const INVALID_SESSION_LIST_RESPONSE = '桌面接口返回了无法识别的会话列表。'
const INVALID_PREFERENCES_RESPONSE = '桌面接口返回了无法识别的界面偏好。'
const INVALID_TRUST_RESPONSE = '桌面接口返回了无法识别的信任状态。'
const INVALID_EXTENSION_UI_RESPONSE = '桌面接口返回了无法识别的 Extension UI 状态。'
const INVALID_RESOURCES_RESPONSE = '桌面接口返回了无法识别的资源清单。'
const INVALID_RESOURCE_PREVIEW_RESPONSE = '桌面接口返回了无法识别的资源预读结果。'
const INVALID_DIAGNOSTICS_RESPONSE = '桌面接口返回了无法识别的诊断结果。'
const INVALID_MCP_STATUS_RESPONSE = '桌面接口返回了无法识别的 MCP 状态结果。'
const INVALID_MCP_INSPECTION_RESPONSE = '桌面接口返回了无法识别的 MCP 探测结果。'
const INVALID_MCP_CONFIG_RESPONSE = '桌面接口返回了无法识别的 MCP 配置列举结果。'
const INVALID_MCP_INSPECT_ABORT_RESPONSE = '桌面接口返回了无法识别的中止探测结果。'
const INVALID_AUTH_STATUS_RESPONSE = '桌面接口返回了无法识别的认证状态。'
const INVALID_AUTH_FLOW_RESPONSE = '桌面接口返回了无法识别的登录流程状态。'

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

function invalidProjectFileResponse(): ProjectFileSearchResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_RESPONSE } }
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

function invalidResourcesResponse(): ResourcesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RESOURCES_RESPONSE } }
}

function invalidResourcePreviewResponse(): ResourcePreviewResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RESOURCE_PREVIEW_RESPONSE } }
}

function invalidDiagnosticsResponse(): RuntimeDiagnosticsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_DIAGNOSTICS_RESPONSE } }
}

function invalidMcpStatusResponse(): McpStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_STATUS_RESPONSE } }
}

function invalidMcpInspectionResponse(): McpInspectionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_INSPECTION_RESPONSE } }
}

function invalidMcpConfigResponse(): McpConfigResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_CONFIG_RESPONSE } }
}

function invalidMcpInspectAbortResponse(): McpInspectAbortResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_INSPECT_ABORT_RESPONSE } }
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

const desktop: DesktopApi & RuntimeApi & ProjectApi & ProjectFileApi & SessionApi & PreferencesApi & TrustApi & ExtensionUiApi & AuthApi = {
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

  async addProject(path, trustStatus, trustDecision, allowInterrupt) {
    const request: ProjectAddRequest = { path, trustStatus, trustDecision, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ADD_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async removeProject(projectId, allowInterrupt) {
    const request: ProjectRemoveRequest = { projectId, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_REMOVE_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async listSessions() {
    const response: unknown = await ipcRenderer.invoke(SESSION_LIST_CHANNEL)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  /** 在当前项目内检索文件候选；只搬运查询串，检索根由主进程决定。 */
  async searchProjectFiles(query: string) {
    const request = { query }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_SEARCH_CHANNEL, request)
    return isProjectFileSearchResult(response) ? response : invalidProjectFileResponse()
  },

  async openSession(sessionId: string | null, allowInterrupt: boolean) {
    const request: SessionOpenRequest = { sessionId, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(SESSION_OPEN_CHANNEL, request)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  async reloadSession(allowInterrupt: boolean) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RELOAD_CHANNEL, { allowInterrupt })
    return isSessionListResult(response) ? response : invalidSessionResponse()
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
    const request: UiPreferences = {
      sidebarCollapsed: ui.sidebarCollapsed,
      theme: ui.theme,
      thinkingDefaultExpanded: ui.thinkingDefaultExpanded
    }
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

  /** 只传模型身份与代际；不向页面开放任意 RPC，也不接受持久化选项。 */
  async setRuntimeModel(runtimeId: number, provider: string, modelId: string): Promise<RuntimeResult> {
    const request: RuntimeSetModelRequest = { runtimeId, provider, modelId }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_SET_MODEL_CHANNEL, request)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async getRuntimeResources(): Promise<ResourcesResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCES_CHANNEL)
    return isResourcesResult(response) ? response : invalidResourcesResponse()
  },

  /** Runtime 未启动时的资源预读：项目与信任决定由主进程决定，`force` 要求绕过其缓存重新探测。 */
  async getResourcePreview(force: boolean): Promise<ResourcePreviewResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCE_PREVIEW_CHANNEL, { force })
    return isResourcePreviewResult(response) ? response : invalidResourcePreviewResponse()
  },

  async getRuntimeDiagnostics(): Promise<RuntimeDiagnosticsResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_DIAGNOSTICS_CHANNEL)
    return isRuntimeDiagnosticsResult(response) ? response : invalidDiagnosticsResponse()
  },

  async readRuntimeMcpStatus(): Promise<McpStatusResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_STATUS_CHANNEL)
    return isMcpStatusResult(response) ? response : invalidMcpStatusResponse()
  },

  /** MCP 登录/退出/重连：只搬运已声明的字段；命令文本由主进程拼出。 */
  async runRuntimeMcpCommand(action: McpCommandAction, serverName: string): Promise<McpCommandResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_COMMAND_CHANNEL, { action, serverName })
    return isMcpCommandResult(response) ? response : invalidMcpStatusResponse()
  },

  /** MCP 配置列举：零参数只读读取 Pi 的 mcp.json；不连接服务器、不写配置文件。 */
  async getRuntimeMcpConfig(): Promise<McpConfigResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_CONFIG_CHANNEL)
    return isMcpConfigResult(response) ? response : invalidMcpConfigResponse()
  },

  /** MCP 服务器探测：零参数，命令与工作目录都由主进程决定。 */
  async inspectRuntimeMcpServers(): Promise<McpInspectionResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_INSPECT_CHANNEL)
    return isMcpInspectionResult(response) ? response : invalidMcpInspectionResponse()
  },

  /** 中止进行中的 MCP 探测：零参数。 */
  async abortRuntimeMcpInspection(): Promise<McpInspectAbortResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_INSPECT_ABORT_CHANNEL)
    return isMcpInspectAbortResult(response) ? response : invalidMcpInspectAbortResponse()
  },

  async startRuntimeSafely(): Promise<RuntimeResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_START_SAFE_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
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
  },

  async getAuthStatus(): Promise<AuthStatusResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_STATUS_CHANNEL)
    return isAuthStatusResult(response) ? response : invalidAuthStatusResponse()
  },

  /** 启动登录流程：只搬运 provider 名与登录方式，不传入其他字段。 */
  async startAuthLogin(providerId: string, method: AuthMethod): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_START_CHANNEL, { providerId, method })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  /** 回应登录提示：密钥只经这一个方法单向提交，之后不保留任何副本。 */
  async respondAuthLogin(flowId: string, promptId: string, value: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_RESPOND_CHANNEL, { flowId, promptId, value })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async cancelAuthLogin(flowId: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGIN_CANCEL_CHANNEL, { flowId })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  /** 打开当前流程记录的授权地址；页面不能传入任意 URL。 */
  async openAuthFlowUrl(flowId: string): Promise<AuthFlowResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_OPEN_URL_CHANNEL, { flowId })
    return isAuthFlowResult(response) ? response : invalidAuthFlowResponse()
  },

  async logoutAuthProvider(providerId: string): Promise<AuthLogoutResult> {
    const response: unknown = await ipcRenderer.invoke(AUTH_LOGOUT_CHANNEL, { providerId })
    return isAuthLogoutResult(response) ? response : invalidAuthLogoutResponse()
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
}

contextBridge.exposeInMainWorld('desktop', desktop)
