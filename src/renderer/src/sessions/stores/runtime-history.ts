/**
 * 会话历史的页面缓存：保存已加载的历史分页、展开轮次的原文与续段状态。
 * 只做缓存合并与淘汰，不持有运行身份；读取目标与会话键由调用方注入，因此不依赖其它切片。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type {
  HistoryChunk,
  HistoryData,
  HistoryQuery,
  ProjectionMessage,
  ToolExecution
} from '../../../../shared/runtime-api'

/** 续段失败只影响原位置，不向整轮重复铺错误或原文区域。 */
export interface HistoryChunkLoadState {
  loading: boolean
  error: string | null
}
export function historyChunkKey(chunk: HistoryChunk): string {
  return `${chunk.entryId}:${chunk.contentIndex}:${chunk.field}`
}

/** 原文缓存按轮限量，摘要页与实时投影分开，回读失败不清空已有内容。 */
export interface HistoryTurnState {
  messages: readonly ProjectionMessage[]
  tools: readonly ToolExecution[]
  chunks: readonly HistoryChunk[]
  next: string | null
  loading: boolean
  loaded: boolean
  error: string | null
  chunkStates: Record<string, HistoryChunkLoadState>
}
export interface HistoryState {
  /** 本页缓存所属的分支版本，只用于判断是否还能沿用已加载页；不随请求外发。 */
  revision: number
  before: string | null
  loading: boolean
  error: string | null
  pages: readonly ProjectionMessage[]
  visible: string[]
  uiRevisions: Map<string, number>
  turns: Record<string, HistoryTurnState>
}
export function emptyHistory(): HistoryState {
  return {
    revision: 0, before: null, loading: false, error: null, pages: [], visible: [],
    uiRevisions: new Map(), turns: Object.create(null) as Record<string, HistoryTurnState>
  }
}
export function messageKey(message: ProjectionMessage): string {
  return message.entryId ?? message.id
}

/** 界面版本事实不随工具卡片淘汰，避免旧历史界面被重新激活。 */
export function rememberUiRevisions(state: HistoryState, incoming: readonly ToolExecution[]): void {
  for (const tool of incoming) if (tool.ui) state.uiRevisions.set(tool.ui.documentId,
    Math.max(state.uiRevisions.get(tool.ui.documentId) ?? 0, tool.ui.revision, tool.latestRevision ?? 0))
}

export interface HistoryCacheDeps {
  /** 按当前展示的会话读取历史；绑定与否由主进程判定。 */
  request(query: HistoryQuery): Promise<HistoryData | null>
  /** 会话视图的稳定键；展开可见性只对发起它的那个会话生效。 */
  conversationKey(): string
}

export interface HistoryCache {
  state: Ref<HistoryState>
  loadEarlier(): Promise<void>
  loadTurn(turnId: string, more?: boolean): Promise<void>
  loadChunk(turnId: string, chunk: HistoryChunk): Promise<void>
  setVisibility(turnId: string, visible: boolean, ownerKey: string): void
}

