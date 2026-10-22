/** 生成式界面的文档与载荷：文档与节点联合类型、解析、修复、说明生成、交付工具名及载荷头读取。 */

import { GENUI_CHART_KINDS, GENUI_DIAGRAM_KINDS, GENUI_MAX_CELL_CHARS, GENUI_MAX_CHART_LABEL_CHARS, GENUI_MAX_CHART_POINTS, GENUI_MAX_CHART_SERIES, GENUI_MAX_CHART_SERIES_NAME_CHARS, GENUI_MAX_CHART_TITLE_CHARS, GENUI_MAX_CIRCUIT_PARTS, GENUI_MAX_COLLAPSE_ITEMS, GENUI_MAX_COLUMNS, GENUI_MAX_DEPTH, GENUI_MAX_DIAGRAM_LABEL_CHARS, GENUI_MAX_DIAGRAM_NOTE_CHARS, GENUI_MAX_EXPLODED_PARTS, GENUI_MAX_GEARS, GENUI_MAX_GEAR_TEETH, GENUI_MAX_ISSUES, GENUI_MAX_LIST_ITEMS, GENUI_MAX_NODES, GENUI_MAX_PARAMS, GENUI_MAX_PARAM_DESCRIPTION_CHARS, GENUI_MAX_PARAM_GROUP_CHARS, GENUI_MAX_PARAM_LABEL_CHARS, GENUI_MAX_PARAM_OPTIONS, GENUI_MAX_PARAM_OPTION_CHARS, GENUI_MAX_PARAM_PLACEHOLDER_CHARS, GENUI_MAX_PARAM_TEXT_CHARS, GENUI_MAX_PARAM_UNIT_CHARS, GENUI_MAX_PIE_SLICES, GENUI_MAX_REPAIRS, GENUI_MAX_SECTION_LAYERS, GENUI_MAX_STEPS, GENUI_MAX_SUBMIT_LABEL_CHARS, GENUI_MAX_TABLE_COLUMNS, GENUI_MAX_TABLE_ROWS, GENUI_MAX_TABS, GENUI_MAX_TAB_LABEL_CHARS, GENUI_MAX_TEXT_CHARS, GENUI_MAX_TIMELINE_ITEMS, GENUI_MAX_TIMELINE_TIME_CHARS, GENUI_MAX_VECTORS, GENUI_MIN_CHART_POINTS, GENUI_MIN_CIRCUIT_PARTS, GENUI_MIN_COLLAPSE_ITEMS, GENUI_MIN_EXPLODED_PARTS, GENUI_MIN_GEARS, GENUI_MIN_GEAR_TEETH, GENUI_MIN_PARAM_OPTIONS, GENUI_MIN_SECTION_LAYERS, GENUI_MIN_TABS, GENUI_MIN_VECTORS, GENUI_PARAM_ID_PATTERN_SOURCE, GENUI_VERSION } from './limits'
import type { GenuiCardNode, GenuiCollapseItem, GenuiCollapseNode, GenuiControlsNode, GenuiListNode, GenuiMetricNode, GenuiRowNode, GenuiStepItem, GenuiStepsNode, GenuiTabItem, GenuiTableCell, GenuiTableColumn, GenuiTableNode, GenuiTableRow, GenuiTabsNode, GenuiTextNode, GenuiTextSize, GenuiTimelineItem, GenuiTimelineNode, GenuiTone } from './nodes'
import type { GenuiCircuitComponent, GenuiDiagramBinds, GenuiDiagramKind, GenuiDiagramNode, GenuiExplodedPart, GenuiGearSpec, GenuiSectionLayer, GenuiVectorSpec } from './diagram'
import type { GenuiChartNode, GenuiChartSeries } from './chart'
import type { GenuiParam, GenuiParamCondition, GenuiSelectOption } from './params'


const PARAM_ID_PATTERN = new RegExp(GENUI_PARAM_ID_PATTERN_SOURCE)

/** 一条校验诊断：`path` 是 JSON 路径，`reason` 是可直接执行的修正方向。 */
export interface GenuiIssue {
  readonly path: string
  readonly reason: string
}

/**
 * 一条自动修复记录：`path` 是被改动的位置，`note` 说明改成了什么。
 * 修复是可见的——它会写进工具摘要，用户与模型都能看出哪几处不是原始输入。
 */
export interface GenuiRepair {
  readonly path: string
  readonly note: string
}

/**
 * 文档校验结果：通过时给归一化后的文档，失败时给带路径的诊断。
 * 只有扩展层需要诊断（要告诉模型改哪一处）；投影层与渲染端仍用 `parseGenuiDocument` 的 null 语义。
 * `repairs` 只由 `explainGenuiDocumentWithRepairs` 填充，严格解析入口永远不带。
 */
export type GenuiParseResult =
  | { readonly ok: true; readonly document: GenuiDocument; readonly repairs?: readonly GenuiRepair[] }
  | {
    readonly ok: false
    readonly issues: readonly GenuiIssue[]
    /** 失败前已尝试的自动修复条数；大于 0 时说明这些错不是引用问题。 */
    readonly repairs?: readonly GenuiRepair[]
  }

/** 文档标识：小写 UUID v4，与工具结果一一对应，供后续轮次定位与局部修改。 */
const DOCUMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

const TONES: ReadonlySet<string> = new Set<GenuiTone>(['default', 'muted', 'accent', 'success', 'warning', 'danger'])

const TEXT_SIZES: ReadonlySet<string> = new Set<GenuiTextSize>(['small', 'body', 'large'])

/** 各类图示允许绑定的键；解析与自动修复共用同一份，避免校验与修复两处漂移。 */
const DIAGRAM_BIND_KEYS: Readonly<Record<GenuiDiagramKind, readonly (keyof GenuiDiagramBinds)[]>> = {
  exploded: ['spread'],
  gear: ['angle'],
  crank: ['angle'],
  vector: ['angle'],
  circuit: ['voltage'],
  // 剖面没有天然可调量：层厚是静态事实，不提供绑定。
  section: []
}

/** 按 kind 取允许的绑定键；未知 kind 返回 null，由调用方按不可处理对待。 */
function allowedBindsOf(kind: unknown): readonly (keyof GenuiDiagramBinds)[] | null {
  if (typeof kind !== 'string') return null
  return Object.hasOwn(DIAGRAM_BIND_KEYS, kind) ? DIAGRAM_BIND_KEYS[kind as GenuiDiagramKind] : null
}

/** 文档节点联合；新增类型必须同时补解析分支与渲染分支，否则解析即拒绝。 */
export type GenuiNode =
  | GenuiTextNode
  | GenuiListNode
  | GenuiMetricNode
  | GenuiTableNode
  | GenuiStepsNode
  | GenuiTimelineNode
  | GenuiCardNode
  | GenuiRowNode
  | GenuiCollapseNode
  | GenuiTabsNode
  | GenuiControlsNode
  | GenuiDiagramNode
  | GenuiChartNode

/** 一份完整界面文档。 */
export interface GenuiDocument {
  readonly version: typeof GENUI_VERSION
  readonly title: string
  /** 界面无法渲染时的可读替代文本；始终随文档保存，不依赖渲染端补齐。 */
  readonly fallback: string
  /** 可调参数；省略表示这份界面没有可提交的内容。 */
  readonly params?: readonly GenuiParam[]
  /** 提交按钮文案；省略时用渲染端的默认文案。 */
  readonly submitLabel?: string
  readonly nodes: readonly GenuiNode[]
}

/**
 * 工具结果里的 UI 载荷：随工具结果进入会话，天然跟随 fork / rewind / 树导航。
 * `revision` 由扩展层维护，用于后续轮次判断自己看到的是哪一版。
 */
export interface GenuiPayload {
  readonly version: number
  readonly documentId: string
  readonly revision: number
  readonly document: GenuiDocument
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空且不超长的字符串；空串按缺失处理，避免渲染出空壳节点。 */
function isText(value: unknown, maxChars = GENUI_MAX_TEXT_CHARS): value is string {
  return typeof value === 'string' && value !== '' && value.length <= maxChars
}

/** 可选文本字段：缺失或 undefined 都按未提供处理。 */
function optionalText(value: unknown, maxChars = GENUI_MAX_TEXT_CHARS): string | undefined | null {
  if (value === undefined) return undefined
  return isText(value, maxChars) ? value : null
}

/** 允许空串的字符串字段：文本参数的默认值常态是留空，不能走 `isText` 的非空约束。 */
function isTextOrEmpty(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value.length <= maxChars
}

function readTone(value: unknown): GenuiTone | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && TONES.has(value) ? (value as GenuiTone) : null
}

function readTextSize(value: unknown): GenuiTextSize | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && TEXT_SIZES.has(value) ? (value as GenuiTextSize) : null
}

/** 有限数字；NaN 与 Infinity 不是合法数值。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 解析计数上限内的正整数。 */
function readCount(value: unknown, max: number): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : null
}

/**
 * 一次解析的共享状态：节点计数、参数集合与诊断。
 * 所有失败都走 `fail` 而不是裸 `return null`，否则模型只能看到「未通过校验」而不知道改哪里。
 */
