/** 管理唯一桌面窗口、本地资产边界，以及应用信息、Project 选择/添加/移除、项目文件检索与目录列举、Session 与 Project Trust、会话运行状态（查询、释放与结束）、内置终端（PTY）、界面偏好、Runtime、Pi 默认模型、自定义供应商配置、认证、Pi 版本检查、Extension IPC、事件广播及退出编排。 */
import { mkdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, session } from 'electron'
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron'
import { APP_INFO_CHANNEL } from '../shared/desktop-api'
import type { AppInfoResult, DesktopErrorCode } from '../shared/desktop-api'
import { devServerPortFromEnv } from '../shared/dev-server'
import {
  PREFERENCES_GET_CHANNEL,
  PREFERENCES_SET_UI_CHANNEL,
  PREFERENCES_GET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_SET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_GET_QUICK_SEND_CHANNEL,
  PREFERENCES_SET_QUICK_SEND_CHANNEL,
  PREFERENCES_GET_AUTO_UPDATE_CHANNEL,
  PREFERENCES_SET_AUTO_UPDATE_CHANNEL
} from '../shared/preferences-api'
import type { AutoUpdateResult, ModelDisplayResult, PreferencesErrorCode, PreferencesResult, QuickSendResult } from '../shared/preferences-api'
import { isAutoUpdatePreference, isUiPreferences, isModelDisplayPreference, isQuickSendPreference } from '../shared/preferences-api'
import type { UiTheme } from '../shared/preferences-api'
import {
  PROJECT_ADD_CHANNEL,
  PROJECT_CHOOSE_DIRECTORY_CHANNEL,
  PROJECT_LIST_CHANNEL,
  PROJECT_REMOVE_CHANNEL,
  PROJECT_SET_CURRENT_CHANNEL
} from '../shared/project-api'
import type {
  ProjectAddRequest,
  ProjectErrorCode,
  ProjectListResult,
  ProjectPathResult,
  ProjectRemoveRequest
} from '../shared/project-api'
import {
  PROJECT_DIRECTORY_LIST_CHANNEL,
  PROJECT_ENTRY_RESOLVE_CHANNEL,
  PROJECT_ENTRY_REVEAL_CHANNEL,
  PROJECT_FILE_QUERY_MAX_CHARS,
  PROJECT_FILE_SEARCH_CHANNEL,
  isProjectEntryPathRequest
} from '../shared/project-file-api'
import type {
  ProjectDirectoryListResult,
  ProjectEntryPathResult,
  ProjectEntryRevealResult,
  ProjectFileSearchResult
} from '../shared/project-file-api'
import {
  TERMINAL_ACK_CHANNEL,
  TERMINAL_CLOSE_CHANNEL,
  TERMINAL_CREATE_CHANNEL,
  TERMINAL_DATA_EVENT,
  TERMINAL_EXIT_EVENT,
  TERMINAL_LIST_CHANNEL,
  TERMINAL_RESIZE_CHANNEL,
  TERMINAL_WRITE_CHANNEL,
  isTerminalAckRequest,
  isTerminalCloseRequest,
  isTerminalCreateRequest,
  isTerminalListRequest,
  isTerminalResizeRequest,
  isTerminalWriteRequest
} from '../shared/terminal-api'
import type {
  TerminalCommandResult,
  TerminalDataEvent,
  TerminalErrorCode,
  TerminalExitEvent,
  TerminalSessionResult,
  TerminalSessionsResult
} from '../shared/terminal-api'
import {
  SESSION_DELETE_CHANNEL,
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  SESSION_RELOAD_CHANNEL,
  isSessionDeleteRequest,
  isSessionListRequest,
  isSessionListWindow
} from '../shared/session-api'
import type {
  SessionDeleteResult,
  SessionErrorCode,
  SessionListResult,
  SessionOpenResult
} from '../shared/session-api'
import {
  SESSION_RUNS_STATE_CHANNEL,
  SESSION_RUNS_EVENT,
  SESSION_RUN_RELEASE_CHANNEL,
  SESSION_RUN_CLOSE_CHANNEL,
  isSessionRunReleaseRequest
} from '../shared/session-run-api'
import type {
  SessionRunReleaseResult,
  SessionRunsResult,
  SessionRunsSnapshot
} from '../shared/session-run-api'
import {
  EXTENSION_UI_RESPOND_CHANNEL,
  EXTENSION_UI_STATE_CHANNEL,
  EXTENSION_UI_EVENT,
  isExtensionDialogResponseInput,
  isExtensionDialogTarget,
  isExtensionUiResult
} from '../shared/extension-ui-api'
import type {
  ExtensionDialogResponseInput,
  ExtensionUiErrorCode,
  ExtensionUiResult,
  ExtensionUiSnapshot
} from '../shared/extension-ui-api'
import {
  TRUST_DECIDE_CHANNEL,
  TRUST_STATUS_CHANNEL,
  isTrustDecision,
  isTrustDecisionInput,
  isTrustStatus
} from '../shared/trust-api'
import type {
  TrustDecisionResult,
  TrustStatusResult
} from '../shared/trust-api'
import {
  AUTH_FLOW_EVENT,
  AUTH_LOGIN_CANCEL_CHANNEL,
  AUTH_LOGIN_RESPOND_CHANNEL,
  AUTH_LOGIN_START_CHANNEL,
  AUTH_LOGOUT_CHANNEL,
  AUTH_MAX_FLOW_ID_CHARS,
  AUTH_MAX_PROMPT_ID_CHARS,
  AUTH_MAX_PROVIDER_ID_CHARS,
  AUTH_MAX_SECRET_CHARS,
  AUTH_OPEN_URL_CHANNEL,
  AUTH_STATUS_CHANNEL,
  isAuthLoginRespondRequest,
  isAuthLoginStartRequest
} from '../shared/auth-api'
import type {
  AuthErrorCode,
  AuthFlowResult,
  AuthFlowSnapshot,
  AuthLogoutResult,
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
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_RESOURCES_CHANNEL,
  RUNTIME_RESOURCE_PREVIEW_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STATUS_EVENT,
  isResourcePreviewRequest,
  isRuntimeCompactRequest,
  isRuntimeSetModelRequest,
  isRuntimeRewindRequest,
  isRuntimeTarget
} from '../shared/runtime-api'
import type {
  CapabilitiesResult,
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
  RuntimeDiagnosticsResult,
  RuntimeErrorCode,
  RuntimeResult,
  RuntimeRewindResult,
  RuntimeStatus
} from '../shared/runtime-api'
import {
  MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
  MODELS_CONFIG_GET_CHANNEL,
  MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
  isModelsConfigDeleteRequest,
  isModelsConfigSaveRequest
} from '../shared/models-config-api'
import type { ModelsConfigErrorCode, ModelsConfigResult } from '../shared/models-config-api'
import {
  PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL,
  PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL,
  isPiDefaultModelSetRequest
} from '../shared/pi-settings-api'
import type { PiDefaultModelResult } from '../shared/pi-settings-api'
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
  UPDATES_UPDATE_PROGRESS_EVENT
} from '../shared/updates-api'
import type {
  AgentInstallProgress,
  AgentInstallResult,
  AgentRuntimeResetResult,
  PackageUpdateOutcome,
  PackageUpdateProgress,
  PackageUpdateResult,
  PiAgentUpdateInfo,
  UpdatesResult,
  UpdatesSnapshot
} from '../shared/updates-api'
import { DesktopConfigStore } from './desktop-config-store'
import { AuthManager, AuthManagerError } from './auth-manager'
import { readMcpConfigListing } from './mcp-config-reader'
import { ModelsConfigError, ModelsConfigManager } from './models-config-manager'
import { PiSettingsError, PiSettingsManager } from './pi-settings-manager'
import { PreferencesManager } from './preferences-manager'
import { ProjectDirectoryReader } from './project-directory'
import { ProjectFileIndex } from './project-file-index'
import { ProjectManager } from './project-manager'
import { McpInspectionManager } from './mcp-inspection'
import { ResourcePreviewError, previewGlobalModels, previewProjectResources } from './resource-preview'
import { SdkHostManager } from './sdk-host-manager'
import { SdkRuntimeBridge } from './sdk-runtime-bridge'
import { SessionManager } from './session-manager'
import { SessionRunRegistry } from './session-run-registry'
import { TerminalManager } from './terminal-manager'
import { TrustManager, TrustManagerError } from './trust-manager'
import { UpdateChecker } from './update-checker'
import { PackageUpdater } from './package-updater'
import { PiAgentUpdater } from './pi-agent-updater'
import { getRuntimeRoot } from './pi-runtime'
import { applyLoginShellPath } from './shell-path'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, WindowState } from './window-state'