export function createHistoryCache(deps: HistoryCacheDeps): HistoryCache {
  const state = ref<HistoryState>(emptyHistory())

  /** 分页必须前进：游标未变就停下，不靠重复请求补齐。 */
  async function loadEarlier(): Promise<void> {
    const owner = state.value
    if (owner.loading || owner.before === null) return
    owner.loading = true; owner.error = null
    const before = owner.before
    try {
      const page = await deps.request({ kind: 'page', before })
      // 期间换过分支时读取已返回 null，旧分页不会写回新缓存。
      if (page === null) return
      if (page.kind !== 'page' || page.before === before) throw new Error('历史分页未前进，已停止自动加载。')
      owner.pages = [...page.messages, ...owner.pages]
      owner.before = page.before
    } catch (error) { owner.error = error instanceof Error ? error.message : String(error) }
    finally { owner.loading = false }
  }

  /** 只缓存少量已展开原文；被回收的详情仍可从原始分支再次读取。 */
  async function loadTurn(turnId: string, more = false): Promise<void> {
    const owner = state.value
    if (owner.turns[turnId] === undefined) owner.turns[turnId] = {
      messages: [], tools: [], chunks: [], next: null, loading: false, loaded: false, error: null,
      chunkStates: Object.create(null) as Record<string, HistoryChunkLoadState>
    }
    // 插入后经响应式容器取回；赋值表达式返回原始对象，直接修改不会通知界面。
    const turn = owner.turns[turnId]
    if (!turn || turn.loading || (turn.loaded && !more) || (more && turn.next === null)) return
    turn.loading = true; turn.error = null
    try {
      const page = await deps.request({ kind: 'turn', turnId, after: more ? turn.next : null })
      if (page === null) return
      if (page.kind !== 'turn' || page.turnId !== turnId || (more && page.next === turn.next)) {
        throw new Error('历史轮次游标未前进，已停止自动加载。')
      }
      const merge = <T,>(previous: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] => {
        const rows = new Map(previous.map(item => [key(item), item]))
        for (const item of incoming) rows.set(key(item), item)
        return [...rows.values()]
      }
      turn.messages = merge(more ? turn.messages : [], page.messages, messageKey)
      turn.tools = merge(more ? turn.tools : [], page.tools, tool => tool.toolCallId)
      // 已完成的参数续段可能再次随后续工具结果页出现，不能重置回原游标。
      turn.chunks = merge(more ? turn.chunks : [], page.chunks.filter(chunk => !turn.chunkStates[historyChunkKey(chunk)]), historyChunkKey)
      rememberUiRevisions(owner, page.tools)
      turn.next = page.next; turn.loaded = true
      trim(owner, turnId)
    } catch (error) { turn.error = error instanceof Error ? error.message : String(error) }
    finally { turn.loading = false }
  }

  /** 可见原文不被缓存回收抢走；否则全局展开可能在读取与淘汰之间循环。 */
  function setVisibility(turnId: string, visible: boolean, ownerKey: string): void {
    if (deps.conversationKey() !== ownerKey) return
    const owner = state.value
    owner.visible = visible ? [...new Set([...owner.visible, turnId])] : owner.visible.filter(id => id !== turnId)
    trim(owner)
  }
  function trim(owner: HistoryState, current?: string): void {
    const keys = Object.keys(owner.turns)
    let excess = keys.length - 6
    for (const key of keys) {
      const saved = owner.turns[key]
      if (excess <= 0) break
      if (key !== current && !owner.visible.includes(key) && saved && !saved.loading) {
        delete owner.turns[key]; excess--
      }
    }
  }

  async function loadChunk(turnId: string, chunk: HistoryChunk): Promise<void> {
    const owner = state.value
    const turn = owner.turns[turnId]
    const key = historyChunkKey(chunk)
    if (!turn || turn.loading || !turn.chunks.some(item => historyChunkKey(item) === key && item.offset === chunk.offset)) return
    if (turn.chunkStates[key] === undefined) turn.chunkStates[key] = { loading: false, error: null }
    const status = turn.chunkStates[key]
    if (!status) return
    turn.loading = true; status.loading = true; status.error = null
    try {
      const data = await deps.request({ kind: 'text', ...chunk })
      if (data === null) return
      if (data.kind !== 'text') throw new Error('历史续段响应类型不匹配，已停止自动加载。')
      if (historyChunkKey(data.chunk) !== key || data.chunk.offset !== chunk.offset || data.chunk.toolCallId !== chunk.toolCallId
        || (data.next !== null && data.next <= chunk.offset)) throw new Error('历史内容游标不匹配，未写入。')
      if (chunk.field === 'text' || chunk.field === 'thinking') {
        const message = turn.messages.find(item => item.entryId === chunk.entryId)
        const block = message?.blocks.find(item => item.contentIndex === chunk.contentIndex)
        if (!block || block.text.length !== chunk.offset) throw new Error('历史正文位置已变化，未拼接。')
        turn.messages = turn.messages.map(item => item !== message ? item : { ...item,
          blocks: item.blocks.map(part => part !== block ? part : { ...part, text: part.text + data.text, truncated: data.next !== null }) })
      } else if (chunk.field === 'summary') {
        const message = turn.messages.find(item => item.entryId === chunk.entryId)
        if (!message?.compaction || message.compaction.summary.length !== chunk.offset) throw new Error('历史摘要位置已变化，未拼接。')
        turn.messages = turn.messages.map(item => item !== message || !item.compaction ? item
          : { ...item, compaction: { ...item.compaction, summary: item.compaction.summary + data.text } })
      } else {
        const tool = turn.tools.find(item => item.toolCallId === chunk.toolCallId)
        if (!tool) throw new Error('历史工具归属缺失，未写入。')
        if (chunk.field === 'arguments') {
          if (chunk.offset > 0 && (tool.argsText?.length ?? 0) !== chunk.offset) throw new Error('历史参数位置已变化，未拼接。')
          turn.tools = turn.tools.map(item => item !== tool ? item : { ...item,
            argsText: (chunk.offset === 0 ? '' : item.argsText ?? '') + data.text, argsTruncated: data.next !== null })
        } else {
          const position = chunk.targetOffset
          if (position === undefined || position > tool.text.length) throw new Error('历史输出位置已变化，未拼接。')
          const remaining = turn.chunks.some(item => historyChunkKey(item) !== key && item.field === 'output' && item.toolCallId === tool.toolCallId)
          turn.tools = turn.tools.map(item => item !== tool ? item : { ...item,
            text: item.text.slice(0, position) + data.text + item.text.slice(position), textTruncated: data.next !== null || remaining })
          // 一份工具结果的多个文本块共享聚合输出，前块续载后同步移动后块的插入点。
          turn.chunks = turn.chunks.map(item => item.field === 'output' && item.toolCallId === tool.toolCallId
            && item.targetOffset !== undefined && item.targetOffset >= position
            ? { ...item, targetOffset: item.targetOffset + data.text.length } : item)
        }
      }
      turn.chunks = turn.chunks.flatMap(item => historyChunkKey(item) !== key ? [item]
        : data.next === null ? [] : [{ ...item, offset: data.next }])
    } catch (error) { status.error = error instanceof Error ? error.message : String(error) }
    finally { turn.loading = false; status.loading = false }
  }

  return { state, loadEarlier, loadTurn, loadChunk, setVisibility }
}
