/** 主进程业务实例的唯一装配处：配置、项目、信任、会话、只读解析宿主池、终端、供应商、资源、更新、生成式界面、记忆、Git 清理、用量统计与手机访问各一份，按依赖顺序建立并互相注入回调。本文件只做实例化，不注册 IPC、不写业务判断；其中系统目录选择与终端守护状态广播经 window-channel.ts 提供，是本文件对窗口投递层的唯一依赖。 */

import { app, dialog } from 'electron'
import { join } from 'node:path'
import { WorkspaceStore } from './workspaces/workspace-store'
import { WorkspaceManager } from './workspaces/workspace-manager'
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
import { ProjectHtmlPreview } from './projects/project-html-preview'
import { ProjectFileIndex } from './projects/project-file-index'
import { GitService } from './git/git-service'
import { WorktreeService } from './git/worktree-service'
import { TurnSnapshotService } from './git/turn-snapshot-service'
import { GitCleanupService } from './git/git-cleanup-service'
import { UsageStatsService } from './usage/usage-stats-service'
import { ProjectManager } from './projects/project-manager'
import { McpInspectionManager } from './resources/mcp-inspection'
import { createReadOnlyHost, getSdkHostEntryPath, SdkHostManager } from './sessions/sdk-host-manager'
import { LogHostPool } from './sessions/log-host-pool'
import { SdkRuntimeBridge } from './sessions/sdk-runtime-bridge'
import { SessionManager } from './sessions/session-manager'
import { SessionRunRegistry } from './sessions/session-run-registry'
import { TerminalManager } from './terminal/terminal-manager'
import { TrustManager } from './trust/trust-manager'
import { UpdateChecker } from './updates/update-checker'
import { PackageUpdater } from './updates/package-updater'
import { PiAgentUpdater } from './updates/pi-agent-updater'
import { getRuntimeRoot } from './updates/pi-runtime'
import { MemoryManager } from './memory/memory-manager'
import { WindowState } from './window-state'
import { LanRemoteManager } from './lan-remote/manager'
import { BrowserSessionService } from './browser/browser-session-service'
import {
  broadcastTerminalDaemonStatus,
  chooseDirectoryWithDialog,
  mainWindow,
  registerTerminalStatusSource,
  sendToRenderer,
} from './window-channel'

/** 会话运行注册表：应用级运行身份、绑定代际与会话占用的唯一登记处。 */
export const sessionRuns = new SessionRunRegistry<SdkHostManager>()

/** 只读解析宿主池：查看会话历史不再需要登记运行实例，查看与打开共用同一套进程。 */
export const logHosts = new LogHostPool({
  create: (hostId) => createReadOnlyHost({ hostId })
})

