/**
 * 能力插件清单的跨进程契约：插件标识、清单视图、启停请求与响应校验的唯一声明处。
 *
 * 插件指「可独立启停的产品能力」（文件、快捷命令、终端、Git、手机访问、专家与专家团、记忆、用量），
 * 不是内核：窗口外壳、IPC 基座、会话运行时、模型认证、信任与写入守卫始终装配。
 * 启停只在启动期决定装配，运行期切换留待下次启动完全生效；这里不表达热卸载。
 */
import type { DesktopError } from './desktop-api'

export const PLUGIN_LIST_CHANNEL = 'desktop:plugin-list'
export const PLUGIN_TOGGLE_CHANNEL = 'desktop:plugin-toggle'

/** 插件标识的字符规则：与专家、团队标识同一口径，小写短横线。 */
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 停用记录的总条数与单条长度上限；装配期与配置解析共用这一份取值。 */
export const MAX_DISABLED_PLUGINS = 64
export const MAX_PLUGIN_ID_LENGTH = 48
/** 清单条数上限：随包插件只有几项，超过即视为响应异常，不让一份超长清单撑爆渲染端。 */
export const MAX_PLUGIN_ENTRIES = 64

/** 本契约允许的错误码；与 `DesktopErrorCode` 取值一致，失败响应不会带出联合之外的字串。 */
const PLUGIN_ERROR_CODES: readonly string[] = [
  'FORBIDDEN',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
  'INVALID_RESPONSE',
  'BRIDGE_UNAVAILABLE',
  'BRIDGE_CALL_FAILED'
]

/** 插件来源：内置随包声明；用户来源预留给后续可安装插件，当前没有写入通道。 */
export type PluginSource = 'builtin' | 'user'

/**
 * 清单里的一项插件。
 * `enabled` 表示配置里的启用状态；`active` 表示按依赖计算后本次启动是否真的装配了它——
 * 被停用本身与「因为依赖被停用而缺席」是两件事，后者由 `unavailableReason` 说明。
 * `requiresRestart` 恒为 true：主进程无法注销已注册的通道，切换后需重启才完全生效。
 */
export interface PluginEntryView {
  readonly id: string
  readonly name: string
  readonly summary: string
  readonly source: PluginSource
  readonly enabled: boolean
  readonly active: boolean
  readonly requiresRestart: true
  readonly dependencies: readonly string[]
  readonly unavailableReason: string | null
}

export interface PluginListView {
  readonly plugins: readonly PluginEntryView[]
}

export type PluginListResult =
  | { readonly ok: true; readonly data: PluginListView }
  | { readonly ok: false; readonly error: DesktopError }

/** 启停请求只带标识与目标状态，不接受整对象透传。 */
export interface PluginToggleRequest {
  readonly id: string
  readonly enabled: boolean
}

/** 切换成功后返回整份清单：状态与依赖缺席原因在同一个响应里保持一致。 */
export type PluginToggleResult = PluginListResult

export interface PluginApi {
  /** 读取插件清单；顺序即内置声明的展示顺序。 */
  readonly listPlugins: () => Promise<PluginListResult>
  /** 启用或停用一个插件，返回更新后的整份清单。 */
  readonly setPluginEnabled: (id: string, enabled: boolean) => Promise<PluginToggleResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_PLUGIN_ID_LENGTH && PLUGIN_ID_PATTERN.test(value)
}

function isPluginEntryView(value: unknown): value is PluginEntryView {
  if (!isRecord(value)) return false
  const { id, name, summary, source, enabled, active, requiresRestart, dependencies, unavailableReason } = value
  if (!isPluginId(id)) return false
  if (typeof name !== 'string' || name === '') return false
  if (typeof summary !== 'string') return false
  if (source !== 'builtin' && source !== 'user') return false
  if (typeof enabled !== 'boolean' || typeof active !== 'boolean' || requiresRestart !== true) return false
  if (!Array.isArray(dependencies) || !dependencies.every(isPluginId)) return false
  return unavailableReason === null || typeof unavailableReason === 'string'
}

export function isPluginListView(value: unknown): value is PluginListView {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.plugins) || value.plugins.length > MAX_PLUGIN_ENTRIES) return false
  return value.plugins.every(isPluginEntryView)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isPluginListResult(value: unknown): value is PluginListResult {
  if (!isRecord(value)) return false

  if (value.ok === true) return isPluginListView(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && PLUGIN_ERROR_CODES.includes(code) && typeof message === 'string'
}

/** 主进程侧的请求校验：只接受两个已声明字段，多余字段整份拒绝。 */
export function isPluginToggleRequest(value: unknown): value is PluginToggleRequest {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every(key => key === 'id' || key === 'enabled')) return false
  return isPluginId(value.id) && typeof value.enabled === 'boolean'
}
