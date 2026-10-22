/** 唯一桌面窗口的所有权：窗口创建、原生主题与标题栏配色、导航与权限限制、向渲染进程投递事件、单实例聚焦与应用退出时的窗口状态收敛。窗口引用只在这里持有，业务实例由 services.ts 注入。 */

import { resolve } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { UiTheme } from '../shared/preferences-api'
import { TERMINAL_DAEMON_STATUS_EVENT } from '../shared/terminal-api'
import { SESSION_RUNS_EVENT } from '../shared/session-run-api'
import type { SessionRunsSnapshot } from '../shared/session-run-api'
import { EXTENSION_UI_EVENT } from '../shared/extension-ui-api'
import type { ExtensionUiSnapshot } from '../shared/extension-ui-api'
import { AUTH_FLOW_EVENT } from '../shared/auth-api'
import type { AuthFlowSnapshot } from '../shared/auth-api'
import { RUNTIME_PROJECTION_EVENT, RUNTIME_STATUS_EVENT } from '../shared/runtime-api'
import type { ProjectionBatch, RuntimeStatus } from '../shared/runtime-api'
import {
  UPDATES_INSTALL_AGENT_PROGRESS_EVENT,
  UPDATES_STATE_EVENT,
  UPDATES_UPDATE_OUTCOME_EVENT,
  UPDATES_UPDATE_PROGRESS_EVENT
} from '../shared/updates-api'
import type {
  AgentInstallProgress,
  PackageUpdateOutcome,
  PackageUpdateProgress,
  UpdatesSnapshot
} from '../shared/updates-api'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from './window-state'
import {
  configStore,
  projectDirectoryWatcher,
  sdkRuntime,
  terminals,
  windowState,
} from './services'
import { APPLICATION_PAGE_URL } from './asset-protocol'

/** 窗口背景色的浅色与暗色值；与 main.css 的 canvas 令牌保持一致，避免首帧闪烁。 */
export const LIGHT_WINDOW_BACKGROUND = '#f4f6f8'
const DARK_WINDOW_BACKGROUND = '#10161c'
/** 页面自绘顶部栏的高度；与 main.css 的 `.app-titlebar` 及 Windows/Linux 覆盖层高度共用同一数值。 */
const TITLEBAR_HEIGHT = 44
/** 顶部栏底色与窗口按钮图标色的浅色/暗色值；与 main.css 的 surface、ink 令牌保持一致。 */
const LIGHT_WINDOW_SURFACE = '#ffffff'
const DARK_WINDOW_SURFACE = '#1a222b'
const LIGHT_WINDOW_INK = '#17252f'
const DARK_WINDOW_INK = '#dce6ee'

/** 唯一业务窗口的引用；全部推送与调用者校验都从这里取当前窗口。 */
export let mainWindow: BrowserWindow | null = null

/** 把界面偏好的主题取值应用到 Electron 原生主题；驱动页面内 `prefers-color-scheme` 媒体查询。 */
export function applyNativeTheme(theme: UiTheme): void {
  nativeTheme.themeSource = theme
}

/** 按当前生效主题返回窗口背景色；与 main.css 的 `--color-desk-canvas` 同步维护。 */
export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_BACKGROUND : LIGHT_WINDOW_BACKGROUND
}

/** 按当前生效主题返回顶部栏底色；与 main.css 的 `--color-desk-surface` 同步维护。 */
export function windowSurfaceColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_SURFACE : LIGHT_WINDOW_SURFACE
}

/** 按当前生效主题返回 Windows/Linux 窗口按钮的图标色；与 main.css 的 `--color-desk-ink` 同步维护。 */
export function windowInkColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_WINDOW_INK : LIGHT_WINDOW_INK
}

/**
 * 顶部栏的窗口参数：页面自绘顶部栏后不再保留原生标题栏，避免出现两层栏。
 * macOS 用 hiddenInset 保留原生红绿灯；Windows/Linux 用系统绘制的覆盖层提供最小化/最大化/关闭。
 */
export function titleBarWindowOptions(): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: windowSurfaceColor(), symbolColor: windowInkColor(), height: TITLEBAR_HEIGHT }
  }
}

