/**
 * 内置浏览器会话与控制权契约：受管实例登记、项目级存储分区派生、会话独占绑定与接管状态机类型。
 *
 * 浏览器实例生命周期由工作区标签驱动，控制权由主进程统一协调；
 * 跨进程通信仅传递纯数据与状态快照，不透传原生 Electron 对象或未经校验的选择器。
 */

export const PROJECT_BROWSER_PARTITION_PREFIX = 'persist:browser-project:'

/** 登记受管浏览器实例通道。 */
export const BROWSER_REGISTER_INSTANCE_CHANNEL = 'browser:register-instance'
/** 注销受管浏览器实例通道。 */
export const BROWSER_UNREGISTER_INSTANCE_CHANNEL = 'browser:unregister-instance'
/** 会话申请独占绑定通道。 */
export const BROWSER_BIND_SESSION_CHANNEL = 'browser:bind-session'
/** 会话主动释放绑定通道。 */
export const BROWSER_RELEASE_SESSION_CHANNEL = 'browser:release-session'
/** 用户手动接管通道。 */
export const BROWSER_TAKEOVER_CHANNEL = 'browser:takeover'
/** 恢复自动化控制通道。 */
export const BROWSER_RESUME_CHANNEL = 'browser:resume'
/** 查询浏览器实例控制权状态通道。 */
export const BROWSER_QUERY_STATE_CHANNEL = 'browser:query-state'
/** 获取页面有界快照通道。 */
export const BROWSER_TAKE_SNAPSHOT_CHANNEL = 'browser:take-snapshot'
/** 获取页面纯文本正文通道。 */
export const BROWSER_GET_CONTENT_CHANNEL = 'browser:get-content'
/** 派发有限输入动作通道。 */
export const BROWSER_DISPATCH_ACTION_CHANNEL = 'browser:dispatch-action'

/** 受管浏览器实例的运行状态。 */
export type BrowserInstanceStatus = 'ready' | 'navigating' | 'destroyed'

/** 前端 webview 挂载或导航后向主进程上报的登记数据。 */
export interface BrowserInstanceRegistration {
  readonly instanceId: string
  readonly projectPath: string
  readonly webContentsId: number
  readonly url: string
  readonly title: string
}

/** 主进程中维护的受管浏览器实例元数据快照。 */
export interface BrowserInstanceRecord {
  readonly instanceId: string
  readonly projectPath: string
  readonly partition: string
  readonly webContentsId: number
  readonly url: string
  readonly title: string
  readonly status: BrowserInstanceStatus
  readonly registeredAt: number
  readonly updatedAt: number
}

/** 控制权状态机阶段：未绑定、已绑定待命、Agent 交互执行中、暂停挂起、人工接管。 */
export type BrowserControlPhase = 'unbound' | 'attached' | 'running' | 'paused' | 'takeover'

/** 浏览器实例的独占控制权与租约状态。 */
export interface BrowserControlState {
  readonly instanceId: string
  readonly sessionId: string | null
  readonly runId: number | null
  readonly generation: number | null
  readonly phase: BrowserControlPhase
  readonly allowedOrigin: string | null
  readonly pausedReason: string | null
  readonly attachedAt: number | null
  readonly updatedAt: number
}

/** 会话绑定请求载荷。 */
export interface BrowserBindRequest {
  readonly instanceId: string
  readonly sessionId: string
  readonly runId: number
  readonly generation: number
  readonly initialAllowedOrigin?: string | null
}

/** 通用操作结果。 */
export type BrowserOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** 实例登记结果。 */
export type BrowserRegisterResult =
  | { readonly ok: true; readonly record: BrowserInstanceRecord }
  | { readonly ok: false; readonly error: string }

/** 会话绑定结果。 */
export type BrowserBindResult =
  | { readonly ok: true; readonly state: BrowserControlState }
  | { readonly ok: false; readonly error: string }

