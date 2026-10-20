/** 为沙箱页面提供应用信息、外链打开（仅 http/https）、Project 选择/添加/移除/列表、项目文件检索、目录列举、目录监听、条目路径解析与文件内容读写、Git（源代码管理）、Session、会话运行状态、终端、Project Trust、偏好与快捷命令、Runtime、Pi 资源、Pi 默认模型、Pi 版本检查、扩展更新与内置 agent 安装、自定义供应商、认证与 Extension 等受限接口，不暴露 Electron、任意 channel 或系统能力。 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  APP_INFO_CHANNEL,
  OPEN_EXTERNAL_URL_CHANNEL,
  isAppInfoResult,
  isOpenExternalUrlResult
} from '../shared/desktop-api'
import type { OpenExternalUrlRequest, OpenExternalUrlResult } from '../shared/desktop-api'
import type { DesktopApi } from '../shared/desktop-api'
import {
  PREFERENCES_GET_CHANNEL,
  PREFERENCES_SET_UI_CHANNEL,
  PREFERENCES_GET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_SET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_GET_QUICK_SEND_CHANNEL,
  PREFERENCES_SET_QUICK_SEND_CHANNEL,
  PREFERENCES_GET_AUTO_UPDATE_CHANNEL,
  PREFERENCES_SET_AUTO_UPDATE_CHANNEL,
  PREFERENCES_GET_GENUI_CHANNEL,
  PREFERENCES_SET_GENUI_CHANNEL,
  isPreferencesResult,
  isModelDisplayResult,
  isQuickSendResult,
  isAutoUpdateResult,
  isGenuiResult
} from '../shared/preferences-api'
import type {
  AutoUpdatePreference,
  AutoUpdateResult,
  GenuiPreference,
  GenuiResult,
  ModelDisplayPreference,
  ModelDisplayResult,
  PreferencesApi,
  PreferencesResult,
  QuickSendPreference,
  QuickSendResult,
  UiPreferences
} from '../shared/preferences-api'
import {
  QUICK_COMMANDS_GET_CHANNEL,
  QUICK_COMMANDS_SET_CHANNEL,
  isQuickCommandsResult
} from '../shared/quick-commands-api'
import type { QuickCommand, QuickCommandsApi, QuickCommandsPreference, QuickCommandsResult } from '../shared/quick-commands-api'
import {
  GENUI_PARAMS_CLEAR_CHANNEL,
  GENUI_PARAMS_GET_CHANNEL,
  GENUI_PARAMS_SAVE_CHANNEL,
  isGenuiParamsClearResult,
  isGenuiParamsGetResult,
  isGenuiParamsSaveResult
} from '../shared/genui-params-api'
import type {
  GenuiParamRecord,
  GenuiParamsApi,
  GenuiParamsClearResult,
  GenuiParamsGetResult,
  GenuiParamSaveRequest,
  GenuiParamsSaveResult
} from '../shared/genui-params-api'
import {
  PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL,
  PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL,
  isPiDefaultModelResult
} from '../shared/pi-settings-api'
import type { PiDefaultModelResult, PiSettingsApi } from '../shared/pi-settings-api'
import {
  MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
  MODELS_CONFIG_GET_CHANNEL,
  MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
  isModelsConfigDeleteRequest,
  isModelsConfigResult,
  isModelsConfigSaveRequest
} from '../shared/models-config-api'
import type {
  ModelsConfigApi,
  ModelsConfigDeleteRequest,
  ModelsConfigResult,
  ModelsConfigSaveRequest
} from '../shared/models-config-api'
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
  PROJECT_DIRECTORY_CHANGED_EVENT,
  PROJECT_DIRECTORY_LIST_CHANNEL,
  PROJECT_DIRECTORY_WATCH_CHANNEL,
  PROJECT_ENTRY_RESOLVE_CHANNEL,
  PROJECT_ENTRY_REVEAL_CHANNEL,
  PROJECT_FILE_READ_CHANNEL,
  PROJECT_FILE_SEARCH_CHANNEL,
  PROJECT_FILE_STAT_CHANNEL,
  PROJECT_FILE_WRITE_CHANNEL,
  isProjectDirectoryChange,
  isProjectDirectoryListResult,
  isProjectDirectoryWatchResult,
  isProjectEntryPathResult,
  isProjectEntryRevealResult,
  isProjectFileReadResult,
  isProjectFileSearchResult,
  isProjectFileStatResult,
  isProjectFileWriteResult
} from '../shared/project-file-api'
import type {
  ProjectDirectoryChange,
  ProjectDirectoryListRequest,
  ProjectDirectoryListResult,
  ProjectDirectoryWatchRequest,
  ProjectDirectoryWatchResult,
  ProjectEntryPathRequest,
  ProjectEntryPathResult,
  ProjectEntryRevealResult,
  ProjectFileApi,
  ProjectFileReadRequest,
  ProjectFileReadResult,
  ProjectFileSearchResult,
  ProjectFileStatRequest,
  ProjectFileStatResult,
  ProjectFileWriteRequest,
  ProjectFileWriteResult
} from '../shared/project-file-api'
import {
  GIT_COMMIT_CHANNEL,
  GIT_COMMIT_DETAIL_CHANNEL,
  GIT_COMMIT_DIFF_CHANNEL,
  GIT_DIFF_CHANNEL,
  GIT_DISCARD_CHANNEL,
  GIT_HISTORY_CHANNEL,
  GIT_PULL_CHANNEL,
  GIT_PUSH_CHANNEL,
  GIT_STAGE_CHANNEL,
  GIT_STATUS_CHANNEL,
  GIT_UNSTAGE_CHANNEL,
  isGitCommitDetailResult,
  isGitCommitDiffResult,
  isGitDiffResult,
  isGitHistoryResult,
  isGitStatusResult
} from '../shared/git-api'
import type {
  GitApi,
  GitCommitDetailRequest,
  GitCommitDetailResult,
  GitCommitDiffRequest,
  GitCommitDiffResult,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitHistoryRequest,
  GitHistoryResult,
  GitOperationResult,
  GitPathRequest,
  GitStatusResult
} from '../shared/git-api'
import {
  TERMINAL_ACK_CHANNEL,
  TERMINAL_CLOSE_ALL_CHANNEL,
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_DAEMON_STATUS_CHANNEL,
  TERMINAL_DAEMON_STATUS_EVENT,
  TERMINAL_DAEMON_STOP_CHANNEL,
  TERMINAL_DAEMON_STOP_STALE_CHANNEL,
  TERMINAL_DATA_EVENT,
  TERMINAL_EXIT_EVENT,
  TERMINAL_LIST_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_SNAPSHOTS_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  isTerminalCommandResult,
  isTerminalDaemonStatus,
  isTerminalDaemonStatusResult,
  isTerminalDataEvent,
  isTerminalExitEvent,
  isTerminalSessionResult,
  isTerminalSessionsResult,
  isTerminalSnapshotsResult
} from '../shared/terminal-api'
import type {
  TerminalAckRequest,
  TerminalApi,
  TerminalCloseRequest,
  TerminalCommandResult,
  TerminalCreateRequest,
  TerminalDaemonStatus,
  TerminalDaemonStatusResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalListRequest,
  TerminalResizeRequest,
  TerminalSessionResult,
  TerminalSessionsResult,
  TerminalSnapshotsResult,
  TerminalWriteRequest
} from '../shared/terminal-api'
import {
  SESSION_DELETE_CHANNEL,
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  SESSION_RELOAD_CHANNEL,
  isSessionListResult,
  isSessionOpenResult
} from '../shared/session-api'
import type {
  SessionApi,
  SessionDeleteRequest,
  SessionListRequest,
  SessionListResult,
  SessionOpenRequest
} from '../shared/session-api'
import {
  SESSION_RUNS_STATE_CHANNEL,
  SESSION_RUNS_EVENT,
  SESSION_RUN_RELEASE_CHANNEL,
  SESSION_RUN_CLOSE_CHANNEL,
  isSessionRunsEvent,
  isSessionRunsResult,
  isSessionRunReleaseResult
} from '../shared/session-run-api'
import type {
  SessionRunApi,
  SessionRunReleaseRequest,
  SessionRunReleaseResult,
  SessionRunsResult,
  SessionRunsSnapshot
} from '../shared/session-run-api'
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
  UPDATES_CHECK_CHANNEL,
  UPDATES_GET_CHANNEL,
  UPDATES_INSTALL_AGENT_CHANNEL,
  UPDATES_INSTALL_AGENT_PROGRESS_EVENT,
  UPDATES_REINSTALL_AGENT_CHANNEL,
  UPDATES_RESET_AGENT_RUNTIME_CHANNEL,
  UPDATES_STATE_EVENT,
  UPDATES_UPDATE_CHANNEL,
  UPDATES_UPDATE_OUTCOME_EVENT,
  UPDATES_UPDATE_PROGRESS_EVENT,
  isAgentInstallProgress,
  isAgentInstallResult,
  isAgentRuntimeResetResult,
  isPackageUpdateOutcome,
  isPackageUpdateProgress,
  isPackageUpdateResult,
  isUpdatesResult,
  isUpdatesSnapshot
} from '../shared/updates-api'
import type {
  AgentInstallProgress,
  AgentInstallResult,
  AgentRuntimeResetResult,
  PackageUpdateOutcome,
  PackageUpdateProgress,
  PackageUpdateResult,
  UpdatesApi,
  UpdatesResult,
  UpdatesSnapshot
} from '../shared/updates-api'
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
  RUNTIME_COMPACT_CHANNEL,
  RUNTIME_SET_MODEL_CHANNEL,
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_MCP_COMMAND_CHANNEL,
  RUNTIME_MCP_CONFIG_CHANNEL,
  RUNTIME_MCP_INSPECT_ABORT_CHANNEL,
  RUNTIME_MCP_INSPECT_CHANNEL,
  RUNTIME_MCP_STATUS_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_REWIND_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_HISTORY_CHANNEL,
  isRuntimeHistoryResult,
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_RESOURCES_CHANNEL,
  RUNTIME_RESOURCE_PREVIEW_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
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
  isRuntimeRewindResult,
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
  ModelIdentity,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  ResourcesResult,
  ResourcePreviewResult,
  RuntimeApi,
  RuntimeCompactRequest,
  RuntimeDiagnosticsResult,
  RuntimeHistoryRequest,
  RuntimeResult,
  RuntimeSetModelRequest,
  RuntimeRewindRequest,
  RuntimeStatus,
  RuntimeTarget
} from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'
const INVALID_PROMPT_RESPONSE = '桌面接口返回了无法识别的 Prompt 结果。'
const INVALID_PROJECTION_RESPONSE = '桌面接口返回了无法识别的投影快照。'
const INVALID_CAPABILITIES_RESPONSE = '桌面接口返回了无法识别的模型列表结果。'
const INVALID_PROJECT_PATH_RESPONSE = '桌面接口返回了无法识别的目录选择结果。'
const INVALID_PROJECT_LIST_RESPONSE = '桌面接口返回了无法识别的项目列表。'
const INVALID_PROJECT_FILE_RESPONSE = '桌面接口返回了无法识别的文件检索结果。'
const INVALID_PROJECT_DIRECTORY_RESPONSE = '桌面接口返回了无法识别的目录列举结果。'
const INVALID_PROJECT_DIRECTORY_WATCH_RESPONSE = '桌面接口返回了无法识别的目录监听登记结果。'
const INVALID_PROJECT_ENTRY_PATH_RESPONSE = '桌面接口返回了无法识别的条目路径解析结果。'
const INVALID_PROJECT_ENTRY_REVEAL_RESPONSE = '桌面接口返回了无法识别的显示文件位置结果。'
const INVALID_PROJECT_FILE_READ_RESPONSE = '桌面接口返回了无法识别的文件读取结果。'
const INVALID_PROJECT_FILE_WRITE_RESPONSE = '桌面接口返回了无法识别的文件保存结果。'
const INVALID_PROJECT_FILE_STAT_RESPONSE = '桌面接口返回了无法识别的文件状态结果。'
const INVALID_GIT_RESPONSE = '桌面接口返回了无法识别的 Git 结果。'
const INVALID_SESSION_LIST_RESPONSE = '桌面接口返回了无法识别的会话列表。'
const INVALID_SESSION_RUNS_RESPONSE = '桌面接口返回了无法识别的会话运行状态。'
const INVALID_PREFERENCES_RESPONSE = '桌面接口返回了无法识别的界面偏好。'
const INVALID_MODEL_DISPLAY_RESPONSE = '桌面接口返回了无法识别的对话页模型展示偏好。'
const INVALID_QUICK_SEND_RESPONSE = '桌面接口返回了无法识别的快捷发送短语。'
const INVALID_QUICK_COMMANDS_RESPONSE = '桌面接口返回了无法识别的快捷命令清单。'
const INVALID_AUTO_UPDATE_RESPONSE = '桌面接口返回了无法识别的扩展自动更新开关。'
const INVALID_GENUI_RESPONSE = '桌面接口返回了无法识别的生成式 UI 开关。'
const INVALID_GENUI_PARAMS_GET_RESPONSE = '桌面接口返回了无法识别的界面参数记录。'
const INVALID_GENUI_PARAMS_SAVE_RESPONSE = '桌面接口返回了无法识别的界面参数保存结果。'
const INVALID_GENUI_PARAMS_CLEAR_RESPONSE = '桌面接口返回了无法识别的界面参数清除结果。'
const INVALID_MODELS_CONFIG_RESPONSE = '桌面接口返回了无法识别的自定义供应商配置。'
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
const INVALID_UPDATES_RESPONSE = '桌面接口返回了无法识别的版本检查结果。'
const INVALID_PACKAGE_UPDATE_RESPONSE = '桌面接口返回了无法识别的扩展更新结果。'
const INVALID_AGENT_INSTALL_RESPONSE = '桌面接口返回了无法识别的内置 Pi agent 安装结果。'
const INVALID_AGENT_RUNTIME_RESET_RESPONSE = '桌面接口返回了无法识别的运行时指针清除结果。'
const INVALID_TERMINAL_SESSION_RESPONSE = '桌面接口返回了无法识别的终端状态。'
const INVALID_TERMINAL_SESSIONS_RESPONSE = '桌面接口返回了无法识别的终端清单。'
const INVALID_TERMINAL_COMMAND_RESPONSE = '桌面接口返回了无法识别的终端操作结果。'
const INVALID_TERMINAL_SNAPSHOTS_RESPONSE = '桌面接口返回了无法识别的终端快照。'
const INVALID_TERMINAL_DAEMON_STATUS_RESPONSE = '桌面接口返回了无法识别的终端守护进程状态。'

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

function invalidProjectDirectoryResponse(): ProjectDirectoryListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_DIRECTORY_RESPONSE } }
}

function invalidProjectDirectoryWatchResponse(): ProjectDirectoryWatchResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_DIRECTORY_WATCH_RESPONSE } }
}

function invalidProjectEntryPathResponse(): ProjectEntryPathResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_ENTRY_PATH_RESPONSE } }
}

function invalidProjectEntryRevealResponse(): ProjectEntryRevealResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_ENTRY_REVEAL_RESPONSE } }
}

function invalidProjectFileReadResponse(): ProjectFileReadResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_READ_RESPONSE } }
}

function invalidProjectFileWriteResponse(): ProjectFileWriteResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_WRITE_RESPONSE } }
}

function invalidProjectFileStatResponse(): ProjectFileStatResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_STAT_RESPONSE } }
}

function invalidGitStatusResponse(): GitStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitDiffResponse(): GitDiffResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitHistoryResponse(): GitHistoryResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitCommitDetailResponse(): GitCommitDetailResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitCommitDiffResponse(): GitCommitDiffResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidSessionResponse(): Extract<SessionListResult, { ok: false }> {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_SESSION_LIST_RESPONSE } }
}

function invalidSessionRunsResponse(): SessionRunsResult {
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: INVALID_SESSION_RUNS_RESPONSE } }
}

function invalidSessionRunReleaseResponse(): SessionRunReleaseResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_SESSION_RUNS_RESPONSE } }
}

function invalidTerminalSessionResponse(): TerminalSessionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SESSION_RESPONSE } }
}

function invalidTerminalSessionsResponse(): TerminalSessionsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SESSIONS_RESPONSE } }
}

function invalidTerminalCommandResponse(): TerminalCommandResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_COMMAND_RESPONSE } }
}

function invalidTerminalSnapshotsResponse(): TerminalSnapshotsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_SNAPSHOTS_RESPONSE } }
}

function invalidTerminalDaemonStatusResponse(): TerminalDaemonStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_TERMINAL_DAEMON_STATUS_RESPONSE } }
}

function invalidPreferencesResponse(): PreferencesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PREFERENCES_RESPONSE } }
}

function invalidModelDisplayResponse(): ModelDisplayResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MODEL_DISPLAY_RESPONSE } }
}

function invalidQuickSendResponse(): QuickSendResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_QUICK_SEND_RESPONSE } }
}

function invalidAutoUpdateResponse(): AutoUpdateResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AUTO_UPDATE_RESPONSE } }
}

function invalidGenuiResponse(): GenuiResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GENUI_RESPONSE } }
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

function invalidQuickCommandsResponse(): QuickCommandsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_QUICK_COMMANDS_RESPONSE } }
}

function invalidModelsConfigResponse(): ModelsConfigResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MODELS_CONFIG_RESPONSE } }
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

function invalidUpdatesResponse(): UpdatesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_UPDATES_RESPONSE } }
}

function invalidPackageUpdateResponse(): PackageUpdateResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PACKAGE_UPDATE_RESPONSE } }
}

function invalidAgentInstallResponse(): AgentInstallResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AGENT_INSTALL_RESPONSE } }
}

function invalidAgentRuntimeResetResponse(): AgentRuntimeResetResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AGENT_RUNTIME_RESET_RESPONSE } }
}

const desktop: DesktopApi & RuntimeApi & ProjectApi & ProjectFileApi & SessionApi & SessionRunApi & TerminalApi & PreferencesApi & QuickCommandsApi & GenuiParamsApi & PiSettingsApi & TrustApi & ExtensionUiApi & AuthApi & ModelsConfigApi & UpdatesApi & GitApi = {
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

  /** 外链打开：只搬运地址，协议与凭据由主进程校验；响应结构不对时统一报无法识别。 */
  async openExternalUrl(request: OpenExternalUrlRequest): Promise<OpenExternalUrlResult> {
    const payload: OpenExternalUrlRequest = { url: request.url }
    const response: unknown = await ipcRenderer.invoke(OPEN_EXTERNAL_URL_CHANNEL, payload)
    return isOpenExternalUrlResult(response)
      ? response
      : { ok: false, error: { code: 'INVALID_RESPONSE', message: '桌面接口返回了无法识别的外链打开结果。' } }
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

  /** 读取指定项目的会话列表窗口；项目路径由主进程校验是否已添加，窗口大小由页面按加载进度给出。 */
  async listSessions(request: SessionListRequest) {
    const payload: SessionListRequest = { projectPath: request.projectPath, limit: request.limit }
    const response: unknown = await ipcRenderer.invoke(SESSION_LIST_CHANNEL, payload)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  /** 在当前项目内检索文件候选；只搬运查询串，检索根由主进程决定。 */
  async searchProjectFiles(query: string) {
    const request = { query }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_SEARCH_CHANNEL, request)
    return isProjectFileSearchResult(response) ? response : invalidProjectFileResponse()
  },

  /** 在当前项目内列举一层目录；只搬运相对目录路径，根路径与越界判定都在主进程。 */
  async listProjectDirectory(request: ProjectDirectoryListRequest) {
    const payload: ProjectDirectoryListRequest = { directory: request.directory }
    const response: unknown = await ipcRenderer.invoke(PROJECT_DIRECTORY_LIST_CHANNEL, payload)
    return isProjectDirectoryListResult(response) ? response : invalidProjectDirectoryResponse()
  },

  /** 提交当前项目里需要监听的目录集合；主进程按集合增删非递归监听，越界路径直接丢弃。 */
  async watchProjectDirectories(request: ProjectDirectoryWatchRequest) {
    const payload: ProjectDirectoryWatchRequest = { directories: request.directories }
    const response: unknown = await ipcRenderer.invoke(PROJECT_DIRECTORY_WATCH_CHANNEL, payload)
    return isProjectDirectoryWatchResult(response) ? response : invalidProjectDirectoryWatchResponse()
  },

  /**
   * 订阅目录变化；载荷不可信，契约不符时丢弃。
   * 回调只代表「这些已登记的目录层有变化」，具体重读哪一层由页面决定。
   */
  onProjectDirectoryChanged(listener: (change: ProjectDirectoryChange) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isProjectDirectoryChange(payload)) return
      listener(payload)
    }
    ipcRenderer.on(PROJECT_DIRECTORY_CHANGED_EVENT, handler)
    return () => {
      ipcRenderer.off(PROJECT_DIRECTORY_CHANGED_EVENT, handler)
    }
  },

  /** 把项目内相对条目路径交给主进程解析为绝对路径；页面不自行拼接路径，也不传绝对路径。 */
  async resolveProjectEntryPath(request: ProjectEntryPathRequest) {
    const payload: ProjectEntryPathRequest = { path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ENTRY_RESOLVE_CHANNEL, payload)
    return isProjectEntryPathResult(response) ? response : invalidProjectEntryPathResponse()
  },

  /** 在系统文件管理器中显示一个项目内条目；路径解析、越界判定与存在性检查都在主进程。 */
  async revealProjectEntry(request: ProjectEntryPathRequest) {
    const payload: ProjectEntryPathRequest = { path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ENTRY_REVEAL_CHANNEL, payload)
    return isProjectEntryRevealResult(response) ? response : invalidProjectEntryRevealResponse()
  },

  /** 读取指定项目内文件；固定项目归属，内容分类与大小上限由主进程判定。 */
  async readProjectFile(request: ProjectFileReadRequest) {
    const payload: ProjectFileReadRequest = { projectPath: request.projectPath, path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_READ_CHANNEL, payload)
    return isProjectFileReadResult(response) ? response : invalidProjectFileReadResponse()
  },

  /** 保存项目内文本文件；只搬运相对路径、文本与磁盘基线，越界与符号链接由主进程拒绝。 */
  async writeProjectFile(request: ProjectFileWriteRequest) {
    const payload: ProjectFileWriteRequest = {
      projectPath: request.projectPath,
      path: request.path,
      text: request.text,
      eol: request.eol,
      bom: request.bom,
      expected: request.expected === null
        ? null
        : { size: request.expected.size, mtimeMs: request.expected.mtimeMs }
    }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_WRITE_CHANNEL, payload)
    return isProjectFileWriteResult(response) ? response : invalidProjectFileWriteResponse()
  },

  /** 查询项目内文件的磁盘基线；只回元数据，不读内容。 */
  async statProjectFile(request: ProjectFileStatRequest) {
    const payload: ProjectFileStatRequest = { projectPath: request.projectPath, path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_STAT_CHANNEL, payload)
    return isProjectFileStatResult(response) ? response : invalidProjectFileStatResponse()
  },

  async openSession(request: SessionOpenRequest) {
    const payload: SessionOpenRequest = {
      projectPath: request.projectPath, sessionId: request.sessionId,
      allowInterrupt: request.allowInterrupt, listLimit: request.listLimit
    }
    const response: unknown = await ipcRenderer.invoke(SESSION_OPEN_CHANNEL, payload)
    return isSessionOpenResult(response) ? response : invalidSessionResponse()
  },

  async reloadSession(allowInterrupt: boolean, listLimit: number) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RELOAD_CHANNEL, { allowInterrupt, listLimit })
    return isSessionOpenResult(response) ? response : invalidSessionResponse()
  },

  /** 删除会话：只搬运声明字段；主进程负责归属校验、占用收敛与文件删除。 */
  async deleteSession(request: SessionDeleteRequest) {
    const payload: SessionDeleteRequest = {
      projectPath: request.projectPath,
      sessionId: request.sessionId,
      allowInterrupt: request.allowInterrupt,
      listLimit: request.listLimit
    }
    const response: unknown = await ipcRenderer.invoke(SESSION_DELETE_CHANNEL, payload)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  /** 读取应用内全部运行实例的粗粒度状态；零参数，不建立宿主。 */
  async getSessionRuns() {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUNS_STATE_CHANNEL)
    return isSessionRunsResult(response) ? response : invalidSessionRunsResponse()
  },

  onSessionRunsChanged(listener: (snapshot: SessionRunsSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：契约不符时丢弃，由下一次查询或事件收敛。
      if (!isSessionRunsEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(SESSION_RUNS_EVENT, handler)
    return () => {
      ipcRenderer.off(SESSION_RUNS_EVENT, handler)
    }
  },

  /** 释放一个未确认退出或宿主已失败的运行实例；只搬运运行实例身份，不传其他字段。 */
  async releaseSessionRun(request: SessionRunReleaseRequest) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUN_RELEASE_CHANNEL, { runId: request.runId })
    return isSessionRunReleaseResult(response) ? response : invalidSessionRunReleaseResponse()
  },

  /** 结束一个运行实例（中断在途工作、解除占用并关闭宿主）；同样只搬运运行实例身份。 */
  async closeSessionRun(request: SessionRunReleaseRequest) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUN_CLOSE_CHANNEL, { runId: request.runId })
    return isSessionRunReleaseResult(response) ? response : invalidSessionRunReleaseResponse()
  },

  /** 在已添加的项目内新建终端；shell、环境变量与工作目录都由主进程决定。 */
  async createTerminal(request: TerminalCreateRequest) {
    const payload: TerminalCreateRequest = {
      projectPath: request.projectPath,
      cols: request.cols,
      rows: request.rows
    }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CREATE_CHANNEL, payload)
    return isTerminalSessionResult(response) ? response : invalidTerminalSessionResponse()
  },

  /** 把用户输入写入终端；只搬运终端标识与文本，不传尺寸或路径。 */
  async writeTerminal(request: TerminalWriteRequest) {
    const payload: TerminalWriteRequest = { id: request.id, data: request.data }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_WRITE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  /** 同步终端尺寸；行列数由页面按实际显示区域给出，主进程校验取值范围。 */
  async resizeTerminal(request: TerminalResizeRequest) {
    const payload: TerminalResizeRequest = { id: request.id, cols: request.cols, rows: request.rows }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_RESIZE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  /** 关闭终端并收敛其进程树；只搬运终端标识。 */
  async closeTerminal(request: TerminalCloseRequest) {
    const payload: TerminalCloseRequest = { id: request.id }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CLOSE_CHANNEL, payload)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  /** 读取终端清单；项目路径为 null 时列全部，供页面重新挂载后重建标签。 */
  async listTerminals(request: TerminalListRequest) {
    const payload: TerminalListRequest = { projectPath: request.projectPath }
    const response: unknown = await ipcRenderer.invoke(TERMINAL_LIST_CHANNEL, payload)
    return isTerminalSessionsResult(response) ? response : invalidTerminalSessionsResponse()
  },

  /** 读取全部终端的画面快照；页面重挂载后用它还原滚动历史。 */
  async fetchTerminalSnapshots() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_SNAPSHOTS_CHANNEL)
    return isTerminalSnapshotsResult(response) ? response : invalidTerminalSnapshotsResponse()
  },

  /** 关闭全部终端（含其他项目）；只用于用户显式清理常驻会话。 */
  async closeAllTerminals() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_CLOSE_ALL_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  /** 读取终端守护进程状态；不传参数，不暴露端点或 token。 */
  async getTerminalDaemonStatus() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STATUS_CHANNEL)
    return isTerminalDaemonStatusResult(response) ? response : invalidTerminalDaemonStatusResponse()
  },

  /** 结束协议版本不符的旧守护进程；只在用户显式操作时调用。 */
  async stopStaleTerminalDaemon() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STOP_STALE_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  /** 停止守护进程（含全部终端）；用于释放被终端占用的文件。 */
  async stopTerminalDaemon() {
    const response: unknown = await ipcRenderer.invoke(TERMINAL_DAEMON_STOP_CHANNEL)
    return isTerminalCommandResult(response) ? response : invalidTerminalCommandResponse()
  },

  onTerminalDaemonStatus(listener: (status: TerminalDaemonStatus) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 状态事件同样不可信：契约不符时丢弃，由下一次读取收敛。
      if (!isTerminalDaemonStatus(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_DAEMON_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_DAEMON_STATUS_EVENT, handler)
    }
  },

  /** 回报已消费的字符数；只释放背压额度，失败不重试也不产生未处理的拒绝。 */
  ackTerminalData(request: TerminalAckRequest) {
    void ipcRenderer
      .invoke(TERMINAL_ACK_CHANNEL, { id: request.id, chars: request.chars })
      .catch(() => undefined)
  },

  onTerminalData(listener: (event: TerminalDataEvent) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：契约不符时丢弃，由后续输出收敛。
      if (!isTerminalDataEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_DATA_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_DATA_EVENT, handler)
    }
  },

  onTerminalExit(listener: (event: TerminalExitEvent) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 退出事件同样不可信：契约不符时丢弃，由终端清单收敛。
      if (!isTerminalExitEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(TERMINAL_EXIT_EVENT, handler)
    return () => {
      ipcRenderer.off(TERMINAL_EXIT_EVENT, handler)
    }
  },

  async getTrustStatus(runId?: number) {
    // 不传身份时保持零参数调用，让主进程按当前项目解析。
    const response: unknown = runId === undefined
      ? await ipcRenderer.invoke(TRUST_STATUS_CHANNEL)
      : await ipcRenderer.invoke(TRUST_STATUS_CHANNEL, { runId })
    return isTrustStatusResult(response) ? response : invalidTrustResponse()
  },

  async decideTrust(projectPath: string, decision: TrustDecisionInput, runId?: number) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request = runId === undefined
      ? { projectPath, decision }
      : { projectPath, decision, runId }
    const response: unknown = await ipcRenderer.invoke(TRUST_DECIDE_CHANNEL, request)
    return isTrustDecisionResult(response) ? response : invalidTrustResponse()
  },

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

  async getPreferences() {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_CHANNEL)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  async getModelDisplay(): Promise<ModelDisplayResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_MODEL_DISPLAY_CHANNEL)
    return isModelDisplayResult(response) ? response : invalidModelDisplayResponse()
  },

  async setModelDisplay(preference: ModelDisplayPreference): Promise<ModelDisplayResult> {
    // 只搬运已声明的字段，并重建普通对象与数组，避免响应式代理跨 contextBridge。
    const payload: ModelDisplayPreference = {
      hiddenModels: preference.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
    }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_MODEL_DISPLAY_CHANNEL, payload)
    return isModelDisplayResult(response) ? response : invalidModelDisplayResponse()
  },

  async getQuickSend(): Promise<QuickSendResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_QUICK_SEND_CHANNEL)
    return isQuickSendResult(response) ? response : invalidQuickSendResponse()
  },

  async setQuickSend(preference: QuickSendPreference): Promise<QuickSendResult> {
    // 只搬运已声明的字段，并重建普通数组，避免响应式代理跨 contextBridge。
    const payload: QuickSendPreference = { messages: [...preference.messages] }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_QUICK_SEND_CHANNEL, payload)
    return isQuickSendResult(response) ? response : invalidQuickSendResponse()
  },

  async getAutoUpdate(): Promise<AutoUpdateResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_AUTO_UPDATE_CHANNEL)
    return isAutoUpdateResult(response) ? response : invalidAutoUpdateResponse()
  },

  async getQuickCommands(): Promise<QuickCommandsResult> {
    const response: unknown = await ipcRenderer.invoke(QUICK_COMMANDS_GET_CHANNEL)
    return isQuickCommandsResult(response) ? response : invalidQuickCommandsResponse()
  },

  async setQuickCommands(preference: QuickCommandsPreference): Promise<QuickCommandsResult> {
    // 只搬运已声明的字段，并逐条重建普通对象，避免响应式代理跨 contextBridge。
    const payload: QuickCommandsPreference = {
      commands: preference.commands.map((command): QuickCommand => ({
        id: command.id,
        label: command.label,
        command: command.command,
        appendEnter: command.appendEnter === true,
        scope: command.scope,
        projectPath: command.projectPath
      }))
    }
    const response: unknown = await ipcRenderer.invoke(QUICK_COMMANDS_SET_CHANNEL, payload)
    return isQuickCommandsResult(response) ? response : invalidQuickCommandsResponse()
  },

  async setAutoUpdate(preference: AutoUpdatePreference): Promise<AutoUpdateResult> {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const payload: AutoUpdatePreference = { enabled: preference.enabled === true }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_AUTO_UPDATE_CHANNEL, payload)
    return isAutoUpdateResult(response) ? response : invalidAutoUpdateResponse()
  },

  async getGenui(): Promise<GenuiResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_GENUI_CHANNEL)
    return isGenuiResult(response) ? response : invalidGenuiResponse()
  },

  async setGenui(preference: GenuiPreference): Promise<GenuiResult> {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const payload: GenuiPreference = { enabled: preference.enabled === true }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_GENUI_CHANNEL, payload)
    return isGenuiResult(response) ? response : invalidGenuiResponse()
  },

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

  async setUiPreferences(ui: UiPreferences) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request: UiPreferences = {
      sidebarCollapsed: ui.sidebarCollapsed,
      theme: ui.theme,
      expandedProjects: [...ui.expandedProjects],
      rightPanelOpen: ui.rightPanelOpen,
      rightPanelWidth: ui.rightPanelWidth,
      rightPanelTab: ui.rightPanelTab,
      markdownDefaultView: ui.markdownDefaultView
    }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_UI_CHANNEL, request)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  /** 自定义供应商快照：零参数；这次读取同时刷新主进程后续保存的比对基线。 */
  async getModelsConfig(): Promise<ModelsConfigResult> {
    const response: unknown = await ipcRenderer.invoke(MODELS_CONFIG_GET_CHANNEL)
    return isModelsConfigResult(response) ? response : invalidModelsConfigResponse()
  },

  /** 新增或替换一个供应商条目：只搬运已声明的两个字段，不把页面对象整体转交。 */
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

  async getRuntimeStatus() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_STATUS_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async abortRuntime(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_ABORT_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async sendPrompt(target: RuntimeTarget, message: string, images?: readonly PromptImageInput[]) {
    // 只搬运已声明的字段：目标逐字段重建，图片附件逐条重建，不带页面传入的其他内容。
    const payloadImages = (images ?? []).map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      data: image.data
    }))
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROMPT_CHANNEL, {
      target: { runId: target.runId, runtimeId: target.runtimeId },
      message,
      ...(payloadImages.length > 0 ? { images: payloadImages } : {})
    })
    return isPromptResult(response) ? response : invalidPromptResponse()
  },

  async rewindRuntime(request: RuntimeRewindRequest) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_REWIND_CHANNEL, {
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      messageId: request.messageId
    })
    return isRuntimeRewindResult(response)
      ? response
      : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '桌面接口返回了无法识别的回退结果。' }, blocked: true }
  },

  async getRuntimeProjection(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROJECTION_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isProjectionResult(response) ? response : invalidProjectionResponse()
  },

  async readRuntimeHistory(request: RuntimeHistoryRequest) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_HISTORY_CHANNEL, {
      runId: request.runId, runtimeId: request.runtimeId, sessionId: request.sessionId, revision: request.revision, query: { ...request.query }
    })
    return isRuntimeHistoryResult(response) ? response
      : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '桌面接口返回了无法识别的历史记录。' } }
  },

  async getRuntimeCapabilities(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_CAPABILITIES_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isCapabilitiesResult(response) ? response : invalidCapabilitiesResponse()
  },

  /** 只传运行身份、代际与模型身份；不向页面开放任意 RPC，也不接受持久化选项。 */
  async setRuntimeModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
    const payload: RuntimeSetModelRequest = {
      runId: request.runId,
      runtimeId: request.runtimeId,
      provider: request.provider,
      modelId: request.modelId
    }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_SET_MODEL_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  /** 手动压缩只搬运目标身份与可选说明文本；压缩过程与结果由投影事件表达。 */
  async compactRuntime(request: RuntimeCompactRequest): Promise<RuntimeResult> {
    const payload: RuntimeCompactRequest = {
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      instructions: request.instructions
    }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_COMPACT_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async getRuntimeResources(target: RuntimeTarget): Promise<ResourcesResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCES_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isResourcesResult(response) ? response : invalidResourcesResponse()
  },

  /** 共享预读资源、可用模型与默认模型及分项错误；项目与信任由主进程决定，`force` 绕过缓存。 */
  async getResourcePreview(force: boolean): Promise<ResourcePreviewResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCE_PREVIEW_CHANNEL, { force })
    return isResourcePreviewResult(response) ? response : invalidResourcePreviewResponse()
  },

  async getRuntimeDiagnostics(target: RuntimeTarget): Promise<RuntimeDiagnosticsResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_DIAGNOSTICS_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isRuntimeDiagnosticsResult(response) ? response : invalidDiagnosticsResponse()
  },

  async readRuntimeMcpStatus(target: RuntimeTarget): Promise<McpStatusResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_STATUS_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isMcpStatusResult(response) ? response : invalidMcpStatusResponse()
  },

  /** MCP 登录/退出/重连：只搬运目标与已声明的字段；命令文本由主进程拼出。 */
  async runRuntimeMcpCommand(
    target: RuntimeTarget,
    action: McpCommandAction,
    serverName: string
  ): Promise<McpCommandResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_COMMAND_CHANNEL, {
      target: { runId: target.runId, runtimeId: target.runtimeId },
      action,
      serverName
    })
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

  ackRuntimeProjection(target: RuntimeTarget, seq: number) {
    // 应用确认失败只影响通知窗口，不应产生未处理的拒绝。
    void ipcRenderer
      .invoke(RUNTIME_PROJECTION_ACK_CHANNEL, {
        target: { runId: target.runId, runtimeId: target.runtimeId },
        seq
      })
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
  },

  async getUpdates(): Promise<UpdatesResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_GET_CHANNEL)
    return isUpdatesResult(response) ? response : invalidUpdatesResponse()
  },

  async checkUpdates(): Promise<UpdatesResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_CHECK_CHANNEL)
    return isUpdatesResult(response) ? response : invalidUpdatesResponse()
  },

  onUpdatesChanged(listener: (snapshot: UpdatesSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 快照载荷同样不可信：契约不符时丢弃，由下一次快照收敛。
      if (!isUpdatesSnapshot(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_STATE_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_STATE_EVENT, handler)
    }
  },

  async updatePackages(source?: string): Promise<PackageUpdateResult> {
    const response: unknown = await ipcRenderer.invoke(
      UPDATES_UPDATE_CHANNEL,
      ...(source === undefined ? [] : [source])
    )
    return isPackageUpdateResult(response) ? response : invalidPackageUpdateResponse()
  },

  onPackageUpdateProgress(listener: (progress: PackageUpdateProgress) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 进度载荷同样不可信：契约不符时丢弃，由后续进度或结论收敛。
      if (!isPackageUpdateProgress(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_UPDATE_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_UPDATE_PROGRESS_EVENT, handler)
    }
  },

  onPackageUpdateOutcome(listener: (outcome: PackageUpdateOutcome) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 结论载荷同样不可信：契约不符时丢弃，由下一次更新或重查收敛。
      if (!isPackageUpdateOutcome(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_UPDATE_OUTCOME_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_UPDATE_OUTCOME_EVENT, handler)
    }
  },

  async installAgentRuntime(version?: string): Promise<AgentInstallResult> {
    const response: unknown = await ipcRenderer.invoke(
      UPDATES_INSTALL_AGENT_CHANNEL,
      ...(version === undefined ? [] : [version])
    )
    return isAgentInstallResult(response) ? response : invalidAgentInstallResponse()
  },

  onAgentInstallProgress(listener: (progress: AgentInstallProgress) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 进度载荷同样不可信：契约不符时丢弃，由后续进度或结论收敛。
      if (!isAgentInstallProgress(payload)) return
      listener(payload)
    }
    ipcRenderer.on(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, handler)
    return () => {
      ipcRenderer.off(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, handler)
    }
  },

  async reinstallAgentRuntime(version: string): Promise<AgentInstallResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_REINSTALL_AGENT_CHANNEL, version)
    return isAgentInstallResult(response) ? response : invalidAgentInstallResponse()
  },

  async resetAgentRuntime(): Promise<AgentRuntimeResetResult> {
    const response: unknown = await ipcRenderer.invoke(UPDATES_RESET_AGENT_RUNTIME_CHANNEL)
    return isAgentRuntimeResetResult(response) ? response : invalidAgentRuntimeResetResponse()
  },

  /** 源代码管理：状态、差异、历史、四个写操作与拉取/推送；参数只重建契约里声明的字段。 */
  async getGitStatus(): Promise<GitStatusResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_STATUS_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_DIFF_CHANNEL, { path: request.path, area: request.area })
    return isGitDiffResult(response) ? response : invalidGitDiffResponse()
  },

  async stageGitPaths(request: GitPathRequest): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_STAGE_CHANNEL, { path: request.path })
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async unstageGitPaths(request: GitPathRequest): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_UNSTAGE_CHANNEL, { path: request.path })
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async discardGitPath(request: GitPathRequest): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_DISCARD_CHANNEL, { path: request.path })
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async commitGitStaged(request: GitCommitRequest): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_CHANNEL, { message: request.message })
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async pullGit(): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_PULL_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async pushGit(): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_PUSH_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async getGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_HISTORY_CHANNEL, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.skip === undefined ? {} : { skip: request.skip }),
      ...(request.path === undefined ? {} : { path: request.path })
    })
    return isGitHistoryResult(response) ? response : invalidGitHistoryResponse()
  },

  async getGitCommitDetail(request: GitCommitDetailRequest): Promise<GitCommitDetailResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_DETAIL_CHANNEL, { oid: request.oid })
    return isGitCommitDetailResult(response) ? response : invalidGitCommitDetailResponse()
  },

  async getGitCommitDiff(request: GitCommitDiffRequest): Promise<GitCommitDiffResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_DIFF_CHANNEL, {
      oid: request.oid,
      path: request.path,
      ...(request.oldPath === undefined ? {} : { oldPath: request.oldPath })
    })
    return isGitCommitDiffResult(response) ? response : invalidGitCommitDiffResponse()
  }
}

contextBridge.exposeInMainWorld('desktop', desktop)
