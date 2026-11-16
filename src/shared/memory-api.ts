/** 用户级全局记忆的受限桌面接口；页面不指定解释器、脚本、数据根或批准标志。 */
export const MEMORY_STATUS_CHANNEL = 'desktop:memory-status'
export const MEMORY_ENABLED_CHANNEL = 'desktop:memory-enabled'
export const MEMORY_INITIALIZE_CHANNEL = 'desktop:memory-initialize'
/** 只读：按真实记录 ID 取回正文，供会话内的注入条目展开；不写库、不产生标注。 */
export const MEMORY_READ_CHANNEL = 'desktop:memory-read'
/** 只读：按领域取回画像正文，供注入卡片展开画像条目；不写库、不产生标注。 */
export const MEMORY_PROFILE_READ_CHANNEL = 'desktop:memory-profile-read'
/** 只读：按真实风格 ID 取回要点与全部原句，供注入卡片展开风格条目；不写库。 */
export const MEMORY_STYLE_READ_CHANNEL = 'desktop:memory-style-read'
/** 单次风格读取上限：与引擎 `style-read` 的 1..10 一致。 */
export const MEMORY_STYLE_MAX_IDS = 10

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

/** 风格正文读取只接受真实风格 ID：页面不能按名称、关键词或数量扫描风格库。 */
export interface MemoryStyleReadRequest { readonly ids: readonly string[] }
export interface MemoryStyleSampleRecord {
  readonly quote: string
  readonly source_session: string
  readonly source_date: string
}
export interface MemoryStyleReadRecord {
  readonly id: string
  readonly name: string
  readonly scene: string
  readonly points: string
  readonly date: string
  readonly samples: readonly MemoryStyleSampleRecord[]
}
export type MemoryStyleReadResult =
  | { readonly ok: true; readonly data: { readonly styles: readonly MemoryStyleReadRecord[] } }
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
  readonly readMemoryStyles: (request: MemoryStyleReadRequest) => Promise<MemoryStyleReadResult>
  readonly saveMemoryCandidates: (request: MemorySaveCandidatesRequest) => Promise<MemorySaveResult>
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

const STYLE_ID = /^t_[0-9A-HJKMNP-TV-Z]{26}$/

/** 风格读取请求：1..10 个真实风格 ID，不重复；不接受名称或关键词。 */
export function isMemoryStyleReadRequest(value: unknown): value is MemoryStyleReadRequest {
  if (!record(value) || Object.keys(value).length !== 1) return false
  const ids = value.ids
  return Array.isArray(ids) && ids.length > 0 && ids.length <= MEMORY_STYLE_MAX_IDS
    && ids.every(id => typeof id === 'string' && STYLE_ID.test(id))
    && new Set(ids).size === ids.length
}

function isMemoryStyleSampleRecord(value: unknown): value is MemoryStyleSampleRecord {
  if (!record(value)) return false
  return typeof value.quote === 'string' && value.quote.length > 0 && value.quote.length <= 1_000
    && typeof value.source_session === 'string' && value.source_session.length > 0 && value.source_session.length <= 200
    && typeof value.source_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.source_date)
}

function isMemoryStyleReadRecord(value: unknown): value is MemoryStyleReadRecord {
  if (!record(value)) return false
  return typeof value.id === 'string' && STYLE_ID.test(value.id)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200
    && typeof value.scene === 'string' && value.scene.length <= 2_000
    && typeof value.points === 'string' && value.points.length <= 4_000
    && typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && Array.isArray(value.samples) && value.samples.length <= 12 && value.samples.every(isMemoryStyleSampleRecord)
}

export function isMemoryStyleReadResult(value: unknown): value is MemoryStyleReadResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && Array.isArray(value.data.styles)
      && value.data.styles.length <= MEMORY_STYLE_MAX_IDS && value.data.styles.every(isMemoryStyleReadRecord)
  }
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
}

/** 会话内卡片候选的保存通道：用户在卡片上勾选并编辑后由主进程经引擎计划提交；页面不指定 plan、store 或批准标志。 */
export const MEMORY_SAVE_CANDIDATES_CHANNEL = 'desktop:memory-save-candidates'

/** 记录类型：与引擎及扩展侧 `memory_save` 同一枚举；decision／constraint 是规则类（需 rule_key，恒为 active）。 */
export const MEMORY_RECORD_TYPES = ['decision', 'constraint', 'progress', 'issue', 'fact', 'preference_evidence'] as const
export type MemoryRecordType = typeof MEMORY_RECORD_TYPES[number]

