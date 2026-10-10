/** 保存聊天区与 Runtime 状态的展示状态、投影消息与工具条目副本、可用模型与会话模型切换、订阅与启停、Prompt 提交及中止动作，不持有 Runtime 所有权，也不承担消息重建与通知窗口。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AgentCapabilities,
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
  getRuntimeCapabilities,
  getRuntimeProjection,
  getRuntimeStatus,
  sendPrompt,
  setRuntimeModel,
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

/** 模型切换只保存动作状态，当前模型始终由 Runtime 快照表达。 */
type ModelSwitchViewState =
  | { phase: 'idle' }
  | { phase: 'switching' }
  | { phase: 'error'; error: RuntimeError }

/** `synced` 表示当前展示就是基准（无 Runtime 时为空基准），`syncing` 表示未取得基准或正在重同步，`stale` 表示失去同步且尚未取得快照。 */
type ProjectionSyncState = 'syncing' | 'synced' | 'stale'

/** 可用模型列表的读取状态。 */
type CapabilitiesViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: AgentCapabilities }
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
  const modelSwitchView = ref<ModelSwitchViewState>({ phase: 'idle' })
  let modelSwitchRequest = 0
  let capabilitiesRequest = 0
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的 Runtime 代际；为空表示当前没有 Runtime 代际（空基准或尚未取得快照）。 */
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  let syncInFlight = false
  /** 已发起过读取的代际：读取失败后不因每次状态广播重复重试。 */
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

  /** 页面卸载时释放订阅并作废模型切换与模型列表读取的迟到结果；不取消主进程已提交的操作。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
    releaseProjection?.()
    releaseProjection = null
    modelSwitchRequest += 1
    capabilitiesRequest += 1
    modelSwitchView.value = { phase: 'idle' }
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

  /** 提交 Prompt（含可选图片附件）；仅在就绪且未切换模型时发起，发送中不重复提交。 */
  async function send(message: string, images: readonly PromptImageInput[] = []): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending'
      || modelSwitchView.value.phase === 'switching') return

    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(message, images)
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
      : { phase: 'error', error: result.error }
  }

  /** 只在当前代际空闲时切换；不乐观更新模型，也不自动重试写操作。 */
  async function switchModel(provider: string, modelId: string): Promise<void> {
    if (view.value.phase !== 'ready' || view.value.snapshot.info?.isStreaming === true
      || promptView.value.phase === 'sending' || modelSwitchView.value.phase === 'switching') return
    const status = view.value.snapshot
    const runtimeId = status.runtimeId
    if (runtimeId === null) return
    if (status.info?.modelProvider === provider && status.info.modelId === modelId) return

    const request = ++modelSwitchRequest
    modelSwitchView.value = { phase: 'switching' }
    const result = await setRuntimeModel(runtimeId, provider, modelId)
    if (request !== modelSwitchRequest || view.value.phase !== 'ready'
      || view.value.snapshot.runtimeId !== runtimeId) return
    if (!result.ok) {
      modelSwitchView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== runtimeId || result.data.state !== 'ready') {
      modelSwitchView.value = {
        phase: 'error',
        error: { code: 'INVALID_RESPONSE', message: '模型切换返回了其他会话的状态，未应用该结果。' }
      }
      return
    }
    applyStatus(result.data)
    modelSwitchView.value = { phase: 'idle' }
    void refreshCapabilities()
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

  /**
   * 全量重同步：快照是唯一基准，期间到达的增量由序号守卫丢弃。
   * 无活动 Runtime 的空快照（`runtimeId` 为 null）本身是有效空基准，不作为换代冲突处理。
   */
  async function syncProjection(expectedRuntimeId?: number): Promise<void> {
    if (syncInFlight) return
    syncInFlight = true
    projectionSync.value = 'syncing'

    try {
      const result = await getRuntimeProjection()
      if (!result.ok) {
        projectionSync.value = 'stale'
        return
      }

      const snapshot = result.data
      if (expectedRuntimeId !== undefined
        && snapshot.runtimeId !== null
        && snapshot.runtimeId !== expectedRuntimeId) {
        // 快照已换代且新代际仍在运行：等待该代际的基准，不套用旧结果。
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
    } finally {
      // 任何返回路径（含通信异常）都必须释放标记，否则后续重同步会被永久丢弃。
      syncInFlight = false
    }
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

  /** 投影随 Runtime 代际存在：离开就绪即清空展示消息；没有 Runtime 时空投影本身就是基准。 */
  function resetProjection(): void {
    messages.value = []
    tools.value = []
    projectionSync.value = 'synced'
    projectionTruncated.value = false
    droppedMessages.value = 0
    droppedTools.value = 0
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    const previousRuntimeId = view.value.phase === 'ready' ? view.value.snapshot.runtimeId : null
    const previousStreaming = view.value.phase === 'ready'
      && view.value.snapshot.info?.isStreaming === true
    if (status.state !== 'ready' || status.runtimeId !== previousRuntimeId) {
      modelSwitchRequest += 1
      capabilitiesRequest += 1
      modelSwitchView.value = { phase: 'idle' }
    }
    if (status.state !== 'ready') {
      resetProjection()
      // Runtime 离开就绪后，上一次中止请求的展示状态不再有意义。
      abortView.value = { phase: 'idle' }
      capabilitiesView.value = { phase: 'idle' }
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
      // 换代与上一次重同步未收敛（syncing/stale）都重新取基准。
      if (status.runtimeId !== appliedRuntimeId || projectionSync.value !== 'synced') {
        void syncProjection(status.runtimeId ?? undefined)
      }
      // 新 Runtime 或一轮结束后刷新模型列表，维持 Provider 与图片输入能力提示。
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

  /** 读取当前 Runtime 的可用模型；仅接收仍在就绪的同一代际中最新请求的结果，其余结果丢弃。 */
  async function refreshCapabilities(): Promise<void> {
    if (view.value.phase !== 'ready') return
    const requestedRuntimeId = view.value.snapshot.runtimeId
    const request = ++capabilitiesRequest
    capabilitiesAttemptedRuntimeId = requestedRuntimeId
    if (capabilitiesView.value.phase !== 'ready' || capabilitiesView.value.data.modelsError !== null) {
      capabilitiesView.value = { phase: 'loading' }
    }

    const result = await getRuntimeCapabilities()
    if (request !== capabilitiesRequest || view.value.phase !== 'ready'
      || view.value.snapshot.runtimeId !== requestedRuntimeId) return
    if (!result.ok) {
      capabilitiesView.value = { phase: 'error', error: result.error }
      return
    }
    if (result.data.runtimeId !== requestedRuntimeId) return
    capabilitiesView.value = { phase: 'ready', data: result.data }
  }

  return {
    view,
    promptView,
    abortView,
    capabilitiesView,
    modelSwitchView,
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
    switchModel,
    stopOperation,
    refreshCapabilities
  }
})
