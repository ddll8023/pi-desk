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
  /** 依据来源：用户明确表达或已展示依据并确认的推测；编辑保存时原样回传。 */
  readonly basis: string
  readonly title: string
  readonly content: string
  /** 提炼依据的日记记录 ID；编辑保存时原样回传，避免一次编辑把来源洗掉。 */
  readonly source_record_ids: readonly string[]
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
  readonly readMemoryProfilesList: () => Promise<MemoryProfileListResult>
  readonly readMemoryStylesList: () => Promise<MemoryStyleListResult>
  readonly saveMemoryProfile: (request: MemoryProfileSaveRequest) => Promise<MemoryProfileSaveResult>
  readonly saveMemoryStyle: (request: MemoryStyleSaveRequest) => Promise<MemoryStyleSaveResult>
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
    && typeof value.basis === 'string' && value.basis.length <= 64
    && typeof value.title === 'string' && value.title.length <= MEMORY_PROFILE_TITLE_MAX
    && typeof value.content === 'string' && value.content.length <= 20_000
    && Array.isArray(value.source_record_ids)
    && value.source_record_ids.length <= MEMORY_LIST_MAX_ITEMS
    && value.source_record_ids.every(id => typeof id === 'string' && RECORD_ID.test(id))
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

/**
 * 设置页查看与编辑画像、语气风格：列表通道无参数，保存通道走引擎 `plan` → `commit`。
 * 页面不指定计划 ID、库位置或批准标志，也不提供新建与删除——引擎没有对应的计划操作。
 */
export const MEMORY_PROFILES_CHANNEL = 'desktop:memory-profiles'
export const MEMORY_STYLES_CHANNEL = 'desktop:memory-styles'
export const MEMORY_PROFILE_SAVE_CHANNEL = 'desktop:memory-profile-save'
export const MEMORY_STYLE_SAVE_CHANNEL = 'desktop:memory-style-save'

/** 列表通道的条数上限：只约束请求体积，超限整份拒绝，不静默截断。 */
export const MEMORY_LIST_MAX_ITEMS = 200
/** 画像标题上限：读、写校验器与设置页输入框共用同一数值。 */
export const MEMORY_PROFILE_TITLE_MAX = 300
/** 单次保存的风格条数与单条样本上限：与引擎写入语义一致。 */
export const MEMORY_STYLE_SAVE_MAX_ITEMS = 10
export const MEMORY_STYLE_SAMPLE_MAX = 12
export const MEMORY_STYLE_QUOTE_MAX = 1_000
export const MEMORY_STYLE_NAME_MAX = 200
export const MEMORY_STYLE_SCENE_MAX = 2_000
export const MEMORY_STYLE_POINTS_MAX = 4_000

export type MemoryProfileListResult =
  | { readonly ok: true; readonly data: { readonly profiles: readonly MemoryProfileReadRecord[] } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

export type MemoryStyleListResult =
  | { readonly ok: true; readonly data: { readonly styles: readonly MemoryStyleReadRecord[] } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

/** 画像依据：与引擎枚举同值，页面只能二选一。 */
export const MEMORY_PROFILE_BASES = ['explicit', 'inferred_confirmed'] as const
export type MemoryProfileBasis = typeof MEMORY_PROFILE_BASES[number]

/**
 * 画像保存请求：领域锁定（引擎要求替换目标同领域），作用域只能是全库或本领域。
 * 保存即「新增一条并替换旧 ID」，来源记录 ID 沿用原条目（失效项在提交前剔除），页面不编辑来源。
 */
export interface MemoryProfileSaveRequest {
  readonly domain: MemoryProfileDomain
  readonly scope: string
  readonly basis: MemoryProfileBasis
  readonly title: string
  readonly content: string
  readonly sourceRecordIds: readonly string[]
  readonly replaceProfileIds: readonly string[]
}
export type MemoryProfileSaveResult =
  | { readonly ok: true; readonly data: {
    readonly profileId: string
    readonly replacedProfileIds: readonly string[]
    /** 提交前被剔除的失效来源记录 ID：页面据此如实提示，不静默丢来源。 */
    readonly droppedSourceIds: readonly string[]
  } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

/** 风格样本：原句逐字保留；设置页手工补录的样本来源会话记为 `manual`。 */
export interface MemoryStyleSaveSample {
  readonly quote: string
  readonly sourceSession: string
  readonly sourceDate: string
}
export interface MemoryStyleSaveItem {
  readonly name: string
  readonly scene: string
  readonly points: string
  readonly samples: readonly MemoryStyleSaveSample[]
  /** 被这条保存取代的旧风格 ID：含同名条目时按覆盖处理，不含且同名时按合并处理。 */
  readonly replaceStyleIds: readonly string[]
}
export interface MemoryStyleSaveRequest { readonly styles: readonly MemoryStyleSaveItem[] }
export type MemoryStyleSaveResult =
  | { readonly ok: true; readonly data: {
    readonly newStyleIds: readonly string[]
    readonly mergedStyleIds: readonly string[]
    readonly replacedStyleIds: readonly string[]
  } }
  | { readonly ok: false; readonly error: { readonly code: MemoryErrorCode; readonly message: string } }

/** 保存类结果共用同一失败形状；错误码由主进程给出，这里只校验形态。 */
function isFailureResult(value: Record<string, unknown>): boolean {
  return value.ok === false && record(value.error) && typeof value.error.message === 'string'
    && typeof value.error.code === 'string'
}

/** ID 名单：形态匹配、不重复、不超过上限；空数组合法（表示不引用、不替换）。 */
function isIdList(value: unknown, pattern: RegExp, maxItems: number): boolean {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === 'string' && pattern.test(item))
    && new Set(value as readonly string[]).size === value.length
}

export function isMemoryProfileListResult(value: unknown): value is MemoryProfileListResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && Array.isArray(value.data.profiles)
      && value.data.profiles.length <= MEMORY_LIST_MAX_ITEMS && value.data.profiles.every(isMemoryProfileReadRecord)
  }
  return isFailureResult(value)
}

