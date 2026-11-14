/**
 * 会话内卡片视图：`present_card` 工具在 `details.card` 里交付的结构化载荷。
 *
 * 模型只能在宿主枚举里选卡片类型与动作，字段一律是纯文本与有界列表；这里同时是宿主投影与
 * 渲染层校验的唯一形状来源——形状或枚举不符即返回 null，由界面降级成普通工具结果，
 * 不猜造缺失字段，也不允许模型描述布局、样式或可执行内容（边界见 docs/present-card-design.md）。
 */

/** 卡片类型：首期只有「草案」，新增类型前必须确认它有唯一动作落点。 */
export const PRESENT_CARD_TYPES = ['draft'] as const

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
  actionLabel: 24
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

/** 一份卡片载荷；`body` 只在界面展示，不进入模型可见的工具结果文本。 */
export interface PresentCardView {
  readonly cardType: PresentCardType
  readonly title: string
  readonly subtitle: string | null
  readonly fields: readonly PresentCardField[]
  readonly body: string | null
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
  const { cardType, title, subtitle, fields, body, primaryAction, secondaryAction } = value
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
    primaryAction: parsedPrimary,
    secondaryAction: parsedSecondary
  }
}

/** 跨进程校验入口：只判断形状，不复制对象。 */
export function isPresentCardView(value: unknown): value is PresentCardView {
  return parsePresentCardView(value) !== null
}