/** 紧凑无障碍节点结构。 */
export interface BrowserA11yNode {
  readonly refId: number
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly description?: string
  readonly disabled?: boolean
  readonly focused?: boolean
  readonly checked?: boolean | 'mixed'
  readonly children?: readonly BrowserA11yNode[]
}

/** 页面结构化快照快照契约。 */
export interface BrowserSnapshot {
  readonly snapshotId: string
  readonly instanceId: string
  readonly url: string
  readonly title: string
  readonly nodes: readonly BrowserA11yNode[]
  readonly hasMore: boolean
  readonly capturedAt: number
}

/** 快照提取结果。 */
export type BrowserSnapshotResult =
  | { readonly ok: true; readonly snapshot: BrowserSnapshot }
  | { readonly ok: false; readonly error: string }

/** 纯文本正文提取结果。 */
export type BrowserContentResult =
  | { readonly ok: true; readonly text: string; readonly title: string; readonly url: string }
  | { readonly ok: false; readonly error: string }

/** 动作请求判别联合：点击、填充、按键与滚动。 */
export type BrowserActionRequest =
  | { readonly type: 'click'; readonly instanceId: string; readonly refId: number }
  | { readonly type: 'fill'; readonly instanceId: string; readonly refId: number; readonly text: string }
  | { readonly type: 'press'; readonly instanceId: string; readonly key: string }
  | { readonly type: 'scroll'; readonly instanceId: string; readonly deltaX?: number; readonly deltaY?: number }

/** 动作执行结果。 */
export type BrowserActionResult =
  | { readonly ok: true; readonly dispatched: boolean; readonly url: string; readonly title: string }
  | { readonly ok: false; readonly error: string; readonly refNotFound?: boolean; readonly detached?: boolean }

/** 浏览器会话与控制权跨进程 API。 */
export interface BrowserSessionApi {
  readonly registerBrowserInstance: (registration: BrowserInstanceRegistration) => Promise<BrowserRegisterResult>
  readonly unregisterBrowserInstance: (instanceId: string) => Promise<BrowserOperationResult>
  readonly bindBrowserSession: (request: BrowserBindRequest) => Promise<BrowserBindResult>
  readonly releaseBrowserSession: (instanceId: string, sessionId: string) => Promise<BrowserOperationResult>
  readonly takeoverBrowser: (instanceId: string, reason?: string) => Promise<BrowserOperationResult>
  readonly resumeBrowser: (instanceId: string) => Promise<BrowserOperationResult>
  readonly queryBrowserState: (instanceId: string) => Promise<BrowserControlState | null>
  readonly takeBrowserSnapshot: (instanceId: string) => Promise<BrowserSnapshotResult>
  readonly getBrowserContent: (instanceId: string) => Promise<BrowserContentResult>
  readonly dispatchBrowserAction: (request: BrowserActionRequest) => Promise<BrowserActionResult>
}

/** 标准化项目路径，统一斜杠并去掉末尾多余斜杠。 */
export function normalizeProjectPathForPartition(projectPath: string): string {
  if (!projectPath) return ''
  return projectPath.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 跨平台确定性哈希，生成无符号 14 字符 hex，不依赖 Node.js crypto 模块。 */
export function hashProjectPath(projectPath: string): string {
  const normalized = normalizeProjectPathForPartition(projectPath)
  if (!normalized) return 'general'
  let h1 = 0xdeadbeef
  let h2 = 0x41c64e6d
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** 获取项目专属的浏览器持久分区名称。 */
export function getProjectBrowserPartition(projectPath: string): string {
  const hash = hashProjectPath(projectPath)
  return `${PROJECT_BROWSER_PARTITION_PREFIX}${hash}`
}

/** 从完整 URL 中提取 Origin（协议 + 主机 + 端口）；非 HTTP(S) 地址返回 null。 */
export function extractOrigin(rawUrl: string): string | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin
    }
    return null
  } catch {
    return null
  }
}

