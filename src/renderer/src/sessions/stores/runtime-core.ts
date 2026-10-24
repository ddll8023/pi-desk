/**
 * 会话运行与投影状态：前台实例身份、Prompt/回退/中止/压缩等动作状态、投影分片与后台留底。
 * 同时持有日志展示：会话未绑定时先展示按会话读到的历史，绑定后等权威基准落位再交还展示位。
 * 历史读取按会话寻址，读取目标由本切片给出；历史缓存是纯函数模块、由本切片组合；
 * 模型能力、模型切换与展示偏好由 `runtime-models` 与 `runtime-model-display` 持有，
 * 本切片只经 `bindStatusEffects` 在状态收敛时通知它们。
 */
import { computed, ref, shallowRef } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type {
  HistoryChunk,
  HistoryData,
  HistoryQuery,
  ProjectionBatch,
  ProjectionBlock,
  ProjectionMessage,
  ProjectionUpdate,
  PromptDisposition,
  PromptImageInput,
  RuntimeError,
  RuntimeRewindRequest,
  RuntimeStatus,
  RuntimeTarget,
  SessionActivity,
  ToolExecution,
  HistoryPage
} from '../../../../shared/runtime-api'
import {
  abortRuntime,
  ackRuntimeProjection,
  compactRuntime,
  getRuntimeProjection,
  getRuntimeStatus,
  rewindRuntime,
  sendPrompt,
  subscribeRuntimeProjection,
  subscribeRuntimeStatus
} from '../services/runtime'
import { readSessionHistory } from '../services/session'
import { createHistoryCache, emptyHistory, messageKey, rememberUiRevisions } from './runtime-history'
import type { HistoryCache, HistoryState } from './runtime-history'

/** Runtime 的展示阶段；宿主已回收时用 `closed` 表示挂起而不是失败。 */
export type RuntimeViewState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; snapshot: RuntimeStatus }
  | { phase: 'stopping' }
  | { phase: 'closed' }
  | { phase: 'failed'; error: RuntimeError }

export type PromptViewState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'accepted'; disposition: PromptDisposition }
  | { phase: 'error'; error: RuntimeError }

/** 回退结果未知时禁止继续写入；重新打开会话后才解除保守保护。 */
export type RewindViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'done'; cancelled: boolean }
  | { phase: 'error'; error: RuntimeError; blocked: boolean }

/** 中止请求的展示状态；运行中状态本身仍由事件流收敛。 */
export type AbortViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'error'; error: RuntimeError }

/** 手动压缩只保存动作状态；压缩过程与结果由投影中的压缩记录表达。 */
export type CompactViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'error'; error: RuntimeError }

/**
 * 手动压缩的受理结果：`dispatched` 表示命令已发给 Runtime，成功、被 Pi 拒绝或结果不适用于当前实例
 * 都由动作状态与投影表达；`refused` 表示前置条件不满足、请求根本没发出，命令文本没有被消费。
 */
export type CompactOutcome = 'dispatched' | 'refused'

/** 模型切换只保存动作状态，当前模型始终由 Runtime 快照表达。 */
export type ModelSwitchViewState =
  | { phase: 'idle' }
  | { phase: 'switching' }
  | { phase: 'error'; error: RuntimeError }

/** `synced` 表示当前展示就是基准（无 Runtime 时为空基准），`syncing` 表示未取得基准或正在重同步，`stale` 表示失去同步且尚未取得快照。 */
export type ProjectionSyncState = 'syncing' | 'synced' | 'stale'

/**
 * 一个运行实例的投影分片：离开前台时留底，之后到达的批次只更新自己的分片，切回时取回。
 * `appliedRuntimeId` 是这份内容对应的绑定代际，与当前代际不符时必须重新取基准。
 */
export interface ProjectionSlice {
  messages: readonly ProjectionMessage[]
  tools: readonly ToolExecution[]
  sync: ProjectionSyncState
  truncated: boolean
  droppedMessages: number
  droppedTools: number
  appliedRuntimeId: number | null
  appliedSeq: number
  history: HistoryState
  activity: SessionActivity | null
}

/**
 * 一次状态收敛带来的会话侧变化，供模型切片决定是否作废或重读自己的能力清单与候选模型。
 * 由 `applyStatus` 单次同步产出，模型切片不自行推断，避免两处判定规则漂移。
 */
export interface StatusTransitionContext {
  targetChanged: boolean
  sessionChanged: boolean
  previousStreaming: boolean
  /** 本轮状态是否不带任何会话身份；仅此时模型侧清空能力清单。 */
  sessionAbsent: boolean
}

/** 块级幂等替换；新块按 contentIndex 顺序插入。 */
function replaceBlock(blocks: readonly ProjectionBlock[], block: ProjectionBlock): ProjectionBlock[] {
  const index = blocks.findIndex((candidate) => candidate.contentIndex === block.contentIndex)
  if (index < 0) {
    return [...blocks, block].sort((left, right) => left.contentIndex - right.contentIndex)
  }
  const next = [...blocks]
  next[index] = block
  return next
}

/** 追加要求长度不变式成立；不符时返回 null，由调用方转快照重同步，不猜测补齐。 */
function appendBlock(
  blocks: readonly ProjectionBlock[],
  contentIndex: number,
  text: string,
  length: number
): ProjectionBlock[] | null {
  const index = blocks.findIndex((candidate) => candidate.contentIndex === contentIndex)
  const target = index < 0 ? undefined : blocks[index]
  if (target === undefined) return null

  const nextText = target.text + text
  if (nextText.length !== length) return null
  const next = [...blocks]
  next[index] = { ...target, text: nextText }
  return next
}

