/**
 * 专家资源管理（设置页）的固定通道、请求与结果类型及跨进程响应校验。
 *
 * 管六件事：「把内置专家派生成本地可编辑副本」「读取与保存专家定义（含覆盖内置）」
 * 「删除自定义专家或覆盖定义」「快速模式会剔除哪些用户级技能」
 * 「能力候选（技能、全局 MCP 服务器、工具）」「默认能力基线」；
 * 专家清单与加载诊断复用会话域的 `desktop:session-experts`，不在这里复制第二份读取。
 * 错误码独立成族：写盘失败、定义不合法与清单读取失败是不同故障，页面据此分开提示。
 */
import { isExpertId } from './session-api'
import { isExpertCapabilityMode } from './expert-capability'
import type { ExpertCapabilityDefaults, ExpertCapabilityFields } from './expert-capability'

// 契约单一来源在 expert-capability；这里转出默认能力基线类型，供渲染层组件按本模块导入。
export type { ExpertCapabilityDefaults }

/** 把内置专家复制成自定义目录下的派生副本；副本立即出现在清单里。 */
export const EXPERTS_DERIVE_CHANNEL = 'desktop:expert-derive'
/** 删除一份自定义专家定义；删掉覆盖内置的那一份即恢复默认，随包文件不受影响。 */
export const EXPERTS_DELETE_CHANNEL = 'desktop:expert-delete'
/** 读取一份专家的声明与正文，供设置页编辑；自定义定义优先，没有时回落到同标识的内置定义。 */
export const EXPERTS_READ_CHANNEL = 'desktop:expert-read'
/** 新建或保存一份专家定义；`expertId` 为空表示新建，与内置同标识时写一份覆盖定义。 */
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
/**
 * 默认能力基线的条目上限：基线描述「默认可用范围」，可能覆盖全部候选，
 * 写入时按此截断。单个专家的技能、MCP 与工具引用不设数量上限。
 */
export const MAX_EXPERT_DEFAULTS_ENTRIES = 64

/** 技能候选：来源区分随包、产品自有目录与共享目录技能，页面按来源标注。 */
export interface ExpertSkillCandidate {
  readonly id: string
  readonly source: 'builtin' | 'product' | 'shared'
}

/** MCP 服务器候选：`scope` 说明它来自全局还是项目配置，项目项只在受信项目里生效。 */
export interface ExpertMcpCandidate {
  readonly name: string
  readonly scope: 'global' | 'project'
  readonly enabled: boolean
}

/**
 * 工具候选：名称与用途来自随包清单的工具声明。
 * `required` 是受保护标记：技能门禁、待办清单与记忆组不能被专家范围排除，界面据它禁用取消。
 */
export interface ExpertToolCandidate {
  readonly name: string
  readonly summary: string
  readonly required: boolean
}