/**
 * 卡片候选是人工确认面：条数远小于工具侧的 50，单条长度与工具 schema 同值。
 * 上限只约束请求体积，超限整份拒绝，不静默截断。
 */
export const MEMORY_CANDIDATE_MAX_ITEMS = 10
export const MEMORY_TOPIC_MAX = 200
export const MEMORY_CONTENT_MAX = 20_000
export const MEMORY_RULE_KEY_MAX = 200
export const MEMORY_REASON_MAX = 2_000
/** 引用名单上限与扩展侧按 ID 批量读取一致。 */
const MEMORY_REFS_MAX = 50

/** 一条待保存候选：字段集合闭合于引擎 save 的 allowed 子集；类型与状态的业务组合由引擎判定，这里不复制。 */
export interface MemorySaveCandidate {
  readonly type: MemoryRecordType
  readonly topic: string
  readonly content: string
  readonly rule_key?: string
  readonly status?: 'active' | 'resolved' | 'archived'
  readonly source_record_ids?: readonly string[]
  readonly supersede_record_ids?: readonly string[]
  readonly supersession_reason?: string
}

/** 保存请求：归属由主进程按项目注册表匹配 projectPath，拿不到或空串（未关联项目）留空为全局记忆，页面不直接给 project_id。 */
export interface MemorySaveCandidatesRequest {
  readonly projectPath: string
  readonly candidates: readonly MemorySaveCandidate[]
}

/** 保存回执：与库内内容完全重复的候选由引擎跳过，不在回执里单独列出；全部重复时保存直接失败并带原因。 */
export type MemorySaveResult =
  | { readonly ok: true; readonly data: { readonly savedCount: number; readonly recordIds: readonly string[] } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength
}

/** 引用名单：真实记录 ID、去重、非空数组。 */
function isRecordRefList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= MEMORY_REFS_MAX
    && value.every(item => typeof item === 'string' && RECORD_ID.test(item))
    && new Set(value as readonly string[]).size === (value as readonly string[]).length
}

const CANDIDATE_FIELDS = ['type', 'topic', 'content', 'rule_key', 'status',
  'source_record_ids', 'supersede_record_ids', 'supersession_reason'] as const
const CANDIDATE_STATUS = ['active', 'resolved', 'archived'] as const

/** 单条候选校验：卡片候选段与保存请求共用同一判定，保证「卡片上能出现的」与「能提交引擎的」同形。 */
export function isMemorySaveCandidate(value: unknown): value is MemorySaveCandidate {
  if (!record(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !(CANDIDATE_FIELDS as readonly string[]).includes(key))) return false
  if (!(MEMORY_RECORD_TYPES as readonly string[]).includes(String(item.type))) return false
  if (!boundedText(item.topic, MEMORY_TOPIC_MAX) || !boundedText(item.content, MEMORY_CONTENT_MAX)) return false
  if (item.rule_key !== undefined && !boundedText(item.rule_key, MEMORY_RULE_KEY_MAX)) return false
  if (item.status !== undefined && !(CANDIDATE_STATUS as readonly string[]).includes(String(item.status))) return false
  if (item.source_record_ids !== undefined && !isRecordRefList(item.source_record_ids)) return false
  if (item.supersede_record_ids !== undefined && !isRecordRefList(item.supersede_record_ids)) return false
  if (item.supersession_reason !== undefined && !boundedText(item.supersession_reason, MEMORY_REASON_MAX)) return false
  return true
}

export function isMemorySaveCandidatesRequest(value: unknown): value is MemorySaveCandidatesRequest {
  if (!record(value) || Object.keys(value).length !== 2) return false
  if (typeof value.projectPath !== 'string' || value.projectPath.length > 1024) return false
  const { candidates } = value
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MEMORY_CANDIDATE_MAX_ITEMS) return false
  return candidates.every(item => isMemorySaveCandidate(item))
}

export function isMemorySaveResult(value: unknown): value is MemorySaveResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && typeof value.data.savedCount === 'number'
      && Number.isInteger(value.data.savedCount) && value.data.savedCount >= 0
      && Array.isArray(value.data.recordIds) && value.data.recordIds.length === value.data.savedCount
      && value.data.recordIds.every(id => typeof id === 'string' && RECORD_ID.test(id))
  }
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
    && ['FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'CANCELLED', 'RUNTIME_MISSING', 'STORE_UNAVAILABLE',
      'INITIALIZATION_FAILED', 'BUSY', 'BRIDGE_UNAVAILABLE', 'INVALID_RESPONSE'].includes(String(value.error.code))
}
