/**
 * 渲染进程投递通道：唯一窗口引用、向页面发送事件、全部业务广播，以及系统目录选择。
 *
 * 只依赖 Electron 与共享契约，不 import `services.ts`。窗口创建与业务实例分别在其他模块，
 * 两侧都只单向依赖本文件，因此这里不能反向读取任何业务管理器：需要业务数据的广播
 * （如终端守护进程状态）由组合根注册取值函数，见 `registerTerminalStatusSource`。
 */
import { BrowserWindow, dialog } from 'electron'
import { LAN_REMOTE_STATE_EVENT } from '../shared/lan-remote-api'
import type { LanRemoteState } from '../shared/lan-remote-api'
import type { TerminalDaemonStatusResult } from '../shared/terminal-api'
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

/** 唯一业务窗口的引用；全部推送与调用者校验都从这里取当前窗口。 */
export let mainWindow: BrowserWindow | null = null

/** 由窗口创建链在建立窗口后登记，销毁时置回 null。 */
export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window
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

/** 手机访问控制状态只投递可信桌面窗口，不包含设备凭证摘要。 */
export function broadcastLanRemoteState(state: LanRemoteState): void {
  sendToRenderer(LAN_REMOTE_STATE_EVENT, state)
}

/**
 * 终端守护进程状态的取值函数：由组合根在建立终端管理器后注册。
 * 本文件不持有终端实例，避免投递通道反向依赖业务装配。
 */
let readTerminalStatus: (() => Promise<TerminalDaemonStatusResult>) | null = null

/** 注册终端守护进程状态来源；重复注册以最后一次为准。 */
export function registerTerminalStatusSource(read: () => Promise<TerminalDaemonStatusResult>): void {
  readTerminalStatus = read
}

/**
 * 守护进程连接变化时推一份最新状态给页面。
 * 重入保护：状态请求本身可能触发重连，重连又会回调到这里，不加保护会形成回环。
 * 未注册取值函数时只记一次错误：终端尚未建立，没有可推送的状态。
 */
let broadcastingTerminalDaemonStatus = false
export async function broadcastTerminalDaemonStatus(): Promise<void> {
  if (broadcastingTerminalDaemonStatus) return
  if (readTerminalStatus === null) {
    console.error('[window-channel] 终端状态来源尚未注册，跳过本次守护进程状态推送。')
    return
  }
  broadcastingTerminalDaemonStatus = true
  try {
    const result = await readTerminalStatus()
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