/** 能力候选与当前基线一起返回：页面一次拿到勾选项与继承源，不用再读一次配置。 */
export interface ExpertCapabilities {
  readonly skills: readonly ExpertSkillCandidate[]
  readonly mcpServers: readonly ExpertMcpCandidate[]
  readonly tools: readonly ExpertToolCandidate[]
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

/** 编辑对话框需要的一份专家定义：声明字段与正文一起返回，只在设置页使用；自定义定义优先，回落到内置时形状相同。 */
export interface ExpertEditableDefinition extends ExpertCapabilityFields {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  /** 写入范围：`null` 表示不限制，空数组表示只读，否则是允许写入的目录或文件。 */
  readonly writeScope: readonly string[] | null
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
 * 保存请求：`expertId` 为 `null` 表示新建（标识由主进程分配），否则更新该标识的专家定义，
 * 与内置同标识时写成一份覆盖定义。能力字段语义见 `ExpertCapabilityFields`；不可用引用由主进程在结果里回报，不拦保存。
 */
export interface ExpertSaveRequest extends ExpertCapabilityFields {
  readonly expertId: string | null
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  /** 写入范围：与读取同一口径，`null` 不限制、空数组只读。 */
  readonly writeScope: readonly string[] | null
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

/** 保存基线的请求：三个维度都用 `null` 表示不限制。 */
export interface ExpertSaveDefaultsRequest {
  readonly skills: readonly string[] | null
  readonly mcpServers: readonly string[] | null
  readonly tools: readonly string[] | null
}

export type ExpertSaveDefaultsResult =
  | { readonly ok: true; readonly data: ExpertCapabilityDefaults }
  | { readonly ok: false; readonly error: ExpertError }

export interface ExpertApi {
  /** 派生一份内置专家；返回新副本的标识，同名占用时由主进程顺延编号。 */
  readonly deriveExpert: (request: ExpertDeriveRequest) => Promise<ExpertDeriveResult>
  /** 删除一份自定义专家；覆盖项删除即恢复内置默认，随包定义与仍带其他文件的目录会被拒绝。 */
  readonly deleteExpert: (request: ExpertDeleteRequest) => Promise<ExpertDeleteResult>
  /** 读取一份专家定义的声明与正文，供编辑对话框回填；自定义定义优先，没有时回落到同标识的内置定义。 */
  readonly readExpertDefinition: (request: ExpertReadRequest) => Promise<ExpertReadResult>
  /** 新建或保存专家定义（内置标识写成覆盖定义）；保存成功后清单立即反映结果。 */
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

/** 工具名允许下划线（`tool_search`、`memory_read`），与专家标识的连字符规则不同。 */
export function isToolReference(value: unknown): value is string {
  return typeof value === 'string' && SKILL_REFERENCE.test(value)
}

/**
 * 一组引用：每个写法都合法，传了上限时还要在数量内；同名重复不在这里判，保存时按原顺序去重。
 * 专家的技能、MCP 与工具范围不设数量上限，只有默认能力基线按 `MAX_EXPERT_DEFAULTS_ENTRIES` 截断。
 */
function isReferenceList(
  value: unknown,
  check: (item: unknown) => item is string,
  max?: number
): value is readonly string[] {
  if (!Array.isArray(value) || !value.every(check)) return false
  return max === undefined || value.length <= max
}

/** 写入范围的项数上限与单条长度上限：一份声明会进记录与提示，条数过多反而难以读懂。 */
export const MAX_EXPERT_WRITE_SCOPE_ITEMS = 8
export const MAX_EXPERT_WRITE_SCOPE_ENTRY = 240

/**
 * 写入范围项归一化：项目内相对路径，目录以 `/` 结尾。
 * 绝对路径、盘符与上一级跳转一律不合法，避免一条手写声明把范围指到项目之外。
 * 返回 `null` 表示写法不合法，标量时的调用方据此拒绝或忽略该项。
 */
export function normalizeExpertWriteScopeEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/')
  if (raw === '' || raw.length > MAX_EXPERT_WRITE_SCOPE_ENTRY) return null
  const directory = raw.endsWith('/')
  const body = directory ? raw.replace(/\/+$/, '') : raw
  if (body === '' || body.startsWith('/') || /^[A-Za-z]:/.test(body)) return null
  const segments = body.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return directory ? `${body}/` : body
}

/** 单条写入范围判定；渲染层与主进程共用这一份，不在两边各写一套路径规则。 */
export function isExpertWriteScopeEntry(value: unknown): value is string {
  return normalizeExpertWriteScopeEntry(value) !== null
}

/** 整份写入范围：`null` 表示不限制，空数组表示只读；两种空语义不能合并。 */
export function isExpertWriteScope(value: unknown): value is readonly string[] | null {
  if (value === null) return true
  if (!Array.isArray(value) || value.length > MAX_EXPERT_WRITE_SCOPE_ITEMS) return false
  return value.every(item => isExpertWriteScopeEntry(item))
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
    'mcpMode', 'mcpServerIds', 'mcpAddIds', 'mcpRemoveIds',
    'toolsMode', 'toolIds', 'toolAddIds', 'toolRemoveIds', 'writeScope', 'body'
  ]
  if (Object.keys(value).some(key => !allowed.includes(key))) return false
  if (value.expertId !== null && !isExpertId(value.expertId)) return false
  if (!isSingleLineText(value.displayName, MAX_EXPERT_DISPLAY_NAME_LENGTH)) return false
  if (!isSingleLineText(value.summary, MAX_EXPERT_SUMMARY_LENGTH)) return false
  if (typeof value.body !== 'string' || value.body.trim() === '') return false
  return isExpertCapabilityMode(value.skillsMode)
    && isExpertCapabilityMode(value.mcpMode)
    && isExpertCapabilityMode(value.toolsMode)
    && isReferenceList(value.skillIds, isSkillReference)
    && isReferenceList(value.skillAddIds, isSkillReference)
    && isReferenceList(value.skillRemoveIds, isSkillReference)
    && isReferenceList(value.mcpServerIds, isMcpServerReference)
    && isReferenceList(value.mcpAddIds, isMcpServerReference)
    && isReferenceList(value.mcpRemoveIds, isMcpServerReference)
    && isReferenceList(value.toolIds, isToolReference)
    && isReferenceList(value.toolAddIds, isToolReference)
    && isReferenceList(value.toolRemoveIds, isToolReference)
    && isExpertWriteScope(value.writeScope)
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
    && isExpertCapabilityMode(data.skillsMode)
    && isExpertCapabilityMode(data.mcpMode)
    && isExpertCapabilityMode(data.toolsMode)
    && isReferenceList(data.skillIds, isSkillReference)
    && isReferenceList(data.skillAddIds, isSkillReference)
    && isReferenceList(data.skillRemoveIds, isSkillReference)
    && isReferenceList(data.mcpServerIds, isMcpServerReference)
    && isReferenceList(data.mcpAddIds, isMcpServerReference)
    && isReferenceList(data.mcpRemoveIds, isMcpServerReference)
    && isReferenceList(data.toolIds, isToolReference)
    && isReferenceList(data.toolAddIds, isToolReference)
    && isReferenceList(data.toolRemoveIds, isToolReference)
    && isExpertWriteScope(data.writeScope)
}

export function isExpertSaveResult(value: unknown): value is ExpertSaveResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  return isExpertId(data.expertId)
    && typeof data.truncated === 'boolean'
    && isReferenceList(data.unavailableSkillIds, isSkillReference)
    && isReferenceList(data.unavailableMcpServers, isMcpServerReference)
}

/** 默认基线：三个维度各自是 `null`（不限制）或合法的引用列表。 */
export function isExpertCapabilityDefaults(value: unknown): value is ExpertCapabilityDefaults {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'skills' && key !== 'mcpServers' && key !== 'tools')) return false
  const skillsOk = value.skills === null
    || isReferenceList(value.skills, isSkillReference, MAX_EXPERT_DEFAULTS_ENTRIES)
  const mcpOk = value.mcpServers === null
    || isReferenceList(value.mcpServers, isMcpServerReference, MAX_EXPERT_DEFAULTS_ENTRIES)
  const toolsOk = value.tools === null
    || isReferenceList(value.tools, isToolReference, MAX_EXPERT_DEFAULTS_ENTRIES)
  return skillsOk && mcpOk && toolsOk
}