const DEVELOPMENT_PAGE_URL = `http://127.0.0.1:${devServerPortFromEnv(process.env.PI_DESK_DEV_SERVER_PORT)}/`
const APPLICATION_PAGE_URL = 'app://desktop/index.html'
/** 应用退出时等待关闭链的总预算；覆盖各平台兜底阶段后强制退出。 */
const QUIT_DEADLINE_MS = 10_000
/** 窗口状态落盘的等待上限；超过就继续关闭链，不让小文件写入拖住退出。 */
const WINDOW_STATE_FLUSH_MS = 1_000
/** 窗口背景色的浅色与暗色值；与 main.css 的 canvas 令牌保持一致，避免首帧闪烁。 */
const LIGHT_WINDOW_BACKGROUND = '#f4f6f8'
const DARK_WINDOW_BACKGROUND = '#10161c'
/** 页面自绘顶部栏的高度；与 main.css 的 `.app-titlebar` 及 Windows/Linux 覆盖层高度共用同一数值。 */
const TITLEBAR_HEIGHT = 44
/** 顶部栏底色与窗口按钮图标色的浅色/暗色值；与 main.css 的 surface、ink 令牌保持一致。 */
const LIGHT_WINDOW_SURFACE = '#ffffff'
const DARK_WINDOW_SURFACE = '#1a222b'
const LIGHT_WINDOW_INK = '#17252f'
const DARK_WINDOW_INK = '#dce6ee'
const rendererRoot = resolve(__dirname, '../renderer')
const productionCsp = [
  "default-src 'none'",
  "script-src 'self'",
  // 终端组件在运行时按测量结果写样式（xterm 的滚动条颜色等），因此样式源放开内联；
  // 脚本仍然只允许自身，页面也不加载任何远程内容。
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  // data: 与 blob: 仅用于本地图片附件的缩略图展示；不放开远程图片。
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')
const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

let mainWindow: BrowserWindow | null = null
let quittingAfterShutdown = false
/** 会话运行注册表：应用级运行身份、绑定代际与会话占用的唯一登记处。 */
const sessionRuns = new SessionRunRegistry<SdkHostManager>()
/** 页面会话主链后端：按注册表定位运行实例，宿主按需建立，失败分类在此映射回既有 Runtime 契约。 */
const sdkRuntime = new SdkRuntimeBridge({
  runs: sessionRuns,
  // 授权回路接主进程会话编排：宿主不能自行授权项目或任意会话路径。
  createHost: (runId) => {
    const host = new SdkHostManager({ runId, runs: sessionRuns })
    host.setSessionAuthority((reference, ownerProjectPath) => sessionManager.prepareSdkTarget(reference, ownerProjectPath))
    return host
  }
})
/** 本地配置文件的唯一读写者；本文件的所有字段共用同一份配置与写入队列。 */
const configStore = new DesktopConfigStore()
const trustManager = new TrustManager({ store: configStore })
const projectManager = new ProjectManager({
  chooseDirectory: chooseDirectoryWithDialog,
  runtime: sdkRuntime,
  store: configStore,
  trust: trustManager,
  runs: sessionRuns
})
const sessionManager = new SessionManager({
  projects: projectManager,
  sdk: sdkRuntime,
  projectsTrust: trustManager,
  ownership: sessionRuns
})
/** MCP 服务器探测与取消：与当前会话无关，只按项目跑一次性官方 CLI 进程。 */
const mcpInspection = new McpInspectionManager()
/** Pi 版本检查：启动时后台跑一次，之后按页面请求重查；只读，不写 Pi 的任何配置。 */
const updateChecker = new UpdateChecker({
  currentProjectPath: () => projectManager.currentProjectPath()
})
/** 扩展更新：只由页面显式发起，复用受管一次性入口执行，不自动执行也不重试。 */
const packageUpdater = new PackageUpdater({
  currentProjectPath: () => projectManager.currentProjectPath()
})
/** 内置 Pi agent 安装：只由页面显式发起，写入应用自有的运行时目录，不自动执行也不重试。 */
const piAgentUpdater = new PiAgentUpdater({ runtimeRoot: getRuntimeRoot })
/** 项目文件索引：根路径只取当前项目，页面无法指定检索目录。 */
const projectFileIndex = new ProjectFileIndex({
  currentProjectPath: () => projectManager.currentProjectPath()
})
/** 项目目录读取：右侧面板文件树的单层列举，根路径同样只取当前项目。 */
const projectDirectory = new ProjectDirectoryReader({
  currentProjectPath: () => projectManager.currentProjectPath()
})
/** 认证执行端：管理认证辅助进程，凭据读写全在官方实现内完成。 */
const authManager = new AuthManager({ store: configStore, isPackaged: app.isPackaged })
const preferencesManager = new PreferencesManager({ store: configStore })
/** 自定义供应商配置（Pi 的 models.json）的唯一读写者；与 Desktop 自己的配置互不影响。 */
const modelsConfigManager = new ModelsConfigManager()
/** Pi 默认模型（Pi 的 settings.json）的唯一读写者；只改 defaultProvider 与 defaultModel。 */
const piSettingsManager = new PiSettingsManager()
const windowState = new WindowState({ store: configStore })
/** 内置终端：进程、缓冲与背压都在主进程，页面只收输出并回报已消费的字符数。 */
const terminals = new TerminalManager({
  resolveProjectPath: resolveRegisteredProjectPath,
  sendData: (event) => sendToRenderer(TERMINAL_DATA_EVENT, event),
  sendExit: (event) => sendToRenderer(TERMINAL_EXIT_EVENT, event)
})

/**
 * 终端管理器与项目移除共用的项目解析：只认已登记项目，并回登记时的规范路径。
 * 终端的工作目录只取这条路径，页面给出的写法不直接进入 shell。
 */
async function resolveRegisteredProjectPath(requested: string): Promise<string | null> {
  const list = await configStore.list()
  const match = list.projects.find((project) => projectMatchesPath(project.path, requested))
  return match?.path ?? null
}

/** 按项目 id 取规范路径；只用于项目移除时收敛它的终端，找不到返回 null。 */
async function registeredProjectPathById(projectId: string): Promise<string | null> {
  const list = await configStore.list()
  return list.projects.find((project) => project.id === projectId)?.path ?? null
}

/** 项目路径比较口径与项目登记一致：Windows 路径大小写不敏感。 */
function projectMatchesPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 有限等待；只用于退出编排，不证明被等待的操作已完成。 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

// 必须在 ready 前注册；不赋予绕过 CSP 或运行 Service Worker 的权限。
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } }
])

function getPageUrl(): string {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (app.isPackaged || !developmentUrl) return APPLICATION_PAGE_URL

  if (new URL(developmentUrl).href !== DEVELOPMENT_PAGE_URL) {
    throw new Error('开发页面地址不在允许范围内。')
  }
  return DEVELOPMENT_PAGE_URL
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const pathname = relative(root, candidate)
  return pathname !== ''
    && pathname !== '..'
    && !pathname.startsWith(`..${sep}`)
    && !isAbsolute(pathname)
}

function assetError(status: number): Response {
  return new Response('应用资源不可用。', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': productionCsp,
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

function registerAssetProtocol(): void {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'app:' || url.hostname !== 'desktop'
        || url.port || url.username || url.password || url.search || url.hash) {
        return assetError(403)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return assetError(405)
      }

      const pathname = decodeURIComponent(url.pathname)
      // 同时拒绝 Windows 分隔符、盘符、ADS 与控制字符。
      if (!pathname.startsWith('/') || /[\\:\u0000-\u001f]/.test(pathname)) {
        return assetError(403)
      }
      const resource = pathname.slice(1)
      if (resource.split('/').some((part) => !part || part === '.' || part === '..')) {
        return assetError(403)
      }
      if (resource !== 'index.html' && !resource.startsWith('assets/')) {
        return assetError(404)
      }
      const contentType = contentTypes[extname(resource)]
      if (!contentType) return assetError(404)

      const root = await realpath(rendererRoot)
      const candidate = resolve(root, resource)
      if (!isInsideDirectory(root, candidate)) return assetError(403)
      const asset = await realpath(candidate)
      // realpath 后再次限制边界，避免符号链接把应用协议变成任意文件入口。
      if (!isInsideDirectory(root, asset)) return assetError(403)

      const response = await net.fetch(pathToFileURL(asset).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', contentType)
      headers.set('Content-Security-Policy', productionCsp)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers
      })
    } catch {
      // 不将安装路径、底层文件错误或内部堆栈回传给页面。
      return assetError(404)
    }
  })
}

function isTrustedCaller(event: IpcMainInvokeEvent, pageUrl: string): boolean {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.isDestroyed()) {
      return false
    }
    const contents = mainWindow.webContents
    const frame = event.senderFrame
    return event.sender === contents
      && frame !== null
      && frame === contents.mainFrame
      && frame.url === pageUrl
  } catch {
    // frame 在导航或销毁过程中可能失效，不能因此放宽调用者校验。
    return false
  }
}

function registerAppInfoHandler(pageUrl: string): void {
  handle(APP_INFO_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): AppInfoResult => {
    if (!isTrustedCaller(event, pageUrl)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
    }
    if (args.length !== 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '应用信息接口不接受参数。' } }
    }
    try {
      return {
        ok: true,
        data: {
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          platform: process.platform,
          arch: process.arch
        }
      }
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '暂时无法取得应用信息。' } }
    }
  })
}

function runtimeFailure(code: RuntimeErrorCode, message: string): RuntimeResult {
  return { ok: false, error: { code, message } }
}

function promptFailure(code: RuntimeErrorCode, message: string): PromptResult {
  return { ok: false, error: { code, message } }
}

function projectionFailure(code: RuntimeErrorCode, message: string): ProjectionResult {
  return { ok: false, error: { code, message } }
}

function capabilitiesFailure(code: RuntimeErrorCode, message: string): CapabilitiesResult {
  return { ok: false, error: { code, message } }
}

function resourcesFailure(code: RuntimeErrorCode, message: string): ResourcesResult {
  return { ok: false, error: { code, message } }
}

function resourcePreviewFailure(code: RuntimeErrorCode, message: string): ResourcePreviewResult {
  return { ok: false, error: { code, message } }
}

function diagnosticsFailure(code: RuntimeErrorCode, message: string): RuntimeDiagnosticsResult {
  return { ok: false, error: { code, message } }
}

function mcpStatusFailure(code: RuntimeErrorCode, message: string): McpStatusResult {
  return { ok: false, error: { code, message } }
}

function mcpInspectionFailure(code: RuntimeErrorCode, message: string): McpInspectionResult {
  return { ok: false, error: { code, message } }
}

function mcpInspectionAbortFailure(code: RuntimeErrorCode, message: string): McpInspectAbortResult {
  return { ok: false, error: { code, message } }
}

