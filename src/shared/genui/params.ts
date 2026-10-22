/** 生成式界面的可调参数：数值、选项、开关与文本四类，取值、显隐条件与可见性判定。 */

/** 参数公共字段：标识、展示标签、可选说明、可选分组与可选显示条件。 */
interface GenuiParamBase {
  readonly id: string
  readonly label: string
  readonly description?: string
  /** 分组标题：声明顺序上相邻且组名相同的参数会归到同一个带标题的区块。 */
  readonly group?: string
  /** 显示条件：只在另一个参数取到指定值时显示。 */
  readonly visibleWhen?: GenuiParamCondition
}

/**
 * 参数的显示条件：目标参数取到 `equals` 时才显示自己。
 *
 * 只支持单值相等，不做表达式、不做数值比较：区间与组合条件会把「受限求值」的风险重新引进来，
 * 而真实场景（选了 TTL 才显示超时秒数、开了压缩才显示级别）用单值相等就能表达。
 * 目标只能是 select 或 toggle：这两类的取值集合在解析期就已知，`equals` 才能被校验。
 * 目标自身不得再声明条件（单层依赖）：环由构造排除，不需要图分析。
 *
 * 条件不满足时参数仍会随提交带出去，但会标注「条件未满足，未生效」：
 * 静默省略会让模型以为自己声明的参数丢了，而保留取值又能让用户切回去时状态还在。
 */
export interface GenuiParamCondition {
  readonly id: string
  readonly equals: string | boolean
}

/** 数值参数：滑杆调节，`default` 必须落在区间内。 */
export interface GenuiNumberParam extends GenuiParamBase {
  readonly type: 'number'
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly default: number
  readonly unit?: string
}

/** select 参数的一个选项。 */
export interface GenuiSelectOption {
  readonly value: string
  readonly label: string
}

/** 枚举参数：`default` 必须是已声明选项的 value。 */
export interface GenuiSelectParam extends GenuiParamBase {
  readonly type: 'select'
  readonly options: readonly GenuiSelectOption[]
  readonly default: string
}

/** 布尔参数。 */
export interface GenuiToggleParam extends GenuiParamBase {
  readonly type: 'toggle'
  readonly default: boolean
}

/**
 * 单行文本参数：项目名、备注这类自由输入。
 * 协议里 `default` 可省略（省略即空串），因为文本参数的常态就是留空由用户填写；
 * 解析后统一落成字符串，内部保持「每个参数都有默认值」这一不变量。
 */
export interface GenuiTextParam extends GenuiParamBase {
  readonly type: 'text'
  readonly default: string
  readonly placeholder?: string
}

/** 参数联合；新增类型必须同时补解析、渲染与提交格式化三处。 */
export type GenuiParam = GenuiNumberParam | GenuiSelectParam | GenuiToggleParam | GenuiTextParam

/** 参数的当前取值；类型与参数类型一一对应。 */
export type GenuiParamValue = number | string | boolean

/**
 * 参数在当前取值下是否应当显示。
 *
 * 放在 shared 而不是渲染端，是因为渲染（控件）、提交（组装消息）、复制为 Markdown 与扩展层的
 * 交付检查必须看同一份判断：各写一份必然漂移，而漂移的后果是「界面上看不见的参数被静默当成生效值」。
 * 无 `visibleWhen` 的参数恒为真；条件目标缺失时也按可见处理——解析期已经保证目标存在，
 * 走到这里的缺失只可能是历史文档或调用方传了半份取值，此时宁可多显示一个控件。
 */
export function isGenuiParamVisible(
  param: GenuiParam,
  values: Readonly<Record<string, GenuiParamValue>>
): boolean {
  const condition = param.visibleWhen
  if (condition === undefined) return true
  const current = values[condition.id]
  return current !== undefined && current === condition.equals
}
