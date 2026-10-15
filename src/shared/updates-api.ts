/**
 * Pi 版本检查、扩展更新与内置 Pi agent 安装的受限 IPC 契约：只定义固定通道、结果形状与跨进程响应校验，
 * 不含任何可执行入口。
 *
 * 边界：检查只读取 Pi 的已安装版本与远端最新版本，不写 Pi 的任何配置文件；更新与安装都是页面显式发起的动作，
 * 只更新 Pi 已声明的包、只写应用自有的运行时目录，不改动包声明本身，也不安装其它任何东西。
 * 远端查询（npm registry、pi.dev、git 远端）、文件读取、更新执行与运行时安装都在主进程的一次性进程里完成；
 * 页面只能读取结果快照与进度，以及发起更新、安装或重新检查，不能指定查询地址、执行入口、安装路径或运行时目录。
 *
 * 版本口径：
 * - `piAgent.version` 是 pi-desk 实际加载的那个 Pi agent SDK 版本（由应用自带的版本或运行时目录提供，
 *   取决于运行时指针）；`piAgent.runtimeVersion` 是指针指向的版本。两者只作信息展示，
 *   不作为用户待办、不参与启动弹窗。
 * - 扩展条目只统计 Pi 的包声明（settings.json 的 `packages`）；npm 源用版本号，git 源用提交短哈希，
 *   local 源没有可比版本，只如实标注来源。
 */
import type { DesktopErrorCode } from './desktop-api'

/** 零参数：读取最近一次检查的快照；从未检查过时 `checkedAt` 为 null。 */
export const UPDATES_GET_CHANNEL = 'desktop:updates-get'
/** 零参数：强制重新检查一次；进行中时复用同一次检查，不排队也不叠加。 */
export const UPDATES_CHECK_CHANNEL = 'desktop:updates-check'
/** 检查状态快照事件：开始检查与检查结束各发一次，只发给唯一可信窗口。 */
export const UPDATES_STATE_EVENT = 'desktop:updates-state'
/**
 * 可选单参数：要更新的包声明原文；省略时更新全部已声明的包。
 * 取值必须是主进程已经报告过的来源，页面不能凭空构造。
 */
export const UPDATES_UPDATE_CHANNEL = 'desktop:updates-update'
/** 更新进度事件：更新过程中逐条推送，只发给唯一可信窗口。 */
export const UPDATES_UPDATE_PROGRESS_EVENT = 'desktop:updates-update-progress'
/**
 * 可选单参数：要安装的内置 Pi agent 版本；省略时取官方最新。
 * 取值必须是主进程已经报告过的官方最新版本，页面不能凭空构造。
 */
export const UPDATES_INSTALL_AGENT_CHANNEL = 'desktop:updates-install-agent'
/** 内置 Pi agent 安装进度事件：安装过程中逐条推送，只发给唯一可信窗口。 */
export const UPDATES_INSTALL_AGENT_PROGRESS_EVENT = 'desktop:updates-install-agent-progress'
/**
 * 更新入口输出的行标记：只有带此前缀的行才参与协议解析。
 * 更新过程里依赖命令自己的输出会与协议共用同一个标准输出，因此必须靠标记区分。
 */
export const PACKAGE_UPDATE_LINE_PREFIX = 'PI_PACKAGE_UPDATE '
/**
 * 内置 Pi agent 安装入口输出的行标记。与扩展更新分开：两者的进度阶段与失败原因不同，
 * 共用一个标记会让解析方先要分辨载荷属于哪一类。
 */
export const AGENT_INSTALL_LINE_PREFIX = 'PI_AGENT_INSTALL '

/** 复用桌面错误码；检查失败时保留主进程给出的原因文本。 */
export type UpdatesErrorCode = DesktopErrorCode

/** 扩展条目的检查结论；`unchecked` 表示这次没能得出结论（离线、缺少 git、网络失败等）。 */
export type ExtensionUpdateStatus =
  | 'up-to-date'
  | 'update-available'
  | 'not-installed'
  | 'pinned'
  | 'local'
  | 'unchecked'

