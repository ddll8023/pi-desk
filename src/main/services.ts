/** 主进程业务实例的唯一装配处：配置、项目、信任、会话、终端、供应商、资源、更新与生成式界面各一份，按依赖顺序建立并互相注入回调。本文件只做实例化，不注册 IPC、不写业务判断；其中系统目录选择与终端守护状态广播经 window-channel.ts 提供，是本文件对窗口投递层的唯一依赖。 */

import { app } from 'electron'
import { PROJECT_DIRECTORY_CHANGED_EVENT } from '../shared/project-file-api'
import { TERMINAL_DATA_EVENT, TERMINAL_EXIT_EVENT } from '../shared/terminal-api'
import { DesktopConfigStore } from './config/desktop-config-store'
import { AuthManager } from './providers/auth-manager'
import { ModelsConfigManager } from './providers/models-config-manager'
import { PiSettingsManager } from './providers/pi-settings-manager'
import { PreferencesManager } from './preferences/preferences-manager'
import { GenuiParamStore } from './genui/genui-param-store'
import { ProjectDirectoryReader } from './projects/project-directory'
import { ProjectDirectoryWatcher } from './projects/project-directory-watcher'
import { ProjectFileContent } from './projects/project-file-content'
import { ProjectFileIndex } from './projects/project-file-index'
import { GitService } from './git/git-service'
import { ProjectManager } from './projects/project-manager'
import { McpInspectionManager } from './resources/mcp-inspection'
import { SdkHostManager } from './sessions/sdk-host-manager'
import { SdkRuntimeBridge } from './sessions/sdk-runtime-bridge'
import { SessionManager } from './sessions/session-manager'
import { SessionRunRegistry } from './sessions/session-run-registry'
import { TerminalManager } from './terminal/terminal-manager'
import { TrustManager } from './trust/trust-manager'
import { UpdateChecker } from './updates/update-checker'
import { PackageUpdater } from './updates/package-updater'
import { PiAgentUpdater } from './updates/pi-agent-updater'
import { getRuntimeRoot } from './updates/pi-runtime'
import { WindowState } from './window-state'
import {
  broadcastTerminalDaemonStatus,
  chooseDirectoryWithDialog,
  registerTerminalStatusSource,
  sendToRenderer,
} from './window-channel'

/** 会话运行注册表：应用级运行身份、绑定代际与会话占用的唯一登记处。 */
export const sessionRuns = new SessionRunRegistry<SdkHostManager>()

/** 页面会话主链后端：按注册表定位运行实例，宿主按需建立，失败分类在此映射回既有 Runtime 契约。 */
export const sdkRuntime = new SdkRuntimeBridge({
  runs: sessionRuns,
  // 授权回路接主进程会话编排：宿主不能自行授权项目或任意会话路径。
  createHost: (runId) => {
    const host = new SdkHostManager({ runId, runs: sessionRuns })
    host.setSessionAuthority((reference, ownerProjectPath) => sessionManager.prepareSdkTarget(reference, ownerProjectPath))
    return host
  }
})

/** 本地配置文件的唯一读写者；本文件的所有字段共用同一份配置与写入队列。 */
export const configStore = new DesktopConfigStore()

export const trustManager = new TrustManager({ store: configStore })

export const projectManager = new ProjectManager({
  chooseDirectory: chooseDirectoryWithDialog,
  runtime: sdkRuntime,
  store: configStore,
  trust: trustManager,
  runs: sessionRuns
})

export const sessionManager = new SessionManager({
  projects: projectManager,
  sdk: sdkRuntime,
  projectsTrust: trustManager,
  ownership: sessionRuns,
  // 生成式 UI 开关在会话创建期读取；读失败按开启处理，不因偏好故障阻断会话。
  readGenuiEnabled: async () => (await configStore.readGenui()).enabled
})

/** MCP 服务器探测与取消：与当前会话无关，只按项目跑一次性官方 CLI 进程。 */
export const mcpInspection = new McpInspectionManager()

/** Pi 版本检查：启动时后台跑一次，之后按页面请求重查；只读，不写 Pi 的任何配置。 */
export const updateChecker = new UpdateChecker({
  currentProjectPath: () => projectManager.currentProjectPath()
})

