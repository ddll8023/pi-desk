/** 唯一桌面窗口的创建与外观：窗口创建、原生主题与标题栏配色、导航与权限限制、单实例聚焦及关闭拦截（关闭时检测终端任务并提供终止/后台常驻选择，无活跃任务时自动收尾守护进程释放文件锁）。窗口引用由 window-channel.ts 持有，业务实例由 services.ts 注入；投递与广播在同目录的 window-channel.ts，退出时的落盘由 app-lifecycle.ts 驱动。 */

import { resolve } from 'node:path'
import { app, BrowserWindow, dialog, nativeTheme, session } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { UiTheme } from '../shared/preferences-api'
import { TERMINAL_DAEMON_STATUS_EVENT } from '../shared/terminal-api'
import { SESSION_RUNS_EVENT } from '../shared/session-run-api'
import { PROJECT_HTML_PREVIEW_PARTITION_PREFIX, PROJECT_HTML_PREVIEW_SCHEME } from '../shared/project-file-api'
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
  projectHtmlPreview,
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

/** 应用级权限收紧：拒绝主会话与内置浏览器发起的一切敏感权限请求，并阻止下载。 */
export function restrictSession(): void {
  const sessions = [session.defaultSession, session.fromPartition('persist:desktop-browser')]
  for (const s of sessions) {
    s.setPermissionCheckHandler(() => false)
    s.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    s.on('will-download', (event) => event.preventDefault())
  }
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
      webviewTag: true
    }
  })
  if (restored.maximized) window.maximize()
  setMainWindow(window)
  const contents = window.webContents
  const previewOwnerId = contents.id
  const rememberWindowState = (): void => windowState.notifyChanged(window)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const partition = params.partition ?? webPreferences.partition ?? ''
    const htmlPreview = partition.startsWith(PROJECT_HTML_PREVIEW_PARTITION_PREFIX)
      || (params.src ?? '').startsWith(`${PROJECT_HTML_PREVIEW_SCHEME}:`)
    if (htmlPreview) {
      if (!projectHtmlPreview.configureWebview(previewOwnerId, webPreferences, params)) event.preventDefault()
      return
    }
    // 强制隔离内置浏览器 webview，彻底剥离主应用能力与 Node 环境
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    delete webPreferences.preload
    webPreferences.partition = 'persist:desktop-browser'
  })
  contents.on('did-attach-webview', (_event, guest) => projectHtmlPreview.attachGuest(previewOwnerId, guest))
  contents.on('did-start-navigation', event => {
    if (event.isMainFrame && event.frame === contents.mainFrame && !event.isSameDocument) projectHtmlPreview.releaseOwner(previewOwnerId)
  })
  contents.on('render-process-gone', () => projectHtmlPreview.releaseOwner(previewOwnerId))
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

  let isConfirmedToClose = false
  let isCheckingClose = false
  window.on('close', (event) => {
    if (isConfirmedToClose) {
      windowState.captureBeforeClose(window)
      return
    }

    event.preventDefault()
    if (isCheckingClose) return
    isCheckingClose = true

    void (async () => {
      try {
        if (!terminals.hasLiveProcess) {
          isConfirmedToClose = true
          if (!window.isDestroyed()) window.close()
          return
        }

        const statusResult = await terminals.status()
        const runningCount = statusResult.ok ? statusResult.data.runningCount : 0

        if (runningCount > 0) {
          if (window.isDestroyed()) return
          const { response } = await dialog.showMessageBox(window, {
            type: 'question',
            buttons: ['终止终端并退出', '后台保持运行', '取消'],
            defaultId: 0,
            cancelId: 2,
            title: '退出确认',
            message: `当前有 ${runningCount} 个终端任务正在运行，是否终止？`,
            detail: '终止终端：结束所有终端进程并释放程序文件，适合准备覆盖更新；\n后台运行：终端在后台继续执行，下次启动可接回终端；\n取消：留在应用中。',
            noLink: true
          })

          if (response === 0) {
            await terminals.stopDaemon()
            isConfirmedToClose = true
            if (!window.isDestroyed()) window.close()
          } else if (response === 1) {
            isConfirmedToClose = true
            if (!window.isDestroyed()) window.close()
          }
          // response === 2 即取消，保持窗口打开
        } else {
          // 守护进程存活但已无运行中的终端任务，优雅停止以避免空闲锁定可执行文件
          await terminals.stopDaemon()
          isConfirmedToClose = true
          if (!window.isDestroyed()) window.close()
        }
      } catch (error) {
        console.error('窗口关闭检查失败：', error)
        isConfirmedToClose = true
        if (!window.isDestroyed()) window.close()
      } finally {
        isCheckingClose = false
      }
    })()
  })
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
    projectHtmlPreview.releaseOwner(previewOwnerId)
    windowState.dispose()
    setMainWindow(null)
  })
  // 开发页面由 dev server 提供：HTML 带内容 ETag，只改响应头（如 CSP）时 ETag 不变，
  // Vite 会回 304 且不带自定义响应头，浏览器会沿用缓存里的旧头。每次启动先清一次缓存，
  // 保证页面用的是当前配置的响应头；生产页面由本地文件提供，不需要这一步。
  if (pageUrl !== APPLICATION_PAGE_URL) await session.defaultSession.clearCache()
  await window.loadURL(pageUrl)
}
