/** 从完整工具参数与结果提取有界展示摘要；不读文件、不再次检索、不转发任意 details。 */
import { TOOL_PRESENTATION_LIMITS as LIMITS } from '../../shared/runtime/projection'
import type {
  ToolPresentationFact, ToolPresentationItem, ToolRequestPresentation, ToolResultPresentation
} from '../../shared/runtime/projection'
import { getToolOperation, toolLocalName } from '../../shared/tool-operation'

/** 只有无结构化结果时才尝试解析文本 JSON；超限保留原文入口，不阻塞展示。 */
const MAX_JSON_CHARS = 262_144
interface Clipped { readonly text: string; readonly clipped: boolean }
function clip(value: string, limit: number): Clipped {
  return value.length <= limit ? { text: value, clipped: false }
    : { text: `${value.slice(0, Math.max(0, limit - 1))}…`, clipped: true }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function firstString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const entry = value[key]
    if (typeof entry === 'string' && entry.trim() !== '') return entry
  }
  return null
}
function scalar(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value
    : typeof value === 'boolean' ? (value ? '是' : '否')
      : typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function countAt(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) { const number = count(value[key]); if (number !== null) return number }
  return null
}
function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.slice(0, limit).filter((part): part is string => typeof part === 'string') : []
}
function fact(label: string, value: string): ToolPresentationFact {
  return { label: clip(label, LIMITS.label).text, value: clip(value, LIMITS.value).text }
}

export function summarizeToolRequest(toolName: string, args: unknown): ToolRequestPresentation | null {
  if (!record(args)) return null
  const operation = getToolOperation(toolName)
  const local = toolLocalName(toolName)
  const preferred = operation.kind.endsWith('-search') ? ['query', 'queries', 'pattern', 'claim', 'url', 'urls']
    : operation.kind === 'terminal' ? ['command']
      : ['path', 'file_path', 'findText', 'query', 'url', 'urls', 'ids', 'domain', 'action', 'name', 'ref', 'key']
  let subject: string | null = null
  let truncated = false
  for (const key of preferred) {
    const value = args[key]
    const plain = scalar(value)
    if (plain !== null) { subject = plain; break }
    if (Array.isArray(value)) {
      const values = strings(value, LIMITS.items)
      if (values.length > 0) {
        subject = values.join('；')
        truncated = value.length > values.length
        break
      }
    }
  }
  if (local === 'skill_guard_select' && Array.isArray(args.skills)) {
    const names = args.skills.slice(0, LIMITS.items).flatMap(item => record(item) && typeof item.name === 'string' ? [item.name] : [])
    subject = names.length > 0 ? names.join('、') : subject
    truncated ||= args.skills.length > names.length
  }
  const facts: ToolPresentationFact[] = []
  const fields = [
    ['path', '路径'], ['project_id', '项目过滤'], ['mode', '请求模式'], ['month', '月份'],
    ['exclude', '排除'], ['caseSensitive', '区分大小写'], ['provider', '提供方'],
    ['domain', '领域'], ['offset', '偏移'], ['limit', '上限'], ['findMode', '匹配方式']
  ] as const
  for (const [key, label] of fields) {
    const value = scalar(args[key])
    if (value === null || value === subject) continue
    if (facts.length === LIMITS.facts) { truncated = true; break }
    truncated ||= value.length > LIMITS.value
    facts.push(fact(label, value))
  }
  if (Array.isArray(args.queries) && facts.length < LIMITS.facts) facts.push(fact('查询数', String(args.queries.length)))
  if (Array.isArray(args.ids) && facts.length < LIMITS.facts) facts.push(fact('记录数', String(args.ids.length)))
  const clipped = subject === null ? null : clip(subject, LIMITS.subject)
  return { subject: clipped?.text ?? null, facts, truncated: truncated || clipped?.clipped === true }
}

