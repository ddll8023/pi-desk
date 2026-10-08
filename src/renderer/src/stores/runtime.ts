/** 保存 Runtime 页面的展示状态、投影消息副本、订阅与启停、Prompt 提交动作，不持有 Runtime 所有权，也不承担消息重建与通知窗口。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ProjectionBatch,
  ProjectionBlock,
  ProjectionMessage,
  ProjectionUpdate,
  PromptDisposition,
  RuntimeError,
  RuntimeStatus
} from '../../../shared/runtime-api'
import {
  ackRuntimeProjection,
  getRuntimeProjection,
  getRuntimeStatus,
  sendPrompt,
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

/** `syncing` 表示未取得基准或正在重同步，`stale` 表示失去同步且尚未取得快照。 */
type ProjectionSyncState = 'syncing' | 'synced' | 'stale'

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
  updates: readonly ProjectionUpdate[]
): ProjectionMessage[] | null {
  let next = [...messages]
  for (const update of updates) {
    if (update.kind === 'message') {
      const index = next.findIndex((message) => message.id === update.message.id)
      next = index < 0
        ? [...next, update.message]
        : next.map((message) => (message.id === update.message.id ? update.message : message))
      continue
    }

    const index = next.findIndex((message) => message.id === update.messageId)
    const target = index < 0 ? undefined : next[index]
    if (target === undefined) return null

    const blocks = update.kind === 'block'
      ? replaceBlock(target.blocks, update.block)
      : appendBlock(target.blocks, update.contentIndex, update.text, update.length)
    if (blocks === null) return null
    next[index] = { ...target, blocks }
  }
  return next
}

export const useRuntimeStore = defineStore('runtime', () => {
  const view = ref<RuntimeViewState>({ phase: 'idle' })
  const promptView = ref<PromptViewState>({ phase: 'idle' })
  const messages = ref<readonly ProjectionMessage[]>([])
  const projectionSync = ref<ProjectionSyncState>('syncing')
  const projectionTruncated = ref(false)
  const droppedMessages = ref(0)
  let releaseSubscription: (() => void) | null = null
  let releaseProjection: (() => void) | null = null
  /** 已取得基准快照的 Runtime 代际；为空表示尚无基准。 */
  let appliedRuntimeId: number | null = null
  let appliedSeq = 0
  let syncInFlight = false

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

  /** 启动唯一 Runtime；启动、就绪或关闭中都不重复发起。 */
  async function launch(projectPath: string): Promise<void> {
    if (view.value.phase === 'starting' || view.value.phase === 'ready' || view.value.phase === 'stopping') {
      return
    }

    view.value = { phase: 'starting' }
    const result = await startRuntime(projectPath)
    if (!result.ok) {
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

  /** 提交 Prompt；只有就绪状态才发起，发送中不重复提交。 */
  async function send(message: string): Promise<void> {
    if (view.value.phase !== 'ready' || promptView.value.phase === 'sending') return

    promptView.value = { phase: 'sending' }
    const result = await sendPrompt(message)
    promptView.value = result.ok
      ? { phase: 'accepted', disposition: result.data.disposition }
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
    projectionTruncated.value = snapshot.truncated
    droppedMessages.value = snapshot.droppedMessages
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

    const applied = applyUpdates(messages.value, batch.updates)
    if (applied === null) {
      projectionSync.value = 'stale'
      void syncProjection(batch.runtimeId)
      return
    }
    messages.value = applied
    appliedSeq = batch.seq
    projectionSync.value = 'synced'
    ackRuntimeProjection(batch.runtimeId, appliedSeq)
  }

  /** 投影随 Runtime 代际存在：离开就绪即清空展示消息与同步基准。 */
  function resetProjection(): void {
    messages.value = []
    projectionSync.value = 'syncing'
    projectionTruncated.value = false
    droppedMessages.value = 0
    appliedRuntimeId = null
    appliedSeq = 0
  }

  /** 主进程快照是唯一真相：事件通知与查询结果都经这里映射为展示状态。 */
  function applyStatus(status: RuntimeStatus): void {
    if (status.state !== 'ready') resetProjection()
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

  return {
    view,
    promptView,
    messages,
    projectionSync,
    projectionTruncated,
    droppedMessages,
    initialize,
    dispose,
    launch,
    shutdown,
    send
  }
})
