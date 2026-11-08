/** 用户任务驱动的全局召回与有界背景；不映射项目身份、不调用额外模型或写入记忆。 */
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { array, object, text } from './engine.ts'
import type { JsonObject } from './engine.ts'

export interface RecallRequest extends JsonObject {
  query: string
  recent?: boolean
  date_from?: string
  date_to?: string
}
export type TaskSelection = { request: RecallRequest } | { reason: string }
export interface RecallCache {
  requestKey: string
  cacheKey: string
  indexVersion: string
  records: JsonObject[]
  ids: string[]
  eligible: number
  /** 无命中时引擎给出的具体原因；有命中时为 null。 */
  reason: string | null
}
const CONTINUATION = /^(?:继续(?:执行|当前步骤)?|确认|同意|可以|好的?|开始(?:执行)?|按(?:这个|上述|此)(?:做|方案执行)?|continue|proceed|yes|ok)[\s。.!！]*$/i
const SUPPLEMENT = /^(?:补充|另外|还有|特别是|主要是|不考虑|不用|不要|不需要|只考虑|只需要|改为|改成|在此基础上)/
const DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b/g
const MAX_BACKGROUND = 4_000
/** 超长任务原文的降级预算：只取首段完整语义单元，不把长度当成放弃召回的理由。 */
const MAX_QUERY = 600

function userText(message: AgentMessage): string | null {
  if (message.role !== 'user') return null
  const value = typeof message.content === 'string' ? message.content
    : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const trimmed = value.trim()
  return trimmed.startsWith('以下是 pi-memory 为本次请求提供的') ? null : trimmed
}

export function memoryDisabledByRequest(messages: readonly AgentMessage[]): boolean {
  const users = messages.map(userText).filter((value): value is string => value !== null).slice(-24)
  for (let index = users.length - 1; index >= 0; index--) {
    const value = users[index]!
    if (CONTINUATION.test(value)) continue
    if (/(?:不要|不用|不必|无需|禁止|别)(?:再)?(?:使用|读取|检索|调用|加载|参考)?\s*(?:任何|历史|已有|长期)?\s*(?:记忆|memory)/i.test(value)) return true
    if (!SUPPLEMENT.test(value)) break
  }
  return false
}

function dateRange(value: string): [string, string] | null {
  const parts = value.split('-').map(Number)
  const year = parts[0]!, month = parts[1]!, day = parts[2]
  if (year < 1000 || month < 1 || month > 12) return null
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day !== undefined && (day < 1 || day > last)) return null
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  return day === undefined ? [`${prefix}-01`, `${prefix}-${last}`] : [value, value]
}

/** 超长任务原文的首段片段：在句末或换行处截断，保留完整语义单元。 */
function degradeQuery(query: string): string {
  const clipped = query.slice(0, MAX_QUERY)
  const boundary = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('！'),
    clipped.lastIndexOf('？'), clipped.lastIndexOf('\n'), clipped.lastIndexOf('. '))
  return boundary >= 120 ? clipped.slice(0, boundary + 1) : clipped
}

/** 只从当前仍可见的用户任务提取关键词与明确时间，不以当前工作目录补充查询范围。 */
export function selectTask(messages: readonly AgentMessage[]): TaskSelection {
  const users = messages.map(userText).filter((value): value is string => value !== null).slice(-24)
  const fragments: string[] = []
  let anchored = false
  for (let index = users.length - 1; index >= 0; index--) {
    const value = users[index]!
    if (!value || CONTINUATION.test(value)) continue
    fragments.unshift(value)
    if (!SUPPLEMENT.test(value)) { anchored = true; break }
  }
  if (!anchored) return { reason: '没有可确定的任务原文；未从摘要猜测或加载热门记忆。' }
  const query = fragments.join('\n')
  // 超长任务原文降级为首段片段：长度不是放弃整轮召回的理由，也不扩大查询范围。
  const bounded = query.length > 2_000 ? degradeQuery(query) : query
  if (!/[\p{L}\p{N}]{2}/u.test(bounded) || /^(?:你好|谢谢|hi|hello|thanks)[!！。\s]*$/i.test(bounded)) {
    return { reason: '当前输入没有明确检索主题。' }
  }
  const request: RecallRequest = { query: bounded }
  // 时间与项目限定不再直接放弃：全局库本身没有项目过滤；时间无法可靠映射时按无时间过滤检索。
  const recent = /(?:近期|最近)/.test(bounded)
  const dates = [...bounded.matchAll(DATE)].map(match => match[0])
  const timeIntent = /(?:查|搜|检索|回顾|仅|只|限定|限于|范围)[\s\S]{0,24}\d{4}[-年]/.test(bounded)
  if (recent) request.recent = true
  else if (timeIntent && dates.length >= 1 && dates.length <= 2) {
    const start = dateRange(dates[0]!), end = dateRange(dates.at(-1)!)
    if (start && end && start[0] <= end[1] && (dates.length === 1 || /(?:至|到|~|～|—)/.test(bounded))) {
      request.date_from = start[0]; request.date_to = end[1]
    }
  }
  return { request }
}

function hash(value: unknown): string {
  const result = text(value, '来源版本')
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error('自动召回来源版本无效')
  return result
}