/** 历史提取只拼接有界文本；实时路径可以直接复用投影已提取的完整字符串。 */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, MAX_JSON_CHARS + 1)
  if (!record(result)) return ''
  if (typeof result.content === 'string') return result.content.slice(0, MAX_JSON_CHARS + 1)
  if (!Array.isArray(result.content)) return ''
  let text = ''
  for (const block of result.content) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    const separator = text === '' ? '' : '\n'
    const remaining = MAX_JSON_CHARS + 1 - text.length - separator.length
    if (remaining <= 0) break
    text += separator + block.text.slice(0, remaining)
    if (text.length > MAX_JSON_CHARS) break
  }
  return text
}
function dataFromResult(result: unknown, text: string, allowTextJson: boolean): unknown {
  if (record(result)) {
    if (result.structuredContent !== undefined) return result.structuredContent
    const details = result.details
    if (record(details) && ['matches', 'results', 'hits', 'files', 'records', 'rules', 'profiles',
      'scope', 'total_matches', 'status', 'error', 'committed', 'cancelled'].some(key => key in details)) return details
  }
  if (!allowTextJson) return null
  const trimmed = text.trim()
  if (trimmed.length > MAX_JSON_CHARS || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null
  try { return JSON.parse(trimmed) as unknown } catch { return null }
}
function messageOf(error: unknown): string | null {
  if (typeof error === 'string' && error.trim() !== '') return error
  return record(error) ? firstString(error, ['message', 'reason', 'type', 'code']) : null
}
function rowsOf(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value
  if (!record(value)) return null
  for (const key of ['matches', 'results', 'hits', 'files', 'records', 'rules', 'profiles']) {
    const rows = value[key]
    if (Array.isArray(rows)) return rows
  }
  return null
}
function moreOf(value: Record<string, unknown>): boolean | null {
  for (const key of ['has_more', 'hasMore', 'has_more_matches']) {
    const more = value[key]
    if (typeof more === 'boolean') return more
  }
  // 只承认明确的后续位置；通用 cursor 也可能是请求回显，不据此猜下一页。
  if (count(value.next_offset) !== null || firstString(value, ['next_cursor', 'nextCursor']) !== null) return true
  return null
}
function resultFacts(toolName: string, data: Record<string, unknown>): ToolPresentationFact[] {
  const facts: ToolPresentationFact[] = []
  const scope = record(data.requested_scope) ? data.requested_scope : null
  const project = Object.hasOwn(data, 'project_id') ? data.project_id : scope?.project_id
  const projectScoped = ['memory_search', 'memory_rules', 'memory_read'].includes(toolLocalName(toolName))
  const globalMemory = data.memory_scope === 'global' || scope?.memory_scope === 'global'
  if (globalMemory) facts.push(fact('实际范围', '用户级全局记忆'))
  else if (project === null && projectScoped) facts.push(fact('实际范围', '全局（未限定项目）'))
  else if (typeof project === 'string') facts.push(fact(projectScoped ? '实际项目' : '报告项目', project))
  const scopeNames: Readonly<Record<string, string>> = {
    all_daily: '全部日记', recent_daily: '近期日记', historical_month_summaries: '历史月摘要', monthly_summary: '指定月摘要'
  }
  if (typeof data.scope === 'string') facts.push(fact('检索对象', (Object.hasOwn(scopeNames, data.scope) ? scopeNames[data.scope] : undefined) ?? data.scope))
  for (const [key, label] of [['month', '月份'], ['offset', '返回偏移'], ['coverage', '覆盖口径'], ['index_version', '索引版本']] as const) {
    const value = scalar(data[key])
    if (value !== null) facts.push(fact(label, value))
  }
  return facts.slice(0, LIMITS.facts)
}
function toItem(value: unknown, scoreLabel: string, memoryItem: boolean): { readonly item: ToolPresentationItem; readonly clipped: boolean } | null {
  if (typeof value === 'string') {
    const title = clip(value, LIMITS.title)
    return { item: { title: title.text, location: null, excerpt: null, evidence: null, meta: null }, clipped: title.clipped }
  }
  if (!record(value)) return null
  const source = record(value.source) ? value.source : null
  const title = firstString(value, ['topic', 'title', 'name', 'file_path', 'path', 'url', 'id'])
    ?? (source === null ? null : firstString(source, ['title', 'file', 'path', 'url']))
  const text = firstString(value, ['snippet', 'summary', 'content', 'description', 'text', 'line_text'])
    ?? strings(value.highlights, 2).join('\n')
  if (title === null && text === '') return null
  let location = firstString(value, ['file_path', 'path', 'url'])
    ?? (source === null ? null : firstString(source, ['file', 'path', 'url']))
  const line = countAt(value, ['line_number', 'lineNumber', 'line'])
  if (location !== null && line !== null) location += `:${line}`
  const evidenceParts: string[] = []
  const terms = strings(value.matched_terms, 8)
  if (terms.length > 0) evidenceParts.push(`命中：${terms.join('、')}`)
  evidenceParts.push(...strings(value.reasons, 2))
  const metaParts: string[] = []
  const date = firstString(value, ['date', 'month'])
  const project = firstString(value, ['source_project', 'project_id', 'project'])
    ?? (source === null ? null : firstString(source, ['source_project']))
  if (date !== null) metaParts.push(date)
  if (project !== null) metaParts.push(`${memoryItem ? '历史来源项目' : '项目'} ${project}`)
  if (memoryItem && value.status === 'superseded') metaParts.push('历史版本 · 已被替代')
  else if (memoryItem && value.status === 'active') metaParts.push(value.type === 'decision' || value.type === 'constraint' ? '当前有效版本' : '已保存记录')
  else if (typeof value.status === 'string') metaParts.push(`工具报告状态 ${value.status}`)
  if (typeof value.score === 'number' && Number.isFinite(value.score)) metaParts.push(`${scoreLabel} ${value.score.toFixed(3)}`)
  const fields = [
    clip(title ?? '返回内容', LIMITS.title), clip(location ?? '', LIMITS.location),
    clip(text, LIMITS.excerpt), clip(evidenceParts.join('；'), LIMITS.evidence), clip(metaParts.join(' · '), LIMITS.meta)
  ]
  const [heading, target, excerpt, evidence, meta] = fields
  if (heading === undefined || target === undefined || excerpt === undefined || evidence === undefined || meta === undefined) return null
  return { item: { title: heading.text, location: target.text || null, excerpt: excerpt.text || null,
    evidence: evidence.text || null, meta: meta.text || null }, clipped: fields.some(field => field.clipped) }
}

interface PlainSearchPreview {
  readonly items: readonly ToolPresentationItem[]
  readonly facts: readonly ToolPresentationFact[]
  readonly summary: string
  readonly hasMore: boolean | null
  readonly previewTruncated: boolean
}
function pathLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\.?\.?[\\/]|[^\s:]+[\\/])/.test(value) || /^[^\s:]+\.[A-Za-z0-9_-]+$/.test(value)
}
/** 只识别已知文本格式中的可见位置，不从局部行数推导工具总命中数。 */
function plainSearchPreview(toolName: string, text: string): PlainSearchPreview | null {
  const local = toolLocalName(toolName)
  const kind = getToolOperation(toolName).kind
  if (!kind.endsWith('-search') || kind === 'memory-search') return null
  const bounded = text.slice(0, 16_384)
  const lines = bounded.split('\n').slice(0, 200)
  const items: ToolPresentationItem[] = []
  const seen = new Set<string>()
  let visible = 0
  let currentPath: string | null = null
  let clippedFields = false
  if (kind === 'file-search' || kind === 'code-search') {
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (kind === 'file-search') {
        const path = line.trim()
        if (!pathLike(path) || seen.has(path)) continue
        seen.add(path); visible++
        clippedFields ||= path.length > LIMITS.location || (path.split(/[\\/]/).at(-1)?.length ?? 0) > LIMITS.title
        if (items.length < LIMITS.items) items.push({ title: clip(path.split(/[\\/]/).at(-1) ?? path, LIMITS.title).text,
          location: clip(path, LIMITS.location).text, excerpt: null, evidence: '结果原文中的文件候选', meta: null })
        continue
      }
      // ffgrep 按文件分组，匹配行为“行号:”，上下文行为“行号-”；后者不能计入匹配。
      if (local === 'ffgrep' && pathLike(line.trim()) && !/^\s/.test(line) && !/^.+?:\d+:/.test(line)) {
        currentPath = line.trim(); continue
      }
      const grouped = local === 'ffgrep' ? /^\s+(\d+):\s?(.*)$/.exec(line) : null
      const inline = /^(.+?):(\d+):\s?(.*)$/.exec(line)
      const path = grouped !== null ? currentPath : inline?.[1] ?? null
      const number = grouped?.[1] ?? inline?.[2]
      const content = grouped?.[2] ?? inline?.[3] ?? ''
      if (path === null || number === undefined || !pathLike(path)) continue
      visible++
      clippedFields ||= path.length + number.length + 1 > LIMITS.location || content.length > LIMITS.excerpt
        || (path.split(/[\\/]/).at(-1)?.length ?? 0) > LIMITS.title
      if (items.length < LIMITS.items) items.push({ title: clip(path.split(/[\\/]/).at(-1) ?? path, LIMITS.title).text,
        location: clip(`${path}:${number}`, LIMITS.location).text, excerpt: clip(content, LIMITS.excerpt).text,
        evidence: '结果原文中的匹配行', meta: null })
    }
  } else if (kind === 'web-search') {
    const links = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
    for (const match of bounded.matchAll(links)) {
      const title = match[1]; const url = match[2]
      if (title === undefined || url === undefined || seen.has(url)) continue
      seen.add(url); visible++
      clippedFields ||= title.length > LIMITS.title || url.length > LIMITS.location
      if (items.length < LIMITS.items) items.push({ title: clip(title, LIMITS.title).text,
        location: clip(url, LIMITS.location).text, excerpt: null, evidence: '结果原文中的来源链接', meta: null })
    }
  }
  if (visible === 0) return null
  const label = kind === 'code-search' ? '可见匹配行' : kind === 'file-search' ? '可见文件候选' : '可见来源链接'
  const more = /^\[(?:Continue with cursor="[^"]+"|\d+ more matches available\. cursor="[^"]+" to continue)\]\s*$/m.test(text)
  const summary = kind === 'code-search' ? `当前预览：${visible} 处匹配`
    : kind === 'file-search' ? `当前预览：${visible} 个文件候选` : `当前预览：${visible} 个来源链接`
  return { items, facts: [fact(label, String(visible))], summary, hasMore: more ? true : null,
    previewTruncated: clippedFields || visible > items.length || text.length > bounded.length || bounded.split('\n').length > lines.length }
}