function mcpConfigFailure(code: RuntimeErrorCode, message: string): McpConfigResult {
  return { ok: false, error: { code, message } }
}

function modelsConfigFailure(code: ModelsConfigErrorCode, message: string): ModelsConfigResult {
  return { ok: false, error: { code, message } }
}

/** 读写失败统一映射：已知错误保留自己的错误码与结论文本，其余按内部错误处理。 */
function modelsConfigFailureOf(error: unknown, fallback: string): ModelsConfigResult {
  if (error instanceof ModelsConfigError) return modelsConfigFailure(error.code, error.message)
  return modelsConfigFailure('INTERNAL_ERROR', fallback)
}

function piDefaultModelFailure(code: DesktopErrorCode, message: string): PiDefaultModelResult {
  return { ok: false, error: { code, message } }
}

/** 读写失败统一映射：已知错误保留自己的错误码与结论文本，其余按内部错误处理。 */
function piDefaultModelFailureOf(error: unknown, fallback: string): PiDefaultModelResult {
  if (error instanceof PiSettingsError) return piDefaultModelFailure(error.code, error.message)
  return piDefaultModelFailure('INTERNAL_ERROR', fallback)
}

function projectPathFailure(code: ProjectErrorCode, message: string): ProjectPathResult {
  return { ok: false, error: { code, message } }
}

function projectListFailure(code: ProjectErrorCode, message: string): ProjectListResult {
  return { ok: false, error: { code, message } }
}

function projectFileFailure(code: DesktopErrorCode, message: string): ProjectFileSearchResult {
  return { ok: false, error: { code, message } }
}

function projectDirectoryFailure(code: DesktopErrorCode, message: string): ProjectDirectoryListResult {
  return { ok: false, error: { code, message } }
}

function projectEntryPathFailure(code: DesktopErrorCode, message: string): ProjectEntryPathResult {
  return { ok: false, error: { code, message } }
}

function projectEntryRevealFailure(code: DesktopErrorCode, message: string): ProjectEntryRevealResult {
  return { ok: false, error: { code, message } }
}

function sessionFailure(code: SessionErrorCode, message: string): SessionListResult {
  return { ok: false, error: { code, message } }
}

/** 运行状态查询失败只回到通用分类：不把实例内部结构暴露给页面。 */
function sessionRunsFailure(code: 'FORBIDDEN' | 'INVALID_REQUEST' | 'INTERNAL_ERROR', message: string): SessionRunsResult {
  return { ok: false, error: { code, message } }
}

function preferencesFailure(code: PreferencesErrorCode, message: string): PreferencesResult {
  return { ok: false, error: { code, message } }
}

/** 认证操作失败统一映射为共享契约的错误码；未知异常不向外暴露内部细节。 */
function authErrorOf(error: unknown): { readonly code: AuthErrorCode; readonly message: string; readonly detail: string | null } {
  if (error instanceof AuthManagerError) {
    return { code: error.code, message: error.message, detail: error.detail }
  }
  return { code: 'INTERNAL_ERROR', message: '认证操作失败，请重试。', detail: null }
}

function authStatusFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthStatusResult {
  return { ok: false, error: { code, message, detail } }
}

function authFlowFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthFlowResult {
  return { ok: false, error: { code, message, detail } }
}

function authLogoutFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthLogoutResult {
  return { ok: false, error: { code, message, detail } }
}

function extensionUiFailure(code: ExtensionUiErrorCode, message: string): ExtensionUiResult {
  return { ok: false, error: { code, message } }
}

/** 只接受非空且长度受控的标识字符串；空字符串与超长都按参数拒绝。 */
function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength
}

/** MCP 服务器名长度上限；字符集限制保证它只能作为固定命令的一个普通参数。 */
const MCP_SERVER_NAME_MAX_CHARS = 64

/** 服务器名只接受字母、数字、点、下划线与连字符；其他字符一律拒绝。 */
function isMcpServerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MCP_SERVER_NAME_MAX_CHARS
    && /^[A-Za-z0-9._-]+$/.test(value)
}

/** 把界面偏好的主题取值应用到 Electron 原生主题；驱动页面内 `prefers-color-scheme` 媒体查询。 */
function applyNativeTheme(theme: UiTheme): void {
  nativeTheme.themeSource = theme
}

/** 按当前生效主题返回窗口背景色；与 main.css 的 `--color-desk-canvas` 同步维护。 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
}

/** 按当前生效主题返回顶部栏底色；与 main.css 的 `--color-desk-surface` 同步维护。 */
function windowSurfaceColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_SURFACE : LIGHT_WINDOW_SURFACE
}

/** 按当前生效主题返回 Windows/Linux 窗口按钮的图标色；与 main.css 的 `--color-desk-ink` 同步维护。 */
function windowInkColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_INK : LIGHT_WINDOW_INK
}

/**
 * 顶部栏的窗口参数：页面自绘顶部栏后不再保留原生标题栏，避免出现两层栏。
 * macOS 用 hiddenInset 保留原生红绿灯；Windows/Linux 用系统绘制的覆盖层提供最小化/最大化/关闭。
 */
function titleBarWindowOptions(): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: windowSurfaceColor(), symbolColor: windowInkColor(), height: TITLEBAR_HEIGHT }
  }
}

/** 打开系统目录选择器；绑定唯一业务窗口，用户取消返回 `null`。 */
async function chooseDirectoryWithDialog(defaultPath: string): Promise<string | null> {
  const target = mainWindow
  if (target === null || target.isDestroyed()) {
    throw new Error('没有可用的桌面窗口。')
  }

  const result = await dialog.showOpenDialog(target, {
    title: '选择项目目录',
    buttonLabel: '选择此目录',
    defaultPath,
    properties: ['openDirectory']
  })
  if (result.canceled) return null

  const selected = result.filePaths[0]
  return typeof selected === 'string' && selected.trim() !== '' ? selected : null
}

/**
 * 注册 IPC 处理器，并把处理器内部的异常记到主进程 stderr。
 *
 * Electron 只把拒绝传给调用方，主进程默认不留任何记录，页面又只看到一句通用文案，
 * 这类故障就无法从终端或界面定位。异常仍然原样抛出，不改变调用方看到的契约。
 */
function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await listener(event, ...args)
    } catch (error) {
      console.error(`[ipc] ${channel} 处理器抛出异常：`, error)
      throw error
    }
  })
}

/** 只接受受限的项目选择/添加/移除请求与显式中断确认；不接受任意 channel 或 RPC 内容。 */
function registerProjectHandlers(pageUrl: string): void {
  handle(
    PROJECT_CHOOSE_DIRECTORY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectPathResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectPathFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return projectPathFailure('INVALID_REQUEST', '目录选择接口不接受参数。')
      }
      return projectManager.chooseDirectory()
    }
  )

  handle(
    PROJECT_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return projectListFailure('INVALID_REQUEST', '项目列表接口不接受参数。')
      }
      return projectManager.list()
    }
  )

  handle(
    PROJECT_ADD_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '添加项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '添加项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => !['path', 'trustStatus', 'trustDecision', 'allowInterrupt'].includes(key))) {
        return projectListFailure('INVALID_REQUEST', '添加项目参数包含未支持的字段。')
      }
      const { path, trustStatus, trustDecision, allowInterrupt } = fields
      if (typeof path !== 'string' || !isTrustStatus(trustStatus) || trustStatus.projectPath !== path) {
        return projectListFailure('INVALID_REQUEST', '候选项目路径或信任状态无效。')
      }
      if (trustDecision !== null && !isTrustDecision(trustDecision)) {
        return projectListFailure('INVALID_REQUEST', '信任决定必须是 trusted、untrusted 或 null。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '添加项目必须显式给出 allowInterrupt 布尔值。')
      }
      return projectManager.add(request as ProjectAddRequest)
    }
  )

  handle(
    PROJECT_REMOVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '移除项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '移除项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'projectId' && key !== 'allowInterrupt')) {
        return projectListFailure('INVALID_REQUEST', '移除项目参数包含未支持的字段。')
      }
      const { projectId, allowInterrupt } = fields
      if (typeof projectId !== 'string' || projectId.trim() === '') {
        return projectListFailure('INVALID_REQUEST', '项目 id 无效。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '移除项目必须显式说明是否允许中断当前操作。')
      }
      // 项目移除后它的终端不再有意义：先取规范路径，移除成功后一并收敛该项目终端。
      const terminalProjectPath = await registeredProjectPathById(projectId)
      const result = await projectManager.remove(request as ProjectRemoveRequest)
      if (result.ok && terminalProjectPath !== null) terminals.closeProject(terminalProjectPath)
      return result
    }
  )

  handle(
    PROJECT_SET_CURRENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '切换项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '切换项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'path' && key !== 'allowInterrupt')) {
        return projectListFailure('INVALID_REQUEST', '切换项目参数包含未支持的字段。')
      }
      const { path, allowInterrupt } = fields
      if (typeof path !== 'string') {
        return projectListFailure('INVALID_PROJECT_PATH', '项目目录必须是非空的绝对路径。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '切换项目必须显式给出 allowInterrupt 布尔值。')
      }
      return projectManager.setCurrent({ path, allowInterrupt })
    }
  )
}

/**
 * 文件检索只接受一个查询串、目录列举与条目路径解析只接受项目内相对路径；根都是当前项目，页面不能指定绝对路径，也不返回文件内容。
 * 解析与「在文件管理器中显示」共用同一个条目解析：越界、绝对路径与非法段一律拒绝。
 */
