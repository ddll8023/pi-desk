/** 保存聊天区与 Runtime 状态的展示状态、投影消息与工具条目副本、Agent 能力、订阅与启停、Prompt 提交与控制动作（含手动压缩），不持有 Runtime 所有权，也不承担消息重建与通知窗口。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AgentCapabilities,
  CompactResult,
  ProjectionBatch,
  ProjectionBlock,
  ProjectionMessage,
  ProjectionUpdate,
  PromptDisposition,
  PromptImageInput,
  RuntimeError,
  RuntimeStatus,
  ToolExecution
} from '../../../shared/runtime-api'
import { useTrustStore } from './trust'
import {
  abortRuntime,
  ackRuntimeProjection,
  compactRuntime,
  getRuntimeCapabilities,
  getRuntimeProjection,
  getRuntimeStatus,
  sendPrompt,
  setRuntimeModel,
  setRuntimeThinkingLevel,
  startRuntime,
  stopRuntime,
  subscribeRuntimeProjection,
  subscribeRuntimeStatus
} from '../services/runtime'

type RuntimeViewState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; snapshot: RuntimeStatus }
  | { phase: 'stopping' }
  | { phase: 'closed' }
  | { phase: 'failed'; error: RuntimeError }

type PromptViewState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'accepted'; disposition: PromptDisposition }
  | { phase: 'error'; error: RuntimeError }

/** 中止请求的展示状态；运行中状态本身仍由事件流收敛。 */
type AbortViewState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'error'; error: RuntimeError }

/** `syncing` 表示未取得基准或正在重同步，`stale` 表示失去同步且尚未取得快照。 */
type ProjectionSyncState = 'syncing' | 'synced' | 'stale'

/** Agent 能力的展示状态；分区失败已在数据内表达，只有整体失败才进 `error`。 */
type CapabilitiesViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: AgentCapabilities }
  | { phase: 'error'; error: RuntimeError }

/** 模型或 Thinking 设置动作的展示状态；成功以快照收敛，不在这里保存结果值。 */
type AgentActionState =
  | { phase: 'idle' }
  | { phase: 'applying' }
  | { phase: 'error'; error: RuntimeError }

/** 手动压缩动作的展示状态；成功保留最近一次结果供界面展示。 */
type CompactActionState =
  | { phase: 'idle' }
  | { phase: 'compacting' }
  | { phase: 'done'; result: CompactResult }
  | { phase: 'error'; error: RuntimeError }

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