/** 页面会话主链后端：按注册表定位运行实例，宿主按需建立，失败分类在此映射回既有 Runtime 契约。 */
export const sdkRuntime: SdkRuntimeBridge = new SdkRuntimeBridge({
  runs: sessionRuns,
  logHosts,
  // 授权回路接主进程会话编排：宿主不能自行授权项目或任意会话路径。
  prepareHost: (host) => {
    host.setSessionAuthority((reference, ownerProjectPath, workspaceId) => sessionManager.prepareSdkTarget(reference, ownerProjectPath, workspaceId))
  },
  createHost: (runId) => new SdkHostManager({ runId, runs: sessionRuns, browserSessionService, memory: memoryManager.provider }),
  get workspaces(): WorkspaceManager { return workspaceManager }
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

/** 工作区身份独立持久化；应用装配只创建所有者，不提前读写用户任务数据。 */
export const workspaceStore = new WorkspaceStore(() => join(app.getPath('userData'), 'task-workspaces.json'))
export const worktreeService = new WorktreeService()
export const workspaceManager: WorkspaceManager = new WorkspaceManager({
  store: workspaceStore, worktrees: worktreeService, projects: projectManager, trust: trustManager,
  closeWorkspaceRuns: ids => sdkRuntime.closeWorkspaceRuns(ids),
  countTerminals: id => terminals.countWorkspaceTerminals(id),
  settleTerminals: (id, consent) => terminals.settleWorkspace(id, consent),
  releaseViews: id => { projectDirectoryWatcher.releaseWorkspace(id); projectHtmlPreview.releaseWorkspace(id); projectFileIndex.invalidate(id) }
})

export const sessionManager = new SessionManager({
  projects: projectManager,
  sdk: sdkRuntime,
  projectsTrust: trustManager,
  ownership: sessionRuns,
  workspaces: workspaceManager,
  // 生成式 UI 开关在会话创建期读取；读失败按开启处理，不因偏好故障阻断会话。
  readGenuiEnabled: async () => (await configStore.readGenui()).enabled,
  // 删除会话后是否级联清理工作树，由界面偏好决定；读失败按不清理处理，不自作主张删目录。
  readCleanupOnSessionDelete: async () => {
    try {
      return (await configStore.readUiPreferences()).gitAutoCleanWorktreeOnSessionDelete
    } catch {
      return false
    }
  },
  cleanupSessionWorkspace: (projectPath, sessionId) => workspaceManager.cleanupForDeletedSession(projectPath, sessionId)
})

/** 手机访问管理器只装配依赖；局域网入口须显式开启，地址与端口自动确定，无需外部代理。 */
export const lanRemote = new LanRemoteManager(configStore, sessionManager, sdkRuntime, trustManager)

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

/**
 * 首次创建记忆库的确认：在唯一业务窗口展示目标位置与影响。
 * 取消、窗口不可用或对话框异常一律视为未确认，不执行创建。
 */
async function confirmMemoryInitialization(detail: string): Promise<boolean> {
  const target = mainWindow
  if (target === null || target.isDestroyed()) return false
  try {
    const result = await dialog.showMessageBox(target, {
      type: 'question', buttons: ['创建', '取消'], defaultId: 0, cancelId: 1, noLink: true,
      title: '创建记忆库', message: '创建用户级全局记忆库？', detail
    })
    return result.response === 0
  } catch {
    return false
  }
}

/**
 * 用户级全局记忆：开关、受管运行时、库状态与首次创建的唯一所有者。
 * 资源位置相对宿主产物固定；不读项目目录，也不在启动时自动创建用户库。
 */
export const memoryManager = new MemoryManager({
  store: configStore,
  hostEntry: getSdkHostEntryPath,
  confirmInitialize: confirmMemoryInitialization,
  notifyHosts: () => sdkRuntime.notifyMemoryConfiguration()
})

/** 文件索引按已授权工作区缓存，页面不能绕过身份指定执行目录。 */
export const projectFileIndex = new ProjectFileIndex()

/** 文件树按显式工作区逐层列举；不依赖前台项目的可变状态。 */
export const projectDirectory = new ProjectDirectoryReader()

/**
 * 项目目录监听：页面提交已加载的目录集合，主进程只监听这些层并推送变化，文件树不必手动刷新。
 * 变化同时丢弃文件索引快照，让 `@` 检索立刻能看到新文件。
 */
export const projectDirectoryWatcher = new ProjectDirectoryWatcher({
  sendChange: (change) => sendToRenderer(PROJECT_DIRECTORY_CHANGED_EVENT, change),
  onChanged: workspaceId => projectFileIndex.invalidate(workspaceId)
})

/** 文件内容按请求固定的已登记项目读写，切换前台项目不改变异步请求归属。 */
export const projectFileContent = new ProjectFileContent()

/** HTML 草稿与预览隔离身份只存内存，资源请求继续复核所属项目的登记状态。 */
export const projectHtmlPreview = new ProjectHtmlPreview(workspaceManager)

/** 源代码管理：状态、差异、历史与暂存/提交；仓库根与路径折算全在主进程，页面只给项目内相对路径。 */
export const gitService = new GitService({
  resolveWorkspace: target => workspaceManager.contextFor(target, 'read')
})

/** 工作树的提交式快照与恢复服务；服务本身不代表桌面轮次捕获及代码回退链已贯通。 */
export const turnSnapshotService = new TurnSnapshotService()

/** Git 清理与维护：盘点托管工作树与临时分支，修剪失效登记、移除残留与仓库垃圾回收。 */
export const gitCleanupService = new GitCleanupService({
  worktrees: worktreeService,
  readWorkspaces: async () => (await workspaceStore.read()).workspaces,
  // 已登记工作树经工作区管理器清理，由它同步相位并释放终端与视图。
  // 该入口会抛异常而不是返回失败结果，因此直接 await 即可。
  removeRegisteredWorkspace: async (request) => {
    await workspaceManager.removeWorktree(request)
  }
})

/** 会话用量统计服务：盘点各已登记项目的会话目录与 Token 消耗。 */
export const usageStatsService = new UsageStatsService({
  readProjects: async () => (await configStore.list()).projects
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

/** 受管浏览器会话与控制权服务：管理 webview 实例登记、项目分区隔离及独占控制权。 */
export const browserSessionService = new BrowserSessionService()

/** 内置终端适配：PTY、画面与流控由独立守护进程持有，主进程只转发受限协议。 */
export const terminals = new TerminalManager({
  resolveProjectPath: resolveRegisteredProjectPath,
  workspaces: workspaceManager,
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
 * 项目登记解析：只认已登记项目，并回登记时的规范路径；终端执行根另由工作区授权。
 * 项目分组、清单与移除继续使用逻辑项目路径，不以任务目录冒充项目。
 */
export async function resolveRegisteredProjectPath(requested: string): Promise<string | null> {
  const list = await configStore.list()
  const match = list.projects.find((project) => projectMatchesPath(project.path, requested))
  return match?.path ?? null
}

/** 按项目 id 取规范路径，供项目移除后清理所属终端与 HTML 预览；找不到返回 null。 */
export async function registeredProjectPathById(projectId: string): Promise<string | null> {
  const list = await configStore.list()
  return list.projects.find((project) => project.id === projectId)?.path ?? null
}

/** 项目路径比较口径与项目登记一致：Windows 路径大小写不敏感。 */
export function projectMatchesPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** 路径比较辅助在实例之间共用；导出让 IPC 与终端侧复用同一口径。 */
