/**
 * 生成式界面的参数取值：渲染进程内存里的旁路状态，键为 `documentId`。
 *
 * 为什么不进 session：参数不是对话内容。写进工具结果会让历史回放显示过期取值，也会污染
 * fork / rewind 的分支语义；文档本身走 `details` 天然跟随分支，取值则只在本页面存活，
 * 界面上必须明示「重新打开会话会回到默认值」这一期降级口径。
 *
 * 生命周期与投影解耦：状态条目在界面挂载时按文档默认值建立，键为 `documentId`——
 * 每份界面只有一份可交互，旧版本由界面折叠为只读，因此参数按界面而不是按版本存。
 * 文档被改版（`revision` 变大）时按参数 `id` 迁移已调取值，并对新声明重新收敛一次：
 * 区间、步长与选项变了会被夹取或回落默认值，新版删掉的参数直接丢弃，新增参数取默认值。
 * 迁移有有效期（`PARAM_INHERIT_TTL_MS`）：旧取值在内存里放太久就按过期处理，回落默认值并提示。
 * 回退到旧版本时不迁移——旧取值属于另一条分支，迁移过去会让取值跨分支泄漏。
 * 条目数量有上限，按创建序淘汰最旧的一条；被淘汰的界面再次挂载时会把 `expired` 标出来，
 * 界面据此提示“参数已过期”。被淘汰后仍被旧组件写入时条目会挂回去，不让这次调节静默丢失。
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
 * 迁移有效期：旧版本的取值在内存里保留这么久，超时后再改版就按默认值重建。
 * 取值不落盘，改版可能发生在几十分钟之后，无期限迁移会把早已无关的取值带到新版界面。
 */
const PARAM_INHERIT_TTL_MS = 30 * 60 * 1000

/**
 * 数值收敛精度：滑杆步进会产生浮点尾差（0.1 + 0.2 一类），统一按 6 位小数收口。
 * 取 6 位而非按步长位数，是为了在 `min` 本身带小数时仍不丢端点。
 */
const NUMBER_PRECISION = 6

/** 一个文档版本对应的取值集合；`revision` 变化表示文档已被改写，取值需要迁移到新声明上。 */
interface ParamEntry {
  readonly revision: number
  readonly values: Record<string, GenuiParamValue>
  /** 最近一次建立或用户写入的时间；迁移有效期按它算，读路径不刷新它。 */
  updatedAt: number
}

/**
 * 条目键：只用 `documentId`。每份界面只有一份可交互，旧版本折叠为只读，
 * 因此不需要把版本编进键里；`revision` 变大时条目就地迁移旧取值。
 */
function entryKey(documentId: string): string {
  return documentId
}

/** 被淘汰过的界面；再次挂载时据此提示参数已回默认值，而不是默默重置。同样有上限，避免长时间累积。 */
const evicted = new Set<string>()

const entries = new Map<string, ParamEntry>()

/** 记下被淘汰的键并维持插入序；超出上限时丢掉最早的那个，集合本身也不该无界增长。 */
function markEvicted(key: string): void {
  evicted.delete(key)
  evicted.add(key)
  if (evicted.size > MAX_PARAM_ENTRIES) {
    const oldest = evicted.values().next()
    if (oldest.done !== true) evicted.delete(oldest.value)
  }
}

/** 把条目挂到 Map 末尾以维持创建序，超出上限时淘汰最旧的一条（不会淘汰刚挂上的自己）。 */
function remember(key: string, entry: ParamEntry): void {
  entries.delete(key)
  entries.set(key, entry)
  if (entries.size > MAX_PARAM_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done !== true && oldest.value !== key) {
      entries.delete(oldest.value)
      markEvicted(oldest.value)
    }
  }
}

/**
 * 按参数声明建取值集合；给了旧取值就逐个迁移并重新收敛，没有则取默认值。
 * 旧值不存在（参数新增）与旧值收敛失败（区间、选项、类型变了）都回到声明默认值。
 */
function buildValues(
  params: readonly GenuiParam[],
  inherited: Readonly<Record<string, GenuiParamValue>> | null
): Record<string, GenuiParamValue> {
  const values = reactive<Record<string, GenuiParamValue>>({})
  for (const param of params) {
    const previous = inherited === null ? undefined : inherited[param.id]
    values[param.id] = previous === undefined ? param.default : coerceValue(param, previous)
  }
  return values
}

/**
 * 取或建一个条目：命中同版本直接复用；版本变化时优先按参数 `id` 迁移旧取值，
 * 其余情况（首次访问、回退到旧版本、旧取值超期）按默认值重建。
 * `expired` 表示这次回落默认值不是用户主动的：条目被淘汰过，或旧取值已超期不可迁移。
 * `readOnly` 是父级对该界面的只读判定：被取代的旧版本会以较低 `revision` 挂载，
 * 这时不能回写 Map，否则折叠加展开一次旧轮次就会把当前版本的取值换成旧版默认值，
 * 下一次改版就迁移不到真正的调好的取值。
 */