/** Pi agent 的检查结论；`unchecked` 表示这次没能取得远端版本，`unsupported` 表示远端版本超出本应用支持的版本范围。 */
export type PiAgentUpdateStatus = 'up-to-date' | 'update-available' | 'unsupported' | 'unchecked'

/**
 * Pi agent 版本信息；`latestVersion` 取不到时为 null，并给出 `error` 说明原因。
 * `runtimeVersion` 是运行时指针指向的版本（没有安装运行时目录时为 null）：它与 `version` 不一致
 * 就说明运行时目录里的版本没能用上，本次跑的是随应用发布的版本。
 */
export interface PiAgentUpdateInfo {
  /** 本次实际加载的 Pi agent 版本：有可用运行时目录时取它，否则取随应用发布的版本。 */
  readonly version: string
  /** 运行时指针指向的版本；没有可用运行时目录时为 null。 */
  readonly runtimeVersion: string | null
  /** 官方发布的最新版本；取不到时为 null。 */
  readonly latestVersion: string | null
  /** 官方在最新版本上附带的说明；没有则为 null。 */
  readonly note: string | null
  readonly status: PiAgentUpdateStatus
  readonly error: string | null
}

/** 一个 Pi 包条目的版本信息；缺失的取值一律为 null，不用默认值冒充。 */
export interface ExtensionUpdateInfo {
  /** 包声明原文（例如 `npm:pi-mcp-adapter`、`git:github.com/owner/repo`）。 */
  readonly source: string
  readonly scope: 'user' | 'project'
  readonly type: 'npm' | 'git' | 'local'
  /** 面向展示的名称：npm 用包名，git 用 `host/owner/repo`，local 用声明里的路径。 */
  readonly displayName: string
  /** 已安装版本：npm 为版本号，git 为已安装提交短哈希，未安装或读不到时为 null。 */
  readonly installedVersion: string | null
  /** 远端最新：npm 为 registry 最新版本号，git 为远端 HEAD 短哈希，取不到时为 null。 */
  readonly latestVersion: string | null
  readonly status: ExtensionUpdateStatus
  readonly error: string | null
}

/** 一次检查的完整结论；由检查进程输出、主进程校验后使用。 */
export interface UpdateCheckReport {
  /** 处于 `PI_OFFLINE` 语义的离线状态时，只报告已安装版本，不做任何远端查询。 */
  readonly offline: boolean
  /** 检查完成的时刻；由主进程在收到结果时落定。 */
  readonly checkedAt: number | null
  /** Pi agent 版本信息；连 SDK 版本都读不到时为 null。 */
  readonly piAgent: PiAgentUpdateInfo | null
  readonly extensions: readonly ExtensionUpdateInfo[]
  /** 整体失败原因；单个条目失败只写进该条目的 `error`，不影响这里。 */
  readonly error: string | null
}

/** 页面看到的快照：在检查结论上叠加「是否正在检查」。 */
export interface UpdatesSnapshot extends UpdateCheckReport {
  readonly checking: boolean
}

export interface UpdatesError {
  readonly code: UpdatesErrorCode
  readonly message: string
}

export type UpdatesResult =
  | { readonly ok: true; readonly data: UpdatesSnapshot }
  | { readonly ok: false; readonly error: UpdatesError }

/** 进度阶段与动作沿用 Pi 的进度回调语义；`phase` 为 `progress` 时表示仍在进行。 */
export type PackageUpdatePhase = 'start' | 'progress' | 'complete' | 'error'
export type PackageUpdateAction = 'install' | 'remove' | 'update' | 'clone' | 'pull'

/**
 * 失败的归类：只有「工具缺失」与「网络失败」需要用户做不同的事，因此必须分开；
 * 无法归类时用 `unknown`，不把未知原因伪装成某一类。
 */
export type PackageUpdateFailureReason = 'tool-missing' | 'network' | 'untrusted' | 'unknown'

