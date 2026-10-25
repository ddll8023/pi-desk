/**
 * 应用级生命周期：便携数据目录、登录 shell PATH、单实例锁、窗口全部关闭与退出链（先收敛局域网入口）。
 *
 * 退出链在预算内走完即退出，超时强制退出，不把应用挂死；终端的 PTY 由独立守护进程持有，
 * 这里只断开连接，下次启动按同一端点接回。
 */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { applyLoginShellPath } from './shared/shell-path'
import {
  authManager,
  lanRemote,
  packageUpdater,
  piAgentUpdater,
  preferencesManager,
  projectDirectoryWatcher,
  sdkRuntime,
  terminals,
  updateChecker,
  windowState,
} from './services'
import { createWindow, focusMainWindow, restrictSession } from './window'
import {
  broadcastAgentInstallProgress,
  broadcastAuthFlow,
  broadcastExtensionUi,
  broadcastLanRemoteState,
  broadcastPackageUpdateOutcome,
  broadcastPackageUpdateProgress,
  broadcastRuntimeProjection,
  broadcastRuntimeStatus,
  broadcastSessionRuns,
  broadcastUpdates,
} from './window-channel'
import { getPageUrl, registerAssetProtocol, registerAssetScheme } from './asset-protocol'
import { registerAppInfoHandler, registerOpenExternalUrlHandler } from './shell/ipc'
import { registerProjectHandlers, registerProjectFileHandlers } from './projects/ipc'
import { registerGitHandlers } from './git/ipc'
import { registerSessionHandlers, registerSessionRunHandlers } from './sessions/ipc'
import { registerExtensionUiHandlers } from './sessions/extension-ui-ipc'
import { registerRuntimeHandlers } from './sessions/runtime-ipc'
import { registerResourceHandlers } from './resources/ipc'
import { registerTrustHandlers } from './trust/ipc'
import { registerTerminalHandlers } from './terminal/ipc'
import { registerPreferencesHandlers } from './preferences/ipc'
import {
  registerGenuiParamHandlers,
} from './genui/ipc'
import {
  registerAuthHandlers,
  registerModelsConfigHandlers,
  registerPiSettingsHandlers,
} from './providers/ipc'
import { registerUpdatesHandlers } from './updates/ipc'
import { registerLanRemoteHandlers } from './lan-remote/ipc'

/** 应用退出时等待关闭链的总预算；覆盖各平台兜底阶段后强制退出。 */
const QUIT_DEADLINE_MS = 10_000
/** 窗口状态落盘的等待上限；超过就继续关闭链，不让小文件写入拖住退出。 */
const WINDOW_STATE_FLUSH_MS = 1_000

/** 有限等待；只用于退出编排，不证明被等待的操作已完成。 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

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

/** 必须在 ready 前调用：注册应用协议并固定会话权限。 */
export function prepareApplication(): void {
  registerAssetScheme()
  applyPortableDataDirectory()
  // 图形界面启动时进程 PATH 只有系统默认值，先补齐登录 shell 的 PATH，
  // 使后续所有受管子进程（扩展更新、运行时安装、SDK 宿主）都能找到 npm、git。
  applyLoginShellPath()
}

/**
 * 单实例：同一份 Desktop 配置只能由一个进程写。
 *
 * 配置存储是「启动读一次、每次保存写整份文件」，两个进程各自持有内存列表时，后写者会用
 * 自己过期的列表覆盖磁盘，表现为项目记录被写回或凭空消失。第二个实例直接退出，
 * 并把已有窗口带到前台（不走 `before-quit`，避免触发关闭链）。
 *
 * 返回值表示本进程是否获得了单实例锁；调用方在 false 时应直接退出。
 */
export function acquireSingleInstance(): boolean {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', () => focusMainWindow())
  return true
}

/** 注册退出链与窗口全部关闭行为；只应在获得单实例锁之后调用一次。 */
export function registerLifecycle(): void {
  // 第一阶段关闭唯一窗口即退出，不建立托盘或隐藏常驻行为。
  app.on('window-all-closed', () => app.quit())

  let quittingAfterShutdown = false
  // 退出前走完关闭链：预算内完成即退出，超时强制退出，不把应用挂死。
  app.on('before-quit', (event) => {
    if (quittingAfterShutdown) return
    event.preventDefault()
    quittingAfterShutdown = true
    // 先撤销网络入口：停止接收远程操作并断开手机，再并行关闭会话宿主。
    const lanShutdown = lanRemote.shutdown().catch(error => {
      console.error('[lan-remote] 退出清理失败：', error)
    })
    // 退出意图立即阻止恢复，不等其他关闭链结束后才停止重建。
    sdkRuntime.beginShutdown()
    // 全部宿主关闭与其他关闭链并行开始，不因其它链的失败而遗留仍受管的 SDK 进程。
    const sdkShutdown = sdkRuntime.shutdown().catch(() => {
      console.error('SDK 宿主未确认退出，应用按关闭预算退出。')
    })
    // 终端不再随应用退出而终止：终端由独立守护进程持有，应用退出后继续运行；这里只断开连接，
    // 下次启动按同一端点接回。用户要结束终端时用「关闭全部终端」或关闭对应标签。
    terminals.shutdown()
    // 文件监听没有待落盘的数据，先拆掉，避免关闭链期间继续产生事件。
    projectDirectoryWatcher.dispose()
    void (async () => {
      // 先落盘窗口状态：写入很小，避免被关闭链的兜底等待挤掉。
      await Promise.race([windowState.flush(), wait(WINDOW_STATE_FLUSH_MS)])
      // 认证辅助进程没有自己的业务状态，只按关闭链终止。
      await Promise.race([authManager.stop(), wait(QUIT_DEADLINE_MS)])
      await Promise.race([Promise.all([sdkShutdown, lanShutdown]), wait(QUIT_DEADLINE_MS)])
      app.exit(0)
    })()
  })
}

/** 窗口就绪后的注册顺序：权限与协议 → 各能力 IPC → 事件订阅 → 建窗 → 启动检查。 */
export async function startApplication(): Promise<void> {
  const pageUrl = getPageUrl()
  restrictSession()
  registerAssetProtocol()

  registerAppInfoHandler(pageUrl)
  registerOpenExternalUrlHandler(pageUrl)
  registerRuntimeHandlers(pageUrl)
  registerResourceHandlers(pageUrl)
  registerExtensionUiHandlers(pageUrl)
  registerProjectHandlers(pageUrl)
  registerProjectFileHandlers(pageUrl)
  registerGitHandlers(pageUrl)
  registerSessionHandlers(pageUrl)
  registerSessionRunHandlers(pageUrl)
  registerTerminalHandlers(pageUrl)
  registerTrustHandlers(pageUrl)
  registerPreferencesHandlers(pageUrl)
  registerGenuiParamHandlers(pageUrl)
  registerPiSettingsHandlers(pageUrl)
  registerModelsConfigHandlers(pageUrl)
  registerAuthHandlers(pageUrl)
  registerUpdatesHandlers(pageUrl)
  registerLanRemoteHandlers(pageUrl)

  // 事件订阅：全部只投递给当前唯一可信窗口。
  sdkRuntime.onStatusChanged(broadcastRuntimeStatus)
  sdkRuntime.onProjectionBatch(broadcastRuntimeProjection)
  sdkRuntime.onExtensionUi(broadcastExtensionUi)
  sdkRuntime.onRunsChanged(broadcastSessionRuns)
  lanRemote.onChanged(broadcastLanRemoteState)
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
}
