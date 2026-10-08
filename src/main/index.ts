/** 管理唯一桌面窗口及其尺寸位置偏好、本地资产边界，以及应用信息、Project 选择与列表、Session 列表与打开、界面偏好、Runtime 启停、Prompt 提交、中止、Agent 能力查询与设置、消息/工具投影 IPC、事件广播与退出编排。 */
import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_INFO_CHANNEL } from '../shared/desktop-api'
import type { AppInfoResult } from '../shared/desktop-api'
import {
  PREFERENCES_GET_CHANNEL,
  PREFERENCES_SET_UI_CHANNEL
} from '../shared/preferences-api'
import type { PreferencesErrorCode, PreferencesResult } from '../shared/preferences-api'
import {
  PROJECT_CHOOSE_DIRECTORY_CHANNEL,
  PROJECT_LIST_CHANNEL,
  PROJECT_SET_CURRENT_CHANNEL
} from '../shared/project-api'
import type { ProjectErrorCode, ProjectListResult, ProjectPathResult } from '../shared/project-api'
import {
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL
} from '../shared/session-api'
import type { SessionErrorCode, SessionListResult, SessionOpenResult } from '../shared/session-api'
import {
  RUNTIME_ABORT_CHANNEL,
  RUNTIME_CAPABILITIES_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_PROJECTION_EVENT,
  RUNTIME_SET_MODEL_CHANNEL,
  RUNTIME_SET_THINKING_LEVEL_CHANNEL,
  RUNTIME_START_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STOP_CHANNEL,
  RUNTIME_STATUS_EVENT
} from '../shared/runtime-api'
import type {
  CapabilitiesResult,
  ProjectionBatch,
  ProjectionResult,
  PromptResult,
  RuntimeErrorCode,
  RuntimeResult,
  RuntimeStatus
} from '../shared/runtime-api'
import { DesktopConfigStore } from './desktop-config-store'
import { PreferencesManager } from './preferences-manager'
import { ProjectManager } from './project-manager'
import { RuntimeManager } from './runtime-manager'
import { SessionManager } from './session-manager'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, WindowState } from './window-state'

const DEVELOPMENT_PAGE_URL = 'http://127.0.0.1:5173/'
const APPLICATION_PAGE_URL = 'app://desktop/index.html'
/** 应用退出时等待关闭链的总预算；覆盖各平台兜底阶段后强制退出。 */
const QUIT_DEADLINE_MS = 10_000
/** 窗口状态落盘的等待上限；超过就继续关闭链，不让小文件写入拖住退出。 */
const WINDOW_STATE_FLUSH_MS = 1_000
/** 模型 provider/id 的长度上限；只限制形状，模型是否存在由 Pi 判定。 */
const MAX_MODEL_IDENTIFIER_CHARS = 256
/** Thinking level 的长度上限；取值合法性由 Pi 判定，不在此白名单。 */
const MAX_THINKING_LEVEL_CHARS = 32
const rendererRoot = resolve(__dirname, '../renderer')
const productionCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
  "img-src 'self'",
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
const runtimeManager = new RuntimeManager()
/** 配置文件的唯一读写者；项目列表、界面偏好与窗口状态共用同一份文件。 */
const configStore = new DesktopConfigStore()
const projectManager = new ProjectManager({
  chooseDirectory: chooseDirectoryWithDialog,
  runtime: runtimeManager,
  store: configStore
})
const sessionManager = new SessionManager({ projects: projectManager, runtime: runtimeManager })
const preferencesManager = new PreferencesManager({ store: configStore })
const windowState = new WindowState({ store: configStore })

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
  ipcMain.handle(APP_INFO_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): AppInfoResult => {
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

function projectPathFailure(code: ProjectErrorCode, message: string): ProjectPathResult {
  return { ok: false, error: { code, message } }
}

function projectListFailure(code: ProjectErrorCode, message: string): ProjectListResult {
  return { ok: false, error: { code, message } }
}

function sessionFailure(code: SessionErrorCode, message: string): SessionListResult {
  return { ok: false, error: { code, message } }
}

function preferencesFailure(code: PreferencesErrorCode, message: string): PreferencesResult {
  return { ok: false, error: { code, message } }
}

/** 只接受非空且长度受控的标识字符串；空字符串与超长都按参数拒绝。 */
function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength
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

/** 只接受项目路径与显式中断确认；不接受任意 channel、任意路径或其他 RPC 内容。 */
function registerProjectHandlers(pageUrl: string): void {
  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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
        return projectListFailure('INVALID_REQUEST', '切换项目必须显式说明是否允许中断当前操作。')
      }
      return projectManager.setCurrent({ path, allowInterrupt })
    }
  )
}