function registerProjectFileHandlers(pageUrl: string): void {
  handle(
    PROJECT_FILE_SEARCH_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectFileSearchResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectFileFailure('INVALID_REQUEST', '文件检索接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectFileFailure('INVALID_REQUEST', '文件检索参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'query')) {
        return projectFileFailure('INVALID_REQUEST', '文件检索参数包含未支持的字段。')
      }
      const { query } = fields
      if (typeof query !== 'string' || query.length > PROJECT_FILE_QUERY_MAX_CHARS) {
        return projectFileFailure('INVALID_REQUEST', '文件检索查询串无效。')
      }
      return projectFileIndex.search(query)
    }
  )

  handle(
    PROJECT_DIRECTORY_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectDirectoryListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectDirectoryFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectDirectoryFailure('INVALID_REQUEST', '目录列举接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectDirectoryFailure('INVALID_REQUEST', '目录列举参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'directory')) {
        return projectDirectoryFailure('INVALID_REQUEST', '目录列举参数包含未支持的字段。')
      }
      const { directory } = fields
      if (typeof directory !== 'string') {
        return projectDirectoryFailure('INVALID_REQUEST', '目录列举必须给出相对目录路径字符串。')
      }
      return projectDirectory.list(directory)
    }
  )

  handle(
    PROJECT_ENTRY_RESOLVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectEntryPathResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectEntryPathFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectEntryPathRequest(args[0])) {
        return projectEntryPathFailure('INVALID_REQUEST', '路径解析只接受一个项目内相对路径请求。')
      }
      return projectDirectory.resolveEntry(args[0].path)
    }
  )

  handle(
    PROJECT_ENTRY_REVEAL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectEntryRevealResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectEntryRevealFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectEntryPathRequest(args[0])) {
        return projectEntryRevealFailure('INVALID_REQUEST', '显示文件位置只接受一个项目内相对路径请求。')
      }
      return projectDirectory.revealEntry(args[0].path)
    }
  )
}

/** 会话列表、打开、重载与删除通道：参数白名单校验后转调会话编排层；新会话的默认模型由 Pi 自己的 settings.json 决定，会话归属与文件解析由主进程完成。 */
function registerSessionHandlers(pageUrl: string): void {
  handle(
    SESSION_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      // 侧栏按项目树展示会话：列表必须显式给出项目路径与窗口大小，主进程只接受已添加项目。
      if (args.length !== 1) {
        return sessionFailure('INVALID_REQUEST', '会话列表接口只接受一个项目路径与窗口大小请求对象。')
      }
      const request = args[0]
      if (!isSessionListRequest(request)) {
        return sessionFailure('INVALID_REQUEST', '会话列表接口只接受一个项目路径与窗口大小请求对象。')
      }
      return sessionManager.list(request.projectPath, request.limit)
    }
  )

  handle(
    SESSION_OPEN_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionOpenResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return sessionFailure('INVALID_REQUEST', '打开会话接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return sessionFailure('INVALID_REQUEST', '打开会话参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'sessionId' && key !== 'allowInterrupt' && key !== 'listLimit')) {
        return sessionFailure('INVALID_REQUEST', '打开会话参数包含未支持的字段。')
      }
      const { sessionId, allowInterrupt, listLimit } = fields
      let targetSessionId: string | null = null
      if (typeof sessionId === 'string') {
        if (sessionId.trim() === '') {
          return sessionFailure('INVALID_REQUEST', '会话 id 不能为空字符串。')
        }
        targetSessionId = sessionId
      } else if (sessionId !== null) {
        return sessionFailure('INVALID_REQUEST', '会话 id 必须是字符串或 null。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return sessionFailure('INVALID_REQUEST', '打开会话必须显式给出 allowInterrupt 布尔值。')
      }
      if (!isSessionListWindow(listLimit)) {
        return sessionFailure('INVALID_REQUEST', '打开会话必须显式给出合法的列表窗口大小。')
      }
      const trust = await resolveTrustForCurrentProject()
      if (trust.requiresPrompt) {
        return sessionFailure('TRUST_REQUIRED', trust.message ?? '项目包含需要信任决定的资源。')
      }
      return sessionManager.open({
        sessionId: targetSessionId,
        allowInterrupt,
        listLimit
      })
    }
  )

  /** 重新加载 Pi 资源：在目标会话所属实例内重建该会话的 services，并尽量恢复当前会话；
   * 只接受显式中断确认；打开方式仍按前台项目拦截信任，重载按被重载会话的归属项目在编排层复核。 */
  handle(
    SESSION_RELOAD_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionOpenResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'allowInterrupt' && key !== 'listLimit')) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源参数包含未支持的字段。')
      }
      if (typeof fields.allowInterrupt !== 'boolean') {
        return sessionFailure('INVALID_REQUEST', '重新加载资源必须显式说明是否允许中断当前操作。')
      }
      if (!isSessionListWindow(fields.listLimit)) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源必须显式给出合法的列表窗口大小。')
      }
      return sessionManager.reload(fields.allowInterrupt, fields.listLimit)
    }
  )

  /** 删除会话：只接受显式项目路径、会话 id 与中断确认；归属与占用收敛都在编排层完成。 */
  handle(
    SESSION_DELETE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionDeleteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isSessionDeleteRequest(args[0])) {
        return sessionFailure('INVALID_REQUEST', '删除会话接口只接受一个包含项目路径、会话 id、中断确认与列表窗口的请求对象。')
      }
      return sessionManager.delete(args[0])
    }
  )
}

/** 运行实例状态查询、释放与结束：都只操作注册表登记与宿主生命周期，不删除任何会话历史。 */
function registerSessionRunHandlers(pageUrl: string): void {
  handle(
    SESSION_RUNS_STATE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): SessionRunsResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionRunsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return sessionRunsFailure('INVALID_REQUEST', '运行状态接口不接受参数。')
      }
      return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
    }
  )

  handle(
    SESSION_RUN_RELEASE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionRunReleaseResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isSessionRunReleaseRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '释放运行实例只接受一个运行实例身份。' } }
      }
      try {
        // 不中断在途工作：释放只在确实可释放时生效，未确认时占用保留并由错误如实报告。
        const result = await sdkRuntime.releaseRun(args[0].runId, false)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '释放运行实例时发生未预期的内部错误。' } }
      }
    }
  )

  handle(
    SESSION_RUN_CLOSE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionRunReleaseResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isSessionRunReleaseRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '结束运行实例只接受一个运行实例身份。' } }
      }
      try {
        // 结束包含中断：页面已在关闭标签时表达了结束意图，未确认时占用保留并由错误如实报告。
        const result = await sdkRuntime.closeRun(args[0].runId)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '结束运行实例时发生未预期的内部错误。' } }
      }
    }
  )
}

/**
 * Project Trust 拦截点（基于当前项目）：有受保护资源且无已保存决定时返回 `requiresPrompt`，
 * 由调用方按 `TRUST_REQUIRED` 拒绝；有决定或无资源时一并返回已保存的决定，
 * 供只读列举（MCP 配置）判断项目级配置是否生效。
 */
async function resolveTrustForCurrentProject(): Promise<{
  readonly requiresPrompt: boolean
  readonly decision: 'trusted' | 'untrusted' | null
  readonly message: string | null
}> {
  const outcome = await trustManager.resolveLaunchDecision(projectManager.currentProjectPath())
  if (!outcome.requiresPrompt) {
    return { requiresPrompt: false, decision: outcome.decision, message: null }
  }
  const status = await trustManager.statusOf(projectManager.currentProjectPath())
  const summary = status.resources.map((resource) => resource.path).join('、')
  return {
    requiresPrompt: true,
    decision: null,
    message: `项目包含需要信任决定的资源：${summary}`
  }
}

/** Trust 查询与决定接口；决定只接受当前项目，防止页面改写其他项目的记录。 */
/**
 * 信任交互的目标项目：带运行实例身份时取该实例的归属项目（重载按被重载会话的归属项目复核，
 * 可能不等于前台项目），不带身份时取当前项目。未登记的身份不解析成任何项目。
 */
function trustProjectOf(runId: unknown): string | null {
  if (runId === undefined) return projectManager.currentProjectPath()
  if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) return null
  const run = sdkRuntime.listRunStates().find(candidate => candidate.runId === runId)
  return run?.projectPath ?? null
}

/** Trust 查询与决定接口；目标项目按来源运行实例解析，未登记的身份不接受。 */
function registerTrustHandlers(pageUrl: string): void {
  handle(
    TRUST_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TrustStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return trustFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      // 允许零参数（当前项目）或一个只含 runId 的请求对象（来源运行实例的归属项目）。
      let runId: unknown
      if (args.length === 1) {
        const request = args[0]
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
          return trustFailure('INVALID_REQUEST', '信任状态参数格式不正确。')
        }
        const fields = request as Record<string, unknown>
        if (Object.keys(fields).some((key) => key !== 'runId')) {
          return trustFailure('INVALID_REQUEST', '信任状态参数包含未支持的字段。')
        }
        runId = fields.runId
      } else if (args.length !== 0) {
        return trustFailure('INVALID_REQUEST', '信任状态接口只接受零参数或一个请求对象。')
      }
      try {
        return { ok: true, data: await trustManager.statusOf(trustProjectOf(runId)) }
      } catch (error) {
        return trustFailureFromError(error)
      }
    }
  )

  handle(
    TRUST_DECIDE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TrustDecisionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return trustFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return trustFailure('INVALID_REQUEST', '信任决定接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return trustFailure('INVALID_REQUEST', '信任决定参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'projectPath' && key !== 'decision' && key !== 'runId')) {
        return trustFailure('INVALID_REQUEST', '信任决定参数包含未支持的字段。')
      }
      const { projectPath, decision, runId } = fields
      if (typeof projectPath !== 'string') {
        return trustFailure('INVALID_REQUEST', '项目目录必须是非空的绝对路径。')
      }
      if (!isTrustDecisionInput(decision)) {
        return trustFailure('INVALID_REQUEST', '信任决定取值只能是 trusted、untrusted 或 unset。')
      }
      const allowedProjectPath = trustProjectOf(runId)
      if (allowedProjectPath === null) {
        return trustFailure('INVALID_REQUEST', '信任决定的目标不是当前项目，也不是已登记运行实例的归属项目。')
      }
      try {
        const normalizedDecision: 'trusted' | 'untrusted' | null = decision === 'unset' ? null : decision
        const status = await trustManager.decide(projectPath, normalizedDecision, allowedProjectPath)
        return { ok: true, data: status }
      } catch (error) {
        return trustFailureFromError(error)
      }
    }
  )
}

