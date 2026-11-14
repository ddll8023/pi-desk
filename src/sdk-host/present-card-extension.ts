/**
 * 会话内卡片工具：模型提交一份结构化卡片载荷，由渲染层按随包枚举渲染固定外壳。
 *
 * 模型只能选卡片类型与动作白名单里的 ID，不能描述布局、样式或可执行内容；载荷在这里先过
 * 一遍共享契约的解析器，形状或枚举不符就直接拒绝，不产出半成品卡片。工具只负责递交，
 * 不写盘也不改清单——按钮的落点由渲染层转发到既有业务通道（如 `desktop:expert-save`）。
 *
 * 交给模型的只有一句结论，正文与字段只放进 `details.card` 供界面展示，
 * 因此长正文不会在上下文里重复出现（边界见 docs/present-card-design.md）。
 */
import { Type } from '@earendil-works/pi-ai'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  PRESENT_CARD_ACTIONS, PRESENT_CARD_LIMITS, PRESENT_CARD_TYPES, parsePresentCardView
} from '../shared/present-card-view'
import type { PresentCardActionId, PresentCardType, PresentCardView } from '../shared/present-card-view'

const TOOL_NAME = 'present_card'

/** 一次工具调用的参数形状；与注册时给模型的 schema 一一对应。 */
interface CardParams {
  readonly card_type: PresentCardType
  readonly title: string
  readonly subtitle?: string
  readonly fields?: readonly { readonly label: string; readonly value: string }[]
  readonly body?: string
  readonly primary_action_id: PresentCardActionId
  readonly primary_action_label: string
  readonly secondary_action_id?: PresentCardActionId
  readonly secondary_action_label?: string
}

/**
 * 由参数组装卡片并复用共享解析器校验；返回字符串表示拒绝原因。
 * 草案类型额外要求简介与正文：缺任一项的「专家定义」在主进程保存时也会被拒，提前拦下更省一轮往返。
 */
function buildCard(params: CardParams): PresentCardView | string {
  const subtitle = params.subtitle?.trim() === '' ? undefined : params.subtitle
  const body = params.body?.trim() === '' ? undefined : params.body
  if (params.card_type === 'draft') {
    if (subtitle === undefined) return '草案卡片需要 subtitle（一句话简介）。'
    if (body === undefined) return '草案卡片需要 body（正文）。'
  }
  if (params.secondary_action_id !== undefined && params.secondary_action_label === undefined) {
    return '给了次要动作 ID 时也要给次要动作文案。'
  }
  const candidate = {
    cardType: params.card_type,
    title: params.title,
    subtitle: subtitle ?? null,
    fields: params.fields ?? [],
    body: body ?? null,
    primaryAction: { id: params.primary_action_id, label: params.primary_action_label },
    secondaryAction: params.secondary_action_id === undefined
      ? null
      : {
          id: params.secondary_action_id,
          label: params.secondary_action_label ?? ''
        }
  }
  const parsed = parsePresentCardView(candidate)
  if (parsed === null) {
    return '载荷不符合卡片契约：检查类型与动作 ID 是否在枚举内、主次动作是否重复，以及各字段是否超长。'
  }
  return parsed
}

/** 工具结果：文本只给一句结论，卡片数据只走 `details.card`。 */
function result(text: string, card: PresentCardView | null): {
  content: Array<{ type: 'text'; text: string }>
  details: { card: PresentCardView | null }
} {
  return { content: [{ type: 'text', text }], details: { card } }
}

/** 卡片工具工厂：无外部依赖，装配时直接注册。 */
export function createPresentCardExtension(): ExtensionFactory {
  return pi => {
    pi.registerTool({
      name: TOOL_NAME,
      label: '会话内卡片',
      description: '把需要用户点一下才落地的成果做成一张固定外壳卡片：只提交卡片类型、纯文本字段与动作 ID，界面按随包枚举渲染，不接受布局与样式描述。'
        + '卡片上的按钮由产品已登记的动作执行，例如把专家定义草案保存成自定义专家。',
      promptSnippet: '把可落盘的成果做成带按钮的卡片',
      promptGuidelines: [
        '只在成果需要用户点一下才落地时使用（典型是专家定义草案）：普通说明、进度汇报与追问继续用文本。',
        `card_type 目前只有 draft，且必须有 title、subtitle 与 body；fields 只放需要展示的说明行，不放正文。`,
        '动作只能取白名单 ID：expert.save 保存为自定义专家，copy.text 复制正文到剪贴板；不要按文案自行发明动作，也不要声称按钮会执行未登记的操作。',
        'body 不进入工具结果文本，长正文不受上下文成本影响，但仍受长度上限约束；超过上限整张卡片会被拒绝而不是截断。',
        '不要用它提交代码、命令、凭据或链接：卡片只承载纯文本与已登记动作。',
        '卡片放出去后等用户点击即可，不要再把同一份正文重复输出成对话文本。'
      ],
      exposure: 'model-only',
      parameters: Type.Object({
        card_type: Type.Union(PRESENT_CARD_TYPES.map(type => Type.Literal(type)),
          { description: '卡片类型；目前只有 draft（草案）' }),
        title: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.title,
          description: '卡片标题；草案类型下即专家显示名称' }),
        subtitle: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.subtitle,
          description: '一句话说明；草案类型下即专家简介，必填' })),
        fields: Type.Optional(Type.Array(Type.Object({
          label: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.fieldLabel }),
          value: Type.String({ maxLength: PRESENT_CARD_LIMITS.fieldValue })
        }), { maxItems: PRESENT_CARD_LIMITS.fields, description: '字段行，只放说明，不放正文' })),
        body: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.body,
          description: '卡片正文；草案类型下即专家定义正文，必填' })),
        primary_action_id: Type.Union(PRESENT_CARD_ACTIONS.map(action => Type.Literal(action)),
          { description: '主按钮动作 ID' }),
        primary_action_label: Type.String({ minLength: 1, maxLength: PRESENT_CARD_LIMITS.actionLabel,
          description: '主按钮文案' }),
        secondary_action_id: Type.Optional(Type.Union(PRESENT_CARD_ACTIONS.map(action => Type.Literal(action)),
          { description: '次按钮动作 ID；省略即没有次按钮' })),
        secondary_action_label: Type.Optional(Type.String({ maxLength: PRESENT_CARD_LIMITS.actionLabel,
          description: '次按钮文案；给了次按钮动作 ID 时必填' }))
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        const card = buildCard(params)
        if (typeof card === 'string') return result(`卡片未生成：${card}`, null)
        return result(`已在对话中放置卡片「${card.title}」；等用户点击卡片上的按钮，不要重复输出卡片正文。`, card)
      }
    })
  }
}