/** 单个来源的更新失败；`source` 可能是单个包声明，也可能是同一批次的整体标签。 */
export interface PackageUpdateFailure {
  readonly source: string
  readonly reason: PackageUpdateFailureReason
  readonly message: string
}

/** 更新过程的一条进度；文本只用于展示，不作为判定依据。 */
export interface PackageUpdateProgress {
  readonly phase: PackageUpdatePhase
  readonly action: PackageUpdateAction
  readonly source: string
  readonly message: string | null
}

/** 一次更新的结论；`updated` 是报出完成事件的来源，`failed` 是报出失败事件的来源。 */
export interface PackageUpdateOutcome {
  /** 离线时不执行更新，`updated` 与 `failed` 都为空。 */
  readonly offline: boolean
  readonly updated: readonly string[]
  readonly failed: readonly PackageUpdateFailure[]
  /** 整体失败原因（更新过程中断等）；逐项失败只写在 `failed` 里。 */
  readonly error: string | null
}

export type PackageUpdateResult =
  | { readonly ok: true; readonly data: PackageUpdateOutcome }
  | { readonly ok: false; readonly error: UpdatesError }

/** 安装过程的阶段：下载依赖清单、安装依赖、冒烟校验、切换指针、结束。 */
export type AgentInstallPhase = 'download' | 'install' | 'verify' | 'activate' | 'done'

/**
 * 内置 Pi agent 安装的失败归类；与扩展更新分开，因为除工具缺失外还多一类「装上了但自检不过」。
 * `verify-failed` 表示依赖装上了但加载校验没过：此时不切换指针，旧的运行时仍然可用。
 */
export type AgentInstallFailureReason =
  | 'tool-missing'
  | 'network'
  | 'verify-failed'
  | 'unsupported-version'
  | 'unknown'

/** 安装过程的一条进度；版本在确定之前为 null，文本只用于展示。 */
export interface AgentInstallProgress {
  readonly phase: AgentInstallPhase
  readonly version: string | null
  readonly message: string | null
}

/** 一次安装的结论；未完成切换时 `installedVersion` 为 null 且 `reason` 给出原因。 */
export interface AgentInstallOutcome {
  /** 离线时不下载也不安装，其余字段均为空。 */
  readonly offline: boolean
  readonly installedVersion: string | null
  /** 切换前指针指向的版本；此前没有可用运行时则为 null。 */
  readonly previousVersion: string | null
  readonly reason: AgentInstallFailureReason | null
  readonly error: string | null
}

export type AgentInstallResult =
  | { readonly ok: true; readonly data: AgentInstallOutcome }
  | { readonly ok: false; readonly error: UpdatesError }

/** 页面在取得第一份快照前的初始值；不把「还没检查」显示成「已是最新」。 */
export const EMPTY_UPDATES_SNAPSHOT: UpdatesSnapshot = {
  checking: false,
  offline: false,
  checkedAt: null,
  piAgent: null,
  extensions: [],
  error: null
}

const UPDATES_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED',
  'TRUST_REQUIRED'
]

const EXTENSION_UPDATE_STATUSES: readonly string[] = [
  'up-to-date', 'update-available', 'not-installed', 'pinned', 'local', 'unchecked'
]

const PI_AGENT_UPDATE_STATUSES: readonly string[] = ['up-to-date', 'update-available', 'unsupported', 'unchecked']

const PACKAGE_UPDATE_PHASES: readonly string[] = ['start', 'progress', 'complete', 'error']
const PACKAGE_UPDATE_ACTIONS: readonly string[] = ['install', 'remove', 'update', 'clone', 'pull']
const PACKAGE_UPDATE_FAILURE_REASONS: readonly string[] = ['tool-missing', 'network', 'untrusted', 'unknown']
const AGENT_INSTALL_PHASES: readonly string[] = ['download', 'install', 'verify', 'activate', 'done']
const AGENT_INSTALL_FAILURE_REASONS: readonly string[] = [
  'tool-missing', 'network', 'verify-failed', 'unsupported-version', 'unknown'
]