function trustFailure(code: DesktopErrorCode, message: string): TrustStatusResult {
  return { ok: false, error: { code, message } }
}

/** 探测与决定的内部失败按可展示错误返回；不确定的异常收敛为内部错误。 */
function trustFailureFromError(error: unknown): TrustStatusResult {
  if (error instanceof TrustManagerError) {
    return trustFailure('INVALID_REQUEST', error.message)
  }
  return trustFailure('INTERNAL_ERROR', '读取或保存信任决定时发生未预期的内部错误。')
}

/** 注册固定 Runtime 接口并逐接口校验参数；不向页面开放可执行文件路径、任意启动参数或任意 RPC 内容。 */
function registerRuntimeHandlers(pageUrl: string): void {
  handle(RUNTIME_STATUS_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): RuntimeResult => {
    if (!isTrustedCaller(event, pageUrl)) {
      return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    }
    if (args.length !== 0) {
      return runtimeFailure('INVALID_REQUEST', 'Runtime 状态接口不接受参数。')
    }
    return sdkRuntime.getStatus()
  })

  /** 中止目标运行实例的当前操作；只接受受校验的二维目标，运行状态仍以事件流为准。 */
  handle(
    RUNTIME_ABORT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '中止操作只接受运行实例与绑定代际。')
      }
      return sdkRuntime.abort(args[0])
    }
  )

  /** 回退目标只接受受校验的身份，不接受文件路径或任意 Pi 命令。 */
  handle(
    RUNTIME_REWIND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeRewindResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isRuntimeRewindRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '回退只接受运行实例、Runtime、会话与消息身份。' } }
      }
      return sdkRuntime.rewind(args[0])
    }
  )

  /** 可用模型读取只查询目标运行实例的当前绑定代际，不接受其他参数。 */
  handle(
    RUNTIME_CAPABILITIES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<CapabilitiesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return capabilitiesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return capabilitiesFailure('INVALID_REQUEST', '能力读取只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readCapabilities(args[0])
    }
  )

  /** 模型切换只接受明确运行实例、代际与模型身份；运行条件由 Runtime 所有者再次检查。 */
  handle(
    RUNTIME_SET_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeSetModelRequest(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '模型切换只接受运行实例、Runtime 代际、供应商和模型 ID。')
      }
      return sdkRuntime.setModel(args[0])
    }
  )

  /** 手动压缩只接受受校验的目标身份与有界说明文本；摘要内容不在请求里传递。 */
  handle(
    RUNTIME_COMPACT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeCompactRequest(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '压缩只接受运行实例、Runtime 代际、会话身份与可选说明文本。')
      }
      return sdkRuntime.compact(args[0])
    }
  )

  /** 资源清单只读目标实例的绑定代际已加载的扩展命令、提示词与技能。 */
  handle(
    RUNTIME_RESOURCES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ResourcesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return resourcesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return resourcesFailure('INVALID_REQUEST', '资源清单只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readResources(args[0])
    }
  )

  /**
   * 共享预读只接受一个请求对象：返回资源、可用模型与默认模型及分项错误，单项失败不遮蔽其他结果。
   * 未选项目时改用中立目录做全局预读，只回模型与默认身份，`projectPath` 为 null，供首页设置默认模型。
   * 项目与信任由主进程决定，页面只能要求绕过缓存；无决定时按未信任探测，不触发信任提示或写记录。
   */
  handle(
    RUNTIME_RESOURCE_PREVIEW_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ResourcePreviewResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return resourcePreviewFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isResourcePreviewRequest(args[0])) {
        return resourcePreviewFailure('INVALID_REQUEST', '资源预读请求必须显式给出 force 布尔值。')
      }
      const { force } = args[0]
      const projectPath = projectManager.currentProjectPath()
      try {
        if (projectPath === null) {
          // userData 属于桌面应用自己，没有 .pi 项目配置，适合作为无关项目的探测目录。
          const preview = await previewGlobalModels(app.getPath('userData'), force)
          return { ok: true, data: { projectPath: null, ...preview } }
        }
        const outcome = await trustManager.resolveLaunchDecision(projectPath)
        const trustDecision = outcome.requiresPrompt ? 'untrusted' : outcome.decision
        const preview = await previewProjectResources(projectPath, trustDecision, force)
        return { ok: true, data: { projectPath, ...preview } }
      } catch (error) {
        if (error instanceof ResourcePreviewError) {
          return resourcePreviewFailure(error.code, error.message)
        }
        return resourcePreviewFailure(
          'INTERNAL_ERROR',
          `资源预读失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )

  /** 诊断只暴露目标实例绑定代际已持有的 SDK 创建期诊断与 Extension 运行时错误。 */
  handle(
    RUNTIME_DIAGNOSTICS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeDiagnosticsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return diagnosticsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return diagnosticsFailure('INVALID_REQUEST', '诊断接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readDiagnostics(args[0])
    }
  )

  /** MCP 状态使用目标实例绑定内固定的 `/mcp` 命令，不接受页面传入任何命令文本。 */
  handle(
    RUNTIME_MCP_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 状态接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readMcpStatus(args[0])
    }
  )

  /** MCP 登录、退出或重连：只接受动作与服务器名；命令文本与等待期限都由主进程决定。 */
  handle(
    RUNTIME_MCP_COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'action' && key !== 'serverName')) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出参数包含未支持的字段。')
      }
      const target = fields.target
      if (!isRuntimeTarget(target)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 操作必须给出运行实例与绑定代际。')
      }
      if (fields.action !== 'login' && fields.action !== 'logout' && fields.action !== 'reconnect') {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 动作只能是 login、logout 或 reconnect。')
      }
      // 服务器名会被拼进固定命令文本，因此只允许字母、数字、点、下划线与连字符。
      if (!isMcpServerName(fields.serverName)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 服务器名只能包含字母、数字、点、下划线与连字符。')
      }
      return sdkRuntime.runMcpCommand(target, fields.action, fields.serverName)
    }
  )

  /**
   * MCP 服务器探测：零参数，主进程用当前项目跑一次固定的 `pi mcp list --json`。
   * 探测会另起一个 Pi 进程并重新连接所有已启用服务器，不写任何配置文件。
   * 官方 CLI 不接受信任 flag，探测以未信任项目身份运行，因此这里不做信任拦截。
   */
  handle(
    RUNTIME_MCP_INSPECT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpInspectionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpInspectionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpInspectionFailure('INVALID_REQUEST', 'MCP 探测接口不接受参数。')
      }
      const projectPath = projectManager.currentProjectPath()
      if (projectPath === null) {
        return mcpInspectionFailure('INVALID_PROJECT_PATH', '请先选择一个项目，再探测 MCP 服务器。')
      }
      const result = await mcpInspection.inspect(projectPath)
      // 探测期间项目可能已切换：此时结果属于旧项目，不能当作当前项目的状态交给页面。
      if (result.ok && projectManager.currentProjectPath() !== projectPath) {
        return mcpInspectionFailure('INVALID_PROJECT_PATH', '项目已切换，本次探测结果已丢弃。')
      }
      return result
    }
  )

  /** 中止进行中的 MCP 探测：零参数，只终止主进程自己启动的探测进程。 */
  handle(
    RUNTIME_MCP_INSPECT_ABORT_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): McpInspectAbortResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpInspectionAbortFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpInspectionAbortFailure('INVALID_REQUEST', '中止探测接口不接受参数。')
      }
      return mcpInspection.abort()
    }
  )

  /**
   * MCP 配置列举：零参数，只读读取 Pi 的 mcp.json（全局与当前项目两处）。
   * 不连接服务器、不写配置文件；项目级配置是否生效取决于信任决定，因此决定结果一并回传，
   * 未信任与需要信任决定的项目都按「未生效」如实展示，不在这里触发信任拦截。
   */
  handle(
    RUNTIME_MCP_CONFIG_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpConfigFailure('INVALID_REQUEST', 'MCP 配置列举接口不接受参数。')
      }
      try {
        const trust = await resolveTrustForCurrentProject()
        return {
          ok: true,
          data: await readMcpConfigListing(
            projectManager.currentProjectPath(),
            !trust.requiresPrompt && trust.decision === 'trusted'
          )
        }
      } catch (error) {
        return mcpConfigFailure(
          'INTERNAL_ERROR',
          `读取 MCP 配置失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )

  /** 只接受运行目标、Prompt 文本与图片附件；不接受可执行文件路径、启动参数或排队选项。 */
  handle(
    RUNTIME_PROMPT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PromptResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return promptFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 接口只接受一个消息对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'message' && key !== 'images')) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 参数包含未支持的字段。')
      }
      const target = fields.target
      if (!isRuntimeTarget(target)) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 必须给出运行实例与绑定代际。')
      }
      const message = fields.message
      if (typeof message !== 'string') {
        return promptFailure('INVALID_REQUEST', 'Prompt 内容必须是字符串。')
      }
      // 图片附件逐字段校验后重建：name 受控，mimeType 与 data 只接受字符串；其他字段丢弃。
      const images: PromptImageInput[] = []
      if (fields.images !== undefined) {
        if (!Array.isArray(fields.images) || fields.images.length > 4) {
          return promptFailure('INVALID_REQUEST', '图片附件必须是数量受控的数组。')
        }
        for (const entry of fields.images) {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            return promptFailure('INVALID_REQUEST', '图片附件格式不正确。')
          }
          const item = entry as Record<string, unknown>
          if (Object.keys(item).some((key) => key !== 'name' && key !== 'mimeType' && key !== 'data')) {
            return promptFailure('INVALID_REQUEST', '图片附件包含未支持的字段。')
          }
          if (typeof item.name !== 'string' || item.name === '' || item.name.length > 256) {
            return promptFailure('INVALID_REQUEST', '图片文件名必须是非空且长度受控的字符串。')
          }
          if (typeof item.mimeType !== 'string' || item.mimeType === '' || item.mimeType.length > 64) {
            return promptFailure('INVALID_REQUEST', '图片 MIME 类型必须是长度受控的字符串。')
          }
          if (typeof item.data !== 'string' || item.data === '') {
            return promptFailure('INVALID_REQUEST', '图片数据必须是非空字符串。')
          }
          images.push({ name: item.name, mimeType: item.mimeType, data: item.data })
        }
      }
      return sdkRuntime.prompt(target, message, images)
    }
  )

  /** 投影快照只读取目标实例绑定代际的投影；目标不成立或未绑定时由后端给出结果，不伪造空投影。 */
  handle(
    RUNTIME_PROJECTION_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return projectionFailure('INVALID_REQUEST', '投影快照接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.getProjection(args[0])
    }
  )

  /** 应用确认只控制未确认通知窗口；参数不合法时忽略，不回传结果。 */
  handle(
    RUNTIME_PROJECTION_ACK_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
      if (!isTrustedCaller(event, pageUrl) || args.length !== 1) return
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'seq')) return
      const target = fields.target
      const { seq } = fields
      if (!isRuntimeTarget(target)) return
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return
      sdkRuntime.ackProjection(target, seq)
    }
  )
}