/** 应用一批更新；遇到未知消息或长度不符时返回 null，表示必须整表重同步。 */
function applyUpdates(
  messages: readonly ProjectionMessage[],
  tools: readonly ToolExecution[],
  updates: readonly ProjectionUpdate[]
): { messages: ProjectionMessage[]; tools: ToolExecution[] } | null {
  let nextMessages = [...messages]
  let nextTools = [...tools]
  for (const update of updates) {
    if (update.kind === 'activity') continue
    if (update.kind === 'tool') {
      const incoming = update.tool
      // 工具条目本身是权威内容：未知 toolCallId 也直接收录，不做猜测。
      const known = nextTools.some((tool) => tool.toolCallId === incoming.toolCallId)
      nextTools = known
        ? nextTools.map((tool) => (tool.toolCallId === incoming.toolCallId ? incoming : tool))
        : [...nextTools, incoming]
      continue
    }
    if (update.kind === 'message') {
      const incoming = update.message
      const messageIndex = nextMessages.findIndex((message) => message.id === incoming.id)
      nextMessages = messageIndex < 0
        ? [...nextMessages, incoming]
        : nextMessages.map((message) => (message.id === incoming.id ? incoming : message))
      continue
    }

    const messageId = update.messageId
    const index = nextMessages.findIndex((message) => message.id === messageId)
    const target = index < 0 ? undefined : nextMessages[index]
    if (target === undefined) return null

    const blocks = update.kind === 'block'
      ? replaceBlock(target.blocks, update.block)
      : appendBlock(target.blocks, update.contentIndex, update.text, update.length)
    if (blocks === null) return null
    nextMessages[index] = { ...target, blocks }
  }
  return { messages: nextMessages, tools: nextTools }
}

/** 页面每次 `dispose` 都递增；在途读取据此丢弃迟到结果。 */
export interface RuntimeLifecycle {
  count: number
}

export interface RuntimeCoreDeps {
  lifecycle: RuntimeLifecycle
  /** 当前项目的规范路径：历史读取按会话寻址，需要与会话一起给出项目。 */
  currentProjectPath: () => string | null
}

/** 会话运行切片对外提供的能力；组合根据此装配，模型切片只读取其中的身份与互斥状态。 */
export interface RuntimeCore {
  view: Ref<RuntimeViewState>
  foregroundRunId: Ref<number | null>
  suspendedSessionId: ComputedRef<string | null>
  foregroundSessionId: ComputedRef<string | null>
  conversationKey: ComputedRef<string>
  promptView: Ref<PromptViewState>
  preparingPrompt: Ref<boolean>
  rewindView: Ref<RewindViewState>
  abortView: Ref<AbortViewState>
  compactView: Ref<CompactViewState>
  modelSwitchView: Ref<ModelSwitchViewState>
  messages: Ref<readonly ProjectionMessage[]>
  tools: Ref<readonly ToolExecution[]>
  displayMessages: ComputedRef<readonly ProjectionMessage[]>
  displayTools: ComputedRef<readonly ToolExecution[]>
  history: Ref<HistoryState>
  activity: Ref<SessionActivity | null>
  /** 正在展示的日志来源所属会话；null 表示当前展示由绑定投影（或空基准）提供。 */
  logSessionId: Ref<string | null>
  /**
   * 应用一页日志历史：只在会话尚未绑定时生效，绑定投影到达即退场。
   * 它同时固定后续翻页、轮次与续段的读取目标，因此未绑定的会话也能继续往回读。
   */
  applyLogPage(page: HistoryPage, target: { readonly projectPath: string; readonly sessionId: string }): void
  /** 丢弃日志展示并清空内容；切换目标与会话绑定完成时调用。 */
  clearPreview(): void
  projectionSync: Ref<ProjectionSyncState>
  projectionTruncated: Ref<boolean>
  droppedMessages: Ref<number>
  droppedTools: Ref<number>
  bindStatusEffects(handler: (context: StatusTransitionContext) => void): void
  subscribe(): void
  unsubscribe(): void
  refreshStatus(): Promise<void>
  syncProjection(expectedRuntimeId?: number): Promise<void>
  pruneSlices(active: ReadonlySet<number>): void
  /** 历史分页与原文读取由 `runtime-history` 的缓存实现承担，本切片只提供读取目标与分支版本。 */
  loadEarlierHistory(): Promise<void>
  loadHistoryTurn(turnId: string, more?: boolean): Promise<void>
  loadHistoryChunk(turnId: string, chunk: HistoryChunk): Promise<void>
  setHistoryVisibility(turnId: string, visible: boolean, ownerKey: string): void
  currentTarget(): RuntimeTarget | null
  rewindBlocksWrites(): boolean
  send(message: string, images?: readonly PromptImageInput[]): Promise<void>
  rewind(request: RuntimeRewindRequest): Promise<boolean>
  compact(instructions: string | null): Promise<CompactOutcome>
  stopOperation(): Promise<void>
  applyStatus(status: RuntimeStatus): void
  reset(): void
}

