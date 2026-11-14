/**
 * 会话内记忆注入审计的跨进程契约：只读快照，含三段状态与条目身份、摘要。
 *
 * 数据来源是会话分支里 `pi-memory.injection.v1` 自定义条目，由扩展在装配背景时写入；
 * 本契约只搬运它的形状，不读库、不写库，也不携带条目正文全文。
 * 段集合与版本绑定：只有 `version: 2` 判为有效，旧的多段快照一律按「没有审计」处理。
 */
import type { RuntimeError } from './status'

/** 一次装配的结论：有内容、被停用、或装配失败。 */
export type MemoryInjectionStatus = 'provided' | 'disabled' | 'unavailable'

/** 单个注入条目：身份字段供核对，`excerpt` 是正文前若干字，全文按记录 ID 另取。 */
export interface MemoryInjectionEntry {
  readonly id: string
  readonly rule_key: string
  readonly title: string
  readonly type: string
  readonly date: string
  readonly topic: string
  readonly excerpt: string
  readonly truncated: boolean
}

/**
 * 画像条目：来源是 `profiles` 命令，ID 为 `p_` 前缀，没有记录类型与日期，故单列一种形状。
 * 全文不放进审计，展开时按领域另取。
 */
export interface MemoryInjectionProfileEntry {
  readonly id: string
  readonly domain: string
  readonly scope: string
  readonly title: string
  readonly excerpt: string
  readonly truncated: boolean
}

/** 三段可点击的注入内容：画像、常驻约定、当前项目近况，缺任一段即不是有效快照。 */
export interface MemoryInjectionEntries {
  readonly profiles: readonly MemoryInjectionProfileEntry[]
  readonly resident: readonly MemoryInjectionEntry[]
  readonly notes: readonly MemoryInjectionEntry[]
}

/** 三段装配状态按原字段搬运，渲染端只读已知键，不据此推断额外含义。 */
export interface MemoryInjectionSnapshot {
  readonly version: 2
  readonly at: string
  readonly sessionId: string | null
  readonly cwd: string | null
  readonly revision: number
  readonly status: MemoryInjectionStatus
  readonly reason: string | null
  readonly segments: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly entries: MemoryInjectionEntries
}

export type MemoryInjectionResult =
  | { readonly ok: true; readonly data: { readonly injection: MemoryInjectionSnapshot | null } }
  | { readonly ok: false; readonly error: RuntimeError }

const RECORD_ID = /^m_[0-9A-HJKMNP-TV-Z]{26}$/
const PROFILE_ID = /^p_[0-9A-HJKMNP-TV-Z]{26}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ENTRY_TYPES = ['decision', 'constraint', 'fact', 'progress', 'issue', 'preference_evidence']
const PROFILE_DOMAINS = ['communication', 'coding', 'learning', 'workflow']
const PROFILE_SCOPE = /^(global|domain:[a-z0-9-]{1,64})$/
const STATUSES: readonly MemoryInjectionStatus[] = ['provided', 'disabled', 'unavailable']
/** 单段条目上限：与扩展侧的预算一致地宽松，只用于挡住形状错误的数据。 */
const MAX_ENTRIES = 400
const MAX_SEGMENTS = 8
const MAX_SEGMENT_KEYS = 32

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}

function isEntry(value: unknown): value is MemoryInjectionEntry {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && RECORD_ID.test(value.id)
    && bounded(value.rule_key, 300) && bounded(value.title, 300) && bounded(value.topic, 300)
    && typeof value.type === 'string' && ENTRY_TYPES.includes(value.type)
    && typeof value.date === 'string' && DATE.test(value.date)
    && bounded(value.excerpt, 1_000) && typeof value.truncated === 'boolean'
}

function isEntryList(value: unknown): value is readonly MemoryInjectionEntry[] {
  return Array.isArray(value) && value.length <= MAX_ENTRIES && value.every(isEntry)
}

function isProfileEntry(value: unknown): value is MemoryInjectionProfileEntry {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && PROFILE_ID.test(value.id)
    && typeof value.domain === 'string' && PROFILE_DOMAINS.includes(value.domain)
    && typeof value.scope === 'string' && PROFILE_SCOPE.test(value.scope)
    && bounded(value.title, 300) && bounded(value.excerpt, 1_000)
    && typeof value.truncated === 'boolean'
}

/** 画像条目同样按段限流；缺失（旧审计条目）与格式不符区别对待。 */
function isProfileEntryList(value: unknown): value is readonly MemoryInjectionProfileEntry[] {
  return Array.isArray(value) && value.length <= MAX_ENTRIES && value.every(isProfileEntry)
}

function isSegments(value: unknown): value is Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  if (!isRecord(value) || Object.keys(value).length > MAX_SEGMENTS) return false
  return Object.values(value).every(segment => isRecord(segment) && Object.keys(segment).length <= MAX_SEGMENT_KEYS)
}

/** 会话里读到的自定义条目数据可能是旧版本或损坏内容，形状不符时按「没有审计」处理。 */
export function isMemoryInjectionSnapshot(value: unknown): value is MemoryInjectionSnapshot {
  if (!isRecord(value)) return false
  if (value.version !== 2 || !bounded(value.at, 64)) return false
  if (!(value.sessionId === null || bounded(value.sessionId, 256))) return false
  if (!(value.cwd === null || bounded(value.cwd, 4_096))) return false
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return false
  if (typeof value.status !== 'string' || !STATUSES.includes(value.status as MemoryInjectionStatus)) return false
  if (!(value.reason === null || bounded(value.reason, 2_000))) return false
  if (!isSegments(value.segments)) return false
  const entries = value.entries
  if (!isRecord(entries)) return false
  return isProfileEntryList(entries.profiles) && isEntryList(entries.resident) && isEntryList(entries.notes)
}

export function isMemoryInjectionResult(value: unknown): value is MemoryInjectionResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data) && (data.injection === null || isMemoryInjectionSnapshot(data.injection))
  }
  if (value.ok !== false || !isRecord(value.error)) return false
  return typeof value.error.message === 'string' && typeof value.error.code === 'string'
}