export interface ResultPresentationOptions {
  readonly isError: boolean
  readonly partial?: boolean
  readonly text?: string
}

export function summarizeToolResult(
  toolName: string, result: unknown, options: ResultPresentationOptions
): ToolResultPresentation {
  const text = options.text ?? resultText(result)
  const operation = getToolOperation(toolName)
  const local = toolLocalName(toolName)
  // 文件、网页正文与命令输出里的 JSON 不一定是工具协议，不能据其中的 ok/error 判定调用失败。
  const protocolText = operation.kind.endsWith('-search') || local.startsWith('memory_')
    || ['skill_guard_select', 'mcp_status', 'mcp_connect', 'web_enable'].includes(local)
  const parsed = dataFromResult(result, text, protocolText)
  const envelope = record(parsed) ? parsed : null
  const value = envelope !== null && Object.hasOwn(envelope, 'data') ? envelope.data : parsed
  const data = record(value) ? value : null
  const error = envelope?.ok === false ? messageOf(envelope.error) ?? '工具报告失败'
    : data?.ok === false || data?.status === 'error' ? messageOf(data?.error) ?? '查询失败' : null
  const cancelled = data?.cancelled === true
  // 未知工具不解释任意数组或对象的业务含义，只保留身份与有界原文预览。
  const countable = operation.kind.endsWith('-search') || ['memory_read', 'memory_profiles', 'ls'].includes(local)
  const rows = countable ? rowsOf(value) : null
  const plainPreview = rows === null ? plainSearchPreview(toolName, text) : null
  const returnedCount = rows?.length ?? (data === null || !countable ? null : countAt(data, ['returned', 'returned_count']))
  let totalCount = data === null || !countable ? null : countAt(data, ['total_matches', 'totalMatched', 'total_count', 'totalResults'])
  const inconsistentCount = returnedCount !== null && totalCount !== null && totalCount < returnedCount
  if (inconsistentCount) totalCount = null
  const items: ToolPresentationItem[] = []
  let previewTruncated = rows !== null && rows.length > LIMITS.items
  for (const row of rows?.slice(0, LIMITS.items) ?? []) {
    const preview = toItem(row, operation.kind === 'memory-search' ? '词法相关度' : '工具评分',
      operation.kind === 'memory-search' || ['memory_read', 'memory_profiles'].includes(local))
    if (preview !== null) { items.push(preview.item); previewTruncated ||= preview.clipped }
  }
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  let note: string | null = inconsistentCount ? '工具报告的数量口径不一致，未展示总匹配数。'
    : rows !== null && rows.length > 0 && items.length === 0 ? '条目结构未识别，可展开原文查看。' : null
  let summary: string | null = null
  let outcome: ToolResultPresentation['outcome'] = 'unknown'
  if (options.isError || error !== null) {
    outcome = 'error'; summary = error ?? (firstLine || '工具执行失败')
  } else if (cancelled) {
    outcome = 'cancelled'; summary = data?.committed === false ? '已取消，未提交本次计划' : '工具报告操作已取消'
    if (data?.committed !== false) note = '取消状态不表示已执行的操作被撤销。'
  } else if (data?.status === 'MONTHLY_SUMMARY_MISSING') {
    summary = '指定月份的摘要不可用'; note = '摘要缺失不等于没有历史日记。'
  } else if (rows !== null) {
    outcome = rows.length === 0 ? 'empty' : 'result'
    summary = rows.length === 0 ? '没有返回匹配条目' : null
  } else if (data?.no_match === true) {
    outcome = 'empty'; summary = '无相关命中'
  } else if (plainPreview !== null) {
    outcome = 'result'; summary = plainPreview.summary
    items.push(...plainPreview.items)
    previewTruncated ||= plainPreview.previewTruncated
    note = note ?? '可见条目数仅来自当前文本预览，不代表工具的总匹配数。'
  } else if (text !== '') {
    const jsonShaped = text.trimStart().startsWith('{') || text.trimStart().startsWith('[')
    summary = jsonShaped ? '已返回结构化结果' : operation.kind === 'terminal' ? '命令输出已返回' : '文本结果已返回'
    if (jsonShaped) note = text.length > MAX_JSON_CHARS ? '结果超出语义解析上限，可展开原文查看。' : '未识别专用结果结构，可展开原文查看。'
    else {
      const excerpt = clip(text, LIMITS.excerpt)
      items.push({ title: '原文预览', location: null, excerpt: excerpt.text, evidence: null, meta: null })
      previewTruncated ||= excerpt.clipped
    }
  } else summary = '没有文本结果'
  if (options.partial === true && outcome !== 'error' && outcome !== 'cancelled') outcome = 'partial'
  const facts = data === null || operation.kind === 'tool' ? [] : resultFacts(toolName, data)
  if (plainPreview !== null && outcome === 'result') facts.push(...plainPreview.facts.slice(0, LIMITS.facts - facts.length))
  return {
    outcome, summary: summary === null ? null : clip(summary, LIMITS.note).text,
    returnedCount, totalCount, hasMore: (data === null || !countable ? null : moreOf(data)) ?? plainPreview?.hasMore ?? null,
    truncated: data?.truncated === true || data?.isTruncated === true,
    previewTruncated, facts, items, note: note === null ? null : clip(note, LIMITS.note).text
  }
}