export function createRuntimeCore(deps: RuntimeCoreDeps): RuntimeCore {
  const view = ref<RuntimeViewState>({ phase: 'idle' })
  /** 前台运行实例身份；事件与请求的目标都按它校验，切换时同步重置展示基准。 */
  const foregroundRunId = ref<number | null>(null)
  /** 最近一次状态里的会话身份；宿主已回收（挂起）时它是唯一的恢复目标。 */
  const statusSessionId = ref<string | null>(null)
  /**
   * 挂起态：宿主已回收但会话仍被占用，页面按「上次 Runtime 已关闭」展示并保留历史。
   * 下一次发送先恢复这个会话，而不是当成新建。
   */
  const suspendedSessionId = computed(() => (
    view.value.phase === 'closed' ? statusSessionId.value : null
  ))
  /** 前台实例当前展示的会话身份；宿主已回收（挂起）时仍指向同一会话。 */
  const foregroundSessionId = computed(() => (
    view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : suspendedSessionId.value
  ))
  const promptView = ref<PromptViewState>({ phase: 'idle' })
  /** 附件读取也属于提交阶段，回退和切换模型不能穿插其间。 */
  const preparingPrompt = ref(false)
  const rewindView = ref<RewindViewState>({ phase: 'idle' })
  /** 回退尝试序号：换前台实例、重新发起回退或页面卸载时递增，用于作废旧结果。 */
  let rewindRequest = 0
  const abortView = ref<AbortViewState>({ phase: 'idle' })
  const compactView = ref<CompactViewState>({ phase: 'idle' })
  let compactRequest = 0
  const modelSwitchView = ref<ModelSwitchViewState>({ phase: 'idle' })
  const messages = ref<readonly ProjectionMessage[]>([])
  const tools = ref<readonly ToolExecution[]>([])
  const projectionSync = ref<ProjectionSyncState>('syncing')
  const projectionTruncated = ref(false)
  const droppedMessages = ref(0)
  const droppedTools = ref(0)
  /**
   * 最近一次就绪快照的身份：挂起与恢复之间消息组件不能重建，否则回收一次就丢阅读与展开状态。
   * 会话视图的稳定键优先取当前就绪快照，否则退回这份身份；不含项目身份，避免项目切换时重建两次。
   */
  const lastReadyIdentity = ref<{ runId: number; runtimeId: number | null; sessionId: string | null } | null>(null)
  const conversationKey = computed(() => {
    if (view.value.phase !== 'ready' && logSessionId.value !== null) {
      // 日志来源按会话固定键：同一份历史不会因为绑定前后的实例编号不同而重建两次内容。
      return `log:${logSessionId.value}`
    }
    const identity = view.value.phase === 'ready' ? view.value.snapshot : lastReadyIdentity.value
    return `${identity?.runId ?? 'none'}`
      + `:${identity?.runtimeId ?? 'none'}:${identity?.sessionId ?? 'none'}`
  })
  /** 历史分页与展开原文；读取目标与分支版本由下面的 `requestHistory` 提供。 */
  const historyCache: HistoryCache = createHistoryCache({
    request: (query) => requestHistory(query),
    conversationKey: () => conversationKey.value
  })
  const history = historyCache.state
  const activity = ref<SessionActivity | null>(null)
  /** 日志来源：内容随页面进来，绑定完成即退场；它不是权威投影，不参与任何写操作。 */
  const logPage = shallowRef<HistoryPage | null>(null)
  const logSessionId = ref<string | null>(null)
  /** 日志读取目标：翻页、展开轮次与续段都按它寻址，未绑定时不依赖前台实例。 */
  const logProjectPath = ref<string | null>(null)
  /**
   * 最近一次已知的「会话 → 项目」：绑定后按会话读取历史需要项目，
   * 而绑定状态本身只带会话身份；退场时保留这条对应关系，只在与当前会话一致时使用。
   */
  const lastSessionProject = ref<{ readonly sessionId: string; readonly projectPath: string } | null>(null)
  /** 日志展示期间跳过了前台批次：退场时必须重取权威基准，不能当成本地已同步。 */
  let logBatchPending = false
  /**
   * 欠一次基准快照：与 `projectionSync` 分开，避免把「欠基准」说成「失去同步」。
   * 日志展示期间跳过的批次只欠一次重取，界面内容仍是完整一页，不该出现失步提示；
   * 真正取到快照之前也不该放开写入——写入另由绑定态门禁。
   */
  let baselineNeeded = false
  /**
   * 日志展示正等待退场：会话已经绑定到同一个会话，但权威基准还没落位。
   * 期间继续显示日志内容，不提前清空；基准应用后再交还展示位，交接中间不出现空白。
   */
  let previewRetiring = false
  /** 只合并已加载页；按官方来源去重，不按文本、时间戳或数组下标猜身份。 */
  const displayMessages = computed<readonly ProjectionMessage[]>(() => {
    const base = new Map<string, ProjectionMessage>()
    for (const message of [...history.value.pages, ...messages.value]) base.set(messageKey(message), message)
    const output: ProjectionMessage[] = []
    // 最后一条用户消息：`findLast` 属于 ES2023，当前页面的 lib 只到 ES2022，因此从尾部手写一次查找。
    let latestUser: ProjectionMessage | undefined
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const candidate = messages.value[index]
      if (candidate?.role === 'user') {
        latestUser = candidate
        break
      }
    }
    let group: ProjectionMessage[] = []
    const finish = (): void => {
      const first = group[0]
      const turnId = first?.role === 'user' ? first.entryId : first?.turnEntryId
      const detail = turnId ? history.value.turns[turnId] : undefined
      const currentLive = first?.role === 'user' && first.turn !== null && latestUser !== undefined
        && messageKey(first) === messageKey(latestUser)
      if (!detail?.loaded || currentLive) { output.push(...group); group = []; return }
      const seen = new Set(detail.messages.map(messageKey))
      for (const message of detail.messages) {
        const live = group.find(candidate => messageKey(candidate) === messageKey(message))
        const liveComplete = live && !live.blocks.some(block => block.truncated || block.notice)
          && (live.role === 'user' || live.generation !== null)
        output.push(live ? { ...message, generation: live.generation, turn: live.turn,
          blocks: liveComplete ? live.blocks : message.blocks } : message)
      }
      for (const message of group) if (!seen.has(messageKey(message))
        && (!message.recoverable || message.generation !== null || message.turn !== null)) output.push(message)
      group = []
    }
    for (const message of base.values()) {
      if (message.role === 'user') finish()
      group.push(message)
    }
    finish()
    return output
  })
  const displayTools = computed<readonly ToolExecution[]>(() => {
    const combined = new Map<string, ToolExecution>()
    for (const detail of Object.values(history.value.turns)) for (const tool of detail.tools) combined.set(tool.toolCallId, tool)
    for (const live of tools.value) {
      const previous = combined.get(live.toolCallId)
      if (!previous || live.phase === 'running') { combined.set(live.toolCallId, live); continue }
      // 实时终态始终权威；历史仅补充被展示窗口截断的参数或结果正文。
      const keepText = previous.textKind === 'result' && (!previous.textTruncated || previous.text.length > live.text.length)
      const keepArgs = previous.argsText !== null && (!previous.argsTruncated || previous.argsText.length > (live.argsText?.length ?? 0))
      combined.set(live.toolCallId, { ...previous, ...live,
        text: keepText ? previous.text : live.text,
        textTruncated: keepText ? previous.textTruncated : live.textTruncated,
        argsText: keepArgs ? previous.argsText : live.argsText,
        argsTruncated: keepArgs ? previous.argsTruncated : live.argsTruncated,
        latestRevision: Math.max(previous.latestRevision ?? 0, live.latestRevision ?? 0) })
    }
    return [...combined.values()].map(tool => tool.ui ? { ...tool,
      latestRevision: Math.max(tool.ui.revision, tool.latestRevision ?? 0,
        history.value.uiRevisions.get(tool.ui.documentId) ?? 0) } : tool)
  })
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的运行实例与 Runtime 代际；两者一起判定当前展示是否仍是权威基准。 */
  let appliedRunId: number | null = null
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  /**
   * 后台实例的投影分片：只保存离开前台时的内容与之后到达的增量，不参与前台展示。
   * 分片寿命跟随运行实例，实例从运行状态列表消失时丢弃（见 pruneSlices）。
   */
  const backgroundProjections = new Map<number, ProjectionSlice>()
  let projectionSyncPromise: Promise<void> | null = null
  /** 在途读取针对的绑定代际；不同代际的读取要排在它之后，不复用它的结果。 */
  let projectionSyncExpectation: number | undefined
  /** 模型切片在状态收敛时的同步回调；绑定在 `subscribe()` 之前完成，因此首个状态快照也能带上模型侧动作。 */
  let statusEffects: ((context: StatusTransitionContext) => void) | null = null

  /** 先订阅状态与投影、再取快照，避免初始化期间漏掉通知。 */
  function subscribe(): void {
    if (releaseSubscription === null) releaseSubscription = subscribeRuntimeStatus((status) => applyStatus(status))
    if (releaseProjection === null) releaseProjection = subscribeRuntimeProjection((batch) => applyBatch(batch))
  }

  function unsubscribe(): void {
    releaseSubscription?.()
    releaseSubscription = null
    releaseProjection?.()
    releaseProjection = null
  }

  /** 取一次权威状态；失败时保留现状，由下一次广播收敛。 */
  async function refreshStatus(): Promise<void> {
    const result = await getRuntimeStatus()
    if (result.ok) applyStatus(result.data)
  }

  /** 当前就绪快照的二维目标；未就绪或缺少运行身份时返回 null，调用方据此不发起请求。 */
  function currentTarget(): RuntimeTarget | null {
    if (view.value.phase !== 'ready') return null
    const status = view.value.snapshot
    if (status.runId === null) return null
    return { runId: status.runId, runtimeId: status.runtimeId }
  }

  /** 回退处理中或结果未知时，禁止发送和切换模型。 */
  function rewindBlocksWrites(): boolean {
    return rewindView.value.phase === 'requesting'
      || (rewindView.value.phase === 'error' && rewindView.value.blocked)
  }

  /** 提交 Prompt；旧实例或旧会话的迟到结果不能清空或改写当前输入。 */
  async function send(message: string, images: readonly PromptImageInput[] = []): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending'
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return
    const target = currentTarget()
    if (target === null) return
    const sessionId = view.value.snapshot.info?.sessionId ?? null
    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(target, message, images)
    if (view.value.phase !== 'ready' || view.value.snapshot.runId !== target.runId
      || view.value.snapshot.runtimeId !== target.runtimeId
      || (view.value.snapshot.info?.sessionId ?? null) !== sessionId) return
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /** 显式确认后回退；成功时同步投影。 */
  async function rewind(request: RuntimeRewindRequest): Promise<boolean> {
    if (view.value.phase !== 'ready' || rewindBlocksWrites() || preparingPrompt.value
      || promptView.value.phase === 'sending' || modelSwitchView.value.phase === 'switching'
      || view.value.snapshot.info?.isStreaming === true || projectionSync.value !== 'synced'
      || view.value.snapshot.runId !== request.runId || view.value.snapshot.runtimeId !== request.runtimeId
      || view.value.snapshot.info?.sessionId !== request.sessionId) return false
    const sequence = ++rewindRequest
    rewindView.value = { phase: 'requesting' }
    try {
      const result = await rewindRuntime(request)
      // 分叉本身会换会话与绑定代际，宿主还会先上报一次 preparing；只有换了前台实例或又发起了新的回退才作废结果。
      if (sequence !== rewindRequest) return false
      if (!result.ok) {
        rewindView.value = { phase: 'error', error: result.error, blocked: result.blocked === true }
        return false
      }
      const status = result.data.status
      if (result.data.cancelled) {
        rewindView.value = { phase: 'done', cancelled: true }
        return false
      }
      // 以主进程在分叉后读到的权威状态为准，不拿回退前固定的代际与过程中变化的页面快照比较。
      if (status.state !== 'ready' || status.runId !== request.runId) {
        rewindView.value = { phase: 'error', error: { code: 'INVALID_RESPONSE', message: '对话已回退，但运行时没有回到就绪；请重新打开会话。' }, blocked: true }
        return false
      }
      applyStatus(status)
      await syncProjection(status.runtimeId ?? undefined)
      if (sequence !== rewindRequest) return false
      if (projectionSync.value !== 'synced') {
        rewindView.value = { phase: 'error', error: { code: 'INVALID_RESPONSE', message: '对话已回退，但消息同步失败；请重新打开会话。' }, blocked: true }
        return false
      }
      // 成功不留下常驻状态：交回输入框的文本与附件由调用方处理，这里只表达动作已结束。
      rewindView.value = { phase: 'idle' }
      return true
    } finally {
      if (sequence === rewindRequest && rewindView.value.phase === 'requesting') rewindView.value = { phase: 'idle' }
    }
  }

  /**
   * 手动压缩当前会话上下文；说明可选，返回受理结果供调用方决定命令文本的去留。
   * 只在会话空闲时发起：Pi 的手动压缩会先中止当前轮次，从文本命令里静默中断一轮太意外。
   * 调用会等到整段压缩结束才返回，因此这里只维护动作状态，进行中与结果都由投影表达；
   * Pi 的拒绝（上下文太小、刚压缩过）已经算命令被消费，只有请求没发出才是 `refused`。
   */
  async function compact(instructions: string | null): Promise<CompactOutcome> {
    if (view.value.phase !== 'ready' || compactView.value.phase === 'requesting'
      || preparingPrompt.value || promptView.value.phase === 'sending'
      || modelSwitchView.value.phase === 'switching' || rewindBlocksWrites()) return 'refused'
    const status = view.value.snapshot
    const runtimeId = status.runtimeId
    const sessionId = status.info?.sessionId ?? null
    // 运行中由页面先提示（需要中断时用停止键）；这里再按快照复核一次，避免并发提交。
    if (status.runId === null || runtimeId === null || sessionId === null
      || status.info?.isStreaming === true) return 'refused'
    const sequence = ++compactRequest
    compactView.value = { phase: 'requesting' }
    try {
      const result = await compactRuntime({ runId: status.runId, runtimeId, sessionId, instructions })
      // 命令已经发出：身份变化只决定结果是否应用到当前实例，命令本身已被消费。
      if (sequence !== compactRequest || view.value.phase !== 'ready'
        || view.value.snapshot.runId !== status.runId || view.value.snapshot.runtimeId !== runtimeId) return 'dispatched'
      if (!result.ok) {
        compactView.value = { phase: 'error', error: result.error }
        return 'dispatched'
      }
      if (result.data.runId === status.runId && result.data.runtimeId === runtimeId) applyStatus(result.data)
      compactView.value = { phase: 'idle' }
      return 'dispatched'
    } finally {
      if (sequence === compactRequest && compactView.value.phase === 'requesting') compactView.value = { phase: 'idle' }
    }
  }

  /**
   * 请求中止目标实例的当前操作；只在就绪且事件流显示运行中时发起，发送中不重复提交。
   * 成功只表示 Pi 已确认取消，运行中状态的最终收敛仍由事件流负责。
   */
  async function stopOperation(): Promise<void> {
    if (view.value.phase !== 'ready') return
    if (view.value.snapshot.info?.isStreaming !== true) return
    if (abortView.value.phase === 'requesting') return
    const target = currentTarget()
    if (target === null) return

    abortView.value = { phase: 'requesting' }
    const result = await abortRuntime(target)
    // 期间前台切走：结果属于旧实例，不写入新前台的展示状态。
    if (view.value.phase !== 'ready' || view.value.snapshot.runId !== target.runId
      || view.value.snapshot.runtimeId !== target.runtimeId) return
    abortView.value = result.ok
      ? { phase: 'idle' }
      : { phase: 'error', error: result.error }
  }

  /**
   * 历史读取：页面只给会话，绑定与否由主进程判定，两条路径返回同一套条目身份，
   * 缓存合并规则不需要区分来源。读取期间换目标或换会话就丢弃结果，不写进别的展示。
   * 游标失效说明分支已变（回退、压缩或外部改写）：本页不再有效，按权威基准重建一次。
   */
  async function requestHistory(query: HistoryQuery): Promise<HistoryData | null> {
    const target = historyTarget()
    if (target === null) return null
    const owner = history.value
    const result = await readSessionHistory(target.projectPath, target.sessionId, query)
    const current = historyTarget()
    if (owner !== history.value || current === null
      || current.projectPath !== target.projectPath || current.sessionId !== target.sessionId) return null
    if (!result.ok) {
      if (result.error.code === 'STALE_SESSION') {
        if (view.value.phase === 'ready') {
          baselineNeeded = true
          void syncProjection()
        } else history.value = emptyHistory()
        return null
      }
      throw new Error(result.error.message)
    }
    if (result.data.projectPath !== target.projectPath || result.data.sessionId !== target.sessionId) return null
    return result.data.data
  }

  /**
   * 历史读取目标：正在展示的日志会话优先（它可能与已绑定的会话不是同一个），
   * 其余情况取前台已就绪的绑定会话；都没有时不读取。
   */
  function historyTarget(): { readonly projectPath: string; readonly sessionId: string } | null {
    const readySessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : null
    if (logSessionId.value !== null && logSessionId.value !== readySessionId) {
      const projectPath = logProjectPath.value
      return projectPath === null ? null : { projectPath, sessionId: logSessionId.value }
    }
    if (readySessionId === null) return null
    // 绑定状态只带会话身份，项目取同一会话最近一次的读取目标，缺失时退回当前项目。
    const known = lastSessionProject.value
    const projectPath = known !== null && known.sessionId === readySessionId
      ? known.projectPath
      : deps.currentProjectPath()
    return projectPath === null ? null : { projectPath, sessionId: readySessionId }
  }

  /** 全量重同步保持序号守卫；回退换绑后等待旧请求完成，再读取新绑定基准。 */
  function syncProjection(expectedRuntimeId?: number): Promise<void> {
    // 同一代际的读取可以共用；不同代际（回退的 fork 会换绑定）必须排在它之后重新读一次，
    // 否则回退拿到的是上一代读取的结果，会被判成同步失败。
    if (projectionSyncPromise !== null
      && (expectedRuntimeId === undefined || projectionSyncExpectation === expectedRuntimeId)) return projectionSyncPromise
    const queued = projectionSyncPromise
    const pending: Promise<void> = (queued ?? Promise.resolve())
      .then(() => readProjection(expectedRuntimeId))
      .finally(() => {
        if (projectionSyncPromise === pending) {
          projectionSyncPromise = null
          projectionSyncExpectation = undefined
        }
      })
    projectionSyncPromise = pending
    projectionSyncExpectation = expectedRuntimeId
    return pending
  }

  /** 读取期间换实例、换代或换会话就丢弃旧响应，并在同一等待链中取得新目标的快照。 */
  async function readProjection(expectedRuntimeId?: number): Promise<void> {
    projectionSync.value = 'syncing'
    const lifecycle = deps.lifecycle.count
    while (lifecycle === deps.lifecycle.count) {
      const target = currentTarget()
      if (target === null) {
        resetProjection()
        return
      }
      const sessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : null
      const result = await getRuntimeProjection(target)
      const current = currentTarget()
      const currentSessionId = view.value.phase === 'ready' ? view.value.snapshot.info?.sessionId ?? null : null
      if (lifecycle !== deps.lifecycle.count) return
      if (target.runId !== current?.runId || target.runtimeId !== current?.runtimeId
        || sessionId !== currentSessionId) {
        expectedRuntimeId = current?.runtimeId ?? undefined
        continue
      }
      if (!result.ok) {
        projectionSync.value = 'stale'
        return
      }
      const snapshot = result.data
      if (expectedRuntimeId !== undefined && snapshot.runtimeId !== expectedRuntimeId) {
        projectionSync.value = 'stale'
        return
      }
      const sameBinding = appliedRunId === target.runId && appliedRuntimeId === snapshot.runtimeId
      if (sameBinding && snapshot.seq < appliedSeq) {
        // 同一绑定的快照水位不得倒退：更早的快照已经被在手的增量覆盖，采用它会把正文回退；
        // 只补一次确认，保留已应用的高水位。
        projectionSync.value = 'synced'
        if (snapshot.runtimeId !== null) ackRuntimeProjection(target, appliedSeq)
        if (previewRetiring) retirePreview()
        return
      }
      appliedRunId = target.runId
      appliedRuntimeId = snapshot.runtimeId
      appliedSeq = snapshot.seq
      const sameBranch = sameBinding && history.value.revision === (snapshot.history?.revision ?? 0)
      if (!sameBranch) history.value = { ...emptyHistory(), revision: snapshot.history?.revision ?? 0 }
      if (!sameBranch || history.value.pages.length === 0) history.value.before = snapshot.history?.before ?? null
      activity.value = snapshot.activity ?? null
      messages.value = snapshot.messages
      tools.value = snapshot.tools
      rememberUiRevisions(history.value, snapshot.tools)
      projectionTruncated.value = snapshot.truncated
      droppedMessages.value = snapshot.droppedMessages
      droppedTools.value = snapshot.droppedTools
      projectionSync.value = 'synced'
      if (snapshot.runtimeId !== null) ackRuntimeProjection(target, snapshot.seq)
      // 权威基准已经写进展示位：日志展示到此退场，内容不需要再清一次。
      if (previewRetiring) retirePreview()
      return
    }
  }

  /**
   * 批次按来源实例分流：前台走展示状态，后台只更新来源实例的分片。
   * 日志展示期间前台批次不落在展示上，但仍要补一次确认并记下待重取：
   * 丢弃又不确认会让未确认窗口白白堆积，而退场后本来就要按权威基准重建。
   */
  function applyBatch(batch: ProjectionBatch): void {
    const origin = batch.runId ?? foregroundRunId.value
    if (origin === null) return
    if (origin !== foregroundRunId.value) {
      applyBackgroundBatch(origin, batch)
      return
    }
    if (logPage.value !== null) {
      logBatchPending = true
      ackRuntimeProjection({ runId: origin, runtimeId: batch.runtimeId }, batch.seq)
      return
    }
    const target: RuntimeTarget = { runId: origin, runtimeId: batch.runtimeId }
    if (appliedRunId !== origin || batch.runtimeId !== appliedRuntimeId) {
      // 尚无基准快照，或批次属于其他实例/代际：不能无基准地应用增量。
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.resyncRequired) {
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.seq <= appliedSeq) {
      // 快照已经覆盖的迟到批次，只需补一次确认。
      ackRuntimeProjection(target, appliedSeq)
      return
    }
    if (batch.seq !== appliedSeq + 1) {
      void syncProjection(batch.runtimeId)
      return
    }

    const applied = applyUpdates(messages.value, tools.value, batch.updates)
    if (applied === null) {
      projectionSync.value = 'stale'
      void syncProjection(batch.runtimeId)
      return
    }
    messages.value = applied.messages
    tools.value = applied.tools
    rememberUiRevisions(history.value, applied.tools)
    for (const update of batch.updates) if (update.kind === 'activity') activity.value = update.activity
    appliedSeq = batch.seq
    projectionSync.value = 'synced'
    ackRuntimeProjection(target, appliedSeq)
  }

  /**
   * 投影随运行实例与绑定代际存在：离开就绪即清空展示消息；没有目标时空投影本身就是基准。
   * 日志展示在场时改由它提供内容：否则一次空重置就会把用户刚看到的历史抹掉。
   */
  function resetProjection(): void {
    const logDisplay = logPage.value
    if (logDisplay !== null) {
      showPreview(logDisplay, false)
      return
    }
    messages.value = []
    tools.value = []
    history.value = emptyHistory()
    activity.value = null
    projectionSync.value = 'synced'
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    appliedRunId = null
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 离开前台时把当前展示留底到该实例的分片；未就绪或没有来源时不留底。 */
  function stashProjection(runId: number): void {
    if (view.value.phase !== 'ready') return
    backgroundProjections.set(runId, {
      messages: messages.value,
      tools: tools.value,
      sync: projectionSync.value,
      truncated: projectionTruncated.value,
      droppedMessages: droppedMessages.value,
      droppedTools: droppedTools.value,
      appliedRuntimeId,
      appliedSeq,
      history: history.value,
      activity: activity.value
    })
  }

  /**
   * 切回前台时取回分片；没有分片就按空基准处理，由状态收敛决定是否重取。
   * 分片保留在表里：中间经过一个未就绪的前台不会把已取得的内容丢掉。
   */
  function restoreProjection(runId: number | null): void {
    const saved = runId === null ? undefined : backgroundProjections.get(runId)
    if (saved === undefined) {
      resetProjection()
      return
    }
    messages.value = saved.messages
    tools.value = saved.tools
    history.value = saved.history
    activity.value = saved.activity
    projectionSync.value = saved.sync
    projectionTruncated.value = saved.truncated
    droppedMessages.value = saved.droppedMessages
    droppedTools.value = saved.droppedTools
    appliedRunId = runId
    appliedRuntimeId = saved.appliedRuntimeId
    appliedSeq = saved.appliedSeq
  }

  /** 运行实例消失（释放、移除或退出）后丢弃它的分片，不让已结束实例的内容留在内存里。 */
  function pruneSlices(active: ReadonlySet<number>): void {
    for (const runId of [...backgroundProjections.keys()]) {
      if (!active.has(runId)) backgroundProjections.delete(runId)
    }
  }

  /**
   * 后台实例的批次只更新它的分片：前台展示不变，切回时无需重取。
   * 没有基准或代际不符时不做无基准的增量，只标记为需要重取。
   */
  function applyBackgroundBatch(runId: number, batch: ProjectionBatch): void {
    const slice = backgroundProjections.get(runId)
    if (slice === undefined) return
    const target: RuntimeTarget = { runId, runtimeId: batch.runtimeId }
    if (slice.appliedRuntimeId !== batch.runtimeId) {
      slice.sync = 'stale'
      return
    }
    if (batch.seq <= slice.appliedSeq) {
      ackRuntimeProjection(target, slice.appliedSeq)
      return
    }
    if (batch.resyncRequired || batch.seq !== slice.appliedSeq + 1) {
      slice.sync = 'stale'
      return
    }
    const applied = applyUpdates(slice.messages, slice.tools, batch.updates)
    if (applied === null) {
      slice.sync = 'stale'
      return
    }
    slice.messages = applied.messages
    slice.tools = applied.tools
    rememberUiRevisions(slice.history, applied.tools)
    for (const update of batch.updates) if (update.kind === 'activity') slice.activity = update.activity
    slice.appliedSeq = batch.seq
    slice.sync = 'synced'
    ackRuntimeProjection(target, slice.appliedSeq)
  }

  /**
   * 只收敛会话侧状态：投影分片、动作互斥与前台身份；模型侧影响经 `statusEffects` 在
   * 同一同步栈内一次转交，两切片各自只维护自己的判定；绑定由组合根在创建时完成（早于 subscribe）。
   */
  function applyStatus(status: RuntimeStatus): void {
    statusEffects?.(applySessionStatus(status))
  }

  /** 应用状态中的会话侧部分，返回本轮的会话变化供模型切片复用。 */
  function applySessionStatus(status: RuntimeStatus): StatusTransitionContext {
    const previous = view.value.phase === 'ready' ? view.value.snapshot : null
    const previousRunId = previous?.runId ?? null
    statusSessionId.value = status.sessionId
    // 运行实例与绑定代际一起决定目标：任一维度变化都重置瞬态并重取基准。
    const targetChanged = status.state !== 'ready'
      || status.runId !== previous?.runId
      || status.runtimeId !== previous?.runtimeId
    const sessionChanged = status.state === 'ready'
      && (status.info?.sessionId ?? null) !== (previous?.info?.sessionId ?? null)
    const previousStreaming = previous?.info?.isStreaming === true
    foregroundRunId.value = status.runId
    // 只有绑定到日志展示所属会话时才让日志展示退场：切到另一个项目的旧前台实例也会上报 ready，
    // 那种情况下用户等待的仍然是日志展示中的会话，提前清掉就会退回等待态。
    // 退场不在这里清空：先取一次权威基准，应用成功后再交还展示位，中间不出现空白。
    if (status.state === 'ready' && status.info?.sessionId === logSessionId.value) {
      previewRetiring = true
      baselineNeeded = true
    }
    // 前台换实例：把上一个实例的投影留底，再取回目标实例的分片；同一实例内换代由下面的重取收敛。
    let reusedSlice = false
    if (previousRunId !== status.runId) {
      if (previousRunId !== null) stashProjection(previousRunId)
      // 目标实例未就绪时没有可展示的投影，分片留在表里等它重新就绪。
      if (status.state === 'ready') {
        restoreProjection(status.runId)
        // 分片的绑定代际与目标一致且未失去同步时，取回的就是权威基准，再读一次整表不会带来新内容。
        reusedSlice = appliedRunId === status.runId && appliedRuntimeId === status.runtimeId
          && projectionSync.value === 'synced'
      } else resetProjection()
    }
    if (targetChanged) preparingPrompt.value = false
    // 只有换了前台实例才作废进行中的回退：回退自身会换会话与绑定代际，不能把自己的结果判成过期。
    if (status.runId !== previousRunId) {
      rewindRequest += 1
      rewindView.value = { phase: 'idle' }
    }
    if (targetChanged || sessionChanged) {
      promptView.value = { phase: 'idle' }
      abortView.value = { phase: 'idle' }
      compactRequest += 1
      compactView.value = { phase: 'idle' }
    }
    if (status.state !== 'ready') {
      // 挂起态（宿主已回收）保留历史：会话身份仍在，清空展示会让用户以为会话丢了。
      if (status.sessionId === null) resetProjection()
      // 离开就绪后，上一次中止请求的展示状态不再有意义。
      abortView.value = { phase: 'idle' }
    }
    if (status.state === 'failed') {
      view.value = {
        phase: 'failed',
        error: {
          code: 'RUNTIME_EXITED',
          message: status.lastError ?? 'Runtime 已异常退出，结果不确定。'
        }
      }
      return { targetChanged, sessionChanged, previousStreaming, sessionAbsent: status.sessionId === null }
    }
    if (status.state === 'ready') {
      view.value = { phase: 'ready', snapshot: status }
      if (status.runId !== null) {
        lastReadyIdentity.value = { runId: status.runId, runtimeId: status.runtimeId,
          sessionId: status.info?.sessionId ?? null }
      }
      // 换实例、换代、换会话、上一次重同步未收敛（syncing/stale）或欠着基准快照都重新取基准；
      // 例外是取回的分片仍与该绑定一致：此时切回直接复用缓存，不再重读整表。
      // 日志展示等退场时也一定取一次基准：退场只能发生在基准落位之后。
      if (previewRetiring || sessionChanged || status.runtimeId !== appliedRuntimeId
        || projectionSync.value !== 'synced' || baselineNeeded || (targetChanged && !reusedSlice)) {
        baselineNeeded = false
        void syncProjection(status.runtimeId ?? undefined)
      }
      return { targetChanged, sessionChanged, previousStreaming, sessionAbsent: false }
    }
    if (status.state === 'stopping') {
      view.value = { phase: 'stopping' }
      return { targetChanged, sessionChanged, previousStreaming, sessionAbsent: status.sessionId === null }
    }
    if (status.state === 'starting') {
      view.value = { phase: 'starting' }
      return { targetChanged, sessionChanged, previousStreaming, sessionAbsent: status.sessionId === null }
    }
    // idle 且带会话身份表示宿主已回收（挂起），带 runtimeId 表示上一次 Runtime 已正常关闭。
    view.value = status.sessionId !== null || status.runtimeId !== null ? { phase: 'closed' } : { phase: 'idle' }
    return { targetChanged, sessionChanged, previousStreaming, sessionAbsent: status.sessionId === null }
  }

  /**
   * 把日志历史写进展示位；只替换展示，不触碰应用水位与确认状态。
   * `resetHistory` 为假时保留已往回加载的分页与游标：同一份日志在状态收敛时重放，
   * 不该把用户已经翻到的更早内容与游标一起丢掉。
   */
  function showPreview(page: HistoryPage, resetHistory = true): void {
    messages.value = page.messages
    tools.value = page.tools
    if (resetHistory) history.value = { ...emptyHistory(), before: page.before }
    activity.value = null
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    // 日志页本身就是完整一页：不进入 stale，否则界面会提示「失去同步」而掩盖真实状态。
    projectionSync.value = 'synced'
  }

  /**
   * 应用一页日志历史：同一会话已经绑定就忽略（权威投影优先），
   * 否则把内容放进展示位，并记住后续读取要寻址的项目与会话。
   */
  function applyLogPage(page: HistoryPage, target: { readonly projectPath: string; readonly sessionId: string }): void {
    if (view.value.phase === 'ready' && view.value.snapshot.info?.sessionId === target.sessionId) return
    logPage.value = page
    logSessionId.value = target.sessionId
    logProjectPath.value = target.projectPath
    lastSessionProject.value = { sessionId: target.sessionId, projectPath: target.projectPath }
    showPreview(page)
  }

  /**
   * 日志展示退场但保留内容：权威基准已经写在同一展示位上，再清一次会把刚取到的历史抹掉。
   * 只交还来源身份与欠基准标记，写入门禁由绑定态本身决定。
   */
  function retirePreview(): void {
    previewRetiring = false
    logPage.value = null
    logSessionId.value = null
    logProjectPath.value = null
    logBatchPending = false
    baselineNeeded = false
  }

  /** 丢弃日志展示并清空内容；随后由状态收敛决定是否取权威基准。 */
  function clearPreview(): void {
    if (logPage.value === null && logSessionId.value === null) return
    previewRetiring = false
    logPage.value = null
    logSessionId.value = null
    logProjectPath.value = null
    messages.value = []
    tools.value = []
    history.value = emptyHistory()
    activity.value = null
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    // 日志展示期间跳过的前台批次只能靠重取补上：只记「欠基准」，不改失步状态，
    // 由随后的就绪收敛取一次权威快照。
    if (logBatchPending) {
      logBatchPending = false
      baselineNeeded = true
    }
  }

  /** 页面卸载：释放订阅并作废回退结果；已提交的主进程操作不受影响。 */
  function reset(): void {
    clearPreview()
    previewRetiring = false
    baselineNeeded = false
    unsubscribe()
    projectionSyncPromise = null
    foregroundRunId.value = null
    appliedRunId = null
    backgroundProjections.clear()
    lastReadyIdentity.value = null
    statusSessionId.value = null
    rewindRequest += 1
    rewindView.value = { phase: 'idle' }
    preparingPrompt.value = false
  }

  return {
    view,
    foregroundRunId,
    suspendedSessionId,
    foregroundSessionId,
    conversationKey,
    promptView,
    preparingPrompt,
    rewindView,
    abortView,
    compactView,
    modelSwitchView,
    messages,
    tools,
    displayMessages,
    displayTools,
    history,
    activity,
    logSessionId,
    applyLogPage,
    clearPreview,
    projectionSync,
    projectionTruncated,
    droppedMessages,
    droppedTools,
    bindStatusEffects(handler) { statusEffects = handler },
    subscribe,
    unsubscribe,
    refreshStatus,
    syncProjection,
    pruneSlices,
    loadEarlierHistory: historyCache.loadEarlier,
    loadHistoryTurn: historyCache.loadTurn,
    loadHistoryChunk: historyCache.loadChunk,
    setHistoryVisibility: historyCache.setVisibility,
    currentTarget,
    rewindBlocksWrites,
    send,
    rewind,
    compact,
    stopOperation,
    applyStatus,
    reset
  }
}
