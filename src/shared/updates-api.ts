/**
 * Pi 版本检查的受限 IPC 契约：只定义固定通道、结果形状与跨进程响应校验，不含任何可执行入口。
 *
 * 边界：检查只读取 Pi 的已安装版本与远端最新版本，不写 Pi 的任何配置文件、不安装也不更新任何东西；
 * 远端查询（npm registry、pi.dev、git 远端）与文件读取都在主进程的一次性检查进程里完成，
 * 页面只能读取结果快照，既不能指定查询地址，也不能触发除「重新检查」以外的动作。
 *
 * 版本口径：
 * - `piAgent.version` 是 pi-desk 实际加载的那个 Pi agent SDK 版本（随应用打包，版本由 `package.json` 的依赖声明决定）。
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

/** Pi agent 的检查结论；只有三种，`unchecked` 表示这次没能取得远端版本。 */
export type PiAgentUpdateStatus = 'up-to-date' | 'update-available' | 'unchecked'

/** Pi agent 版本信息；`latestVersion` 取不到时为 null，并给出 `error` 说明原因。 */
export interface PiAgentUpdateInfo {
  /** 当前应用加载的 Pi agent 版本。 */
  readonly version: string
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

const PI_AGENT_UPDATE_STATUSES: readonly string[] = ['up-to-date', 'update-available', 'unchecked']

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
}
