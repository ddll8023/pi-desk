/**
 * 专家资源管理（设置页）的固定通道、请求与结果类型及跨进程响应校验。
 *
 * 管六件事：「把内置专家派生成本地可编辑副本」「读取与保存自定义专家定义」「删除自定义专家」
 * 「快速模式会剔除哪些用户级技能」「能力候选（技能、全局 MCP 服务器）」「默认能力基线」；
 * 专家清单与加载诊断复用会话域的 `desktop:session-experts`，不在这里复制第二份读取。
 * 错误码独立成族：写盘失败、定义不合法与清单读取失败是不同故障，页面据此分开提示。
 */
import { isExpertId } from './session-api'

/** 把内置专家复制成自定义目录下的派生副本；副本立即出现在清单里。 */
export const EXPERTS_DERIVE_CHANNEL = 'desktop:expert-derive'
/** 删除一份自定义专家；内置专家只读，不能通过这条通道删除。 */
export const EXPERTS_DELETE_CHANNEL = 'desktop:expert-delete'
/** 读取一份自定义专家的声明与正文，供设置页编辑；内置专家不走这条通道。 */
export const EXPERTS_READ_CHANNEL = 'desktop:expert-read'
/** 新建或保存一份自定义专家定义；`expertId` 为空表示新建，由主进程分配标识。 */
export const EXPERTS_SAVE_CHANNEL = 'desktop:expert-save'
/** 快速模式下会被剔除的用户级技能标识；名单与宿主实际过滤同源。 */
export const EXPERTS_FAST_MODE_CHANNEL = 'desktop:expert-fast-mode'
/** 读取能力候选（技能、MCP 服务器、默认基线）；页面不自己拼路径，也不自己读配置。 */
export const EXPERTS_CAPABILITIES_CHANNEL = 'desktop:expert-capabilities'
/** 保存默认能力基线；专家继承这一份，改它会影响所有继承模式的专家。 */
export const EXPERTS_SAVE_DEFAULTS_CHANNEL = 'desktop:expert-save-defaults'

/** 显示名称的长度上限；历史定义超出时仍可读，只在新保存时拒绝。 */
export const MAX_EXPERT_DISPLAY_NAME_LENGTH = 64
/** 一句话简介的长度上限：列表里只占一行，过长会被截断显示。 */
export const MAX_EXPERT_SUMMARY_LENGTH = 200
/** 单个专家可引用的技能数量上限；再多就退化成技能集合，失去单点任务的定位。 */
export const MAX_EXPERT_SKILL_REFS = 20
/** 单个专家可引用的 MCP 服务器数量上限；与技能同一口径。 */
export const MAX_EXPERT_MCP_REFS = 20
/**
 * 默认能力基线的条目上限：基线描述「默认可用范围」，可能覆盖全部候选，
 * 因此不能沿用单个专家 20 个引用的上限，否则专家越多时基线反而写不进去。
 */
export const MAX_EXPERT_DEFAULTS_ENTRIES = 64

/** 能力范围的两种语义：继承默认基线后加减，或直接给出白名单。 */
export type ExpertCapabilityMode = 'inherit' | 'only'

/** 默认能力基线：`null` 表示该维度不限制，等于全部可用。 */
export interface ExpertCapabilityDefaults {
  readonly skills: readonly string[] | null
  readonly mcpServers: readonly string[] | null
}

/** 技能候选：来源区分随包技能与共享目录技能，页面按来源标注。 */
export interface ExpertSkillCandidate {
  readonly id: string
  readonly source: 'builtin' | 'shared'
}

/** MCP 服务器候选：`scope` 说明它来自全局还是项目配置，项目项只在受信项目里生效。 */
export interface ExpertMcpCandidate {
  readonly name: string
  readonly scope: 'global' | 'project'
  readonly enabled: boolean
}

/** 能力候选与当前基线一起返回：页面一次拿到勾选项与继承源，不用再读一次配置。 */
export interface ExpertCapabilities {
  readonly skills: readonly ExpertSkillCandidate[]
  readonly mcpServers: readonly ExpertMcpCandidate[]
  readonly defaults: ExpertCapabilityDefaults
}