export function acceptRecall(data: JsonObject, request: RecallRequest, previous?: RecallCache): RecallCache {
  if (data.policy !== 'lexical-global-background-v2' || data.coverage !== 'indexed_sources') throw new Error('自动召回协议不匹配')
  const scope = object(data.scope, '召回范围')
  if (scope.memory_scope !== 'global' || (!request.recent
    && (scope.date_from !== (request.date_from ?? null) || scope.date_to !== (request.date_to ?? null)))) {
    throw new Error('自动召回范围不一致，未展示')
  }
  const cacheKey = hash(data.cache_key), indexVersion = hash(data.index_version)
  const ids = array(data.ids).map(value => text(value, '记录 ID'))
  if (ids.length > 6 || new Set(ids).size !== ids.length || ids.some(id => !/^m_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))) {
    throw new Error('自动召回记录身份无效')
  }
  const requestKey = JSON.stringify(request)
  if (data.unchanged === true) {
    if (!previous || previous.requestKey !== requestKey || previous.cacheKey !== cacheKey
      || previous.indexVersion !== indexVersion || JSON.stringify(previous.ids) !== JSON.stringify(ids)) {
      throw new Error('未取得与本请求一致的缓存确认')
    }
    return previous
  }
  if (data.unchanged !== false) throw new Error('自动召回缓存状态无效')
  const records = array(data.matches).map((value, index) => {
    const row = object(value), date = text(row.date)
    text(row.content); text(row.topic); text(row.title)
    if (row.id !== ids[index] || row.status !== 'active' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !/^daily\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(text(row.file_path))
      || !['decision', 'constraint', 'fact', 'progress', 'issue', 'preference_evidence'].includes(text(row.type))
      || (typeof scope.date_from === 'string' && date < scope.date_from)
      || (typeof scope.date_to === 'string' && date > scope.date_to)) throw new Error('自动召回身份或生命周期无效')
    return row
  })
  if (records.length !== ids.length || data.no_match !== (ids.length === 0)
    || typeof data.eligible_count !== 'number' || !Number.isSafeInteger(data.eligible_count)
    || data.eligible_count < ids.length) throw new Error('自动召回数量不一致')
  // 无命中原因只接受固定枚举；有命中时必须为空，避免把旧原因带进新结果。
  const rawReason = data.reason ?? null
  const reason = rawReason === null ? null : text(rawReason, '无命中原因')
  if (ids.length === 0 ? !['no_terms', 'no_overlap', 'below_threshold'].includes(reason ?? '')
    : reason !== null) throw new Error('自动召回无命中原因不一致')
  return { requestKey, cacheKey, indexVersion, records, ids, eligible: data.eligible_count, reason }
}

/** 完整同版本工具原文才作为去重证据，摘要与历史来源同名均不能替代。 */
function presentRecords(messages: readonly AgentMessage[], cache: RecallCache): Set<string> {
  const present = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.isError
      || !['memory_read', 'memory_search', 'memory_rules'].includes(message.toolName)) continue
    try {
      const body = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const envelope = object(JSON.parse(body))
      if (envelope.ok !== true) continue
      const data = object(envelope.data)
      if (data.index_version !== cache.indexVersion) continue
      const values = data.records ?? data.matches ?? data.rules
      if (!Array.isArray(values)) continue
      for (const value of values) {
        const row = object(value)
        if (cache.records.some(record => record.id === row.id && record.content === row.content
          && record.status === row.status && record.file_path === row.file_path)) present.add(text(row.id))
      }
    } catch { /* 不完整输出不作为已读证明。 */ }
  }
  return present
}

export function renderRecall(cache: RecallCache, messages: readonly AgentMessage[]): { content: string; status: JsonObject } {
  const present = presentRecords(messages, cache)
  const lines: string[] = []
  let full = 0, references = 0, omitted = 0, used = 300
  for (const row of cache.records) {
    if (present.has(text(row.id))) continue
    const metadata = { id: row.id, date: row.date, title: row.title, status: row.status, source: row.file_path,
      source_project: row.project_id ?? null,
      applicability: '用户级全局库中的参考；历史来源和有效状态不证明适用于当前任务。' }
    const complete = JSON.stringify({ ...metadata, content: row.content })
    if (used + complete.length + 1 <= MAX_BACKGROUND) {
      lines.push(complete); used += complete.length + 1; full++
    } else {
      const pointer = JSON.stringify({ ...metadata, content_omitted: '预算不足，未截断原文；需要时按 ID 调用 memory_read。' })
      if (used + pointer.length + 1 <= MAX_BACKGROUND) {
        lines.push(pointer); used += pointer.length + 1; references++
      } else omitted++
    }
  }
  const status = { status: cache.ids.length === 0 ? 'no_match' : lines.length ? 'provided'
    : omitted ? 'budget_omitted' : 'already_present', selected: cache.ids.length,
    full_records: full, references, already_present: present.size, budget_omitted: omitted,
    eligible: cache.eligible, reason: cache.reason }
  // 无命中不静默：明确告知“没有命中”与原因，而不是留一个没有正文的小节标题。
  const empty = cache.ids.length === 0
    ? [`未命中（${cache.reason === 'no_terms' ? '查询没有可用词项'
      : cache.reason === 'no_overlap' ? '没有词项重叠' : '相关度低于注入门槛'}）；需要历史细节时可按关键词调用 memory_search。`]
    : []
  const content = [...empty, ...(lines.length ? ['【任务相关历史，仅供参考】', ...lines,
    omitted ? `另有 ${omitted} 条因预算未提供，可按需主动检索。` : ''] : [])].filter(Boolean).join('\n')
  return { content, status }
}