interface ParseContext {
  nodes: number
  /** 文档已声明的参数；控件组只能引用这些 id，图示绑定还要额外确认是数值参数。解析期会写入，读完即冻结语义。 */
  readonly declaredParams: Map<string, GenuiParam>
  /** 已被某个控件组引用的参数 id；文档级交叉校验用它找出未被渲染的参数。 */
  readonly usedParams: Set<string>
  readonly issues: GenuiIssue[]
}

/** 记一条诊断并返回 null；超过上限后不再追加，避免刷屏。 */
function fail(context: ParseContext, path: string, reason: string): null {
  if (context.issues.length < GENUI_MAX_ISSUES) context.issues.push({ path, reason })
  return null
}

/**
 * 解析单个参数；`id` 唯一性与数量上限由调用方 `parseParams` 负责。
 * 数值参数不校验 `step` 与区间的整除关系：非整除步长仍能滑到端点，不必因此拒掉整份文档。
 */
function parseParam(value: unknown, path: string, context: ParseContext): GenuiParam | null {
  if (!isRecord(value)) return fail(context, path, '必须是对象')
  const id = value.id
  const label = value.label
  if (typeof id !== 'string' || !PARAM_ID_PATTERN.test(id)) {
    return fail(context, `${path}.id`, '必须是小写字母开头、只含小写字母/数字/下划线的标识，如 capacity')
  }
  if (!isText(label, GENUI_MAX_PARAM_LABEL_CHARS)) {
    return fail(context, `${path}.label`, `必须是 1..${GENUI_MAX_PARAM_LABEL_CHARS} 字符的非空字符串`)
  }
  const description = optionalText(value.description, GENUI_MAX_PARAM_DESCRIPTION_CHARS)
  if (description === null) {
    return fail(context, `${path}.description`, `省略，或给 1..${GENUI_MAX_PARAM_DESCRIPTION_CHARS} 字符的字符串`)
  }
  const group = optionalText(value.group, GENUI_MAX_PARAM_GROUP_CHARS)
  if (group === null) {
    return fail(context, `${path}.group`, `省略，或给 1..${GENUI_MAX_PARAM_GROUP_CHARS} 字符的字符串`)
  }
  const visibleWhen = parseParamCondition(value.visibleWhen, `${path}.visibleWhen`, context)
  if (visibleWhen === null) return null
  const base = {
    id,
    label,
    ...(description === undefined ? {} : { description }),
    ...(group === undefined ? {} : { group }),
    ...(visibleWhen === undefined ? {} : { visibleWhen })
  }

  switch (value.type) {
    case 'number': {
      const min = value.min
      const max = value.max
      const fallback = value.default
      if (!isFiniteNumber(min) || !isFiniteNumber(max) || min >= max) {
        return fail(context, `${path}.min`, 'min 与 max 必须是有限数字且 min < max')
      }
      if (!isFiniteNumber(fallback) || fallback < min || fallback > max) {
        return fail(context, `${path}.default`, 'default 必须是有限数字且落在 [min, max] 内')
      }
      const step = value.step
      if (step !== undefined && (!isFiniteNumber(step) || step <= 0)) {
        return fail(context, `${path}.step`, '省略，或给大于 0 的有限数字')
      }
      const unit = optionalText(value.unit, GENUI_MAX_PARAM_UNIT_CHARS)
      if (unit === null) return fail(context, `${path}.unit`, `省略，或给 1..${GENUI_MAX_PARAM_UNIT_CHARS} 字符的字符串`)
      return {
        ...base,
        type: 'number',
        min,
        max,
        default: fallback,
        ...(step === undefined ? {} : { step }),
        ...(unit === undefined ? {} : { unit })
      }
    }
    case 'select': {
      if (!Array.isArray(value.options)) {
        return fail(context, `${path}.options`, '必须是选项数组，每项 {value,label}')
      }
      if (value.options.length < GENUI_MIN_PARAM_OPTIONS || value.options.length > GENUI_MAX_PARAM_OPTIONS) {
        return fail(
          context,
          `${path}.options`,
          `选项个数必须是 ${GENUI_MIN_PARAM_OPTIONS}..${GENUI_MAX_PARAM_OPTIONS}`
        )
      }
      const options: GenuiSelectOption[] = []
      const values = new Set<string>()
      for (const [index, option] of value.options.entries()) {
        const optionPath = `${path}.options[${index}]`
        if (!isRecord(option)) return fail(context, optionPath, '必须是 {value,label} 对象')
        const optionValue = option.value
        const optionLabel = option.label
        if (!isText(optionValue, GENUI_MAX_PARAM_OPTION_CHARS)) {
          return fail(context, `${optionPath}.value`, `必须是 1..${GENUI_MAX_PARAM_OPTION_CHARS} 字符的非空字符串`)
        }
        if (!isText(optionLabel, GENUI_MAX_PARAM_OPTION_CHARS)) {
          return fail(context, `${optionPath}.label`, `必须是 1..${GENUI_MAX_PARAM_OPTION_CHARS} 字符的非空字符串`)
        }
        // 值重复会让默认值指向不唯一的选项，因此整份拒绝。
        if (values.has(optionValue)) {
          return fail(context, `${optionPath}.value`, '选项 value 不能重复')
        }
        values.add(optionValue)
        options.push({ value: optionValue, label: optionLabel })
      }
      const fallback = value.default
      if (typeof fallback !== 'string' || !values.has(fallback)) {
        return fail(context, `${path}.default`, '必须是某个已声明选项的 value')
      }
      return { ...base, type: 'select', options, default: fallback }
    }
    case 'toggle': {
      if (typeof value.default !== 'boolean') return fail(context, `${path}.default`, '必须是布尔值')
      return { ...base, type: 'toggle', default: value.default }
    }
    case 'text': {
      // 省略 default 即空串：文本参数常态是留空，强制必填只会让模型编造一个占位默认值。
      const raw = value.default
      if (raw !== undefined && !isTextOrEmpty(raw, GENUI_MAX_PARAM_TEXT_CHARS)) {
        return fail(context, `${path}.default`, `省略（按空串处理），或给不超过 ${GENUI_MAX_PARAM_TEXT_CHARS} 字符的字符串`)
      }
      // 走到这里 raw 要么是合法字符串、要么被省略：统一落成字符串，保持「每个参数都有默认值」。
      const fallback = typeof raw === 'string' ? raw : ''
      const placeholder = optionalText(value.placeholder, GENUI_MAX_PARAM_PLACEHOLDER_CHARS)
      if (placeholder === null) {
        return fail(context, `${path}.placeholder`, `省略，或给 1..${GENUI_MAX_PARAM_PLACEHOLDER_CHARS} 字符的字符串`)
      }
      return {
        ...base,
        type: 'text',
        default: fallback,
        ...(placeholder === undefined ? {} : { placeholder })
      }
    }
    default:
      return fail(context, `${path}.type`, '参数 type 只能是 number、select、toggle 或 text')
  }
}

/**
 * 解析参数的显示条件；形状与自引用在这里校验，目标是否存在、目标类型与 `equals` 是否合法
 * 需要全量参数才能判断，因此交给解析完所有参数后的 `validateParamConditions`。
 * 自引用必须在这里拒：它是形状错误，与目标参数无关，放进后置校验会把顺序搞得很绕。
 */
function parseParamCondition(
  value: unknown,
  path: string,
  context: ParseContext
): GenuiParamCondition | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return fail(context, path, '省略，或给 {id, equals} 对象')
  const id = value.id
  if (typeof id !== 'string' || !PARAM_ID_PATTERN.test(id)) {
    return fail(context, `${path}.id`, '必须是小写字母开头、只含小写字母/数字/下划线的参数标识')
  }
  const equals = value.equals
  if (typeof equals !== 'string' && typeof equals !== 'boolean') {
    return fail(context, `${path}.equals`, '必须是字符串（select 选项 value）或布尔值（toggle）')
  }
  return { id, equals }
}

/**
 * 参数条件的全量校验：目标必须已声明且是 select / toggle，`equals` 必须落在目标的取值集合里，
 * 且目标自身不得声明条件（单层依赖）。
 * 放在参数全部解析完之后：这些判定都需要看到完整的参数表。
 */
function validateParamConditions(params: readonly GenuiParam[], context: ParseContext): boolean {
  const byId = new Map(params.map((param) => [param.id, param]))
  for (const [index, param] of params.entries()) {
    const condition = param.visibleWhen
    if (condition === undefined) continue
    const path = `params[${index}].visibleWhen`
    if (condition.id === param.id) {
      fail(context, `${path}.id`, '不能引用自己：显示条件只能指向另一个参数')
      return false
    }
    const target = byId.get(condition.id)
    if (target === undefined) {
      fail(context, `${path}.id`, `参数「${condition.id}」未在 document.params 中声明`)
      return false
    }
    if (target.type !== 'select' && target.type !== 'toggle') {
      fail(context, `${path}.id`, `只能由 select 或 toggle 参数控制显示，「${condition.id}」是 ${target.type}`)
      return false
    }
    if (target.visibleWhen !== undefined) {
      fail(
        context,
        `${path}.id`,
        `「${condition.id}」自己也有 visibleWhen，不支持多级依赖；请改成单层，或把条件合并到控制它的那个参数上`
      )
      return false
    }
    if (target.type === 'select') {
      const values = target.options.map((option) => option.value)
      if (typeof condition.equals !== 'string' || !values.includes(condition.equals)) {
        fail(context, `${path}.equals`, `必须是「${condition.id}」的选项 value：${values.join(' / ')}`)
        return false
      }
      continue
    }
    if (typeof condition.equals !== 'boolean') {
      fail(context, `${path}.equals`, `「${condition.id}」是 toggle，equals 必须是布尔值`)
      return false
    }
  }
  return true
}