export const useRuntimeStore = defineStore('runtime', () => {
  const view = ref<RuntimeViewState>({ phase: 'idle' })
  const promptView = ref<PromptViewState>({ phase: 'idle' })
  const abortView = ref<AbortViewState>({ phase: 'idle' })
  const messages = ref<readonly ProjectionMessage[]>([])
  const tools = ref<readonly ToolExecution[]>([])
  const projectionSync = ref<ProjectionSyncState>('syncing')
  const projectionTruncated = ref(false)
  const droppedMessages = ref(0)
  const droppedTools = ref(0)
  const capabilitiesView = ref<CapabilitiesViewState>({ phase: 'idle' })
  const modelAction = ref<AgentActionState>({ phase: 'idle' })
  const thinkingAction = ref<AgentActionState>({ phase: 'idle' })
  const compactAction = ref<CompactActionState>({ phase: 'idle' })
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的 Runtime 代际；为空表示尚无基准。 */
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  let syncInFlight = false
  /** 已取得能力结果的 Runtime 代际；代际不符的结果一律丢弃。 */
  let capabilitiesRuntimeId: number | null = null
  /**
   * 已发起过读取的代际：读取失败后不因每次状态广播重复重试，
   * 只有代际变化或一轮结束（上下文占用会变化）才再次读取。
   */
  let capabilitiesAttemptedRuntimeId: number | null = null

  /** 先订阅状态与投影、再取快照，避免初始化期间漏掉通知。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeRuntimeStatus(applyStatus)
    }
    if (releaseProjection === null) {
      releaseProjection = subscribeRuntimeProjection(applyBatch)
    }
    const result = await getRuntimeStatus()
    if (result.ok) applyStatus(result.data)
    await syncProjection()
  }

  /** 页面卸载时释放订阅；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
    releaseProjection?.()
    releaseProjection = null
  }

  /** 启动唯一 Runtime；启动、就绪或关闭中都不重复发起。当前界面不调用它，启动统一走打开或新建会话。 */
  async function launch(projectPath: string): Promise<void> {
    if (view.value.phase === 'starting' || view.value.phase === 'ready' || view.value.phase === 'stopping') {
      return
    }

    view.value = { phase: 'starting' }
    const result = await startRuntime(projectPath)
    if (!result.ok) {
      if (result.error.code === 'TRUST_REQUIRED') {
        // 与会话切换共用同一条信任决定流程；用户取消后回到当前状态。
        view.value = { phase: 'idle' }
        await useTrustStore().openPrompt()
        return
      }
      view.value = { phase: 'failed', error: result.error }
      return
    }
    // 主进程只在就绪时返回成功；其他状态按失败展示，不把进程存在当作可用。
    if (result.data.state !== 'ready') {
      view.value = {
        phase: 'failed',
        error: { code: 'INTERNAL_ERROR', message: 'Runtime 没有进入就绪状态。' }
      }
      return
    }
    applyStatus(result.data)
  }

  /** 关闭当前 Runtime；只有就绪状态才发起关闭。 */
  async function shutdown(): Promise<void> {
    if (view.value.phase !== 'ready') return

    view.value = { phase: 'stopping' }
    const result = await stopRuntime()
    if (!result.ok) {
      view.value = { phase: 'failed', error: result.error }
      return
    }
    applyStatus(result.data)
  }

  /** 提交 Prompt（含可选图片附件）；只有就绪状态才发起，发送中不重复提交。 */
  async function send(message: string, images: readonly PromptImageInput[] = []): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending') return

    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(message, images)
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /**
   * 请求中止当前操作；只在就绪且事件流显示运行中时发起，发送中不重复提交。
   * 成功只表示 Pi 已确认取消，运行中状态的最终收敛仍由事件流负责。
   */
  async function stopOperation(): Promise<void> {
    if (view.value.phase !== 'ready') return
    if (view.value.snapshot.info?.isStreaming !== true) return
    if (abortView.value.phase === 'requesting') return

    abortView.value = { phase: 'requesting' }
    const result = await abortRuntime()
    abortView.value = result.ok
      ? { phase: 'idle' }
      : { phase: 'error', error: result.error }
  }

  /** 全量重同步：快照是唯一基准，期间到达的增量由序号守卫丢弃。 */
  async function syncProjection(expectedRuntimeId?: number): Promise<void> {
    if (syncInFlight) return
    syncInFlight = true
    projectionSync.value = 'syncing'

    const result = await getRuntimeProjection()
    syncInFlight = false
    if (!result.ok) {
      projectionSync.value = 'stale'
      return
    }

    const snapshot = result.data
    if (expectedRuntimeId !== undefined && snapshot.runtimeId !== expectedRuntimeId) {
      // 快照已经换代：等待新代际的基准，不套用旧结果。
      projectionSync.value = 'syncing'
      return
    }

    appliedRuntimeId = snapshot.runtimeId
    appliedSeq = snapshot.seq
    messages.value = snapshot.messages
    tools.value = snapshot.tools
    projectionTruncated.value = snapshot.truncated
    droppedMessages.value = snapshot.droppedMessages
    droppedTools.value = snapshot.droppedTools
    projectionSync.value = 'synced'
    if (snapshot.runtimeId !== null) ackRuntimeProjection(snapshot.runtimeId, snapshot.seq)
  }

  /** 批次按序号连续应用；旧代际、缺口与重同步标记都收敛到快照。 */
  function applyBatch(batch: ProjectionBatch): void {
    if (appliedRuntimeId === null || batch.runtimeId !== appliedRuntimeId) {
      // 尚无基准快照或批次来自旧代际：不能无基准地应用增量。
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.resyncRequired) {
      void syncProjection(batch.runtimeId)
      return
    }
    if (batch.seq <= appliedSeq) {
      // 快照已经覆盖的迟到批次，只需补一次确认。
      ackRuntimeProjection(batch.runtimeId, appliedSeq)
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
    appliedSeq = batch.seq
    projectionSync.value = 'synced'
    ackRuntimeProjection(batch.runtimeId, appliedSeq)
  }

  /** 投影随 Runtime 代际存在：离开就绪即清空展示消息与同步基准。 */
  function resetProjection(): void {
    messages.value = []
    tools.value = []
    projectionSync.value = 'syncing'
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    const previousStreaming = view.value.phase === 'ready'
      && view.value.snapshot.info?.isStreaming === true
    if (status.state !== 'ready') {
      resetProjection()
      // Runtime 离开就绪后，上一次中止请求与控制动作的展示状态不再有意义。
      abortView.value = { phase: 'idle' }
      modelAction.value = { phase: 'idle' }
      thinkingAction.value = { phase: 'idle' }
      compactAction.value = { phase: 'idle' }
      capabilitiesView.value = { phase: 'idle' }
      capabilitiesRuntimeId = null
      capabilitiesAttemptedRuntimeId = null
    }
    if (status.state === 'failed') {
      view.value = {
        phase: 'failed',
        error: {
          code: 'RUNTIME_EXITED',
          message: status.lastError ?? 'Runtime 已异常退出，结果不确定。'
        }
      }
      return
    }
    if (status.state === 'ready') {
      view.value = { phase: 'ready', snapshot: status }
      if (status.runtimeId !== appliedRuntimeId) void syncProjection(status.runtimeId ?? undefined)
      // 新代际，或一轮结束（运行中 → 非运行中）都会改变上下文占用，重新读取能力。
      if (status.runtimeId !== capabilitiesAttemptedRuntimeId
        || (previousStreaming && status.info?.isStreaming !== true)) {
        void refreshCapabilities()
      }
      return
    }
    if (status.state === 'stopping') {
      view.value = { phase: 'stopping' }
      return
    }
    if (status.state === 'starting') {
      view.value = { phase: 'starting' }
      return
    }
    // idle 且带 runtimeId 表示上一次 Runtime 已正常关闭。
    view.value = status.runtimeId === null ? { phase: 'idle' } : { phase: 'closed' }
  }

  /**
   * 读取 Agent 能力：结果必须属于仍在就绪的同一代际，否则丢弃。
   * 已有结果时不回到 loading，避免周期刷新让弹层闪烁。
   */
  async function refreshCapabilities(): Promise<void> {
    if (view.value.phase !== 'ready') return
    const requestedRuntimeId = view.value.snapshot.runtimeId
    capabilitiesAttemptedRuntimeId = requestedRuntimeId
    if (capabilitiesView.value.phase !== 'ready') capabilitiesView.value = { phase: 'loading' }

    const result = await getRuntimeCapabilities()
    if (view.value.phase !== 'ready' || view.value.snapshot.runtimeId !== requestedRuntimeId) return
    if (!result.ok) {
      capabilitiesView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== requestedRuntimeId) return
    capabilitiesRuntimeId = result.data.runtimeId
    capabilitiesView.value = { phase: 'ready', data: result.data }
  }

  /** 切换模型；成功后以主进程快照为准，并重新读取能力（Thinking levels 会随模型变化）。 */
  async function setModel(provider: string, modelId: string): Promise<void> {
    if (view.value.phase !== 'ready' || modelAction.value.phase === 'applying') return

    modelAction.value = { phase: 'applying' }
    const result = await setRuntimeModel(provider, modelId)
    if (!result.ok) {
      modelAction.value = { phase: 'error', error: result.error }
      return
    }
    modelAction.value = { phase: 'idle' }
    applyStatus(result.data)
    await refreshCapabilities()
  }

  /** 设置 Thinking level；取值是否被接受由 Pi 决定，失败按错误码如实展示。 */
  async function setThinkingLevel(level: string): Promise<void> {
    if (view.value.phase !== 'ready' || thinkingAction.value.phase === 'applying') return

    thinkingAction.value = { phase: 'applying' }
    const result = await setRuntimeThinkingLevel(level)
    if (!result.ok) {
      thinkingAction.value = { phase: 'error', error: result.error }
      return
    }
    thinkingAction.value = { phase: 'idle' }
    applyStatus(result.data)
  }

  /**
   * 手动压缩上下文；等待完成，成功展示结果并重新读取能力（上下文占用会变化）。
   * 压缩中提交仍以 Pi 的拒绝为准，这里不做本地预检。
   */
  async function compact(): Promise<void> {
    if (view.value.phase !== 'ready' || compactAction.value.phase === 'compacting') return

    compactAction.value = { phase: 'compacting' }
    const result = await compactRuntime()
    if (!result.ok) {
      compactAction.value = { phase: 'error', error: result.error }
      return
    }
    compactAction.value = { phase: 'done', result: result.data }
    await refreshCapabilities()
  }

  return {
    view,
    promptView,
    abortView,
    capabilitiesView,
    modelAction,
    thinkingAction,
    compactAction,
    messages,
    tools,
    projectionSync,
    projectionTruncated,
    droppedMessages,
    droppedTools,
    initialize,
    dispose,
    launch,
    shutdown,
    send,
    stopOperation,
    refreshCapabilities,
    setModel,
    setThinkingLevel,
    compact
  }
})
