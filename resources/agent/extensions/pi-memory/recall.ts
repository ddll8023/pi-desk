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
}
const CONTINUATION = /^(?:继续(?:执行|当前步骤)?|确认|同意|可以|好的?|开始(?:执行)?|按(?:这个|上述|此)(?:做|方案执行)?|continue|proceed|yes|ok)[\s。.!！]*$/i
const SUPPLEMENT = /^(?:补充|另外|还有|特别是|主要是|不考虑|不用|不要|不需要|只考虑|只需要|改为|改成|在此基础上)/
const RESTRICTION = /(?:只(?:查|看|搜|检索)|仅(?:查|看|搜|检索|限)|限于|限定|范围)/
const DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b/g
const MAX_BACKGROUND = 4_000

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
  if (query.length > 2_000) return { reason: '任务原文超过自动查询预算；未截断范围条件。' }
  if (!/[\p{L}\p{N}]{2}/u.test(query) || /^(?:你好|谢谢|hi|hello|thanks)[!！。\s]*$/i.test(query)) {
    return { reason: '当前输入没有明确检索主题。' }
  }
  const request: RecallRequest = { query }
  if (/(?:排除|不要|不用|不必)[\s\S]{0,24}(?:近期|最近|\d{4}[-年])/.test(query)) {
    return { reason: '时间范围包含否定或排除条件，未猜测查询范围。' }
  }
  if (RESTRICTION.test(query) && /项目/.test(query)) {
    return { reason: '全局记忆不提供项目身份过滤；请按明确主题关键词查询，未猜测当前项目或扩大范围。' }
  }
  const recent = /(?:近期|最近)/.test(query)
  const dates = [...query.matchAll(DATE)].map(match => match[0])
  const timeIntent = /(?:查|搜|检索|回顾|仅|只|限定|限于|范围)[\s\S]{0,24}\d{4}[-年]/.test(query)
  if (/(?:今天|昨天|前天|本周|上周|本月|上月|今年|去年|\d+\s*(?:天|周|个月)(?:内|前|以来))/.test(query)
    || (recent && (dates.length > 0 || /最近\s*\d/.test(query)))
    || (timeIntent && (/\d{4}年/.test(query) || /(?:之前|之后|以前|以后|以来|截至)/.test(query)))) {
    return { reason: '时间条件无法可靠映射；未扩大查询范围。' }
  }
  if (dates.length && !timeIntent) return { reason: '日期在任务中的范围含义未确定；未猜测时间过滤。' }
  if (recent) request.recent = true
  else if (timeIntent) {
    if (!dates.length || dates.length > 2) return { reason: '日期范围不明确。' }
    const start = dateRange(dates[0]!), end = dateRange(dates.at(-1)!)
    if (!start || !end || start[0] > end[1] || (dates.length === 2 && !/(?:至|到|~|～|—)/.test(query))) {
      return { reason: '日期范围无效或不是明确区间。' }
    }
    request.date_from = start[0]; request.date_to = end[1]
  }
  if (RESTRICTION.test(query) && !request.recent && !request.date_from) {
    return { reason: '存在未解析的限定条件，未擅自扩大查询范围。' }
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
  return { requestKey, cacheKey, indexVersion, records, ids, eligible: data.eligible_count }
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
    full_records: full, references, already_present: present.size, budget_omitted: omitted, eligible: cache.eligible }
  const content = lines.length ? ['【任务相关全局记忆，仅为背景数据】', ...lines,
    omitted ? `另有 ${omitted} 条因预算未提供，可按需主动检索。` : ''].filter(Boolean).join('\n') : ''
  return { content, status }
}