export function isMemoryStyleListResult(value: unknown): value is MemoryStyleListResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && Array.isArray(value.data.styles)
      && value.data.styles.length <= MEMORY_LIST_MAX_ITEMS && value.data.styles.every(isMemoryStyleReadRecord)
  }
  return isFailureResult(value)
}

const PROFILE_SCOPE = /^(global|domain:[a-z0-9-]{1,64})$/
const PROFILE_SAVE_FIELDS = ['domain', 'scope', 'basis', 'title', 'content', 'sourceRecordIds', 'replaceProfileIds'] as const

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
}

export function isMemoryProfileSaveRequest(value: unknown): value is MemoryProfileSaveRequest {
  if (!record(value) || !hasExactFields(value, PROFILE_SAVE_FIELDS)) return false
  const domain = value.domain
  if (typeof domain !== 'string' || !(MEMORY_PROFILE_DOMAINS as readonly string[]).includes(domain)) return false
  if (typeof value.scope !== 'string' || !PROFILE_SCOPE.test(value.scope)) return false
  // 作用域只有「全库」与「本领域」两种：跨领域作用域会让画像落在错误领域生效，直接拒绝。
  if (value.scope.startsWith('domain:') && value.scope !== `domain:${domain}`) return false
  if (typeof value.basis !== 'string' || !(MEMORY_PROFILE_BASES as readonly string[]).includes(value.basis)) return false
  if (!boundedText(value.title, MEMORY_PROFILE_TITLE_MAX) || !boundedText(value.content, MEMORY_CONTENT_MAX)) return false
  // 来源上限与读侧同一数值：读得到就必须存得下，否则 51..200 条来源的画像在页面上可读却永远存不了。
  return isIdList(value.sourceRecordIds, RECORD_ID, MEMORY_LIST_MAX_ITEMS)
    && isIdList(value.replaceProfileIds, PROFILE_ID, MEMORY_REFS_MAX)
}

export function isMemoryProfileSaveResult(value: unknown): value is MemoryProfileSaveResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data) && typeof value.data.profileId === 'string' && PROFILE_ID.test(value.data.profileId)
      && isIdList(value.data.replacedProfileIds, PROFILE_ID, MEMORY_REFS_MAX)
      && isIdList(value.data.droppedSourceIds, RECORD_ID, MEMORY_REFS_MAX)
  }
  return isFailureResult(value)
}

const SAMPLE_FIELDS = ['quote', 'sourceSession', 'sourceDate'] as const
const STYLE_ITEM_FIELDS = ['name', 'scene', 'points', 'samples', 'replaceStyleIds'] as const

function isMemoryStyleSaveSample(value: unknown): value is MemoryStyleSaveSample {
  if (!record(value) || !hasExactFields(value, SAMPLE_FIELDS)) return false
  return boundedText(value.quote, MEMORY_STYLE_QUOTE_MAX) && boundedText(value.sourceSession, 200)
    && typeof value.sourceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.sourceDate)
}

export function isMemoryStyleSaveItem(value: unknown): value is MemoryStyleSaveItem {
  if (!record(value) || !hasExactFields(value, STYLE_ITEM_FIELDS)) return false
  if (!boundedText(value.name, MEMORY_STYLE_NAME_MAX) || !boundedText(value.scene, MEMORY_STYLE_SCENE_MAX)) return false
  if (!boundedText(value.points, MEMORY_STYLE_POINTS_MAX)) return false
  const { samples } = value
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > MEMORY_STYLE_SAMPLE_MAX) return false
  if (!samples.every(item => isMemoryStyleSaveSample(item))) return false
  return isIdList(value.replaceStyleIds, STYLE_ID, MEMORY_STYLE_SAVE_MAX_ITEMS)
}

export function isMemoryStyleSaveRequest(value: unknown): value is MemoryStyleSaveRequest {
  if (!record(value) || Object.keys(value).length !== 1) return false
  const { styles } = value
  return Array.isArray(styles) && styles.length >= 1 && styles.length <= MEMORY_STYLE_SAVE_MAX_ITEMS
    && styles.every(item => isMemoryStyleSaveItem(item))
}

export function isMemoryStyleSaveResult(value: unknown): value is MemoryStyleSaveResult {
  if (!record(value)) return false
  if (value.ok === true) {
    return record(value.data)
      && isIdList(value.data.newStyleIds, STYLE_ID, MEMORY_STYLE_SAVE_MAX_ITEMS)
      && isIdList(value.data.mergedStyleIds, STYLE_ID, MEMORY_STYLE_SAVE_MAX_ITEMS)
      && isIdList(value.data.replacedStyleIds, STYLE_ID, MEMORY_STYLE_SAVE_MAX_ITEMS)
  }
  return isFailureResult(value)
}