/** 解析参数数组：数量、id 唯一性在这里收口；空数组按未声明处理，返回 null 让调用方整体拒绝。 */
function parseParams(value: readonly unknown[], path: string, context: ParseContext): GenuiParam[] | null {
  if (value.length === 0) return fail(context, path, '要么省略 params，要么至少声明一个参数')
  if (value.length > GENUI_MAX_PARAMS) return fail(context, path, `参数个数不能超过 ${GENUI_MAX_PARAMS}`)
  const params: GenuiParam[] = []
  const ids = new Set<string>()
  for (const [index, item] of value.entries()) {
    const param = parseParam(item, `${path}[${index}]`, context)
    if (param === null) return null
    if (ids.has(param.id)) return fail(context, `${path}[${index}].id`, `参数 id「${param.id}」重复`)
    ids.add(param.id)
    params.push(param)
  }
  return params
}

/**
 * 解析图示绑定：键必须是该 kind 允许的，目标必须是已声明的数值参数。
 * 绑定不会让参数免于被控件组引用，因此这里不碰 `usedParams`。
 */
function parseDiagramBinds(
  value: unknown,
  path: string,
  allowed: readonly (keyof GenuiDiagramBinds)[],
  context: ParseContext
): GenuiDiagramBinds | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return fail(context, path, '省略，或给 {angle?, spread?, voltage?}')
  // 允许列表为空时直接拒绝：剖面没有可绑定的量，逐键报错会输出「只支持 」这种残缺文案。
  if (allowed.length === 0) return fail(context, path, '这个图示不支持绑定，请省略 binds')
  const binds: { angle?: string; spread?: string; voltage?: string } = {}
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      return fail(context, `${path}.${key}`, `这个图示不支持绑定 ${key}，只支持 ${allowed.join('、')}`)
    }
  }
  for (const key of allowed) {
    const raw = value[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string') return fail(context, `${path}.${key}`, '必须是已声明的数值参数 id')
    const param = context.declaredParams.get(raw)
    if (param === undefined) {
      return fail(context, `${path}.${key}`, `参数「${raw}」未在 document.params 中声明`)
    }
    if (param.type !== 'number') {
      return fail(context, `${path}.${key}`, `参数「${raw}」不是数值参数，绑定只能指向 number 参数`)
    }
    // 条件参数可能被隐藏：控件看不见、图解却被它驱动，用户找不到原因。
    if (param.visibleWhen !== undefined) {
      return fail(
        context,
        `${path}.${key}`,
        `参数「${raw}」声明了 visibleWhen，可能被隐藏，不能作为图示绑定；请换一个始终可见的 number 参数`
      )
    }
    binds[key] = raw
  }
  return Object.keys(binds).length === 0 ? undefined : binds
}