export type ExpertErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'BRIDGE_UNAVAILABLE'
  /** 要派生的内置专家不在随包清单里（清单未重建或被移除）。 */
  | 'BUILTIN_NOT_FOUND'
  /** 目标不是可删除的自定义专家：内置、不存在或目录里还有别的文件。 */
  | 'NOT_USER_EXPERT'
  /** 要读取或保存的自定义专家不存在。 */
  | 'NOT_FOUND'
  /** 定义本身不成立：正文为空、字段超长、标识冲突或引用了子代理专用技能。 */
  | 'INVALID_DEFINITION'

export interface ExpertError {
  readonly code: ExpertErrorCode
  readonly message: string
}

export interface ExpertDeriveRequest {
  /** 要派生的内置专家标识。 */
  readonly builtinId: string
}

export type ExpertDeriveResult =
  | { readonly ok: true; readonly data: { readonly expertId: string } }
  | { readonly ok: false; readonly error: ExpertError }

export interface ExpertDeleteRequest {
  readonly expertId: string
}

export type ExpertDeleteResult =
  | { readonly ok: true; readonly data: { readonly expertId: string } }
  | { readonly ok: false; readonly error: ExpertError }

export type FastModeExclusionsResult =
  | { readonly ok: true; readonly data: { readonly skillIds: readonly string[] } }
  | { readonly ok: false; readonly error: ExpertError }

/** 编辑对话框需要的一份自定义专家：声明字段与正文一起返回，只在设置页使用。 */
export interface ExpertEditableDefinition {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly skillsMode: ExpertCapabilityMode
  readonly skillAddIds: readonly string[]
  readonly skillRemoveIds: readonly string[]
  readonly mcpMode: ExpertCapabilityMode
  readonly mcpServerIds: readonly string[]
  readonly mcpAddIds: readonly string[]
  readonly mcpRemoveIds: readonly string[]
  readonly body: string
  readonly derivedFrom: string | null
}

export interface ExpertReadRequest {
  readonly expertId: string
}

export type ExpertReadResult =
  | { readonly ok: true; readonly data: ExpertEditableDefinition }
  | { readonly ok: false; readonly error: ExpertError }

/**
 * 保存请求：`expertId` 为 `null` 表示新建（标识由主进程分配），否则更新该自定义专家。
 * 技能与 MCP 各带一份模式：`only` 时列表是实际白名单，`inherit` 时列表只是提示、范围由加减项决定。
 * 不可用引用由主进程在结果里回报，不拦保存。
 */
export interface ExpertSaveRequest {
  readonly expertId: string | null
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly skillsMode: ExpertCapabilityMode
  readonly skillAddIds: readonly string[]
  readonly skillRemoveIds: readonly string[]
  readonly mcpMode: ExpertCapabilityMode
  readonly mcpServerIds: readonly string[]
  readonly mcpAddIds: readonly string[]
  readonly mcpRemoveIds: readonly string[]
  readonly body: string
}

/** 保存结果带上不可用引用与截断标记，页面据此就地提示，不必再读一次清单。 */
export type ExpertSaveResult =
  | {
    readonly ok: true
    readonly data: {
      readonly expertId: string
      readonly unavailableSkillIds: readonly string[]
      readonly unavailableMcpServers: readonly string[]
      readonly truncated: boolean
    }
  }
  | { readonly ok: false; readonly error: ExpertError }

export type ExpertCapabilitiesResult =
  | { readonly ok: true; readonly data: ExpertCapabilities }
  | { readonly ok: false; readonly error: ExpertError }

/** 保存基线的请求：两个维度都用 `null` 表示不限制。 */
export interface ExpertSaveDefaultsRequest {
  readonly skills: readonly string[] | null
  readonly mcpServers: readonly string[] | null
}

export type ExpertSaveDefaultsResult =
  | { readonly ok: true; readonly data: ExpertCapabilityDefaults }
  | { readonly ok: false; readonly error: ExpertError }