/** 只接受会话 id 与显式中断确认；会话归属与文件解析都在主进程内部完成。 */
function registerSessionHandlers(pageUrl: string): void {
  ipcMain.handle(
    SESSION_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return sessionFailure('INVALID_REQUEST', '会话列表接口不接受参数。')
      }
      return sessionManager.list()
    }
  )

  ipcMain.handle(
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
      if (Object.keys(fields).some((key) => key !== 'sessionId' && key !== 'allowInterrupt')) {
        return sessionFailure('INVALID_REQUEST', '打开会话参数包含未支持的字段。')
      }
      const { sessionId, allowInterrupt } = fields
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
        return sessionFailure('INVALID_REQUEST', '打开会话必须显式说明是否允许中断当前操作。')
      }
      return sessionManager.open({ sessionId: targetSessionId, allowInterrupt })
    }
  )
}

/** 只接受项目目录；不接受可执行文件路径、启动参数或任意 RPC 内容。 */
function registerRuntimeHandlers(pageUrl: string): void {
  ipcMain.handle(
    RUNTIME_START_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return runtimeFailure('INVALID_REQUEST', '启动 Runtime 接口只接受一个项目目录对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return runtimeFailure('INVALID_REQUEST', '启动 Runtime 参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'projectPath')) {
        return runtimeFailure('INVALID_REQUEST', '启动 Runtime 参数包含未支持的字段。')
      }
      const projectPath = fields.projectPath
      if (typeof projectPath !== 'string') {
        return runtimeFailure('INVALID_PROJECT_PATH', '项目目录必须是非空的绝对路径。')
      }
      return runtimeManager.start(projectPath, null)
    }
  )

  ipcMain.handle(RUNTIME_STATUS_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): RuntimeResult => {
    if (!isTrustedCaller(event, pageUrl)) {
      return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    }
    if (args.length !== 0) {
      return runtimeFailure('INVALID_REQUEST', 'Runtime 状态接口不接受参数。')
    }
    return runtimeManager.getStatus()
  })

  ipcMain.handle(
    RUNTIME_STOP_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return runtimeFailure('INVALID_REQUEST', '关闭 Runtime 接口不接受参数。')
      }
      return runtimeManager.stop()
    }
  )

  /** 中止当前 Agent 操作；只接受零参数，运行状态仍以事件流为准。 */
  ipcMain.handle(
    RUNTIME_ABORT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return runtimeFailure('INVALID_REQUEST', '中止操作接口不接受参数。')
      }
      return runtimeManager.abort()
    }
  )

  /** 能力读取只查询当前 Runtime 代际，不接受任何参数；分区失败由结果内的 error 表达。 */
  ipcMain.handle(
    RUNTIME_CAPABILITIES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<CapabilitiesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return capabilitiesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return capabilitiesFailure('INVALID_REQUEST', '能力读取接口不接受参数。')
      }
      return runtimeManager.readCapabilities()
    }
  )

  /** 只接受 provider 与模型 id；不接受任意模型对象、启动参数或其他 RPC 内容。 */
  ipcMain.handle(
    RUNTIME_SET_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return runtimeFailure('INVALID_REQUEST', '切换模型接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return runtimeFailure('INVALID_REQUEST', '切换模型参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'provider' && key !== 'modelId')) {
        return runtimeFailure('INVALID_REQUEST', '切换模型参数包含未支持的字段。')
      }
      const { provider, modelId } = fields
      if (!isBoundedIdentifier(provider, MAX_MODEL_IDENTIFIER_CHARS)) {
        return runtimeFailure('INVALID_REQUEST', '模型 provider 必须是非空且长度受控的字符串。')
      }
      if (!isBoundedIdentifier(modelId, MAX_MODEL_IDENTIFIER_CHARS)) {
        return runtimeFailure('INVALID_REQUEST', '模型 id 必须是非空且长度受控的字符串。')
      }
      return runtimeManager.setModel({ provider, modelId })
    }
  )

  /** 只接受 Thinking level 字符串；是否被当前模型支持由 Pi 判定。 */
  ipcMain.handle(
    RUNTIME_SET_THINKING_LEVEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return runtimeFailure('INVALID_REQUEST', '设置 Thinking level 接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return runtimeFailure('INVALID_REQUEST', 'Thinking level 参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'level')) {
        return runtimeFailure('INVALID_REQUEST', 'Thinking level 参数包含未支持的字段。')
      }
      const { level } = fields
      if (!isBoundedIdentifier(level, MAX_THINKING_LEVEL_CHARS)) {
        return runtimeFailure('INVALID_REQUEST', 'Thinking level 必须是非空且长度受控的字符串。')
      }
      return runtimeManager.setThinkingLevel({ level })
    }
  )

  /** 只接受 Prompt 文本；不接受可执行文件路径、启动参数、图片或排队选项。 */
  ipcMain.handle(
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
      if (Object.keys(fields).some((key) => key !== 'message')) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 参数包含未支持的字段。')
      }
      const message = fields.message
      if (typeof message !== 'string') {
        return promptFailure('INVALID_REQUEST', 'Prompt 内容必须是字符串。')
      }
      return runtimeManager.prompt(message)
    }
  )

  /** 投影快照只读取当前 Runtime 代际的投影，不接受任何参数。 */
  ipcMain.handle(
    RUNTIME_PROJECTION_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): ProjectionResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return projectionFailure('INVALID_REQUEST', '投影快照接口不接受参数。')
      }
      return runtimeManager.getProjection()
    }
  )

  /** 应用确认只控制未确认通知窗口；参数不合法时忽略，不回传结果。 */
  ipcMain.handle(
    RUNTIME_PROJECTION_ACK_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
      if (!isTrustedCaller(event, pageUrl) || args.length !== 1) return
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'runtimeId' && key !== 'seq')) return
      const { runtimeId, seq } = fields
      if (typeof runtimeId !== 'number' || typeof seq !== 'number') return
      if (!Number.isInteger(runtimeId) || !Number.isInteger(seq) || runtimeId <= 0 || seq < 0) return
      runtimeManager.ackProjection(runtimeId, seq)
    }
  )
}