export function isBrowserInstanceRegistration(value: unknown): value is BrowserInstanceRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.instanceId === 'string' && item.instanceId.length > 0 && item.instanceId.length <= 128
    && typeof item.projectPath === 'string'
    && typeof item.webContentsId === 'number' && Number.isSafeInteger(item.webContentsId) && item.webContentsId > 0
    && typeof item.url === 'string' && item.url.length <= 4096
    && typeof item.title === 'string' && item.title.length <= 1024
}

export function isBrowserBindRequest(value: unknown): value is BrowserBindRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.instanceId === 'string' && item.instanceId.length > 0 && item.instanceId.length <= 128
    && typeof item.sessionId === 'string' && item.sessionId.length > 0 && item.sessionId.length <= 128
    && typeof item.runId === 'number' && Number.isSafeInteger(item.runId) && item.runId > 0
    && typeof item.generation === 'number' && Number.isSafeInteger(item.generation) && item.generation > 0
    && (item.initialAllowedOrigin === undefined || item.initialAllowedOrigin === null || typeof item.initialAllowedOrigin === 'string')
}

export function isBrowserControlState(value: unknown): value is BrowserControlState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const validPhases: BrowserControlPhase[] = ['unbound', 'attached', 'running', 'paused', 'takeover']
  return typeof item.instanceId === 'string'
    && (item.sessionId === null || typeof item.sessionId === 'string')
    && (item.runId === null || typeof item.runId === 'number')
    && (item.generation === null || typeof item.generation === 'number')
    && typeof item.phase === 'string' && validPhases.includes(item.phase as BrowserControlPhase)
    && (item.allowedOrigin === null || typeof item.allowedOrigin === 'string')
    && (item.pausedReason === null || typeof item.pausedReason === 'string')
    && (item.attachedAt === null || typeof item.attachedAt === 'number')
    && typeof item.updatedAt === 'number'
}

export function isBrowserRegisterResult(value: unknown): value is BrowserRegisterResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return typeof item.record === 'object' && item.record !== null
  return item.ok === false && typeof item.error === 'string'
}

export function isBrowserBindResult(value: unknown): value is BrowserBindResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return isBrowserControlState(item.state)
  return item.ok === false && typeof item.error === 'string'
}

export function isBrowserOperationResult(value: unknown): value is BrowserOperationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.ok === true || (item.ok === false && typeof item.error === 'string')
}

export function isBrowserSnapshot(value: unknown): value is BrowserSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.snapshotId === 'string' && typeof item.instanceId === 'string'
    && typeof item.url === 'string' && typeof item.title === 'string'
    && Array.isArray(item.nodes) && typeof item.hasMore === 'boolean' && typeof item.capturedAt === 'number'
}

export function isBrowserSnapshotResult(value: unknown): value is BrowserSnapshotResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return isBrowserSnapshot(item.snapshot)
  return item.ok === false && typeof item.error === 'string'
}

export function isBrowserContentResult(value: unknown): value is BrowserContentResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return typeof item.text === 'string' && typeof item.title === 'string' && typeof item.url === 'string'
  return item.ok === false && typeof item.error === 'string'
}

export function isBrowserActionRequest(value: unknown): value is BrowserActionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (typeof item.instanceId !== 'string' || !item.instanceId) return false
  if (item.type === 'click') {
    return typeof item.refId === 'number' && Number.isSafeInteger(item.refId) && item.refId > 0
  }
  if (item.type === 'fill') {
    return typeof item.refId === 'number' && Number.isSafeInteger(item.refId) && item.refId > 0 && typeof item.text === 'string'
  }
  if (item.type === 'press') {
    return typeof item.key === 'string' && item.key.length > 0 && item.key.length <= 64
  }
  if (item.type === 'scroll') {
    return (item.deltaX === undefined || typeof item.deltaX === 'number')
      && (item.deltaY === undefined || typeof item.deltaY === 'number')
  }
  return false
}

export function isBrowserActionResult(value: unknown): value is BrowserActionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return typeof item.dispatched === 'boolean' && typeof item.url === 'string' && typeof item.title === 'string'
  return item.ok === false && typeof item.error === 'string'
}
