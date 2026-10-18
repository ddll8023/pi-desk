/** 当前分支的按轮历史与分段原文投影；只消费SDK条目，不读取任意文件、不拥有会话。 */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { HistoryChunk, HistoryData, HistoryPage, HistoryQuery, ProjectionMessage } from '../shared/runtime-api'
import { MessageProjection } from './message-projection'
import { summarizeToolArguments } from './tool-projection'
import { parseGenuiPayload } from '../shared/genui-api'

const PAGE_TURNS = 8
const DETAIL_ENTRIES = 32
const BLOCK_CHARS = 8_192
const PAGE_CHARS = 262_144
const TEXT_CHARS = 262_144

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function user(entry: SessionEntry | undefined): boolean { return entry?.type === 'message' && entry.message.role === 'user' }
function display(entry: SessionEntry): boolean {
  return entry.type === 'compaction' || (entry.type === 'message'
    && ['user', 'assistant', 'toolResult'].includes(entry.message.role))
}
function messageOf(entry: SessionEntry): Record<string, unknown> | null {
  if (entry.type === 'message') return entry.message as unknown as Record<string, unknown>
  if (entry.type === 'compaction') return { role: 'compactionSummary', summary: entry.summary,
    tokensBefore: entry.tokensBefore, timestamp: Date.parse(entry.timestamp) }
  return null
}
/** 稳定展示身份始终可逆，但回退仍须由宿主复核当前分支与消息角色。 */
export function historyMessageId(entryId: string): string { return `history:${entryId}` }
export function historyEntryId(messageId: string): string | null {
  return /^history:([A-Za-z0-9_-]{1,128})$/.exec(messageId)?.[1] ?? null
}