/** Pi 默认模型（settings.json）的读写；零参读取，写入只接受一个合法模型身份。 */
function registerPiSettingsHandlers(pageUrl: string): void {
  handle(
    PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PiDefaultModelResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return piDefaultModelFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return piDefaultModelFailure('INVALID_REQUEST', 'Pi 默认模型读取接口不接受参数。')
      }
      try {
        return { ok: true, data: await piSettingsManager.getDefaultModel() }
      } catch (error) {
        return piDefaultModelFailureOf(error, '读取 Pi 默认模型时发生未预期的内部错误。')
      }
    }
  )
  handle(
    PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PiDefaultModelResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return piDefaultModelFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isPiDefaultModelSetRequest(args[0])) {
        return piDefaultModelFailure('INVALID_REQUEST', 'Pi 默认模型必须是包含供应商与模型 ID 的合法身份。')
      }
      const model = args[0]
      try {
        return { ok: true, data: await piSettingsManager.setDefaultModel(model) }
      } catch (error) {
        return piDefaultModelFailureOf(error, '保存 Pi 默认模型时发生未预期的内部错误。')
      }
    }
  )
}

/**
 * 运行时回退时返回指针指向的版本，否则返回 null。
 * 判据是指针版本与实际加载的版本不一致：指针缺失，或目录里的版本已经用上了，都不属于回退。
 */
function pendingRuntimeVersion(piAgent: PiAgentUpdateInfo | null): string | null {
  if (piAgent === null) return null
  const pointer = piAgent.runtimeVersion
  if (pointer === null || pointer === piAgent.version) return null
  return pointer
}

function registerUpdatesHandlers(pageUrl: string): void {
  handle(
    UPDATES_GET_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): UpdatesResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '版本检查读取接口不接受参数。' } }
      }
      return { ok: true, data: updateChecker.getSnapshot() }
    }
  )
  handle(
    UPDATES_CHECK_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<UpdatesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '版本检查接口不接受参数。' } }
      }
      return await updateChecker.check()
    }
  )
  handle(
    UPDATES_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PackageUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length > 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展更新接口只接受一个可选的包来源。' } }
      }
      const requested = args.length === 0 ? undefined : args[0]
      if (requested !== undefined && typeof requested !== 'string') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展更新接口只接受文本来源。' } }
      }
      const source = requested === undefined || requested === '' ? undefined : requested
      // 页面只能引用主进程已经报告过的来源，不能凭空构造要更新的包。
      if (source !== undefined
        && !updateChecker.getSnapshot().extensions.some((entry) => entry.source === source)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能更新版本检查报告过的包。' } }
      }
      return await packageUpdater.update(source)
    }
  )
  handle(
    UPDATES_INSTALL_AGENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentInstallResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length > 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '内置 Pi agent 安装接口只接受一个可选版本号。' } }
      }
      const requested = args.length === 0 ? undefined : args[0]
      if (requested !== undefined && typeof requested !== 'string') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '内置 Pi agent 安装接口只接受文本版本号。' } }
      }
      const version = requested === undefined || requested === '' ? undefined : requested
      // 页面只能要求安装主进程已经报告过的官方最新版本，且该版本得处于可更新状态；
      // 版本范围由安装入口再判一次，这里先把明显不该装的请求挡在门外。
      const piAgent = updateChecker.getSnapshot().piAgent
      if (version !== undefined
        && (piAgent === null || piAgent.status !== 'update-available' || version !== piAgent.latestVersion)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能安装版本检查报告过的、处于可更新状态的官方版本。' } }
      }
      return await piAgentUpdater.install(version)
    }
  )
  handle(
    UPDATES_REINSTALL_AGENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentInstallResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '重装运行时版本接口只接受一个版本号。' } }
      }
      const requested = args[0]
      if (typeof requested !== 'string' || requested === '') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '重装运行时版本接口只接受非空文本版本号。' } }
      }
      // 只能重装主进程报告过的、运行中没生效的那个运行时版本；版本范围由安装入口再判一次。
      if (requested !== pendingRuntimeVersion(updateChecker.getSnapshot().piAgent)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能重装版本检查报告过的、运行中未生效的运行时版本。' } }
      }
      return await piAgentUpdater.install(requested)
    }
  )
  handle(
    UPDATES_RESET_AGENT_RUNTIME_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AgentRuntimeResetResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '清除运行时指针接口不接受参数。' } }
      }
      // 清指针只用于修复回退，避免在一切正常时把在用的版本指针删掉。
      if (pendingRuntimeVersion(updateChecker.getSnapshot().piAgent) === null) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只有运行时版本未能生效时才能清除指针。' } }
      }
      return await piAgentUpdater.resetRuntime()
    }
  )
}

/** 界面偏好、对话页模型展示偏好、快捷发送短语与扩展自动更新开关分开读写；未知字段、任意启动参数一律拒绝。 */
function registerPreferencesHandlers(pageUrl: string): void {
  handle(
    PREFERENCES_GET_QUICK_SEND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickSendResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '快捷发送短语读取接口不接受参数。' } }
      }
      return preferencesManager.getQuickSend()
    }
  )
  handle(
    PREFERENCES_SET_QUICK_SEND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickSendResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isQuickSendPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '快捷发送短语必须是不超过上限的文本列表。' } }
      }
      return preferencesManager.setQuickSend(args[0])
    }
  )
  handle(
    PREFERENCES_GET_AUTO_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AutoUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展自动更新开关读取接口不接受参数。' } }
      }
      return preferencesManager.getExtensionAutoUpdate()
    }
  )
  handle(
    PREFERENCES_SET_AUTO_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AutoUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isAutoUpdatePreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展自动更新开关只接受一个布尔值。' } }
      }
      return preferencesManager.setExtensionAutoUpdate(args[0])
    }
  )
  handle(
    PREFERENCES_GET_MODEL_DISPLAY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelDisplayResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '对话页模型展示偏好读取接口不接受参数。' } }
      }
      return preferencesManager.getModelDisplay()
    }
  )
  handle(
    PREFERENCES_SET_MODEL_DISPLAY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelDisplayResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isModelDisplayPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '对话页模型展示偏好必须是隐藏模型的列表。' } }
      }
      return preferencesManager.setModelDisplay(args[0])
    }
  )
  handle(
    PREFERENCES_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PreferencesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return preferencesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好读取接口不接受参数。')
      }
      return preferencesManager.get()
    }
  )

  handle(
    PREFERENCES_SET_UI_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PreferencesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return preferencesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return preferencesFailure('INVALID_REQUEST', '保存界面偏好接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isUiPreferences(request)) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好必须包含折叠状态、合法主题、展开的项目路径列表与右侧面板状态。')
      }
      const { sidebarCollapsed, theme, expandedProjects, rightPanelOpen, rightPanelWidth } = request
      // 主题在参数合法后立即生效：只读降级时同样切换本次运行的主题，与页面本地生效保持一致。
      applyNativeTheme(theme)
      return preferencesManager.setUi({ sidebarCollapsed, theme, expandedProjects, rightPanelOpen, rightPanelWidth })
    }
  )
}

/**
 * 第三方自定义供应商（Pi 的 models.json）：读取快照、按单个条目新增或替换、删除条目。
 * 页面只能提交一个供应商条目的 JSON 文本，不能指定文件路径、不能整体替换文件；
 * 真实密钥不回传，页面看到的是哨兵文本，保存时由主进程按位置还原。
 */
