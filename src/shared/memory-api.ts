/** 用户级全局记忆的受限桌面接口；页面不指定解释器、脚本、数据根或批准标志。 */
export const MEMORY_STATUS_CHANNEL = 'desktop:memory-status'
export const MEMORY_ENABLED_CHANNEL = 'desktop:memory-enabled'
export const MEMORY_INITIALIZE_CHANNEL = 'desktop:memory-initialize'

export interface MemoryPreference { readonly enabled: boolean }
export interface MemoryInitializeRequest { readonly timezone: string }
export interface MemorySnapshot {
  readonly enabled: boolean
  readonly activation: 'applied' | 'unconfirmed'
  readonly initializing: boolean
  readonly notice: string | null
  readonly runtime: {
    readonly state: 'available' | 'missing' | 'unsupported'
    readonly pythonVersion: string | null
    readonly timezoneVersion: string | null
    readonly message: string | null
  }
  readonly library: {
    readonly state: 'missing' | 'ready' | 'unavailable' | 'invalid'
    readonly path: string
    readonly timezone: string | null
    readonly message: string | null
  }
}
export type MemoryErrorCode = 'FORBIDDEN' | 'INVALID_REQUEST' | 'INTERNAL_ERROR' | 'CANCELLED'
  | 'RUNTIME_MISSING' | 'STORE_UNAVAILABLE' | 'INITIALIZATION_FAILED' | 'BUSY' | 'BRIDGE_UNAVAILABLE' | 'INVALID_RESPONSE'
export type MemoryResult = { readonly ok: true; readonly data: MemorySnapshot }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }
export interface MemoryApi {
  readonly getMemoryStatus: () => Promise<MemoryResult>
  readonly setMemoryEnabled: (request: MemoryPreference) => Promise<MemoryResult>
  readonly initializeMemory: (request: MemoryInitializeRequest) => Promise<MemoryResult>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nullableText(value: unknown): value is string | null { return value === null || typeof value === 'string' }
export function isMemoryPreference(value: unknown): value is MemoryPreference {
  return record(value) && Object.keys(value).length === 1 && typeof value.enabled === 'boolean'
}
export function isMemoryInitializeRequest(value: unknown): value is MemoryInitializeRequest {
  // 只做形式与长度约束，接受单段名（Japan、CET、EST5EDT）与多段名；
  // 是否真实可用由主进程的 Intl 与引擎的 ZoneInfo 判定，这里不重复收窄。
  return record(value) && Object.keys(value).length === 1 && typeof value.timezone === 'string'
    && value.timezone.length <= 128
    && /^[A-Za-z][A-Za-z0-9_+.-]{0,63}(?:\/[A-Za-z0-9_+.-]{1,64}){0,3}$/.test(value.timezone)
    && !value.timezone.split('/').some(part => part === '.' || part === '..')
}
export function isMemorySnapshot(value: unknown): value is MemorySnapshot {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.initializing !== 'boolean'
    || !['applied', 'unconfirmed'].includes(String(value.activation)) || !nullableText(value.notice)
    || !record(value.runtime) || !record(value.library)) return false
  const runtime = value.runtime, library = value.library
  return ['available', 'missing', 'unsupported'].includes(String(runtime.state))
    && nullableText(runtime.pythonVersion) && nullableText(runtime.timezoneVersion) && nullableText(runtime.message)
    && ['missing', 'ready', 'unavailable', 'invalid'].includes(String(library.state))
    && typeof library.path === 'string' && nullableText(library.timezone) && nullableText(library.message)
}
export function isMemoryResult(value: unknown): value is MemoryResult {
  if (!record(value)) return false
  if (value.ok === true) return isMemorySnapshot(value.data)
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && ['FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'CANCELLED', 'RUNTIME_MISSING', 'STORE_UNAVAILABLE',
      'INITIALIZATION_FAILED', 'BUSY', 'BRIDGE_UNAVAILABLE', 'INVALID_RESPONSE'].includes(String(value.error.code))
}