/** 字段定位不允许越过所选原始消息或把附件当成文本读取。 */
function textOf(entry: SessionEntry, chunk: HistoryChunk): string {
  if (!display(entry)) throw new Error('该条目不属于可展示历史')
  const message = messageOf(entry)
  if (message === null) throw new Error('历史条目没有可读正文')
  if (chunk.field === 'summary') {
    if (entry.type !== 'compaction' || chunk.contentIndex !== 0) throw new Error('历史摘要目标无效')
    return entry.summary
  }
  const content = message.content
  const part = typeof content === 'string' && chunk.contentIndex === 0
    ? { type: 'text', text: content } : Array.isArray(content) ? content[chunk.contentIndex] : undefined
  if (!record(part)) throw new Error('历史内容块不存在')
  if (chunk.field === 'arguments' && part.type === 'toolCall') {
    if (chunk.toolCallId !== undefined && chunk.toolCallId !== part.id) throw new Error('历史参数归属已失效')
    return JSON.stringify(part.arguments) ?? ''
  }
  if (chunk.field === 'thinking' && part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking
  if ((chunk.field === 'text' || chunk.field === 'output') && part.type === 'text' && typeof part.text === 'string') {
    if ((message.role === 'toolResult') !== (chunk.field === 'output')) throw new Error('历史文本类型不符')
    if (chunk.field === 'output' && chunk.toolCallId !== undefined && chunk.toolCallId !== message.toolCallId) {
      throw new Error('历史输出归属已失效')
    }
    return part.text
  }
  throw new Error('历史内容块类型不符')
}

export function readBranchHistory(branch: readonly SessionEntry[], query: HistoryQuery, runtimeId: number): HistoryData {
  if (query.kind === 'text') {
    const entry = branch.find(candidate => candidate.id === query.entryId)
    if (!entry) throw new Error('历史目标不属于当前分支')
    const text = textOf(entry, query)
    if (query.offset > text.length) throw new Error('历史读取位置已失效')
    const end = Math.min(text.length, query.offset + TEXT_CHARS)
    const { kind: _kind, ...chunk } = query
    return { kind: 'text', chunk, text: text.slice(query.offset, end), next: end < text.length ? end : null }
  }
  let selected: SessionEntry[]
  let before: string | null = null
  let next: string | null = null
  let turnId: string | null = null
  if (query.kind === 'page') {
    const end = query.before === null ? branch.length : branch.findIndex(entry => entry.id === query.before)
    if (end < 0) throw new Error('历史分页游标已失效')
    let start = end
    let turns = 0
    while (start > 0) {
      start--
      if (user(branch[start])) turns++
      if (turns === PAGE_TURNS) break
    }
    const window = branch.slice(start, end)
    // 每轮只保留用户输入、最后一条回答与最后一条压缩记录，过程由展开回读。
    selected = []
    let response: SessionEntry | null = null
    let compaction: SessionEntry | null = null
    const finish = (): void => {
      const tail = [response, compaction].filter((entry): entry is SessionEntry => entry !== null)
        .sort((a, b) => window.indexOf(a) - window.indexOf(b))
      selected.push(...tail); response = null; compaction = null
    }
    for (const entry of window) {
      if (user(entry)) { finish(); selected.push(entry) }
      else if (entry.type === 'message' && entry.message.role === 'assistant') response = entry
      else if (entry.type === 'compaction') compaction = entry
    }
    finish()
    before = start > 0 ? branch[start]?.id ?? null : null
  } else {
    turnId = query.turnId
    let start = branch.findIndex(entry => entry.id === query.turnId)
    if (start < 0) throw new Error('历史轮次不属于当前分支')
    if (!user(branch[start])) {
      if (branch.slice(0, start + 1).some(user)) throw new Error('历史目标不是轮次起点')
      start = 0
    }
    let end = start + 1
    while (end < branch.length && !user(branch[end])) end++
    const after = query.after === null ? start - 1 : branch.findIndex(entry => entry.id === query.after)
    if (after < start - 1 || after >= end) throw new Error('历史轮次游标已失效')
    const remaining = branch.slice(after + 1, end).filter(display)
    selected = remaining.slice(0, DETAIL_ENTRIES)
    next = remaining.length > selected.length ? selected.at(-1)?.id ?? null : null
  }
  const chunks: HistoryChunk[] = []
  let budget = PAGE_CHARS
  const clip = (entry: SessionEntry, contentIndex: number, field: HistoryChunk['field'], text: string, limit = BLOCK_CHARS): string => {
    const count = Math.min(text.length, limit, Math.max(0, budget))
    budget -= count
    if (count < text.length) chunks.push({ entryId: entry.id, contentIndex, field, offset: count })
    return text.slice(0, count)
  }
  const messages: Record<string, unknown>[] = []
  const ids: string[] = []
  for (const entry of selected) {
    const message = messageOf(entry)
    if (message === null) continue
    const prepared = { ...message }
    if (typeof message.summary === 'string') prepared.summary = clip(entry, 0, 'summary', message.summary)
    if (typeof message.content === 'string') prepared.content = clip(entry, 0,
      message.role === 'toolResult' ? 'output' : 'text', message.content)
    else if (Array.isArray(message.content)) prepared.content = message.content.flatMap((part, index) => {
      if (!record(part)) return [{ type: 'historyOmitted' }]
      if (part.type === 'text' && typeof part.text === 'string') return [{ ...part,
        text: clip(entry, index, message.role === 'toolResult' ? 'output' : 'text', part.text,
          query.kind === 'page' && message.role === 'assistant' ? 2_048 : BLOCK_CHARS) }]
      if (query.kind === 'page' && message.role !== 'user') return [{ type: 'historyOmitted' }]
      if (part.type === 'thinking' && typeof part.thinking === 'string') return [{ ...part,
        thinking: clip(entry, index, 'thinking', part.thinking) }]
      if (part.type === 'toolCall') {
        const args = JSON.stringify(part.arguments) ?? ''
        // 参数原文独立续读，摘要不伪装成完整参数。
        if (args.length > 4_096) {
          chunks.push({ entryId: entry.id, contentIndex: index, field: 'arguments', offset: 0,
            ...(typeof part.id === 'string' ? { toolCallId: part.id } : {}) })
          return [{ ...part, arguments: { history: '参数过长，请读取原文' } }]
        }
        return [part]
      }
      // 历史图片不批量搬运；仍给出附件说明，不把它伪装成用户正文。
      if (part.type === 'image') return query.kind === 'turn' ? [part]
        : [{ type: 'text', text: '[历史图片附件未载入，展开本轮可读取]' }]
      return [{ type: 'historyOmitted' }]
    })
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const toolCallId = message.toolCallId
      const parts = typeof prepared.content === 'string' ? [{ type: 'text', text: prepared.content }]
        : Array.isArray(prepared.content) ? prepared.content : []
      let endOffset = 0
      let hasText = false
      parts.forEach((part: unknown, index: number) => {
        if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') return
        if (hasText) endOffset++
        endOffset += part.text.length
        hasText = true
        const position = chunks.findIndex(chunk => chunk.entryId === entry.id && chunk.contentIndex === index && chunk.field === 'output')
        const chunk = chunks[position]
        if (chunk) chunks[position] = { ...chunk, toolCallId, targetOffset: endOffset }
      })
    }
    messages.push(prepared); ids.push(entry.id)
  }
  const projection = new MessageProjection(runtimeId, { onBatch: () => {}, onStatusHint: () => {} })
  projection.seedHistory({ messages }, ids)
  const snapshot = projection.snapshot()
  projection.dispose()
  const selectedIds = new Set(ids)
  const turnIds = new Map<string, string>()
  let currentTurn = branch[0]?.id
  for (const entry of branch) {
    if (user(entry)) currentTurn = entry.id
    if (currentTurn && selectedIds.has(entry.id)) turnIds.set(entry.id, currentTurn)
  }
  let sourceIndex = 0
  const displayed: ProjectionMessage[] = snapshot.messages.map(message => {
    while (sourceIndex < messages.length && messages[sourceIndex]?.role === 'toolResult') sourceIndex++
    const entryId = ids[sourceIndex++]
    if (!entryId) throw new Error('历史消息缺少官方来源身份')
    const original = selected.find(entry => entry.id === entryId)
    // 图片占位必须与用户原文区分，避免复制、修改重试把说明文字当成输入。
    const originalContent = original?.type === 'message' ? original.message.content : null
    const sourceTurn = turnIds.get(entryId)
    return { ...message, id: historyMessageId(entryId), entryId,
      recoverable: query.kind === 'page' || chunks.some(chunk => chunk.entryId === entryId),
      ...(sourceTurn ? { turnEntryId: sourceTurn } : {}),
      blocks: message.blocks.map(block => ({ ...block,
        notice: query.kind === 'page' && Array.isArray(originalContent)
          && originalContent[block.contentIndex]?.type === 'image' ? true : block.notice,
        truncated: chunks.some(chunk => chunk.entryId === entryId && chunk.contentIndex === block.contentIndex) })) }
  })
  const latest = new Map<string, number>()
  for (const entry of branch) {
    const message = messageOf(entry)
    const details = message && record(message.details) ? message.details : null
    const ui = details ? parseGenuiPayload(details.ui) : null
    if (ui) {
      latest.set(ui.documentId, Math.max(latest.get(ui.documentId) ?? 0, ui.revision))
    }
  }
  const wanted = new Set(snapshot.tools.map(tool => tool.toolCallId))
  const argumentsById = new Map<string, { text: string; truncated: boolean; summary: ReturnType<typeof summarizeToolArguments> }>()
  for (const entry of branch) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) continue
    entry.message.content.forEach((part, index) => {
      if (part.type !== 'toolCall' || !wanted.has(part.id)) return
      const text = JSON.stringify(part.arguments) ?? ''
      argumentsById.set(part.id, { text: text.slice(0, 4_096), truncated: text.length > 4_096,
        summary: summarizeToolArguments(part.arguments) })
      if (text.length > 4_096 && !chunks.some(chunk => chunk.entryId === entry.id && chunk.contentIndex === index && chunk.field === 'arguments')) {
        chunks.push({ entryId: entry.id, contentIndex: index, field: 'arguments', offset: 0, toolCallId: part.id })
      }
    })
  }
  return { kind: query.kind, messages: displayed, tools: snapshot.tools.map(tool => {
    const args = argumentsById.get(tool.toolCallId)
    return { ...tool, textTruncated: tool.textTruncated || chunks.some(chunk => chunk.field === 'output' && chunk.toolCallId === tool.toolCallId),
      ...(args ? { argsText: args.text, argsSummary: args.summary,
      argsTruncated: args.truncated } : {}),
      ...(tool.ui ? { latestRevision: latest.get(tool.ui.documentId) ?? tool.ui.revision } : {}) }
  }), chunks, before, next, turnId } satisfies HistoryPage
}