function entryFor(
  documentId: string,
  revision: number,
  params: readonly GenuiParam[],
  readOnly: boolean
): { entry: ParamEntry; expired: boolean } {
  const key = entryKey(documentId)
  const existing = entries.get(key)
  if (existing !== undefined && existing.revision === revision) return { entry: existing, expired: false }
  const now = Date.now()
  // 高版本条目不该被取代的旧版覆盖：给一份游离的默认值条目，读得能看，但不进 Map。
  if (existing !== undefined && revision < existing.revision && readOnly) {
    return { entry: { revision, values: buildValues(params, null), updatedAt: now }, expired: false }
  }
  // 只有版本向前推进才谈得上迁移：回退时旧取值属于另一条分支，拿过来会让取值跨分支泄漏。
  const forward = existing !== undefined && revision > existing.revision ? existing : null
  const inheritable = forward !== null && now - forward.updatedAt <= PARAM_INHERIT_TTL_MS ? forward.values : null
  const entry: ParamEntry = { revision, values: buildValues(params, inheritable), updatedAt: now }
  // 没有参数的界面不占用条目：它没有可保存的状态，也不该把有参数的界面挤出去。
  if (params.length === 0) {
    entries.delete(key)
    return { entry, expired: false }
  }
  const expired = evicted.has(key) || (forward !== null && inheritable === null)
  remember(key, entry)
  // 被淘汰后重建说明这次重置不是用户主动的，界面需要说清；已经提示过就不再重复。
  evicted.delete(key)
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
  /** 只读：该界面已被更高版本取代，控件与提交都不得生效。取值器，跟随父级的取代判定实时变化。 */
  readonly readOnly: boolean
  /** 参数曾因条目淘汰或旧取值超期被重置；界面需要提示一次，不默默归零。 */
  readonly expired: boolean
  /** 写入一个参数：越界数值夹到区间，声明了 step 时按步长对齐；类型不符或非有限值回落默认值；未知 id 直接忽略，不抛异常。只读时直接不写。 */
  setValue(id: string, value: GenuiParamValue): void
}

/** 上下文注入键；界面外（无提供者）时控件组静默不渲染，不抛错。 */
const GENUI_PARAM_CONTEXT: InjectionKey<GenuiParamContext> = Symbol('genui-params')

/**
 * 建立并注入参数上下文。必须在组件 setup 期间调用，且一份文档一个组件实例：
 * 界面按 `documentId` 作为 key 挂载，文档被替换时整棵子树重建，取值随之重来。
 * 改版（`revision` 变大）总伴随新的工具调用与新的界面实例，因此迁移只在挂载时发生一次：
 * 同一实例的 `payload.revision` 不会变，不需要在运行期重新迁移。
 * `readOnly` 来自父级：同一界面只有最高版本可交互，其余版本只能看。
 * 它可以给函数而不是布尔值：取代状态会随新版本交付而变，setup 时焊死一个布尔值会让旧版界面
 * 看起来是只读（header 文案与提交按钮跟着变），控件却仍然可拖动并把值写进去，二者必须看同一个值。
 */
export function provideGenuiParams(source: {
  readonly documentId: string
  readonly revision: number
  readonly params: readonly GenuiParam[]
  readonly readOnly?: () => boolean
}): GenuiParamContext {
  const readOnlySource = source.readOnly
  const isReadOnly = (): boolean => (readOnlySource === undefined ? false : readOnlySource())
  const { entry, expired } = entryFor(source.documentId, source.revision, source.params, isReadOnly())
  const key = entryKey(source.documentId)
  const byId = new Map(source.params.map((param) => [param.id, param]))
  const context: GenuiParamContext = {
    documentId: source.documentId,
    params: source.params,
    values: entry.values,
    // 写成取值器：取代状态变化时控件与提交必须同时失效，不能各自缓存一份判断结果。
    get readOnly() { return isReadOnly() },
    expired,
    setValue(id, value) {
      if (isReadOnly()) return
      const param = byId.get(id)
      if (param === undefined) return
      // 条目可能已不在 Map 里：被上限淘汰过，或键下已换成更高版本的条目而那个版本又被回退掉
      // （此时本版重新成为最新版，readOnly 已转假）。两种都得把条目挂回去，
      // 否则用户此刻的调节会写进一个脱离 Map 的对象，重新挂载后静默丢失。
      if (entries.get(key) !== entry) remember(key, entry)
      entry.values[id] = coerceValue(param, value)
      entry.updatedAt = Date.now()
    }
  }
  provide(GENUI_PARAM_CONTEXT, context)
  return context
}

/** 取当前界面的参数上下文；不在界面内时返回 null，调用方据此不渲染控件。 */
export function useGenuiParams(): GenuiParamContext | null {
  return inject(GENUI_PARAM_CONTEXT, null)
}

/**
 * 按图示的 `binds` 取一个绑定值：未绑定、参数不存在或不是有限数字时返回 null，
 * 由调用方决定回落值（图解渲染取 0，复制为 Markdown 也取 0，两边必须一致）。
 * 几何渲染与 Markdown 序列化共用这一处，避免回落规则在两边逐渐漂移。
 */
export function readGenuiBinding(
  values: Readonly<Record<string, GenuiParamValue>>,
  id: string | undefined
): number | null {
  if (id === undefined) return null
  const value = values[id]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