/** 共享模块同时被主进程与沙箱页面加载，因此只做纯形状判定，不引入 Node 能力。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isPiAgentUpdateInfo(value: unknown): value is PiAgentUpdateInfo {
  if (!isRecord(value)) return false
  return typeof value.version === 'string'
    && isNullableText(value.runtimeVersion)
    && isNullableText(value.latestVersion)
    && isNullableText(value.note)
    && typeof value.status === 'string' && PI_AGENT_UPDATE_STATUSES.includes(value.status)
    && isNullableText(value.error)
}

function isExtensionUpdateInfo(value: unknown): value is ExtensionUpdateInfo {
  if (!isRecord(value)) return false
  return typeof value.source === 'string'
    && (value.scope === 'user' || value.scope === 'project')
    && (value.type === 'npm' || value.type === 'git' || value.type === 'local')
    && typeof value.displayName === 'string'
    && isNullableText(value.installedVersion)
    && isNullableText(value.latestVersion)
    && typeof value.status === 'string' && EXTENSION_UPDATE_STATUSES.includes(value.status)
    && isNullableText(value.error)
}

/**
 * 检查进程输出与主进程快照共用同一份判定：字段缺失、状态取值越界或多出未知字段一律拒绝，
 * 由调用方按协议错误处理，而不是把不可信的取值带进页面。
 */
export function isUpdateCheckReport(value: unknown): value is UpdateCheckReport {
  if (!isRecord(value)) return false
  if (typeof value.offline !== 'boolean') return false
  if (value.checkedAt !== null && typeof value.checkedAt !== 'number') return false
  if (value.piAgent !== null && !isPiAgentUpdateInfo(value.piAgent)) return false
  if (!Array.isArray(value.extensions) || !value.extensions.every(isExtensionUpdateInfo)) return false
  return isNullableText(value.error)
}

export function isUpdatesSnapshot(value: unknown): value is UpdatesSnapshot {
  return isRecord(value) && typeof value.checking === 'boolean' && isUpdateCheckReport(value)
}

/** 更新进度载荷的运行时判定；主进程与沙箱页面共用同一份，避免两边判定漂移。 */
export function isPackageUpdateProgress(value: unknown): value is PackageUpdateProgress {
  if (!isRecord(value)) return false
  return typeof value.phase === 'string' && PACKAGE_UPDATE_PHASES.includes(value.phase)
    && typeof value.action === 'string' && PACKAGE_UPDATE_ACTIONS.includes(value.action)
    && typeof value.source === 'string'
    && isNullableText(value.message)
}

function isPackageUpdateFailure(value: unknown): value is PackageUpdateFailure {
  if (!isRecord(value)) return false
  return typeof value.source === 'string'
    && typeof value.reason === 'string' && PACKAGE_UPDATE_FAILURE_REASONS.includes(value.reason)
    && typeof value.message === 'string'
}

/** 更新入口的输出与主进程结论共用同一份判定；越界取值或未知字段一律拒绝。 */
export function isPackageUpdateOutcome(value: unknown): value is PackageUpdateOutcome {
  if (!isRecord(value)) return false
  if (typeof value.offline !== 'boolean') return false
  if (!Array.isArray(value.updated) || !value.updated.every((entry) => typeof entry === 'string')) return false
  if (!Array.isArray(value.failed) || !value.failed.every(isPackageUpdateFailure)) return false
  return isNullableText(value.error)
}

/**
 * 解析更新入口的一行输出：带协议标记时返回解析结果，其它行（依赖命令自己的输出）返回 null。
 * 标记存在但内容不合约定时同样返回 null，由调用方按「没有结论」处理，而不是把不可信取值带进页面。
 */