export interface ExpertApi {
  /** 派生一份内置专家；返回新副本的标识，同名占用时由主进程顺延编号。 */
  readonly deriveExpert: (request: ExpertDeriveRequest) => Promise<ExpertDeriveResult>
  /** 删除一份自定义专家；内置专家与仍带其他文件的目录会被拒绝。 */
  readonly deleteExpert: (request: ExpertDeleteRequest) => Promise<ExpertDeleteResult>
  /** 读取一份自定义专家的声明与正文，供编辑对话框回填。 */
  readonly readExpertDefinition: (request: ExpertReadRequest) => Promise<ExpertReadResult>
  /** 新建或保存自定义专家；保存成功后定义立即出现在清单里。 */
  readonly saveExpert: (request: ExpertSaveRequest) => Promise<ExpertSaveResult>
  /** 读取快速模式会剔除的用户级技能；只反映目录里实际存在的那些，可以为空。 */
  readonly listFastModeExclusions: () => Promise<FastModeExclusionsResult>
  /** 读取能力候选与当前默认基线，供编辑对话框的能力段与设置页的基线卡片使用。 */
  readonly listCapabilities: () => Promise<ExpertCapabilitiesResult>
  /** 保存默认能力基线；专家继承这一份，改它会影响所有继承模式的专家。 */
  readonly saveCapabilityDefaults: (request: ExpertSaveDefaultsRequest) => Promise<ExpertSaveDefaultsResult>
}

const EXPERT_ERROR_CODES: readonly string[] = [
  'FORBIDDEN', 'INVALID_REQUEST', 'INTERNAL_ERROR', 'INVALID_RESPONSE', 'BRIDGE_UNAVAILABLE',
  'BUILTIN_NOT_FOUND', 'NOT_USER_EXPERT', 'NOT_FOUND', 'INVALID_DEFINITION'
]

/** 技能标识独立于专家标识：技能目录允许下划线与大写，按专家 id 规则会误拒合法引用。 */
const SKILL_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExpertFailure(value: Record<string, unknown>): boolean {
  if (value.ok !== false || !isRecord(value.error)) return false
  const { code, message } = value.error
  return typeof code === 'string' && EXPERT_ERROR_CODES.includes(code) && typeof message === 'string'
}

/** 派生请求只放行一个合法专家标识，多余字段直接拒绝。 */
export function isExpertDeriveRequest(value: unknown): value is ExpertDeriveRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'builtinId')) return false
  return isExpertId(value.builtinId)
}

export function isExpertDeleteRequest(value: unknown): value is ExpertDeleteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'expertId')) return false
  return isExpertId(value.expertId)
}

export function isExpertDeriveResult(value: unknown): value is ExpertDeriveResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isRecord(value.data) && isExpertId(value.data.expertId)
}

export function isExpertDeleteResult(value: unknown): value is ExpertDeleteResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isRecord(value.data) && isExpertId(value.data.expertId)
}

export function isFastModeExclusionsResult(value: unknown): value is FastModeExclusionsResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  return Array.isArray(value.data.skillIds) && value.data.skillIds.every(item => typeof item === 'string')
}

/** 单个技能引用：形状与技能目录标识同源，但允许空串表示没有引用。 */
export function isSkillReference(value: unknown): value is string {
  return typeof value === 'string' && SKILL_REFERENCE.test(value)
}

/** MCP 服务器名与技能标识同一套字符规则；渲染进程与主进程共用这一份判定。 */
export function isMcpServerReference(value: unknown): value is string {
  return typeof value === 'string' && SKILL_REFERENCE.test(value)
}

function isCapabilityMode(value: unknown): value is ExpertCapabilityMode {
  return value === 'inherit' || value === 'only'
}

/** 一组引用：数量在限制内且每个写法合法；同名重复不在这里判，保存时按原顺序去重。 */
function isReferenceList(value: unknown, max: number, check: (item: unknown) => item is string): value is readonly string[] {
  return Array.isArray(value) && value.length <= max && value.every(check)
}

/** 显示名称与简介都会写进声明段，换行与首尾空白会破坏 `key: value` 结构，这里一并拒绝。 */
function isSingleLineText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed !== '' && trimmed.length <= maxLength && !/[\r\n]/.test(trimmed)
}