/** 解析图示节点；按 kind 分派，每种只接受自己的字段。 */
function parseDiagram(value: Record<string, unknown>, path: string, context: ParseContext): GenuiDiagramNode | null {
  const caption = optionalText(value.caption, 400)
  if (caption === null) return fail(context, `${path}.caption`, '省略，或给 1..400 字符的字符串')
  const captionField = caption === undefined ? {} : { caption }

  switch (value.kind) {
    case 'exploded': {
      if (!Array.isArray(value.parts)) return fail(context, `${path}.parts`, '必须是零件数组，每项 {label,note?}')
      if (value.parts.length < GENUI_MIN_EXPLODED_PARTS || value.parts.length > GENUI_MAX_EXPLODED_PARTS) {
        return fail(
          context,
          `${path}.parts`,
          `零件个数必须是 ${GENUI_MIN_EXPLODED_PARTS}..${GENUI_MAX_EXPLODED_PARTS}`
        )
      }
      const parts: GenuiExplodedPart[] = []
      for (const [index, part] of value.parts.entries()) {
        const partPath = `${path}.parts[${index}]`
        if (!isRecord(part)) return fail(context, partPath, '必须是 {label,note?} 对象')
        const label = part.label
        if (!isText(label, GENUI_MAX_DIAGRAM_LABEL_CHARS)) {
          return fail(context, `${partPath}.label`, `必须是 1..${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符的非空字符串`)
        }
        const note = optionalText(part.note, GENUI_MAX_DIAGRAM_NOTE_CHARS)
        if (note === null) {
          return fail(context, `${partPath}.note`, `省略，或给 1..${GENUI_MAX_DIAGRAM_NOTE_CHARS} 字符的字符串`)
        }
        parts.push({ label, ...(note === undefined ? {} : { note }) })
      }
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.exploded, context)
      if (binds === null) return null
      return { type: 'diagram', kind: 'exploded', parts, ...captionField, ...(binds === undefined ? {} : { binds }) }
    }
    case 'gear': {
      if (!Array.isArray(value.gears)) return fail(context, `${path}.gears`, '必须是齿轮数组，每项 {label,teeth}')
      if (value.gears.length < GENUI_MIN_GEARS || value.gears.length > GENUI_MAX_GEARS) {
        return fail(context, `${path}.gears`, `齿轮个数必须是 ${GENUI_MIN_GEARS}..${GENUI_MAX_GEARS}`)
      }
      const gears: GenuiGearSpec[] = []
      for (const [index, gear] of value.gears.entries()) {
        const gearPath = `${path}.gears[${index}]`
        if (!isRecord(gear)) return fail(context, gearPath, '必须是 {label,teeth} 对象')
        const label = gear.label
        if (!isText(label, GENUI_MAX_DIAGRAM_LABEL_CHARS)) {
          return fail(context, `${gearPath}.label`, `必须是 1..${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符的非空字符串`)
        }
        const teeth = gear.teeth
        if (typeof teeth !== 'number' || !Number.isInteger(teeth)
          || teeth < GENUI_MIN_GEAR_TEETH || teeth > GENUI_MAX_GEAR_TEETH) {
          return fail(
            context,
            `${gearPath}.teeth`,
            `必须是 ${GENUI_MIN_GEAR_TEETH}..${GENUI_MAX_GEAR_TEETH} 的整数`
          )
        }
        gears.push({ label, teeth })
      }
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.gear, context)
      if (binds === null) return null
      return { type: 'diagram', kind: 'gear', gears, ...captionField, ...(binds === undefined ? {} : { binds }) }
    }
    case 'crank': {
      const crank = value.crank
      const rod = value.rod
      if (!isFiniteNumber(crank) || crank <= 0) return fail(context, `${path}.crank`, '必须是大于 0 的有限数字')
      if (!isFiniteNumber(rod) || rod <= 0) return fail(context, `${path}.rod`, '必须是大于 0 的有限数字')
      // rod <= crank 时连杆绕不过曲柄，机构不成立，直接拒掉而不是画一张错的图。
      if (rod <= crank) return fail(context, `${path}.rod`, '必须大于 crank，否则曲柄转不过一周')
      const unit = optionalText(value.unit, GENUI_MAX_PARAM_UNIT_CHARS)
      if (unit === null) return fail(context, `${path}.unit`, `省略，或给 1..${GENUI_MAX_PARAM_UNIT_CHARS} 字符的字符串`)
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.crank, context)
      if (binds === null) return null
      return {
        type: 'diagram',
        kind: 'crank',
        crank,
        rod,
        ...(unit === undefined ? {} : { unit }),
        ...captionField,
        ...(binds === undefined ? {} : { binds })
      }
    }
    case 'vector': {
      if (!Array.isArray(value.vectors)) return fail(context, `${path}.vectors`, '必须是矢量数组，每项 {label,magnitude,angle}')
      if (value.vectors.length < GENUI_MIN_VECTORS || value.vectors.length > GENUI_MAX_VECTORS) {
        return fail(context, `${path}.vectors`, `矢量个数必须是 ${GENUI_MIN_VECTORS}..${GENUI_MAX_VECTORS}`)
      }
      const vectors: GenuiVectorSpec[] = []
      for (const [index, item] of value.vectors.entries()) {
        const itemPath = `${path}.vectors[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {label,magnitude,angle} 对象')
        const label = item.label
        if (!isText(label, GENUI_MAX_DIAGRAM_LABEL_CHARS)) {
          return fail(context, `${itemPath}.label`, `必须是 1..${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符的非空字符串`)
        }
        const magnitude = item.magnitude
        if (!isFiniteNumber(magnitude) || magnitude <= 0) {
          return fail(context, `${itemPath}.magnitude`, '必须是大于 0 的有限数字')
        }
        const vectorAngle = item.angle
        if (!isFiniteNumber(vectorAngle)) return fail(context, `${itemPath}.angle`, '必须是有限数字，单位度')
        vectors.push({ label, magnitude, angle: vectorAngle })
      }
      const unit = optionalText(value.unit, GENUI_MAX_PARAM_UNIT_CHARS)
      if (unit === null) return fail(context, `${path}.unit`, `省略，或给 1..${GENUI_MAX_PARAM_UNIT_CHARS} 字符的字符串`)
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.vector, context)
      if (binds === null) return null
      return {
        type: 'diagram',
        kind: 'vector',
        vectors,
        ...(unit === undefined ? {} : { unit }),
        ...captionField,
        ...(binds === undefined ? {} : { binds })
      }
    }
    case 'circuit': {
      const voltage = value.voltage
      if (!isFiniteNumber(voltage) || voltage <= 0) return fail(context, `${path}.voltage`, '必须是大于 0 的有限数字')
      if (!Array.isArray(value.components)) {
        return fail(context, `${path}.components`, '必须是元件数组，每项 {kind,label,value?}')
      }
      if (value.components.length < GENUI_MIN_CIRCUIT_PARTS || value.components.length > GENUI_MAX_CIRCUIT_PARTS) {
        return fail(context, `${path}.components`, `元件个数必须是 ${GENUI_MIN_CIRCUIT_PARTS}..${GENUI_MAX_CIRCUIT_PARTS}`)
      }
      const components: GenuiCircuitComponent[] = []
      for (const [index, item] of value.components.entries()) {
        const itemPath = `${path}.components[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {kind,label,value?} 对象')
        const kind = item.kind
        if (kind !== 'resistor' && kind !== 'lamp' && kind !== 'switch') {
          return fail(context, `${itemPath}.kind`, '元件 kind 只能是 resistor、lamp 或 switch')
        }
        const label = item.label
        if (!isText(label, GENUI_MAX_DIAGRAM_LABEL_CHARS)) {
          return fail(context, `${itemPath}.label`, `必须是 1..${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符的非空字符串`)
        }
        // 开关没有阻值；其余两种必须有，否则算不出电流与压降。
        if (kind === 'switch') {
          if (item.value !== undefined) return fail(context, `${itemPath}.value`, '开关不接受 value，请省略')
          components.push({ kind, label })
          continue
        }
        const resistance = item.value
        if (!isFiniteNumber(resistance) || resistance <= 0) {
          return fail(context, `${itemPath}.value`, '必须是大于 0 的有限数字（阻值）')
        }
        components.push({ kind, label, value: resistance })
      }
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.circuit, context)
      if (binds === null) return null
      return { type: 'diagram', kind: 'circuit', voltage, components, ...captionField, ...(binds === undefined ? {} : { binds }) }
    }
    case 'section': {
      if (!Array.isArray(value.layers)) return fail(context, `${path}.layers`, '必须是层数组，每项 {label,thickness,note?}')
      if (value.layers.length < GENUI_MIN_SECTION_LAYERS || value.layers.length > GENUI_MAX_SECTION_LAYERS) {
        return fail(context, `${path}.layers`, `层数必须是 ${GENUI_MIN_SECTION_LAYERS}..${GENUI_MAX_SECTION_LAYERS}`)
      }
      const layers: GenuiSectionLayer[] = []
      for (const [index, item] of value.layers.entries()) {
        const itemPath = `${path}.layers[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {label,thickness,note?} 对象')
        const label = item.label
        if (!isText(label, GENUI_MAX_DIAGRAM_LABEL_CHARS)) {
          return fail(context, `${itemPath}.label`, `必须是 1..${GENUI_MAX_DIAGRAM_LABEL_CHARS} 字符的非空字符串`)
        }
        const thickness = item.thickness
        if (!isFiniteNumber(thickness) || thickness <= 0) {
          return fail(context, `${itemPath}.thickness`, '必须是大于 0 的有限数字')
        }
        const note = optionalText(item.note, GENUI_MAX_DIAGRAM_NOTE_CHARS)
        if (note === null) {
          return fail(context, `${itemPath}.note`, `省略，或给 1..${GENUI_MAX_DIAGRAM_NOTE_CHARS} 字符的字符串`)
        }
        layers.push({ label, thickness, ...(note === undefined ? {} : { note }) })
      }
      const unit = optionalText(value.unit, GENUI_MAX_PARAM_UNIT_CHARS)
      if (unit === null) return fail(context, `${path}.unit`, `省略，或给 1..${GENUI_MAX_PARAM_UNIT_CHARS} 字符的字符串`)
      const binds = parseDiagramBinds(value.binds, `${path}.binds`, DIAGRAM_BIND_KEYS.section, context)
      if (binds === null) return null
      return {
        type: 'diagram',
        kind: 'section',
        layers,
        ...(unit === undefined ? {} : { unit }),
        ...captionField,
        ...(binds === undefined ? {} : { binds })
      }
    }
    default:
      return fail(context, `${path}.kind`, `图示 kind 只能是 ${GENUI_DIAGRAM_KINDS.join('、')}`)
  }
}

/** 图表分类轴：1..上限个非空标签。 */
function parseChartLabels(value: Record<string, unknown>, path: string, context: ParseContext): string[] | null {
  if (!Array.isArray(value.labels)) return fail(context, `${path}.labels`, '必须是分类标签数组，如 ["周一","周二"]')
  if (value.labels.length < GENUI_MIN_CHART_POINTS || value.labels.length > GENUI_MAX_CHART_POINTS) {
    return fail(context, `${path}.labels`, `分类个数必须是 ${GENUI_MIN_CHART_POINTS}..${GENUI_MAX_CHART_POINTS}`)
  }
  const labels: string[] = []
  for (const [index, label] of value.labels.entries()) {
    if (!isText(label, GENUI_MAX_CHART_LABEL_CHARS)) {
      return fail(context, `${path}.labels[${index}]`, `必须是 1..${GENUI_MAX_CHART_LABEL_CHARS} 字符的非空字符串`)
    }
    labels.push(label)
  }
  return labels
}

/**
 * 图表序列：1..上限条，每条 `values` 必须与 `labels` 等长。
 * 多序列时 `name` 必填且唯一——图例靠它区分，缺名字的图例等于没有图例。
 */
function parseChartSeries(
  value: Record<string, unknown>,
  path: string,
  labels: readonly string[],
  context: ParseContext
): GenuiChartSeries[] | null {
  if (!Array.isArray(value.series)) return fail(context, `${path}.series`, '必须是序列数组，每项 {name?,values}')
  if (value.series.length < 1 || value.series.length > GENUI_MAX_CHART_SERIES) {
    return fail(context, `${path}.series`, `序列条数必须是 1..${GENUI_MAX_CHART_SERIES}`)
  }
  const multi = value.series.length > 1
  const series: GenuiChartSeries[] = []
  const names = new Set<string>()
  for (const [index, item] of value.series.entries()) {
    const seriesPath = `${path}.series[${index}]`
    if (!isRecord(item)) return fail(context, seriesPath, '必须是 {name?,values} 对象')
    const name = optionalText(item.name, GENUI_MAX_CHART_SERIES_NAME_CHARS)
    if (name === null) {
      return fail(context, `${seriesPath}.name`, `省略，或给 1..${GENUI_MAX_CHART_SERIES_NAME_CHARS} 字符的字符串`)
    }
    if (multi && name === undefined) return fail(context, `${seriesPath}.name`, '多条序列时必填，否则图例无法区分')
    if (name !== undefined) {
      if (names.has(name)) return fail(context, `${seriesPath}.name`, `序列名「${name}」重复，图例无法区分`)
      names.add(name)
    }
    if (!Array.isArray(item.values)) return fail(context, `${seriesPath}.values`, '必须是数字数组，长度与 labels 一致')
    if (item.values.length !== labels.length) {
      return fail(
        context,
        `${seriesPath}.values`,
        `长度必须是 ${labels.length}，与 labels 一一对应（当前 ${item.values.length}）`
      )
    }
    const values: number[] = []
    for (const [valueIndex, rawValue] of item.values.entries()) {
      // 允许负数：柱状图需要表达增减；NaN 与 Infinity 仍拒绝。
      if (!isFiniteNumber(rawValue)) return fail(context, `${seriesPath}.values[${valueIndex}]`, '必须是有限数字')
      values.push(rawValue)
    }
    series.push({ ...(name === undefined ? {} : { name }), values })
  }
  return series
}

/**
 * 旧形状 `points:[{label,value}]` 归一化成一条无名序列。
 * 历史会话里已交付的图表要能继续画出来，否则一次协议变更会让旧图全部降级成纯文本。
 */
function legacyChartPoints(
  value: Record<string, unknown>,
  path: string,
  context: ParseContext
): { labels: string[]; series: GenuiChartSeries[] } | null {
  if (!Array.isArray(value.points)) {
    return fail(context, `${path}.series`, '必须是序列数组，每项 {name?,values}，并配合 labels 数组')
  }
  if (value.points.length < GENUI_MIN_CHART_POINTS || value.points.length > GENUI_MAX_CHART_POINTS) {
    return fail(context, `${path}.points`, `数据点个数必须是 ${GENUI_MIN_CHART_POINTS}..${GENUI_MAX_CHART_POINTS}`)
  }
  const labels: string[] = []
  const values: number[] = []
  for (const [index, point] of value.points.entries()) {
    const pointPath = `${path}.points[${index}]`
    if (!isRecord(point)) return fail(context, pointPath, '必须是 {label,value} 对象')
    const label = point.label
    if (!isText(label, GENUI_MAX_CHART_LABEL_CHARS)) {
      return fail(context, `${pointPath}.label`, `必须是 1..${GENUI_MAX_CHART_LABEL_CHARS} 字符的非空字符串`)
    }
    if (!isFiniteNumber(point.value)) return fail(context, `${pointPath}.value`, '必须是有限数字')
    labels.push(label)
    values.push(point.value)
  }
  return { labels, series: [{ values }] }
}

/**
 * 饼图与环形图的额外约束：一条序列、切片不超过上限、每值非负、总和大于 0。
 * 这四项任一不成立都画不出有意义的占比，因此直接拒掉，不让渲染端去猜怎么兜底。
 */
function checkPieShape(
  data: { labels: string[]; series: GenuiChartSeries[] },
  path: string,
  context: ParseContext
): boolean {
  const first = data.series[0]
  if (data.series.length !== 1 || first === undefined) {
    fail(context, `${path}.series`, '饼图与环形图只能有一条序列，多条序列请用 bar/line 或 table')
    return false
  }
  if (data.labels.length > GENUI_MAX_PIE_SLICES) {
    fail(context, `${path}.labels`, `切片个数不能超过 ${GENUI_MAX_PIE_SLICES}，更多占比请用 table`)
    return false
  }
  let total = 0
  for (const [index, value] of first.values.entries()) {
    if (value < 0) {
      fail(context, `${path}.series[0].values[${index}]`, '占比不能为负')
      return false
    }
    total += value
  }
  if (total <= 0) {
    fail(context, `${path}.series[0].values`, '所有切片之和必须大于 0，否则占比无定义')
    return false
  }
  return true
}

/** 解析图表节点；四种 kind 共用 labels + series，饼图/环形图另有占比约束。 */
function parseChart(value: Record<string, unknown>, path: string, context: ParseContext): GenuiChartNode | null {
  // `series` 存在就按新形状解析，`points` 仅作为旧形状的兼容入口；
  // 两者同时给时不静默合并——静默取一个会让模型以为自己写错了地方还"生效了"。
  let data: { labels: string[]; series: GenuiChartSeries[] } | null
  if (Array.isArray(value.series)) {
    const labels = parseChartLabels(value, path, context)
    if (labels === null) return null
    const series = parseChartSeries(value, path, labels, context)
    if (series === null) return null
    data = { labels, series }
  } else {
    data = legacyChartPoints(value, path, context)
    if (data === null) return null
  }
  const title = optionalText(value.title, GENUI_MAX_CHART_TITLE_CHARS)
  if (title === null) return fail(context, `${path}.title`, `省略，或给 1..${GENUI_MAX_CHART_TITLE_CHARS} 字符的字符串`)
  const caption = optionalText(value.caption, 400)
  if (caption === null) return fail(context, `${path}.caption`, '省略，或给 1..400 字符的字符串')
  const unit = optionalText(value.unit, GENUI_MAX_PARAM_UNIT_CHARS)
  if (unit === null) return fail(context, `${path}.unit`, `省略，或给 1..${GENUI_MAX_PARAM_UNIT_CHARS} 字符的字符串`)

  const common = {
    type: 'chart' as const,
    labels: data.labels,
    series: data.series,
    ...(title === undefined ? {} : { title }),
    ...(caption === undefined ? {} : { caption }),
    ...(unit === undefined ? {} : { unit })
  }
  switch (value.kind) {
    case 'bar': return { ...common, kind: 'bar' }
    case 'line': return { ...common, kind: 'line' }
    case 'pie':
    case 'donut': {
      if (!checkPieShape(data, path, context)) return null
      // 不用 switch 对 unknown 的窄化：显式比较后再赋字面量，类型不依赖窄化细节。
      const kind: 'pie' | 'donut' = value.kind === 'pie' ? 'pie' : 'donut'
      return { ...common, kind }
    }
    default: return fail(context, `${path}.kind`, `图表 kind 只能是 ${GENUI_CHART_KINDS.join('、')}`)
  }
}

/**
 * 解析单个节点；`depth` 为当前层（根节点的子节点为 1），`path` 是给诊断用的 JSON 路径。
 * `inGroup` 表示这个节点位于 collapse / tabs 的分组内：分组会隐藏内容，因此组内不允许 controls。
 * 任何未知字段都被忽略但不视为错误——模型常带多余字段，而字段值本身仍受严格校验。
 */
function parseNode(
  value: unknown,
  path: string,
  depth: number,
  context: ParseContext,
  inGroup: boolean
): GenuiNode | null {
  if (!isRecord(value)) return fail(context, path, '必须是节点对象，至少带 type')
  if (depth > GENUI_MAX_DEPTH) return fail(context, path, `容器最多嵌套 ${GENUI_MAX_DEPTH} 层`)
  context.nodes += 1
  if (context.nodes > GENUI_MAX_NODES) return fail(context, path, `节点总数不能超过 ${GENUI_MAX_NODES}`)

  switch (value.type) {
    case 'text': {
      const text = value.text
      if (!isText(text)) return fail(context, `${path}.text`, `必须是 1..${GENUI_MAX_TEXT_CHARS} 字符的非空字符串`)
      const tone = readTone(value.tone)
      if (tone === null) {
        return fail(context, `${path}.tone`, '省略，或取 default|muted|accent|success|warning|danger')
      }
      const size = readTextSize(value.size)
      if (size === null) return fail(context, `${path}.size`, '省略，或取 small|body|large')
      return {
        type: 'text',
        text,
        ...(tone === undefined ? {} : { tone }),
        ...(size === undefined ? {} : { size })
      }
    }
    case 'list': {
      if (!Array.isArray(value.items)) return fail(context, `${path}.items`, '必须是字符串数组')
      if (value.items.length === 0 || value.items.length > GENUI_MAX_LIST_ITEMS) {
        return fail(context, `${path}.items`, `条目个数必须是 1..${GENUI_MAX_LIST_ITEMS}`)
      }
      const items: string[] = []
      for (const [index, item] of value.items.entries()) {
        if (!isText(item)) return fail(context, `${path}.items[${index}]`, '必须是非空字符串')
        items.push(item)
      }
      if (value.ordered !== undefined && typeof value.ordered !== 'boolean') {
        return fail(context, `${path}.ordered`, '省略，或给布尔值')
      }
      return {
        type: 'list',
        items,
        ...(value.ordered === undefined ? {} : { ordered: value.ordered })
      }
    }
    case 'metric': {
      const label = value.label
      const raw = value.value
      if (!isText(label, 200)) return fail(context, `${path}.label`, '必须是 1..200 字符的非空字符串')
      if (!isText(raw) && !isFiniteNumber(raw)) {
        return fail(context, `${path}.value`, '必须是有限数字或非空字符串')
      }
      const tone = readTone(value.tone)
      if (tone === null) {
        return fail(context, `${path}.tone`, '省略，或取 default|muted|accent|success|warning|danger')
      }
      const unit = optionalText(value.unit, 40)
      if (unit === null) return fail(context, `${path}.unit`, '省略，或给 1..40 字符的字符串')
      return {
        type: 'metric',
        label,
        value: raw,
        ...(unit === undefined ? {} : { unit }),
        ...(tone === undefined ? {} : { tone })
      }
    }
    case 'table': {
      if (!Array.isArray(value.columns)) return fail(context, `${path}.columns`, '必须是列定义数组，每项 {key,label}')
      if (value.columns.length === 0 || value.columns.length > GENUI_MAX_TABLE_COLUMNS) {
        return fail(context, `${path}.columns`, `列数必须是 1..${GENUI_MAX_TABLE_COLUMNS}`)
      }
      const columns: GenuiTableColumn[] = []
      const keys = new Set<string>()
      for (const [index, column] of value.columns.entries()) {
        const columnPath = `${path}.columns[${index}]`
        if (!isRecord(column)) return fail(context, columnPath, '必须是 {key,label} 对象')
        const key = column.key
        const label = column.label
        if (!isText(key, 64)) return fail(context, `${columnPath}.key`, '必须是 1..64 字符的非空字符串')
        if (!isText(label, 200)) return fail(context, `${columnPath}.label`, '必须是 1..200 字符的非空字符串')
        if (keys.has(key)) return fail(context, `${columnPath}.key`, `列 key「${key}」重复`)
        keys.add(key)
        columns.push({ key, label })
      }
      if (!Array.isArray(value.rows)) return fail(context, `${path}.rows`, '必须是行对象数组')
      if (value.rows.length > GENUI_MAX_TABLE_ROWS) {
        return fail(context, `${path}.rows`, `行数不能超过 ${GENUI_MAX_TABLE_ROWS}`)
      }
      const rows: GenuiTableRow[] = []
      for (const [rowIndex, row] of value.rows.entries()) {
        const rowPath = `${path}.rows[${rowIndex}]`
        if (!isRecord(row)) return fail(context, rowPath, '必须是按列 key 取值的对象')
        const cells: Record<string, GenuiTableCell> = {}
        for (const key of keys) {
          const cell = row[key]
          // 只接受已声明列上的字符串与有限数字；缺失单元格留空，不补造占位值。
          if (cell === undefined) continue
          if (!isText(cell, GENUI_MAX_CELL_CHARS) && !isFiniteNumber(cell)) {
            return fail(
              context,
              `${rowPath}.${key}`,
              `必须是有限数字，或 1..${GENUI_MAX_CELL_CHARS} 字符的非空字符串`
            )
          }
          cells[key] = cell
        }
        rows.push(cells)
      }
      const caption = optionalText(value.caption, 400)
      if (caption === null) return fail(context, `${path}.caption`, '省略，或给 1..400 字符的字符串')
      return {
        type: 'table',
        columns,
        rows,
        ...(caption === undefined ? {} : { caption })
      }
    }
    case 'steps': {
      if (!Array.isArray(value.items)) return fail(context, `${path}.items`, '必须是步骤数组，每项 {title,description?}')
      if (value.items.length === 0 || value.items.length > GENUI_MAX_STEPS) {
        return fail(context, `${path}.items`, `步骤个数必须是 1..${GENUI_MAX_STEPS}`)
      }
      const items: GenuiStepItem[] = []
      for (const [index, item] of value.items.entries()) {
        const itemPath = `${path}.items[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {title,description?} 对象')
        const title = item.title
        if (!isText(title, 200)) return fail(context, `${itemPath}.title`, '必须是 1..200 字符的非空字符串')
        const description = optionalText(item.description, 1000)
        if (description === null) return fail(context, `${itemPath}.description`, '省略，或给 1..1000 字符的字符串')
        items.push({ title, ...(description === undefined ? {} : { description }) })
      }
      return { type: 'steps', items }
    }
    case 'timeline': {
      if (!Array.isArray(value.items)) return fail(context, `${path}.items`, '必须是时间点数组，每项 {time,title,description?}')
      if (value.items.length === 0 || value.items.length > GENUI_MAX_TIMELINE_ITEMS) {
        return fail(context, `${path}.items`, `时间点个数必须是 1..${GENUI_MAX_TIMELINE_ITEMS}`)
      }
      const items: GenuiTimelineItem[] = []
      for (const [index, item] of value.items.entries()) {
        const itemPath = `${path}.items[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {time,title,description?} 对象')
        const time = item.time
        if (!isText(time, GENUI_MAX_TIMELINE_TIME_CHARS)) {
          return fail(context, `${itemPath}.time`, `必须是 1..${GENUI_MAX_TIMELINE_TIME_CHARS} 字符的非空字符串，如 "09:12"`)
        }
        const title = item.title
        if (!isText(title, 200)) return fail(context, `${itemPath}.title`, '必须是 1..200 字符的非空字符串')
        const description = optionalText(item.description, 1000)
        if (description === null) return fail(context, `${itemPath}.description`, '省略，或给 1..1000 字符的字符串')
        items.push({ time, title, ...(description === undefined ? {} : { description }) })
      }
      return { type: 'timeline', items }
    }
    case 'card': {
      if (!Array.isArray(value.children)) return fail(context, `${path}.children`, '必须是节点数组')
      if (value.children.length === 0) return fail(context, `${path}.children`, '子节点至少一个')
      const title = optionalText(value.title, 200)
      if (title === null) return fail(context, `${path}.title`, '省略，或给 1..200 字符的字符串')
      // 分组标记继续往下传：折叠或标签页里的 card 仍然算「在分组内」。
      const children = parseNodes(value.children, `${path}.children`, depth + 1, context, inGroup)
      if (children === null) return null
      return { type: 'card', ...(title === undefined ? {} : { title }), children }
    }
    case 'row': {
      if (!Array.isArray(value.children)) return fail(context, `${path}.children`, '必须是节点数组')
      if (value.children.length === 0) return fail(context, `${path}.children`, '子节点至少一个')
      const columns = readCount(value.columns, GENUI_MAX_COLUMNS)
      if (columns === null) return fail(context, `${path}.columns`, `省略，或给 1..${GENUI_MAX_COLUMNS} 的整数`)
      const children = parseNodes(value.children, `${path}.children`, depth + 1, context, inGroup)
      if (children === null) return null
      return { type: 'row', ...(columns === undefined ? {} : { columns }), children }
    }
    case 'controls': {
      // 分组与切页都会隐藏内容：参数藏起来却仍会随提交带出去，等于破坏「声明即可见」这条不变式。
      if (inGroup) {
        return fail(
          context,
          path,
          'controls 不能放在 collapse 或 tabs 里（包括它们内部的 card / row）：收起或切页会把参数藏起来，提交时却仍会带上。请把它放到文档顶层，或放在不在 collapse / tabs 内的 card / row 里'
        )
      }
      // 没有声明参数时控件组没有可渲染的内容，按无效处理而不是渲染空壳。
      if (context.declaredParams.size === 0) {
        return fail(context, path, '文档没有声明 params 时不能用 controls 节点')
      }
      if (value.params === undefined) {
        // 遍历 Map 默认给的是 [id, 参数] 元组，这里要的是 id 本身。
        for (const id of context.declaredParams.keys()) context.usedParams.add(id)
        return { type: 'controls' }
      }
      if (!Array.isArray(value.params)) return fail(context, `${path}.params`, '省略（渲染全部参数）或给参数 id 数组')
      if (value.params.length === 0 || value.params.length > GENUI_MAX_PARAMS) {
        return fail(context, `${path}.params`, `参数 id 个数必须是 1..${GENUI_MAX_PARAMS}`)
      }
      const ids: string[] = []
      const seen = new Set<string>()
      for (const [index, item] of value.params.entries()) {
        const itemPath = `${path}.params[${index}]`
        if (typeof item !== 'string' || !context.declaredParams.has(item)) {
          return fail(context, itemPath, '必须是文档 params 里已声明的参数 id')
        }
        if (seen.has(item)) return fail(context, itemPath, `参数 id「${item}」在同一个 controls 里重复`)
        seen.add(item)
        ids.push(item)
        context.usedParams.add(item)
      }
      return { type: 'controls', params: ids }
    }
    case 'collapse': {
      if (!Array.isArray(value.items)) {
        return fail(context, `${path}.items`, '必须是分组数组，每项 {title,open?,children}')
      }
      if (value.items.length < GENUI_MIN_COLLAPSE_ITEMS || value.items.length > GENUI_MAX_COLLAPSE_ITEMS) {
        return fail(context, `${path}.items`, `分组个数必须是 ${GENUI_MIN_COLLAPSE_ITEMS}..${GENUI_MAX_COLLAPSE_ITEMS}`)
      }
      const items: GenuiCollapseItem[] = []
      for (const [index, item] of value.items.entries()) {
        const itemPath = `${path}.items[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {title,open?,children} 对象')
        const title = item.title
        if (!isText(title, 200)) return fail(context, `${itemPath}.title`, '必须是 1..200 字符的非空字符串')
        if (item.open !== undefined && typeof item.open !== 'boolean') {
          return fail(context, `${itemPath}.open`, '省略（默认收起），或给布尔值')
        }
        if (!Array.isArray(item.children)) return fail(context, `${itemPath}.children`, '必须是节点数组')
        if (item.children.length === 0) return fail(context, `${itemPath}.children`, '子节点至少一个')
        const children = parseNodes(item.children, `${itemPath}.children`, depth + 1, context, true)
        if (children === null) return null
        items.push({ title, ...(item.open === undefined ? {} : { open: item.open }), children })
      }
      return { type: 'collapse', items }
    }
    case 'tabs': {
      if (!Array.isArray(value.items)) return fail(context, `${path}.items`, '必须是页数组，每项 {label,children}')
      if (value.items.length < GENUI_MIN_TABS || value.items.length > GENUI_MAX_TABS) {
        return fail(context, `${path}.items`, `页数必须是 ${GENUI_MIN_TABS}..${GENUI_MAX_TABS}`)
      }
      const items: GenuiTabItem[] = []
      const labels = new Set<string>()
      for (const [index, item] of value.items.entries()) {
        const itemPath = `${path}.items[${index}]`
        if (!isRecord(item)) return fail(context, itemPath, '必须是 {label,children} 对象')
        const label = item.label
        if (!isText(label, GENUI_MAX_TAB_LABEL_CHARS)) {
          return fail(context, `${itemPath}.label`, `必须是 1..${GENUI_MAX_TAB_LABEL_CHARS} 字符的非空字符串`)
        }
        // 页签重复就无法用文案定位到具体哪一页，模型改数据时也会认错。
        if (labels.has(label)) return fail(context, `${itemPath}.label`, `页签「${label}」重复`)
        labels.add(label)
        if (!Array.isArray(item.children)) return fail(context, `${itemPath}.children`, '必须是节点数组')
        if (item.children.length === 0) return fail(context, `${itemPath}.children`, '子节点至少一个')
        const children = parseNodes(item.children, `${itemPath}.children`, depth + 1, context, true)
        if (children === null) return null
        items.push({ label, children })
      }
      return { type: 'tabs', items }
    }
    case 'diagram': {
      // 图示是叶子节点：内部不再嵌子节点，因此不占额外嵌套深度。
      return parseDiagram(value, path, context)
    }
    case 'chart': {
      return parseChart(value, path, context)
    }
    default:
      return fail(
        context,
        `${path}.type`,
        '节点 type 只能是 text、list、metric、table、steps、timeline、card、row、collapse、tabs、controls、diagram 或 chart'
      )
  }
}

/** 解析同层节点数组；空数组按无内容处理，返回 null 让调用方整体拒绝。 */
function parseNodes(
  value: readonly unknown[],
  path: string,
  depth: number,
  context: ParseContext,
  inGroup = false
): GenuiNode[] | null {
  if (value.length === 0) return fail(context, path, '至少一个节点')
  const nodes: GenuiNode[] = []
  for (const [index, item] of value.entries()) {
    const node = parseNode(item, `${path}[${index}]`, depth, context, inGroup)
    if (node === null) return null
    nodes.push(node)
  }
  return nodes
}

/** 浅层修复的产物：改写后的文档与改动记录。 */
interface ShallowRepairResult {
  readonly value: Record<string, unknown>
  readonly repairs: readonly GenuiRepair[]
}

/** 记一条修复记录；不做上限判断，由调用方在最后统一比对 `GENUI_MAX_REPAIRS`。 */
type RepairRecorder = (path: string, note: string) => void

/**
 * 从原始 `params` 里宽松读出已声明参数 id 与其中的数值参数 id。
 * 参数内容的错误仍交给严格解析报告，这里只关心「引用的目标存不存在」。
 */
function readDeclaredParams(params: unknown): { declared: Set<string>; numbers: Set<string> } {
  const declared = new Set<string>()
  const numbers = new Set<string>()
  if (!Array.isArray(params)) return { declared, numbers }
  for (const param of params) {
    if (!isRecord(param) || typeof param.id !== 'string' || param.id === '') continue
    declared.add(param.id)
    if (param.type === 'number') numbers.add(param.id)
  }
  return { declared, numbers }
}

/** 找出没有任何控件组引用的参数 id；`controls` 省略 `params` 时视为渲染全部。 */
function missingParamIds(nodes: readonly unknown[], declared: ReadonlySet<string>): string[] {
  const used = new Set<string>()
  const walk = (list: readonly unknown[]): void => {
    for (const node of list) {
      if (!isRecord(node)) continue
      if (node.type === 'controls') {
        if (!Array.isArray(node.params)) {
          for (const id of declared) used.add(id)
          continue
        }
        for (const id of node.params) {
          if (typeof id === 'string') used.add(id)
        }
        continue
      }
      // 不进入 collapse / tabs：组内不允许 controls，进来也找不到引用者，反而会让
      // 「参数未渲染」的自动修复口径与严格解析不一致。
      if ((node.type === 'card' || node.type === 'row') && Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  return [...declared].filter((id) => !used.has(id))
}

/**
 * 修复单个节点的引用类错误；`null` 表示这个节点应当删除。
 * 只处理「指向不存在的东西」这类字段，节点内容一律原样保留，返回同一引用表示没改。
 */
function repairNode(
  node: Record<string, unknown>,
  path: string,
  declared: ReadonlySet<string>,
  numbers: ReadonlySet<string>,
  record: RepairRecorder
): Record<string, unknown> | null {
  switch (node.type) {
    case 'controls': {
      // 没有声明参数时控件组没有可渲染内容，删掉它比留一个空壳更接近模型的本意。
      if (declared.size === 0) {
        record(path, '文档没有声明 params，已删除这个空的 controls 节点')
        return null
      }
      if (!Array.isArray(node.params)) return node
      const kept: string[] = []
      const seen = new Set<string>()
      for (const id of node.params) {
        if (typeof id !== 'string' || !declared.has(id) || seen.has(id)) continue
        seen.add(id)
        kept.push(id)
      }
      if (kept.length === node.params.length) return node
      if (kept.length === 0) {
        const rest: Record<string, unknown> = { ...node }
        delete rest.params
        record(`${path}.params`, '引用的参数都不存在，已改为渲染全部参数')
        return rest
      }
      record(`${path}.params`, `剔除了 ${node.params.length - kept.length} 个不存在或重复的参数 id`)
      return { ...node, params: kept }
    }
    case 'diagram': {
      if (!isRecord(node.binds)) return node
      const allowed = allowedBindsOf(node.kind)
      if (allowed === null) return node
      const kept: Record<string, string> = {}
      let dropped = 0
      for (const [key, target] of Object.entries(node.binds)) {
        if ((allowed as readonly string[]).includes(key) && typeof target === 'string' && numbers.has(target)) {
          kept[key] = target
        } else {
          dropped += 1
        }
      }
      if (dropped === 0) return node
      if (Object.keys(kept).length === 0) {
        const rest: Record<string, unknown> = { ...node }
        delete rest.binds
        record(`${path}.binds`, '绑定目标不是已声明的数值参数，已去掉这处绑定')
        return rest
      }
      record(`${path}.binds`, `剔除了 ${dropped} 处无效绑定`)
      return { ...node, binds: kept }
    }
    case 'card':
    case 'row': {
      if (!Array.isArray(node.children)) return node
      const children = repairNodeList(node.children, `${path}.children`, declared, numbers, record)
      return children.changed ? { ...node, children: children.items } : node
    }
    case 'collapse':
      return repairGroupItems(node, path, declared, numbers, record)
    case 'tabs':
      return repairGroupItems(node, path, declared, numbers, record)
    default:
      return node
  }
}

/**
 * 修一个分组容器的组内子节点：引用类错误照常修，返回同一引用表示没改。
 * 组内的 controls 不做特殊处理：未声明 params 时由 `repairNode` 的 controls 分支删掉，
 * 「controls 不能放进分组」这类结构性错误仍交给严格解析拒绝，修复层不替模型绕过它。
 */
function repairGroupItems(
  node: Record<string, unknown>,
  path: string,
  declared: ReadonlySet<string>,
  numbers: ReadonlySet<string>,
  record: RepairRecorder
): Record<string, unknown> {
  if (!Array.isArray(node.items)) return node
  let changed = false
  const items: unknown[] = []
  for (const [index, item] of node.items.entries()) {
    if (!isRecord(item) || !Array.isArray(item.children)) {
      items.push(item)
      continue
    }
    const children = repairNodeList(
      item.children,
      `${path}.items[${index}].children`,
      declared,
      numbers,
      record
    )
    if (!children.changed) {
      items.push(item)
      continue
    }
    changed = true
    items.push({ ...item, children: children.items })
  }
  return changed ? { ...node, items } : node
}

/**
 * 修复节点列表里的引用类错误，返回新数组与是否改动。
 * 容器递归下去，其余节点原样保留；被判定要删的节点直接不进入结果。
 */
function repairNodeList(
  list: readonly unknown[],
  path: string,
  declared: ReadonlySet<string>,
  numbers: ReadonlySet<string>,
  record: RepairRecorder
): { items: unknown[]; changed: boolean } {
  const items: unknown[] = []
  let changed = false
  for (const [index, raw] of list.entries()) {
    if (!isRecord(raw)) {
      items.push(raw)
      continue
    }
    const repaired = repairNode(raw, `${path}[${index}]`, declared, numbers, record)
    if (repaired === null) {
      changed = true
      continue
    }
    if (repaired !== raw) changed = true
    items.push(repaired)
  }
  return { items, changed }
}

/**
 * 修参数上的显示条件：目标不存在、目标不是 select / toggle、目标自身也带条件、或自引用时，
 * 去掉这条 `visibleWhen` 并记一条修复。
 * 与 `binds` 同口径：只修「指向不成立的东西」，不改参数本身的取值与选项。
 * `equals` 不落在目标取值集合里时不修：那是模型给错了值，猜一个反而会把错藏起来。
 */
function repairParamConditions(params: readonly unknown[], record: RepairRecorder): unknown[] | null {
  const byId = new Map<string, Record<string, unknown>>()
  for (const param of params) {
    if (isRecord(param) && typeof param.id === 'string' && param.id !== '') byId.set(param.id, param)
  }
  let changed = false
  const items: unknown[] = []
  for (const [index, param] of params.entries()) {
    if (!isRecord(param) || !isRecord(param.visibleWhen)) {
      items.push(param)
      continue
    }
    const condition = param.visibleWhen
    const target = typeof condition.id === 'string' ? byId.get(condition.id) : undefined
    const broken = target === undefined
      || target === param
      || (target.type !== 'select' && target.type !== 'toggle')
      || target.visibleWhen !== undefined
    if (!broken) {
      items.push(param)
      continue
    }
    const rest: Record<string, unknown> = { ...param }
    delete rest.visibleWhen
    record(`params[${index}].visibleWhen`, '显示条件的目标不成立（不存在、不是 select/toggle、或自身也带条件），已去掉这条条件')
    changed = true
    items.push(rest)
  }
  return changed ? items : null
}

/**
 * 浅层修复：只改「引用不存在的东西」与「空数组冗余」这两类错误，不补内容、不改数值、不截断。
 * 返回 null 表示没有可修的，或修复条数超出 `GENUI_MAX_REPAIRS`（视为结构性错误，仍原样拒绝）。
 * 结果不保证能通过校验——调用方必须再跑一遍严格解析，只有通过才采用。
 */
function repairDocumentShallow(value: Record<string, unknown>): ShallowRepairResult | null {
  const repairs: GenuiRepair[] = []
  const record: RepairRecorder = (path, note) => {
    repairs.push({ path, note })
  }
  const next: Record<string, unknown> = { ...value }

  if (next.version !== GENUI_VERSION) {
    next.version = GENUI_VERSION
    record('version', `已按当前协议写为 ${GENUI_VERSION}`)
  }

  // params 不是数组时不知道到底声明了什么，因此不做任何引用类修复，只留着严格解析去报错。
  const paramsReadable = next.params === undefined || Array.isArray(next.params)
  if (Array.isArray(next.params) && next.params.length === 0) {
    delete next.params
    record('params', '空参数数组按未声明处理，已省略')
  }
  if (Array.isArray(next.params)) {
    const repairedParams = repairParamConditions(next.params, record)
    // null 表示没有改动，保持原数组引用。
    if (repairedParams !== null) next.params = repairedParams
  }
  const { declared, numbers } = readDeclaredParams(next.params)

  if (paramsReadable && Array.isArray(next.nodes)) {
    const list = repairNodeList(next.nodes, 'nodes', declared, numbers, record)
    if (list.changed) next.nodes = list.items
  }

  // 未被任何控件组引用的参数会让提交带上用户看不见的值；补一个只渲染这些参数的控件组，
  // 比丢掉模型声明的参数更接近原意，也不会让已渲染的参数重复出现。
  if (paramsReadable && Array.isArray(next.nodes) && declared.size > 0) {
    const missing = missingParamIds(next.nodes, declared)
    if (missing.length > 0) {
      const appended = [...next.nodes, { type: 'controls', params: missing }]
      next.nodes = appended
      record(`nodes[${appended.length - 1}]`, `为未被引用的参数 ${missing.join('、')} 补了一个 controls 节点`)
    }
  }

  if (repairs.length === 0 || repairs.length > GENUI_MAX_REPAIRS) return null
  return { value: next, repairs }
}

/**
 * 解析一份文档并返回带路径的诊断；扩展层用它把失败原因告诉模型。
 * 版本不是当前协议版本时直接拒绝：历史会话里的旧文档由渲染端降级为文本，不做兼容猜测。
 *
 * 参数先于节点解析：控件组要引用已声明的参数 id，解析完节点后再做一遍交叉校验，
 * 确保每个声明的参数都被某个控件组渲染过。
 */
export function explainGenuiDocument(value: unknown): GenuiParseResult {
  if (!isRecord(value)) return { ok: false, issues: [{ path: 'document', reason: '必须是对象' }] }
  const context: ParseContext = { nodes: 0, declaredParams: new Map(), usedParams: new Set(), issues: [] }
  if (value.version !== GENUI_VERSION) {
    return { ok: false, issues: [{ path: 'version', reason: `必须固定为 ${GENUI_VERSION}` }] }
  }
  const title = value.title
  if (!isText(title, 200)) {
    return { ok: false, issues: [{ path: 'title', reason: '必须是 1..200 字符的非空字符串' }] }
  }
  const fallback = value.fallback
  if (!isText(fallback)) {
    return { ok: false, issues: [{ path: 'fallback', reason: `必须是 1..${GENUI_MAX_TEXT_CHARS} 字符的非空字符串` }] }
  }
  if (!Array.isArray(value.nodes)) {
    return { ok: false, issues: [{ path: 'nodes', reason: '必须是节点数组，至少一个' }] }
  }

  let params: GenuiParam[] | undefined
  if (value.params !== undefined) {
    if (!Array.isArray(value.params)) {
      return { ok: false, issues: [{ path: 'params', reason: '省略，或给参数数组' }] }
    }
    const parsed = parseParams(value.params, 'params', context)
    if (parsed === null) return { ok: false, issues: context.issues }
    // 条件的目标与取值集合需要全量参数才能判定，因此放在这里而不是 parseParam 里。
    if (!validateParamConditions(parsed, context)) return { ok: false, issues: context.issues }
    params = parsed
  }
  const submitLabel = optionalText(value.submitLabel, GENUI_MAX_SUBMIT_LABEL_CHARS)
  if (submitLabel === null) {
    return {
      ok: false,
      issues: [{ path: 'submitLabel', reason: `省略，或给 1..${GENUI_MAX_SUBMIT_LABEL_CHARS} 字符的字符串` }]
    }
  }

  for (const param of params ?? []) context.declaredParams.set(param.id, param)
  const nodes = parseNodes(value.nodes, 'nodes', 1, context)
  if (nodes === null) return { ok: false, issues: context.issues }
  for (const [index, param] of (params ?? []).entries()) {
    if (context.usedParams.has(param.id)) continue
    // 没被任何控件组引用的参数会让提交带上用户看不见的值，因此整份拒绝。
    return {
      ok: false,
      issues: [
        ...context.issues,
        { path: `params[${index}]`, reason: `参数「${param.id}」没有被任何 controls 节点引用，请加一个 controls 或删掉它` }
      ]
    }
  }
  return {
    ok: true,
    document: {
      version: GENUI_VERSION,
      title,
      fallback,
      ...(params === undefined ? {} : { params }),
      ...(submitLabel === undefined ? {} : { submitLabel }),
      nodes
    }
  }
}

/**
 * 交付入口的两遍解析：严格解析失败时，先修引用与冗余这类机械错误，再跑一次同一份严格解析。
 *
 * 只有第二次通过才采用修复结果；仍然失败时返回第一次的诊断——那些路径指向模型原始输入，
 * 模型据此改写比看修复后的文档更直接。因此校验口径仍只有一份，修复只是前置的一次重试。
 */
export function explainGenuiDocumentWithRepairs(value: unknown): GenuiParseResult {
  const strict = explainGenuiDocument(value)
  if (strict.ok) return strict
  if (!isRecord(value)) return strict
  const repaired = repairDocumentShallow(value)
  if (repaired === null) return strict
  const retried = explainGenuiDocument(repaired.value)
  if (!retried.ok) return { ...strict, repairs: repaired.repairs }
  return { ...retried, repairs: repaired.repairs }
}

/**
 * 只关心是否通过的校验入口：投影层与渲染端用它，不携带诊断文本。
 * 与 `explainGenuiDocument` 共用同一份实现，不存在第二套口径。
 */
export function parseGenuiDocument(value: unknown): GenuiDocument | null {
  const result = explainGenuiDocument(value)
  return result.ok ? result.document : null
}

/**
 * 解析工具结果里的完整 UI 载荷；任一项不符即整体返回 null。
 * `revision` 只要求非负安全整数，其语义由扩展层维护，投影层不推断。
 */
export function parseGenuiPayload(value: unknown): GenuiPayload | null {
  if (!isRecord(value)) return null
  const { version, documentId, revision } = value
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) return null
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null
  const document = parseGenuiDocument(value.document)
  if (document === null) return null
  return { version, documentId, revision, document }
}

/** 跨进程校验入口：只判断形状，不复制对象。 */
export function isGenuiPayload(value: unknown): value is GenuiPayload {
  return parseGenuiPayload(value) !== null
}

/**
 * 产生界面载荷的工具名：整份交付与局部补丁。
 * 两个下游都要判断「这条工具结果是不是交付了一份界面」，因此定在这里只写一份：
 * 扩展层的版本推导与活动投影的计数必须看同一份名单，否则一边算交付、另一边不算。
 */
export const GENUI_RENDER_TOOL_NAMES: ReadonlySet<string> = new Set(['ui_render', 'ui_patch'])

/** 界面载荷的头部信息；不含节点树。 */
export interface GenuiPayloadHeader {
  readonly documentId: string
  readonly revision: number
  readonly title: string
}

/**
 * 从 UI 载荷里只读头部字段：`documentId` / `revision` / `document.title`。
 *
 * 不做整份校验——分支越长，这个开销越要压住；需要完整文档时再走 `parseGenuiPayload`。
 * 形状不符（非对象、缺字段、类型不对）一律返回 null，不猜造。
 */
export function readGenuiPayloadHeader(value: unknown): GenuiPayloadHeader | null {
  if (!isRecord(value)) return null
  const documentId = value.documentId
  const revision = value.revision
  if (typeof documentId !== 'string' || documentId === '') return null
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null
  const document = value.document
  const title = isRecord(document) ? document.title : undefined
  return { documentId, revision, title: typeof title === 'string' ? title : '' }
}