/** 打开系统目录选择器；绑定唯一业务窗口，用户取消返回 `null`。 */
export async function chooseDirectoryWithDialog(defaultPath: string): Promise<string | null> {
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

/** 只发给当前唯一可信窗口；返回是否真的投递，未投递时调用方保留数据。 */
export function sendToRenderer(channel: string, payload: unknown): boolean {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return false
  const contents = target.webContents
  if (contents.isDestroyed()) return false
  contents.send(channel, payload)
  return true
}

/**
 * 守护进程连接变化时推一份最新状态给页面。
 * 重入保护：状态请求本身可能触发重连，重连又会回调到这里，不加保护会形成回环。
 */
export let broadcastingTerminalDaemonStatus = false

export async function broadcastTerminalDaemonStatus(): Promise<void> {
  if (broadcastingTerminalDaemonStatus) return
  broadcastingTerminalDaemonStatus = true
  try {
    const result = await terminals.status()
    if (result.ok) sendToRenderer(TERMINAL_DAEMON_STATUS_EVENT, result.data)
  } finally {
    broadcastingTerminalDaemonStatus = false
  }
}

/** 状态变化只发给当前唯一可信窗口，不广播到其他 webContents。 */
export function broadcastRuntimeStatus(status: RuntimeStatus): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(RUNTIME_STATUS_EVENT, status)
}

/** 投影批次同样只发给当前唯一可信窗口，不广播到其他 webContents。 */
export function broadcastRuntimeProjection(batch: ProjectionBatch): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(RUNTIME_PROJECTION_EVENT, batch)
}

/** Extension UI 快照同样只发给当前唯一可信窗口，不广播到其他 webContents。 */
export function broadcastExtensionUi(snapshot: ExtensionUiSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(EXTENSION_UI_EVENT, snapshot)
}

/** 运行实例状态列表只发给当前唯一可信窗口；列表只含粗粒度字段。 */
export function broadcastSessionRuns(snapshot: SessionRunsSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(SESSION_RUNS_EVENT, snapshot)
}

/** 登录流程快照同样只发给当前唯一可信窗口。 */
export function broadcastAuthFlow(snapshot: AuthFlowSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(AUTH_FLOW_EVENT, snapshot)
}

/** Pi 版本检查快照同样只发给当前唯一可信窗口；检查结论只含版本号与结论文本。 */
export function broadcastUpdates(snapshot: UpdatesSnapshot): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_STATE_EVENT, snapshot)
}

/** 扩展更新进度同样只发给当前唯一可信窗口；进度只含来源、动作与展示文本。 */
export function broadcastPackageUpdateProgress(progress: PackageUpdateProgress): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_UPDATE_PROGRESS_EVENT, progress)
}

/** 扩展更新结论同样只发给当前唯一可信窗口；自动执行的更新没有调用方在等结果，页面靠它收敛。 */
export function broadcastPackageUpdateOutcome(outcome: PackageUpdateOutcome): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_UPDATE_OUTCOME_EVENT, outcome)
}

/** 内置 Pi agent 安装进度只发给当前唯一可信窗口；进度只含阶段、版本与展示文本。 */
export function broadcastAgentInstallProgress(progress: AgentInstallProgress): void {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return
  const contents = target.webContents
  if (contents.isDestroyed()) return
  contents.send(UPDATES_INSTALL_AGENT_PROGRESS_EVENT, progress)
}

export function restrictSession(): void {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.on('will-download', (event) => event.preventDefault())
}

/**
 * 把已有窗口带到前台；第二个实例启动时调用。窗口已销毁或不存在时什么都不做。
 */
export function focusMainWindow(): void {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export async function createWindow(pageUrl: string): Promise<void> {
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
  // 导航开始时撤销旧页面投递；不能在加载完成时撤销，否则会清掉新页面已建立的恢复代际。
  contents.on('did-start-loading', () => terminals.resetDelivery())
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
    // 页面已消失：终端不再有接收方，释放它的在途额度；终端本身由守护进程保留，重新打开时接回。
    terminals.resetDelivery()
    // 目录监听只服务于这个窗口，窗口关掉就没有接收方了。
    projectDirectoryWatcher.dispose()
    windowState.dispose()
    mainWindow = null
  })
  // 开发页面由 dev server 提供：HTML 带内容 ETag，只改响应头（如 CSP）时 ETag 不变，
  // Vite 会回 304 且不带自定义响应头，浏览器会沿用缓存里的旧头。每次启动先清一次缓存，
  // 保证页面用的是当前配置的响应头；生产页面由本地文件提供，不需要这一步。
  if (pageUrl !== APPLICATION_PAGE_URL) await session.defaultSession.clearCache()
  await window.loadURL(pageUrl)
}