/** 扩展更新：只由页面显式发起，复用受管一次性入口执行，不自动执行也不重试。 */
export const packageUpdater = new PackageUpdater({
  currentProjectPath: () => projectManager.currentProjectPath()
})

/** 内置 Pi agent 安装：只由页面显式发起，写入应用自有的运行时目录，不自动执行也不重试。 */
export const piAgentUpdater = new PiAgentUpdater({ runtimeRoot: getRuntimeRoot })

/** 项目文件索引：根路径只取当前项目，页面无法指定检索目录。 */
export const projectFileIndex = new ProjectFileIndex({
  currentProjectPath: () => projectManager.currentProjectPath()
})

/** 项目目录读取：右侧面板文件树的单层列举，根路径同样只取当前项目。 */
export const projectDirectory = new ProjectDirectoryReader({
  currentProjectPath: () => projectManager.currentProjectPath()
})

/**
 * 项目目录监听：页面提交已加载的目录集合，主进程只监听这些层并推送变化，文件树不必手动刷新。
 * 变化同时丢弃文件索引快照，让 `@` 检索立刻能看到新文件。
 */
export const projectDirectoryWatcher = new ProjectDirectoryWatcher({
  currentProjectPath: () => projectManager.currentProjectPath(),
  sendChange: (change) => sendToRenderer(PROJECT_DIRECTORY_CHANGED_EVENT, change),
  onChanged: () => projectFileIndex.invalidate()
})

/** 文件内容按请求固定的已登记项目读写，切换前台项目不改变异步请求归属。 */
export const projectFileContent = new ProjectFileContent({
  resolveProjectPath: resolveRegisteredProjectPath
})

/** 源代码管理：状态、差异、历史与暂存/提交；仓库根与路径折算全在主进程，页面只给项目内相对路径。 */
export const gitService = new GitService({
  currentProjectPath: () => projectManager.currentProjectPath()
})

/** 认证执行端：管理认证辅助进程，凭据读写全在官方实现内完成。 */
export const authManager = new AuthManager({ store: configStore, isPackaged: app.isPackaged })

export const preferencesManager = new PreferencesManager({ store: configStore })

/** 生成式界面参数取值的本机旁路存储；与 Desktop 配置分开，高频变化且可再生产。 */
export const genuiParamStore = new GenuiParamStore()

/** 自定义供应商配置（Pi 的 models.json）的唯一读写者；与 Desktop 自己的配置互不影响。 */
export const modelsConfigManager = new ModelsConfigManager()

/** Pi 默认模型（Pi 的 settings.json）的唯一读写者；只改 defaultProvider 与 defaultModel。 */
export const piSettingsManager = new PiSettingsManager()

export const windowState = new WindowState({ store: configStore })

/** 内置终端适配：PTY、画面与流控由独立守护进程持有，主进程只转发受限协议。 */
export const terminals = new TerminalManager({
  resolveProjectPath: resolveRegisteredProjectPath,
  sendData: (event) => sendToRenderer(TERMINAL_DATA_EVENT, event),
  sendExit: (event) => sendToRenderer(TERMINAL_EXIT_EVENT, event),
  // 连接变化（守护进程拉起、断开、重连）时把状态推给页面；页面据此刷新快照与提示。
  onStatusChange: () => {
    void broadcastTerminalDaemonStatus()
  }
})

// 投递通道不持有终端实例：把状态取值来源注册给它，避免投递层反向依赖本装配文件。
registerTerminalStatusSource(() => terminals.status())

/**
 * 终端、文件内容与项目移除共用的项目解析：只认已登记项目，并回登记时的规范路径。
 * 终端的工作目录只取这条路径，页面给出的写法不直接进入 shell。
 */
export async function resolveRegisteredProjectPath(requested: string): Promise<string | null> {
  const list = await configStore.list()
  const match = list.projects.find((project) => projectMatchesPath(project.path, requested))
  return match?.path ?? null
}

/** 按项目 id 取规范路径；只用于项目移除时收敛它的终端，找不到返回 null。 */
export async function registeredProjectPathById(projectId: string): Promise<string | null> {
  const list = await configStore.list()
  return list.projects.find((project) => project.id === projectId)?.path ?? null
}

/** 项目路径比较口径与项目登记一致：Windows 路径大小写不敏感。 */
export function projectMatchesPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 路径比较辅助在实例之间共用；导出让 IPC 与终端侧复用同一口径。 */