export function isExpertReadRequest(value: unknown): value is ExpertReadRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'expertId')) return false
  return isExpertId(value.expertId)
}

/** 保存请求：新建时 `expertId` 必须是 `null`，更新时必须是合法标识；正文不允许为空。 */
export function isExpertSaveRequest(value: unknown): value is ExpertSaveRequest {
  if (!isRecord(value)) return false
  const allowed = [
    'expertId', 'displayName', 'summary', 'skillIds', 'skillsMode', 'skillAddIds', 'skillRemoveIds',
    'mcpMode', 'mcpServerIds', 'mcpAddIds', 'mcpRemoveIds', 'body'
  ]
  if (Object.keys(value).some(key => !allowed.includes(key))) return false
  if (value.expertId !== null && !isExpertId(value.expertId)) return false
  if (!isSingleLineText(value.displayName, MAX_EXPERT_DISPLAY_NAME_LENGTH)) return false
  if (!isSingleLineText(value.summary, MAX_EXPERT_SUMMARY_LENGTH)) return false
  if (typeof value.body !== 'string' || value.body.trim() === '') return false
  return isCapabilityMode(value.skillsMode)
    && isCapabilityMode(value.mcpMode)
    && isReferenceList(value.skillIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(value.skillAddIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(value.skillRemoveIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(value.mcpServerIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
    && isReferenceList(value.mcpAddIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
    && isReferenceList(value.mcpRemoveIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
}

export function isExpertEditableDefinitionResult(value: unknown): value is ExpertReadResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  return isExpertId(data.id)
    && typeof data.displayName === 'string'
    && typeof data.summary === 'string'
    && typeof data.body === 'string'
    && (data.derivedFrom === null || isExpertId(data.derivedFrom))
    && isCapabilityMode(data.skillsMode)
    && isCapabilityMode(data.mcpMode)
    && isReferenceList(data.skillIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(data.skillAddIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(data.skillRemoveIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(data.mcpServerIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
    && isReferenceList(data.mcpAddIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
    && isReferenceList(data.mcpRemoveIds, MAX_EXPERT_MCP_REFS, isMcpServerReference)
}

export function isExpertSaveResult(value: unknown): value is ExpertSaveResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  return isExpertId(data.expertId)
    && typeof data.truncated === 'boolean'
    && isReferenceList(data.unavailableSkillIds, MAX_EXPERT_SKILL_REFS, isSkillReference)
    && isReferenceList(data.unavailableMcpServers, MAX_EXPERT_MCP_REFS, isMcpServerReference)
}

/** 默认基线：两个维度各自是 `null`（不限制）或合法的引用列表。 */
export function isExpertCapabilityDefaults(value: unknown): value is ExpertCapabilityDefaults {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'skills' && key !== 'mcpServers')) return false
  const skillsOk = value.skills === null
    || isReferenceList(value.skills, MAX_EXPERT_DEFAULTS_ENTRIES, isSkillReference)
  const mcpOk = value.mcpServers === null
    || isReferenceList(value.mcpServers, MAX_EXPERT_DEFAULTS_ENTRIES, isMcpServerReference)
  return skillsOk && mcpOk
}

export function isExpertCapabilitiesResult(value: unknown): value is ExpertCapabilitiesResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  if (!Array.isArray(data.skills) || !Array.isArray(data.mcpServers)) return false
  if (!isExpertCapabilityDefaults(data.defaults)) return false
  const skillsOk = data.skills.every(item => isRecord(item) && isSkillReference(item.id)
    && (item.source === 'builtin' || item.source === 'shared'))
  const mcpOk = data.mcpServers.every(item => isRecord(item) && isMcpServerReference(item.name)
    && (item.scope === 'global' || item.scope === 'project') && typeof item.enabled === 'boolean')
  return skillsOk && mcpOk
}

export function isExpertSaveDefaultsRequest(value: unknown): value is ExpertSaveDefaultsRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'skills' && key !== 'mcpServers')) return false
  return isExpertCapabilityDefaults(value)
}

export function isExpertSaveDefaultsResult(value: unknown): value is ExpertSaveDefaultsResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isExpertCapabilityDefaults(value.data)
}