/** 只接受 Sidebar 折叠状态；界面偏好没有其他字段，未知字段一律拒绝。 */
function registerPreferencesHandlers(pageUrl: string): void {
  ipcMain.handle(
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

  ipcMain.handle(
    PREFERENCES_SET_UI_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PreferencesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return preferencesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return preferencesFailure('INVALID_REQUEST', '保存界面偏好接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'sidebarCollapsed')) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好参数包含未支持的字段。')
      }
      const { sidebarCollapsed } = fields
      if (typeof sidebarCollapsed !== 'boolean') {
        return preferencesFailure('INVALID_REQUEST', 'Sidebar 折叠状态必须是布尔值。')
      }
      return preferencesManager.setUi({ sidebarCollapsed })
    }
  )
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

function restrictSession(): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.on('will-download', (event) => event.preventDefault())
}

async function createWindow(pageUrl: string): Promise<void> {
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
    backgroundColor: '#f3f6f8',
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
  // 尺寸、位置与最大化状态的变化经防抖写回配置；close 时先记录，销毁后无法再读取 bounds。
  window.on('resize', rememberWindowState)
  window.on('move', rememberWindowState)
  window.on('maximize', rememberWindowState)
  window.on('unmaximize', rememberWindowState)
  window.on('close', () => windowState.captureBeforeClose(window))
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    windowState.dispose()
    mainWindow = null
  })
  await window.loadURL(pageUrl)
}

// 第一阶段关闭唯一窗口即退出，不建立托盘或隐藏常驻行为。
app.on('window-all-closed', () => app.quit())

// 退出前走完关闭链：预算内完成即退出，超时强制退出，不把应用挂死。
app.on('before-quit', (event) => {
  if (quittingAfterShutdown) return
  event.preventDefault()
  quittingAfterShutdown = true
  void (async () => {
    // 先落盘窗口状态：写入很小，避免被关闭链的兜底等待挤掉。
    await Promise.race([windowState.flush(), wait(WINDOW_STATE_FLUSH_MS)])
    await Promise.race([runtimeManager.shutdown(), wait(QUIT_DEADLINE_MS)])
    app.exit(0)
  })()
})

app.whenReady().then(async () => {
  const pageUrl = getPageUrl()
  restrictSession()
  registerAssetProtocol()
  registerAppInfoHandler(pageUrl)
  registerRuntimeHandlers(pageUrl)
  registerProjectHandlers(pageUrl)
  registerSessionHandlers(pageUrl)
  registerPreferencesHandlers(pageUrl)
  runtimeManager.onStatusChanged(broadcastRuntimeStatus)
  runtimeManager.onProjectionBatch(broadcastRuntimeProjection)
  await createWindow(pageUrl)
}).catch(() => {
  console.error('Pi Desktop 无法加载桌面页面。')
  app.exit(1)
})
