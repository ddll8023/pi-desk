/** 桌面显式配置适配：优先读进程内配置，无桌面通道时保留独立 CLI 行为。 */
import { isAbsolute } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export const HOST_CHANGED = 'pi-desk:memory-configuration-changed:v1'
/** 与主进程 shared-process/memory-runtime.ts 的 MEMORY_CONFIGURATION_ENV 一致。 */
const HOST_ENV = 'PI_DESK_MEMORY_CONFIG'
export interface MemoryHostConfiguration {
  version: 1
  revision: number
  enabled: boolean
  disabledByMode: boolean
  available: boolean
  store: string
  engine: string
  python: string
  tzdata: string | null
  pythonVersion: string | null
  timezoneVersion: string | null
  error: string | null
}
export function parseHostConfiguration(value: unknown): MemoryHostConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('桌面记忆配置无效')
  const row = value as Record<string, unknown>
  const path = (name: string): boolean => typeof row[name] === 'string' && isAbsolute(row[name])
  const nullableText = (name: string): boolean => row[name] === null || typeof row[name] === 'string'
  if (row.version !== 1 || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0
    || typeof row.enabled !== 'boolean' || typeof row.disabledByMode !== 'boolean'
    || typeof row.available !== 'boolean'
    || !path('store') || !path('engine') || !path('python') || !(row.tzdata === null || path('tzdata'))
    || (row.available && row.tzdata === null) || !nullableText('error')
    || !nullableText('pythonVersion') || !nullableText('timezoneVersion')
    || Object.keys(row).some(key => !['version', 'revision', 'enabled', 'disabledByMode', 'available', 'store', 'engine', 'python', 'tzdata',
      'pythonVersion', 'timezoneVersion', 'error'].includes(key))) throw new Error('桌面记忆配置字段无效')
  return { version: 1, revision: row.revision, enabled: row.enabled, disabledByMode: row.disabledByMode,
    available: row.available,
    store: String(row.store), engine: String(row.engine), python: String(row.python),
    tzdata: row.tzdata === null ? null : String(row.tzdata), error: row.error === null ? null : String(row.error),
    pythonVersion: row.pythonVersion === null ? null : String(row.pythonVersion),
    timezoneVersion: row.timezoneVersion === null ? null : String(row.timezoneVersion) }
}
/** 只在进程环境中存在桌面配置时才被视为受管运行；解析失败按无桌面通道处理，不阻塞会话。 */
export function readHostConfiguration(): MemoryHostConfiguration | undefined {
  const raw = process.env[HOST_ENV]
  if (typeof raw !== 'string' || raw === '') return undefined
  try { return parseHostConfiguration(JSON.parse(raw)) } catch { return undefined }
}
/** 订阅读桌面配置推送；推送内容无效时保留当前配置，不把旧值当成新值。 */
export function subscribeHostConfiguration(pi: ExtensionAPI, listener: (config: MemoryHostConfiguration) => void): void {
  pi.events.on(HOST_CHANGED, (value: unknown) => {
    try { listener(parseHostConfiguration(value)) } catch { /* 非法推送不改变运行状态。 */ }
  })
}
