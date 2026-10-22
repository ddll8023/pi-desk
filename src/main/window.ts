/** 唯一桌面窗口的创建与外观：窗口创建、原生主题与标题栏配色、导航与权限限制、单实例聚焦。窗口引用由 window-channel.ts 持有，业务实例由 services.ts 注入；投递与广播在同目录的 window-channel.ts，退出时的落盘由 app-lifecycle.ts 驱动。 */

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
import { mainWindow, setMainWindow } from './window-channel'

/** 窗口引用由 window-channel 持有；此处再导出，使既有调用方无需改路径。 */
export { mainWindow }

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

/** 应用级权限收紧：拒绝页面发起的一切权限请求，并阻止下载。 */
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
  setMainWindow(window)
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
    setMainWindow(null)
  })
  // 开发页面由 dev server 提供：HTML 带内容 ETag，只改响应头（如 CSP）时 ETag 不变，
  // Vite 会回 304 且不带自定义响应头，浏览器会沿用缓存里的旧头。每次启动先清一次缓存，
  // 保证页面用的是当前配置的响应头；生产页面由本地文件提供，不需要这一步。
  if (pageUrl !== APPLICATION_PAGE_URL) await session.defaultSession.clearCache()
  await window.loadURL(pageUrl)
}