function registerModelsConfigHandlers(pageUrl: string): void {
  handle(
    MODELS_CONFIG_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return modelsConfigFailure('INVALID_REQUEST', '自定义供应商读取接口不接受参数。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.getSnapshot() }
      } catch (error) {
        return modelsConfigFailureOf(error, '读取自定义供应商配置时发生未预期的内部错误。')
      }
    }
  )

  handle(
    MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return modelsConfigFailure('INVALID_REQUEST', '保存自定义供应商接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isModelsConfigSaveRequest(request)) {
        return modelsConfigFailure('INVALID_REQUEST', '保存自定义供应商需要且只需要 providerId 与 json 两个字段。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.saveProvider(request.providerId, request.json) }
      } catch (error) {
        return modelsConfigFailureOf(error, '保存自定义供应商时发生未预期的内部错误。')
      }
    }
  )

  handle(
    MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return modelsConfigFailure('INVALID_REQUEST', '删除自定义供应商接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isModelsConfigDeleteRequest(request)) {
        return modelsConfigFailure('INVALID_REQUEST', '删除自定义供应商需要且只需要 providerId 一个字段。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.deleteProvider(request.providerId) }
      } catch (error) {
        return modelsConfigFailureOf(error, '删除自定义供应商时发生未预期的内部错误。')
      }
    }
  )
}

/**
 * 认证状态读取、Provider 登录流程（API Key 与 OAuth）、退出登录与外链打开。
 * 登录流程与密钥只经固定业务方法传递：页面不能指定辅助进程路径、命令文本或要打开的 URL。
 */
function registerAuthHandlers(pageUrl: string): void {
  handle(
    AUTH_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return authStatusFailure('INVALID_REQUEST', '认证状态接口不接受参数。')
      }
      try {
        return { ok: true, data: await authManager.readStatus() }
      } catch (error) {
        const failure = authErrorOf(error)
        return authStatusFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_START_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '启动登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'providerId' && key !== 'method')) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数包含未支持的字段。')
      }
      if (!isAuthLoginStartRequest(request)) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数必须包含 providerId 与 method。')
      }
      if (!isBoundedIdentifier(request.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'Provider 名称必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.beginLogin(request.providerId, request.method) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_RESPOND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId' && key !== 'promptId' && key !== 'value')) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数包含未支持的字段。')
      }
      if (!isAuthLoginRespondRequest(request)) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数必须包含 flowId、promptId 与 value。')
      }
      // 密钥长度在这里先拦一次；取值合法性（如 select 候选）由主进程的认证管理再次校验。
      if (request.value.length > AUTH_MAX_SECRET_CHARS) {
        return authFlowFailure('INVALID_REQUEST', `输入超过 ${AUTH_MAX_SECRET_CHARS} 字符上限。`)
      }
      try {
        return {
          ok: true,
          data: await authManager.respondPrompt(request.flowId, request.promptId, request.value)
        }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_CANCEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '取消登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '取消登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId')) {
        return authFlowFailure('INVALID_REQUEST', '取消登录参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.flowId, AUTH_MAX_FLOW_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'flowId 必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.cancelLogin(fields.flowId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_OPEN_URL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId')) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.flowId, AUTH_MAX_FLOW_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'flowId 必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.openFlowUrl(fields.flowId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGOUT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthLogoutResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authLogoutFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'providerId')) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) {
        return authLogoutFailure('INVALID_REQUEST', 'Provider 名称必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.logout(fields.providerId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authLogoutFailure(failure.code, failure.message)
      }
    }
  )
}

/** Extension UI 状态查询与 dialog 响应提交；只接受受控的运行身份、id 与互斥响应形态。
 * 运行实例不存在时状态接口返回空交互；id 不在队列或形态不符按 EXTENSION_DIALOG_NOT_FOUND /
 * INVALID_REQUEST 拒绝，不猜造。
 */
function registerExtensionUiHandlers(pageUrl: string): void {
  handle(
    EXTENSION_UI_STATE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): ExtensionUiResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return extensionUiFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension UI 状态接口只接受一个运行实例身份。')
      }
      const runId = args[0]
      if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension UI 状态接口只接受正整数运行实例身份。')
      }
      return { ok: true, data: sdkRuntime.getExtensionUiSnapshot(runId) }
    }
  )

  handle(
    EXTENSION_UI_RESPOND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExtensionUiResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return extensionUiFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'dialogId' && key !== 'response')) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应参数包含未支持的字段。')
      }
      const target = fields.target
      const { dialogId, response } = fields
      if (!isExtensionDialogTarget(target)) {
        return extensionUiFailure('INVALID_REQUEST', '对话响应必须给出运行实例与绑定代际。')
      }
      if (!isBoundedIdentifier(dialogId, 256)) {
        return extensionUiFailure('INVALID_REQUEST', '对话 id 必须是非空且长度受控的字符串。')
      }
      if (!isExtensionDialogResponseInput(response)) {
        return extensionUiFailure('INVALID_REQUEST', '对话响应形态不符合约定。')
      }
      let snapshot: ExtensionUiSnapshot | null = null
      try {
        snapshot = await sdkRuntime.respondExtensionDialog(
          target,
          dialogId,
          response as ExtensionDialogResponseInput
        )
      } catch {
        return extensionUiFailure('INTERNAL_ERROR', '提交 Extension 对话响应时发生未预期的内部错误。')
      }
      if (snapshot === null) {
        return extensionUiFailure('EXTENSION_DIALOG_NOT_FOUND', '该 Extension 对话已结束或不存在。')
      }
      return { ok: true, data: snapshot }
    }
  )
}

/**
 * 内置终端：创建、写入、改尺寸、关闭、清单与数据确认。
 * 终端进程只在主进程，页面不接触 shell、环境变量与工作目录；数据确认只释放背压额度。
 */
function registerTerminalHandlers(pageUrl: string): void {
  handle(
    TERMINAL_CREATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalSessionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalSessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalCreateRequest(args[0])) {
        return terminalSessionFailure('INVALID_REQUEST', '创建终端只接受已登记项目路径与初始行列数。')
      }
      return terminals.create(args[0])
    }
  )

  handle(
    TERMINAL_WRITE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): TerminalCommandResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalWriteRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '终端写入只接受终端标识与不超过上限的文本。')
      }
      return terminals.write(args[0])
    }
  )

  handle(
    TERMINAL_RESIZE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): TerminalCommandResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalResizeRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '调整终端尺寸只接受终端标识与合法行列数。')
      }
      return terminals.resize(args[0])
    }
  )

  handle(
    TERMINAL_CLOSE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): TerminalCommandResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalCommandFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalCloseRequest(args[0])) {
        return terminalCommandFailure('INVALID_REQUEST', '关闭终端只接受终端标识。')
      }
      return terminals.close(args[0])
    }
  )

  handle(
    TERMINAL_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TerminalSessionsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return terminalSessionsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isTerminalListRequest(args[0])) {
        return terminalSessionsFailure('INVALID_REQUEST', '终端清单只接受一个项目路径或 null。')
      }
      return terminals.list(args[0])
    }
  )

  /** 数据确认只释放背压额度；参数不合法时忽略，不回传结果。 */
  handle(
    TERMINAL_ACK_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
      if (!isTrustedCaller(event, pageUrl) || args.length !== 1 || !isTerminalAckRequest(args[0])) return
      terminals.acknowledge(args[0])
    }
  )
}

function terminalSessionFailure(code: TerminalErrorCode, message: string): TerminalSessionResult {
  return { ok: false, error: { code, message } }
}

function terminalSessionsFailure(code: TerminalErrorCode, message: string): TerminalSessionsResult {
  return { ok: false, error: { code, message } }
}

function terminalCommandFailure(code: TerminalErrorCode, message: string): TerminalCommandResult {
  return { ok: false, error: { code, message } }
}

/** 只发给当前唯一可信窗口；返回是否真的投递，未投递时调用方保留数据。 */
function sendToRenderer(channel: string, payload: unknown): boolean {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return false
  const contents = target.webContents
  if (contents.isDestroyed()) return false
  contents.send(channel, payload)
  return true
}

/** 状态变化只发给当前唯一可信窗口，不广播到其他 webContents。 */
function broadcastRuntimeStatus(status: RuntimeStatus): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(RUNTIME_STATUS_EVENT, status)
}

/** 投影批次同样只发给当前唯一可信窗口，不广播到其他 webContents。 */
function broadcastRuntimeProjection(batch: ProjectionBatch): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(RUNTIME_PROJECTION_EVENT, batch)
}

/** Extension UI 快照同样只发给当前唯一可信窗口，不广播到其他 webContents。 */
function broadcastExtensionUi(snapshot: ExtensionUiSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(EXTENSION_UI_EVENT, snapshot)
}

/** 运行实例状态列表只发给当前唯一可信窗口；列表只含粗粒度字段。 */
function broadcastSessionRuns(snapshot: SessionRunsSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(SESSION_RUNS_EVENT, snapshot)
}

/** 登录流程快照同样只发给当前唯一可信窗口。 */
function broadcastAuthFlow(snapshot: AuthFlowSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(AUTH_FLOW_EVENT, snapshot)
}

/** Pi 版本检查快照同样只发给当前唯一可信窗口；检查结论只含版本号与结论文本。 */
function broadcastUpdates(snapshot: UpdatesSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_STATE_EVENT, snapshot)
}

/** 扩展更新进度同样只发给当前唯一可信窗口；进度只含来源、动作与展示文本。 */
function broadcastPackageUpdateProgress(progress: PackageUpdateProgress): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_UPDATE_PROGRESS_EVENT, progress)
}

/** 扩展更新结论同样只发给当前唯一可信窗口；自动执行的更新没有调用方在等结果，页面靠它收敛。 */
function broadcastPackageUpdateOutcome(outcome: PackageUpdateOutcome): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_UPDATE_OUTCOME_EVENT, outcome)
}

/** 内置 Pi agent 安装进度只发给当前唯一可信窗口；进度只含阶段、版本与展示文本。 */
function broadcastAgentInstallProgress(progress: AgentInstallProgress): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, progress)
}