export function parsePackageUpdateLine(line: string):
  | { readonly kind: 'progress'; readonly progress: PackageUpdateProgress }
  | { readonly kind: 'result'; readonly outcome: PackageUpdateOutcome }
  | null {
  if (!line.startsWith(PACKAGE_UPDATE_LINE_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(PACKAGE_UPDATE_LINE_PREFIX.length))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind === 'progress' && isPackageUpdateProgress(parsed)) {
    return { kind: 'progress', progress: parsed }
  }
  if (parsed.kind === 'result' && isPackageUpdateOutcome(parsed)) {
    return { kind: 'result', outcome: parsed }
  }
  return null
}

/** TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。 */
export function isPackageUpdateResult(value: unknown): value is PackageUpdateResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isPackageUpdateOutcome(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && UPDATES_ERROR_CODES.includes(code)
}

/** 安装进度载荷的运行时判定；主进程与沙箱页面共用同一份。 */
export function isAgentInstallProgress(value: unknown): value is AgentInstallProgress {
  if (!isRecord(value)) return false
  return typeof value.phase === 'string' && AGENT_INSTALL_PHASES.includes(value.phase)
    && isNullableText(value.version)
    && isNullableText(value.message)
}

/** 安装结论的运行时判定；安装入口的输出与主进程结论共用同一份。 */
export function isAgentInstallOutcome(value: unknown): value is AgentInstallOutcome {
  if (!isRecord(value)) return false
  if (typeof value.offline !== 'boolean') return false
  if (!isNullableText(value.installedVersion)) return false
  if (!isNullableText(value.previousVersion)) return false
  if (value.reason !== null
    && (typeof value.reason !== 'string' || !AGENT_INSTALL_FAILURE_REASONS.includes(value.reason))) return false
  return isNullableText(value.error)
}

/**
 * 解析安装入口的一行输出：带协议标记时返回解析结果，其它行（依赖命令自己的输出）返回 null。
 * 标记存在但内容不合约定时同样返回 null，由调用方按「没有结论」处理。
 */
export function parseAgentInstallLine(line: string):
  | { readonly kind: 'progress'; readonly progress: AgentInstallProgress }
  | { readonly kind: 'result'; readonly outcome: AgentInstallOutcome }
  | null {
  if (!line.startsWith(AGENT_INSTALL_LINE_PREFIX)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(AGENT_INSTALL_LINE_PREFIX.length))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.kind === 'progress' && isAgentInstallProgress(parsed)) {
    return { kind: 'progress', progress: parsed }
  }
  if (parsed.kind === 'result' && isAgentInstallOutcome(parsed)) {
    return { kind: 'result', outcome: parsed }
  }
  return null
}

/** TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。 */
export function isAgentInstallResult(value: unknown): value is AgentInstallResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isAgentInstallOutcome(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && UPDATES_ERROR_CODES.includes(code)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isUpdatesResult(value: unknown): value is UpdatesResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isUpdatesSnapshot(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof message === 'string'
    && typeof code === 'string'
    && UPDATES_ERROR_CODES.includes(code)
}

export interface UpdatesApi {
  /** 读取最近一次检查的快照；不触发新的检查。 */
  readonly getUpdates: () => Promise<UpdatesResult>
  /** 重新检查一次；进行中时复用同一次检查的结果。 */
  readonly checkUpdates: () => Promise<UpdatesResult>
  /** 订阅检查状态；返回释放函数。 */
  readonly onUpdatesChanged: (listener: (snapshot: UpdatesSnapshot) => void) => () => void
  /** 执行一次扩展更新；省略来源时更新全部已声明的包。进行中时复用同一次更新。 */
  readonly updatePackages: (source?: string) => Promise<PackageUpdateResult>
  /** 订阅更新进度；返回释放函数。 */
  readonly onPackageUpdateProgress: (listener: (progress: PackageUpdateProgress) => void) => () => void
  /** 安装或切换内置 Pi agent 的运行时版本；省略版本时取官方最新。进行中时复用同一次安装。 */
  readonly installAgentRuntime: (version?: string) => Promise<AgentInstallResult>
  /** 订阅内置 Pi agent 安装进度；返回释放函数。 */
  readonly onAgentInstallProgress: (listener: (progress: AgentInstallProgress) => void) => () => void
}
