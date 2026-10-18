/**
 * 生成式界面的参数取值：渲染进程内存里的旁路状态，键为 `documentId`。
 *
 * 为什么不进 session：参数不是对话内容。写进工具结果会让历史回放显示过期取值，也会污染
 * fork / rewind 的分支语义；文档本身走 `details` 天然跟随分支，取值则只在本页面存活，
 * 界面上必须明示「重新打开会话会回到默认值」这一期降级口径。
 *
 * 生命周期与投影解耦：状态条目在界面挂载时按文档默认值建立，键为 `documentId`——
 * 每份界面只有一份可交互，旧版本由界面折叠为只读，因此参数按界面而不是按版本存；
 * `revision` 变化时重建为默认值。条目数量有上限，按创建序淘汰最旧的一条；被淘汰的界面
 * 再次挂载时会把 `expired` 标出来，界面据此提示“参数已过期”。
 * 这里只做取值收敛，不做派生计算——派生值需要受限求值器，不在本层。
 */
import { inject, provide, reactive } from 'vue'
import type { InjectionKey } from 'vue'
import type {
  GenuiNumberParam,
  GenuiParam,
  GenuiParamValue,
  GenuiSelectParam,
  GenuiTextParam,
  GenuiToggleParam
} from '../../../shared/genui-api'
import { GENUI_MAX_PARAM_TEXT_CHARS } from '../../../shared/genui-api'

/** 内存条目上限；超出后按创建序淘汰最旧的一条，避免长会话累积。 */
const MAX_PARAM_ENTRIES = 500

/**
 * 数值收敛精度：滑杆步进会产生浮点尾差（0.1 + 0.2 一类），统一按 6 位小数收口。
 * 取 6 位而非按步长位数，是为了在 `min` 本身带小数时仍不丢端点。
 */
const NUMBER_PRECISION = 6

/** 一个文档版本对应的取值集合；`revision` 变化表示文档已被改写，取值需要重建。 */
interface ParamEntry {
  readonly revision: number
  readonly values: Record<string, GenuiParamValue>
}

/**
 * 条目键：只用 `documentId`。每份界面只有一份可交互，旧版本折叠为只读，
 * 因此不需要把版本编进键里；`revision` 变化时条目会重建。
 */
function entryKey(documentId: string): string {
  return documentId
}

/** 被淘汰过的界面；再次挂载时据此提示参数已回默认值，而不是默默重置。 */
const evicted = new Set<string>()

const entries = new Map<string, ParamEntry>()

/** 取或建一个条目；命中同版本直接复用，版本变化或首次访问时按默认值重建。 */
function entryFor(documentId: string, revision: number, params: readonly GenuiParam[]): { entry: ParamEntry; expired: boolean } {
  const key = entryKey(documentId)
  const existing = entries.get(key)
  if (existing !== undefined && existing.revision === revision) return { entry: existing, expired: false }
  const values = reactive<Record<string, GenuiParamValue>>({})
  for (const param of params) values[param.id] = param.default
  const entry: ParamEntry = { revision, values }
  // 没有参数的界面不占用条目：它没有可保存的状态，也不该把有参数的界面挤出去。
  if (params.length === 0) return { entry, expired: false }
  // 重新插入以维持创建序，超出上限时淘汰最旧的一条。
  entries.delete(key)
  entries.set(key, entry)
  // 被淘汰后重建说明这次重置不是用户主动的，界面需要说清。
  const expired = evicted.has(key)
  evicted.delete(key)
  if (entries.size > MAX_PARAM_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done !== true) {
      entries.delete(oldest.value)
      evicted.add(oldest.value)
    }
  }
  return { entry, expired }
}

/** 数值取值收敛：非有限值回落默认值，其余夹到区间内；声明了 step 时再按步长对齐。 */
function coerceNumber(param: GenuiNumberParam, raw: GenuiParamValue): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return param.default
  const clamped = Math.min(param.max, Math.max(param.min, raw))
  if (param.step === undefined) return clamped
  const snapped = param.min + Math.round((clamped - param.min) / param.step) * param.step
  return Number(Math.min(param.max, Math.max(param.min, snapped)).toFixed(NUMBER_PRECISION))
}

