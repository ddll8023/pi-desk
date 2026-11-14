/** 用户级全局记忆的受限桌面接口；页面不指定解释器、脚本、数据根或批准标志。 */
export const MEMORY_STATUS_CHANNEL = 'desktop:memory-status'
export const MEMORY_ENABLED_CHANNEL = 'desktop:memory-enabled'
export const MEMORY_INITIALIZE_CHANNEL = 'desktop:memory-initialize'
/** 只读：按真实记录 ID 取回正文，供会话内的注入条目展开；不写库、不产生标注。 */
export const MEMORY_READ_CHANNEL = 'desktop:memory-read'
/** 只读：按领域取回画像正文，供注入卡片展开画像条目；不写库、不产生标注。 */
export const MEMORY_PROFILE_READ_CHANNEL = 'desktop:memory-profile-read'

export interface MemoryPreference { readonly enabled: boolean }
export interface MemoryInitializeRequest { readonly timezone: string }

/** 正文读取只接受真实记录 ID：页面不能按关键词、路径或数量扫描库。 */
export interface MemoryReadRequest { readonly ids: readonly string[] }
export interface MemoryReadRecord {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly date: string
  readonly topic: string
  readonly status: string
  readonly content: string
}
export type MemoryReadResult =
  | { readonly ok: true; readonly data: { readonly records: readonly MemoryReadRecord[] } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

/** 画像领域是固定枚举：页面只能选领域，不能按 ID、关键词或数量扫描。 */
export const MEMORY_PROFILE_DOMAINS = ['communication', 'coding', 'learning', 'workflow'] as const
export type MemoryProfileDomain = typeof MEMORY_PROFILE_DOMAINS[number]
export interface MemoryProfileReadRequest { readonly domain: MemoryProfileDomain }
export interface MemoryProfileReadRecord {
  readonly id: string
  readonly domain: string
  readonly scope: string
  readonly title: string
  readonly content: string
}
export type MemoryProfileReadResult =
  | { readonly ok: true; readonly data: { readonly profiles: readonly MemoryProfileReadRecord[] } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }
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
  readonly readMemoryRecords: (request: MemoryReadRequest) => Promise<MemoryReadResult>
  readonly readMemoryProfiles: (request: MemoryProfileReadRequest) => Promise<MemoryProfileReadResult>
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

const RECORD_ID = /^m_[0-9A-HJKMNP-TV-Z]{26}$/
/** 与扩展侧 `memory_read` 的上限一致：一次最多 50 条，不接受重复 ID。 */
export const MEMORY_READ_MAX_IDS = 50

export function isMemoryReadRequest(value: unknown): value is MemoryReadRequest {
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.ids)) return false
  const ids = value.ids
  return ids.length > 0 && ids.length <= MEMORY_READ_MAX_IDS
    && ids.every(id => typeof id === 'string' && RECORD_ID.test(id))
    && new Set(ids).size === ids.length
}

function isMemoryReadRecord(value: unknown): value is MemoryReadRecord {
  if (!record(value)) return false
  return typeof value.id === 'string' && RECORD_ID.test(value.id)
    && typeof value.title === 'string' && value.title.length <= 300
    && typeof value.type === 'string' && value.type.length <= 64
    && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && typeof value.topic === 'string' && value.topic.length <= 300
    && typeof value.status === 'string' && value.status.length <= 32
    && typeof value.content === 'string' && value.content.length <= 20_000
}

export function isMemoryReadResult(value: unknown): value is MemoryReadResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && Array.isArray(value.data.records)
      && value.data.records.length <= MEMORY_READ_MAX_IDS && value.data.records.every(isMemoryReadRecord)
  }
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
}

export function isMemoryProfileReadRequest(value: unknown): value is MemoryProfileReadRequest {
  if (!record(value) || Object.keys(value).length !== 1) return false
  return typeof value.domain === 'string'
    && (MEMORY_PROFILE_DOMAINS as readonly string[]).includes(value.domain)
}

const PROFILE_ID = /^p_[0-9A-HJKMNP-TV-Z]{26}$/

function isMemoryProfileReadRecord(value: unknown): value is MemoryProfileReadRecord {
  if (!record(value)) return false
  return typeof value.id === 'string' && PROFILE_ID.test(value.id)
    && typeof value.domain === 'string' && (MEMORY_PROFILE_DOMAINS as readonly string[]).includes(value.domain)
    && typeof value.scope === 'string' && /^(global|domain:[a-z0-9-]{1,64})$/.test(value.scope)
    && typeof value.title === 'string' && value.title.length <= 300
    && typeof value.content === 'string' && value.content.length <= 20_000
}

export function isMemoryProfileReadResult(value: unknown): value is MemoryProfileReadResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && Array.isArray(value.data.profiles)
      && value.data.profiles.length <= 64 && value.data.profiles.every(isMemoryProfileReadRecord)
  }
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
}