function restrictSession(): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.on('will-download', (event) => event.preventDefault())
}

/**
 * 把已有窗口带到前台；第二个实例启动时调用。窗口已销毁或不存在时什么都不做。
 */
function focusMainWindow(): void {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/**
 * 启动时的扩展自动更新：开关为开、且首次检查发现了可更新条目时执行一次。
 * 只由启动检查触发，手动重查不会静默安装；更新结果走广播，页面能像手动更新一样看到进度与结论。
 * 硬失败（进程异常退出、超时）只写 stderr：自动动作没有调用方在等结果，不弹页面提示。
 */
async function runStartupAutoUpdate(): Promise<void> {
  try {
    const preference = await preferencesManager.getExtensionAutoUpdate()
    if (!preference.ok || !preference.data.enabled) return
    const snapshot = updateChecker.getSnapshot()
    // 离线或本次检查没拿到结论时不动手：不知道哪些过期就不猜。
    if (snapshot.offline || snapshot.error !== null) return
    if (!snapshot.extensions.some((entry) => entry.status === 'update-available')) return
    const result = await packageUpdater.update()
    if (!result.ok) {
      console.error(`启动时自动更新扩展失败：${result.error.message}`)
      return
    }
    // 更新只改已装包，重查一次让设置页与启动提示看到新的已装版本。
    await updateChecker.check()
  } catch (error) {
    console.error(`启动时自动更新扩展失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function createWindow(pageUrl: string): Promise<void> {
  // 先应用存储的主题再创建窗口：让首帧媒体查询与窗口背景色都命中正确主题，避免闪烁。
  const preferences = await configStore.readUiPreferences()
  applyNativeTheme(preferences.theme)
  // 位置无效时 window-state 返回 null，交给窗口居中；最大化状态在创建后应用。
  const restored = await windowState.read()
  const window = new BrowserWindow({
    title: 'Pi Desktop',
    ...(restored.x !== null && restored.y !== null ? { x: restored.x, y: restored.y } : {}),
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    // 顶部栏由页面自绘：去掉原生标题栏，窗口按钮按平台交给原生红绿灯或系统覆盖层。
    ...titleBarWindowOptions(),
    // 默认菜单栏隐藏（Windows/Linux 按 Alt 临时唤起）；不替换菜单对象，保留其快捷键 role。
    autoHideMenuBar: true,
    backgroundColor: windowBackgroundColor(),
    webPreferences: {
      preload: resolve(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false
    }
  })
  if (restored.maximized) window.maximize()
  mainWindow = window
  const contents = window.webContents
  const rememberWindowState = (): void => windowState.notifyChanged(window)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || event.frame !== contents.mainFrame || event.url !== pageUrl) {
      event.preventDefault()
    }
  })
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame || event.url !== pageUrl) event.preventDefault()
  })
  // 页面重新加载后，上一份页面未确认的终端数据不再有人消费：清掉在途额度，避免终端被永久背压。
  contents.on('did-finish-load', () => terminals.resetDelivery())
  // 尺寸、位置与最大化状态的变化经防抖写回配置；close 时先记录，销毁后无法再读取 bounds。
  window.on('resize', rememberWindowState)
  window.on('move', rememberWindowState)
  window.on('maximize', rememberWindowState)
  window.on('unmaximize', rememberWindowState)
  window.on('close', () => windowState.captureBeforeClose(window))
  // 跟随系统主题时，OS 切换会让原生窗口背景与页面重绘短暂脱节；这里同步收敛背景色与覆盖层配色。
  nativeTheme.on('updated', () => {
    const target = mainWindow
    if (target === null || target.isDestroyed()) return
    target.setBackgroundColor(windowBackgroundColor())
    // 覆盖层只在 Windows/Linux 存在；macOS 调用会抛错，因此按平台区分。
    if (process.platform !== 'darwin') {
      target.setTitleBarOverlay({
        color: windowSurfaceColor(),
        symbolColor: windowInkColor(),
        height: TITLEBAR_HEIGHT
      })
    }
  })
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    // 页面已消失：终端不再有接收方，释放它的在途额度，退出链不必等待无意义的确认。
    terminals.resetDelivery()
    windowState.dispose()
    mainWindow = null
  })
  // 开发页面由 dev server 提供：HTML 带内容 ETag，只改响应头（如 CSP）时 ETag 不变，
  // Vite 会回 304 且不带自定义响应头，浏览器会沿用缓存里的旧头。每次启动先清一次缓存，
  // 保证页面用的是当前配置的响应头；生产页面由本地文件提供，不需要这一步。
  if (pageUrl !== APPLICATION_PAGE_URL) await session.defaultSession.clearCache()
  await window.loadURL(pageUrl)
}

// 第一阶段关闭唯一窗口即退出，不建立托盘或隐藏常驻行为。
app.on('window-all-closed', () => app.quit())

// 退出前走完关闭链：预算内完成即退出，超时强制退出，不把应用挂死。
app.on('before-quit', (event) => {
  if (quittingAfterShutdown) return
  event.preventDefault()
  quittingAfterShutdown = true
  // 退出意图立即阻止恢复，不等其他关闭链结束后才停止重建。
  sdkRuntime.beginShutdown()
  // 全部宿主关闭与其他关闭链并行开始，不因其它链的失败而遗留仍受管的 SDK 进程。
  const sdkShutdown = sdkRuntime.shutdown().catch(() => {
    console.error('SDK 宿主未确认退出，应用按关闭预算退出。')
  })
  // 终端 shell 的子进程（构建、服务）必须在退出前收敛，否则会留在系统里继续运行。
  const terminalShutdown = terminals.shutdown()
  void (async () => {
    // 先落盘窗口状态：写入很小，避免被关闭链的兜底等待挤掉。
    await Promise.race([windowState.flush(), wait(WINDOW_STATE_FLUSH_MS)])
    // 认证辅助进程没有自己的业务状态，只按关闭链终止。
    await Promise.race([authManager.stop(), wait(QUIT_DEADLINE_MS)])
    await Promise.race([terminalShutdown, wait(QUIT_DEADLINE_MS)])
    await Promise.race([sdkShutdown, wait(QUIT_DEADLINE_MS)])
    app.exit(0)
  })()
})

/**
 * 便携版把 Desktop 自己的配置数据放在可执行文件同级目录，整个文件夹可整体搬移。
 * macOS 的可执行文件在 `.app` 包体内，同级目录取包体所在的文件夹，避免往包体内写数据。
 * 只在打包态生效：开发态继续留在系统默认位置，两边数据互不覆盖。
 * 目录不可写时保留系统默认位置，让应用仍能启动，而不是带着空配置直接失败。
 */
function applyPortableDataDirectory(): void {
  if (!app.isPackaged) return
  const executable = app.getPath('exe')
  const root = process.platform === 'darwin'
    ? resolve(dirname(executable), '..', '..', '..')
    : dirname(executable)
  const directory = join(root, 'data')
  try {
    mkdirSync(directory, { recursive: true })
    app.setPath('userData', directory)
  } catch {
    console.error('便携数据目录不可用，改用系统默认位置。')
  }
}

applyPortableDataDirectory()

// 图形界面启动时进程 PATH 只有系统默认值，先补齐登录 shell 的 PATH，
// 使后续所有受管子进程（扩展更新、运行时安装、SDK 宿主）都能找到 npm、git。
applyLoginShellPath()

/**
 * 单实例：同一份 Desktop 配置只能由一个进程写。
 *
 * 配置存储是「启动读一次、每次保存写整份文件」，两个进程各自持有内存列表时，后写者会用
 * 自己过期的列表覆盖磁盘，表现为项目记录被写回或凭空消失。第二个实例直接退出，
 * 并把已有窗口带到前台（不走 `before-quit`，避免触发关闭链）。
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => focusMainWindow())

  app.whenReady().then(async () => {
    const pageUrl = getPageUrl()
    restrictSession()
    registerAssetProtocol()
    registerAppInfoHandler(pageUrl)
    registerRuntimeHandlers(pageUrl)
    registerExtensionUiHandlers(pageUrl)
    registerProjectHandlers(pageUrl)
    registerProjectFileHandlers(pageUrl)
    registerSessionHandlers(pageUrl)
    registerSessionRunHandlers(pageUrl)
    registerTerminalHandlers(pageUrl)
    registerTrustHandlers(pageUrl)
    registerPreferencesHandlers(pageUrl)
    registerPiSettingsHandlers(pageUrl)
    registerModelsConfigHandlers(pageUrl)
    registerAuthHandlers(pageUrl)
    registerUpdatesHandlers(pageUrl)
    sdkRuntime.onStatusChanged(broadcastRuntimeStatus)
    sdkRuntime.onProjectionBatch(broadcastRuntimeProjection)
    sdkRuntime.onExtensionUi(broadcastExtensionUi)
    sdkRuntime.onRunsChanged(broadcastSessionRuns)
    authManager.onFlowChanged(broadcastAuthFlow)
    updateChecker.onChanged(broadcastUpdates)
    packageUpdater.onProgress(broadcastPackageUpdateProgress)
    packageUpdater.onOutcome(broadcastPackageUpdateOutcome)
    piAgentUpdater.onProgress(broadcastAgentInstallProgress)
    await createWindow(pageUrl)
    // 窗口已创建后再开始检查：它只影响页面上的提示，不参与启动编排。
    // 首次检查结束后按开关决定要不要自动更新一次扩展；这一次不阻塞窗口显示。
    const initialCheck = updateChecker.startInitialCheck()
    if (initialCheck !== null) void initialCheck.then(runStartupAutoUpdate)
  }).catch(() => {
    console.error('Pi Desktop 无法加载桌面页面。')
    app.exit(1)
  })
}
