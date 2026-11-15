/**
 * 会话内卡片视图：`present_card` 工具在 `details.card` 里交付的结构化载荷。
 *
 * 模型只能在宿主枚举里选卡片类型与动作，字段一律是纯文本与有界列表；这里同时是宿主投影与
 * 渲染层校验的唯一形状来源——形状或枚举不符即返回 null，由界面降级成普通工具结果，
 * 不猜造缺失字段，也不允许模型描述布局、样式或可执行内容（边界见 docs/present-card-design.md）。
 */
import { isExpertCapabilityMode } from './expert-capability'
import type { ExpertCapabilityMode } from './expert-capability'

/** 卡片类型：类型即场景契约，新增类型前必须确认它有唯一动作落点。 */
export const PRESENT_CARD_TYPES = ['expert.draft', 'session.summary'] as const

export type PresentCardType = typeof PRESENT_CARD_TYPES[number]

/** 动作白名单：ID 绑定到既有业务通道，卡片只按 ID 转发，不自行判断能否写入。 */
export const PRESENT_CARD_ACTIONS = ['expert.save', 'copy.text'] as const

export type PresentCardActionId = typeof PRESENT_CARD_ACTIONS[number]

/** 数量与长度上限：只约束载荷体积，超限整份判为不合规，不静默截断成半张卡片。 */
export const PRESENT_CARD_LIMITS = {
  title: 120,
  subtitle: 240,
  fields: 12,
  fieldLabel: 40,
  fieldValue: 400,
  body: 8_000,
  actionLabel: 24,
  /** 能力段每个维度的名单长度：只防载荷无界，与专家引用数量不设上限无关。 */
  capabilityIds: 64,
  /** 交付汇总文件段三组的合计条数上限：清单是给用户点选的，不是完整改动流水。 */
  summaryFiles: 40,
  /** 交付汇总单条相对路径的长度上限：项目内路径远短于这个值，超长即明显不是相对路径。 */
  summaryPath: 512
} as const

/** 一条字段行：label 与 value 都按纯文本渲染，不解析 Markdown，也不当作链接。 */
export interface PresentCardField {
  readonly label: string
  readonly value: string
}

/** 卡片动作：`id` 决定落点，`label` 只是按钮文案。 */
export interface PresentCardAction {
  readonly id: PresentCardActionId
  readonly label: string
}

/**
 * 草案的能力范围：与专家定义的声明同构，`inherit` 表示在默认基线上加减，`only` 表示名单即白名单。
 * 名单是模型建议的勾选集合，页面在此基础上让用户改；为 `null` 时按「继承默认能力」处理。
 */
export interface PresentCardCapability {
  readonly skillsMode: ExpertCapabilityMode
  readonly skillIds: readonly string[]
  readonly mcpMode: ExpertCapabilityMode
  readonly mcpServerIds: readonly string[]
  readonly toolsMode: ExpertCapabilityMode
  readonly toolIds: readonly string[]
}

/**
 * 交付汇总的文件段：按交付角色分三组的条目相对路径；三组必需（可为空数组），组内去重保序。
 * 路径只是数据，界面按纯文本渲染、不当链接；「定位」是类型段的宿主固定行为，不进动作白名单。
 */
export interface PresentCardFiles {
  readonly changed: readonly string[]
  readonly deleted: readonly string[]
  readonly affected: readonly string[]
}

/** 一份卡片载荷；`body` 与 `files` 只在界面展示，不进入模型可见的工具结果文本。 */
export interface PresentCardView {
  readonly cardType: PresentCardType
  readonly title: string
  readonly subtitle: string | null
  readonly fields: readonly PresentCardField[]
  readonly body: string | null
  readonly capability: PresentCardCapability | null
  readonly files: PresentCardFiles | null
  readonly primaryAction: PresentCardAction
  readonly secondaryAction: PresentCardAction | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有界非空文本：两个校验维度合一，避免调用处逐个拼条件漏掉一侧。 */
function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength
}

/** 有界可空文本：`null` 表示没有该段内容，空串按缺省处理。 */
function isNullableText(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxLength)
}

function parseField(value: unknown): PresentCardField | null {
  if (!isRecord(value)) return null
  const { label, value: fieldValue } = value
  if (!isText(label, PRESENT_CARD_LIMITS.fieldLabel)) return null
  if (!isNullableText(fieldValue, PRESENT_CARD_LIMITS.fieldValue) || fieldValue === null) return null
  return { label, value: fieldValue }
}

/** 能力名单里的一项：与专家标识、技能、MCP 服务器名同一套字符规则。 */
function isCapabilityId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}

function parseIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > PRESENT_CARD_LIMITS.capabilityIds) return null
  const ids: string[] = []
  for (const item of value) {
    if (!isCapabilityId(item)) return null
    if (!ids.includes(item)) ids.push(item)
  }
  return ids
}

/**
 * 项目内相对路径：`/` 分隔，不含 `\`，分段后无空段与 `.`／`..` 段。
 * 定位是否可达仍由主进程解析判定（realpath 与项目内包含性），这里只拒绝形状明显不对的值。
 */
function isRelativeProjectPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PRESENT_CARD_LIMITS.summaryPath) return false
  if (value.includes('\\') || value.startsWith('/')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** 文件段的一组路径：组内去重保序；条数在 parseFiles 里按三组合计校验。 */
function parsePathList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  const paths: string[] = []
  for (const item of value) {
    if (!isRelativeProjectPath(item)) return null
    if (!paths.includes(item)) paths.push(item)
  }
  return paths
}

/**
 * 文件段：缺省为 null（不带文件段的类型与旧卡片按没有该段处理）；给了就必须三组齐全且都是路径数组。
 * 三组合计超上限整份判不合规，不静默截断——清单少列由模型在文本里说明，界面不替它藏。
 */
function parseFiles(value: unknown): PresentCardFiles | null | 'invalid' {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return 'invalid'
  const changed = parsePathList(value.changed)
  const deleted = parsePathList(value.deleted)
  const affected = parsePathList(value.affected)
  if (changed === null || deleted === null || affected === null) return 'invalid'
  if (changed.length + deleted.length + affected.length > PRESENT_CARD_LIMITS.summaryFiles) return 'invalid'
  return { changed, deleted, affected }
}

/**
 * 能力段：缺省为 null（按继承基线处理）；给了就必须维度齐全且模式可识别。
 * 工具维度允许缺省：旧卡片没有这一段，按「继承默认」补齐，不因此把整张卡片判为不合规。
 */
function parseCapability(value: unknown): PresentCardCapability | null | 'invalid' {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) return 'invalid'
  const { skillsMode, skillIds, mcpMode, mcpServerIds } = value
  if (!isExpertCapabilityMode(skillsMode) || !isExpertCapabilityMode(mcpMode)) return 'invalid'
  const toolsMode = value.toolsMode ?? 'inherit'
  if (!isExpertCapabilityMode(toolsMode)) return 'invalid'
  const parsedSkills = parseIdList(skillIds)
  const parsedMcp = parseIdList(mcpServerIds)
  const parsedTools = parseIdList(value.toolIds ?? [])
  if (parsedSkills === null || parsedMcp === null || parsedTools === null) return 'invalid'
  return {
    skillsMode, skillIds: parsedSkills, mcpMode, mcpServerIds: parsedMcp,
    toolsMode, toolIds: parsedTools
  }
}

function parseAction(value: unknown): PresentCardAction | null {
  if (!isRecord(value)) return null
  const { id, label } = value
  if (typeof id !== 'string' || !(PRESENT_CARD_ACTIONS as readonly string[]).includes(id)) return null
  if (!isText(label, PRESENT_CARD_LIMITS.actionLabel)) return null
  return { id: id as PresentCardActionId, label }
}

/**
 * 校验并归一化一张卡片。
 * 动作重复（主次按钮指向同一落点）判为不合规：同一个按钮没必要出现两次，也让界面状态不至于分叉。
 */
export function parsePresentCardView(value: unknown): PresentCardView | null {
  if (!isRecord(value)) return null
  const { cardType, title, subtitle, fields, body, capability, files, primaryAction, secondaryAction } = value
  if (typeof cardType !== 'string' || !(PRESENT_CARD_TYPES as readonly string[]).includes(cardType)) return null
  if (!isText(title, PRESENT_CARD_LIMITS.title)) return null
  if (!isNullableText(subtitle, PRESENT_CARD_LIMITS.subtitle)) return null
  if (!Array.isArray(fields) || fields.length > PRESENT_CARD_LIMITS.fields) return null
  const parsedFields: PresentCardField[] = []
  for (const item of fields) {
    const field = parseField(item)
    if (field === null) return null
    parsedFields.push(field)
  }
  if (!isNullableText(body, PRESENT_CARD_LIMITS.body)) return null
  const parsedCapability = parseCapability(capability)
  if (parsedCapability === 'invalid') return null
  const parsedFiles = parseFiles(files)
  if (parsedFiles === 'invalid') return null
  const parsedPrimary = parseAction(primaryAction)
  if (parsedPrimary === null) return null
  const parsedSecondary = secondaryAction === null || secondaryAction === undefined ? null : parseAction(secondaryAction)
  if (secondaryAction !== null && secondaryAction !== undefined && parsedSecondary === null) return null
  if (parsedSecondary !== null && parsedSecondary.id === parsedPrimary.id) return null
  return {
    cardType: cardType as PresentCardType,
    title,
    subtitle: subtitle === '' ? null : subtitle,
    fields: parsedFields,
    body: body === '' ? null : body,
    capability: parsedCapability,
    files: parsedFiles,
    primaryAction: parsedPrimary,
    secondaryAction: parsedSecondary
  }
}

/** 跨进程校验入口：只判断形状，不复制对象。 */
export function isPresentCardView(value: unknown): value is PresentCardView {
  return parsePresentCardView(value) !== null
}