export function isExpertCapabilitiesResult(value: unknown): value is ExpertCapabilitiesResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  if (!Array.isArray(data.skills) || !Array.isArray(data.mcpServers) || !Array.isArray(data.tools)) return false
  if (!isExpertCapabilityDefaults(data.defaults)) return false
  const skillsOk = data.skills.every(item => isRecord(item) && isSkillReference(item.id)
    && (item.source === 'builtin' || item.source === 'product' || item.source === 'shared'))
  const mcpOk = data.mcpServers.every(item => isRecord(item) && isMcpServerReference(item.name)
    && (item.scope === 'global' || item.scope === 'project') && typeof item.enabled === 'boolean')
  const toolsOk = data.tools.every(item => isRecord(item) && isToolReference(item.name)
    && typeof item.summary === 'string' && typeof item.required === 'boolean')
  return skillsOk && mcpOk && toolsOk
}

export function isExpertSaveDefaultsRequest(value: unknown): value is ExpertSaveDefaultsRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => key !== 'skills' && key !== 'mcpServers' && key !== 'tools')) return false
  return isExpertCapabilityDefaults(value)
}

export function isExpertSaveDefaultsResult(value: unknown): value is ExpertSaveDefaultsResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isExpertFailure(value)
  return value.ok === true && isExpertCapabilityDefaults(value.data)
}