/** 枚举取值收敛：不在选项里的值回落默认值，不把非法值留在状态里。 */
function coerceSelect(param: GenuiSelectParam, raw: GenuiParamValue): string {
  if (typeof raw !== 'string') return param.default
  return param.options.some((option) => option.value === raw) ? raw : param.default
}

/** 布尔取值收敛：非布尔值回落默认值。 */
function coerceToggle(param: GenuiToggleParam, raw: GenuiParamValue): boolean {
  return typeof raw === 'boolean' ? raw : param.default
}

/**
 * 文本取值收敛：非字符串回落默认值；换行折成空格并按上限截断。
 * 不做 trim：输入过程中用户可能刚敲了空格，静默剥除会让光标后的字符被吞。
 * 折行放在这里而不是提交层，是为了让内存里的取值与输入框显示的内容始终一致。
 */
function coerceText(param: GenuiTextParam, raw: GenuiParamValue): string {
  if (typeof raw !== 'string') return param.default
  return raw.replace(/[\r\n]+/g, ' ').slice(0, GENUI_MAX_PARAM_TEXT_CHARS)
}

/** 按参数类型收敛一次写入；未知类型不会被协议放行，这里只保证函数是全函数。 */
function coerceValue(param: GenuiParam, raw: GenuiParamValue): GenuiParamValue {
  switch (param.type) {
    case 'number': return coerceNumber(param, raw)
    case 'select': return coerceSelect(param, raw)
    case 'toggle': return coerceToggle(param, raw)
    case 'text': return coerceText(param, raw)
  }
}

/** 参数上下文：控件组读它渲染，界面根容器读它组装提交文本。 */
export interface GenuiParamContext {
  readonly documentId: string
  readonly params: readonly GenuiParam[]
  /** 当前取值；协议保证每个声明过的参数都有默认值，因此这里按 id 必有一项。 */
  readonly values: Readonly<Record<string, GenuiParamValue>>
  /** 只读：该界面已被更高版本取代，控件与提交都不得生效。 */
  readonly readOnly: boolean
  /** 参数曾因条目淘汰被重置；界面需要提示一次，不默默归零。 */
  readonly expired: boolean
  /** 写入一个参数：越界数值夹到区间，声明了 step 时按步长对齐；类型不符或非有限值回落默认值；未知 id 直接忽略，不抛异常。只读时直接不写。 */
  setValue(id: string, value: GenuiParamValue): void
}

/** 上下文注入键；界面外（无提供者）时控件组静默不渲染，不抛错。 */
const GENUI_PARAM_CONTEXT: InjectionKey<GenuiParamContext> = Symbol('genui-params')

/**
 * 建立并注入参数上下文。必须在组件 setup 期间调用，且一份文档一个组件实例：
 * 界面按 `documentId` 作为 key 挂载，文档被替换时整棵子树重建，取值随之重来。
 * `readOnly` 来自父级：同一界面只有最高版本可交互，其余版本只能看。
 */
export function provideGenuiParams(source: {
  readonly documentId: string
  readonly revision: number
  readonly params: readonly GenuiParam[]
  readonly readOnly?: boolean
}): GenuiParamContext {
  const { entry, expired } = entryFor(source.documentId, source.revision, source.params)
  const byId = new Map(source.params.map((param) => [param.id, param]))
  const readOnly = source.readOnly === true
  const context: GenuiParamContext = {
    documentId: source.documentId,
    params: source.params,
    values: entry.values,
    readOnly,
    expired,
    setValue(id, value) {
      if (readOnly) return
      const param = byId.get(id)
      if (param === undefined) return
      entry.values[id] = coerceValue(param, value)
    }
  }
  provide(GENUI_PARAM_CONTEXT, context)
  return context
}

/** 取当前界面的参数上下文；不在界面内时返回 null，调用方据此不渲染控件。 */
export function useGenuiParams(): GenuiParamContext | null {
  return inject(GENUI_PARAM_CONTEXT, null)
}
