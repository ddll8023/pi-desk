/** 管理唯一桌面窗口、本地资产边界，以及应用信息与 Runtime 启停、Prompt 提交 IPC、状态事件广播与退出编排。 */
import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { APP_INFO_CHANNEL } from '../shared/desktop-api'
import type { AppInfoResult } from '../shared/desktop-api'
import {
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_START_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  RUNTIME_STOP_CHANNEL,
  RUNTIME_STATUS_EVENT
} from '../shared/runtime-api'
import type { PromptResult, RuntimeErrorCode, RuntimeResult, RuntimeStatus } from '../shared/runtime-api'
import { RuntimeManager } from './runtime-manager'

const DEVELOPMENT_PAGE_URL = 'http://127.0.0.1:5173/'
const APPLICATION_PAGE_URL = 'app://desktop/index.html'
/** 应用退出时等待关闭链的总预算；覆盖各平台兜底阶段后强制退出。 */
const QUIT_DEADLINE_MS = 10_000
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
      return runtimeManager.start(projectPath)
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
}

/** 状态变化只发给当前唯一可信窗口，不广播到其他 webContents。 */
function broadcastRuntimeStatus(status: RuntimeStatus): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(RUNTIME_STATUS_EVENT, status)
}

function restrictSession(): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.on('will-download', (event) => event.preventDefault())
}

async function createWindow(pageUrl: string): Promise<void> {
  const window = new BrowserWindow({
    title: 'Pi Desktop',
    width: 1120,
    height: 820,
    minWidth: 720,
    minHeight: 600,
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
  mainWindow = window
  const contents = window.webContents
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
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
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
    await Promise.race([
      runtimeManager.shutdown(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, QUIT_DEADLINE_MS)
      })
    ])
    app.exit(0)
  })()
})

app.whenReady().then(async () => {
  const pageUrl = getPageUrl()
  restrictSession()
  registerAssetProtocol()
  registerAppInfoHandler(pageUrl)
  registerRuntimeHandlers(pageUrl)
  runtimeManager.onStatusChanged(broadcastRuntimeStatus)
  await createWindow(pageUrl)
}).catch(() => {
  console.error('Pi Desktop 无法加载桌面页面。')
  app.exit(1)
})
