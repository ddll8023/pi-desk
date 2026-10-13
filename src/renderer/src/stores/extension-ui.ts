/**
 * 保存 Extension UI 的展示状态：dialog 队列与收起态、通知、状态条、widget 与编辑器填充文本。
 * 只做状态映射、收起/恢复与响应提交，不持有运行实例所有权；只应用前台实例的快照，
 * 过期快照按序号丢弃，序号水位随实例切换重置（每个实例自己的序号从零开始）。
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { WatchStopHandle } from 'vue'
import type {
  ExtensionDialogRequest,
  ExtensionDialogResponseInput,
  ExtensionUiSnapshot
} from '../../../shared/extension-ui-api'
import { useRuntimeStore } from './runtime'
import {
  getExtensionUiState,
  respondExtensionDialog,
  subscribeExtensionUi
} from '../services/extension-ui'

/** 对话响应动作的展示状态；成功以主进程快照收敛，不在这里保存结果。 */
type RespondState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'error'; message: string }

export const useExtensionUiStore = defineStore('extension-ui', () => {
  /** 已应用快照的来源运行实例；没有前台实例或尚未取得快照时为 null。 */
  const runId = ref<number | null>(null)
  const runtimeId = ref<number | null>(null)
  const dialogs = ref<readonly ExtensionDialogRequest[]>([])
  const notifications = ref<ExtensionUiSnapshot['state']['notifications']>([])
  const statuses = ref<ExtensionUiSnapshot['state']['statuses']>([])
  const widgets = ref<ExtensionUiSnapshot['state']['widgets']>([])
  const editorText = ref<string | null>(null)
  const invalidCount = ref(0)
  /**
   * 被收起的队首 dialog id：收起只隐藏弹窗，不提交响应，Pi 侧仍在等待；
   * 队首变化或队列清空时自动作废，避免恢复到已结束的请求。
   */
  const minimizedDialogId = ref<string | null>(null)
  const respondState = ref<RespondState>({ phase: 'idle' })
  /** 已被页面消费的编辑器填充文本；PromptComposer 消费后调用 markEditorTextConsumed。 */
  let editorTextSeq = 0
  const editorTextVersion = ref(0)
  let releaseSubscription: (() => void) | null = null
  let stopRuntimeWatch: WatchStopHandle | null = null
  /** 已应用的快照序号；只在同一来源实例内可比，切换实例时重置。 */
  let appliedSeq = -1

  /**
   * 先订阅、再取当前前台实例的快照，避免初始化期间漏掉通知；
   * 前台实例变化时重新查询，因为订阅只能覆盖已经在发生的事件。
   */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeExtensionUi(applySnapshot)
    }
    if (stopRuntimeWatch === null) {
      const runtimeStore = useRuntimeStore()
      stopRuntimeWatch = watch(
        () => [runtimeStore.foregroundRunId, runtimeStore.view.phase] as const,
        () => { void refreshFromForeground() }
      )
    }
    await refreshFromForeground()
  }

  /** 页面卸载时释放订阅与监听；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
    stopRuntimeWatch?.()
    stopRuntimeWatch = null
    minimizedDialogId.value = null
  }

  /** 按当前前台实例重新取交互快照；没有前台实例时清空展示，不保留上一个实例的交互。 */
  async function refreshFromForeground(): Promise<void> {
    const foreground = useRuntimeStore().foregroundRunId
    if (foreground === null) {
      resetSnapshot()
      return
    }
    const result = await getExtensionUiState(foreground)
    // 期间前台又切换了：结果属于旧实例，等新实例自己的查询收敛。
    if (!result.ok || useRuntimeStore().foregroundRunId !== foreground) return
    applySnapshot(result.data)
  }

  /** 清空交互展示并重置序号水位；没有来源实例时展示的就是无交互。 */
  function resetSnapshot(): void {
    runId.value = null
    appliedSeq = -1
    dialogs.value = []
    notifications.value = []
    statuses.value = []
    widgets.value = []
    editorText.value = null
    invalidCount.value = 0
    minimizedDialogId.value = null
  }

  /** 收起当前对话：只影响展示，不代替取消；底部入口据此恢复。 */
  function minimizeDialog(dialogId: string): void {
    if (!dialogs.value.some((entry) => entry.id === dialogId)) return
    minimizedDialogId.value = dialogId
  }

  /** 恢复被收起的对话；没有收起态时无副作用。 */
  function restoreDialog(): void {
    minimizedDialogId.value = null
  }

  /** 提交 dialog 响应；只有 sending 之外的空闲状态才发起，目标固定为已应用的来源实例。 */
  async function respond(dialogId: string, response: ExtensionDialogResponseInput): Promise<void> {
    if (respondState.value.phase === 'sending') return
    const target = respondTarget()
    // 没有来源实例或代际时不提交：回应不能落到别的实例或旧代际上。
    if (target === null) return
    respondState.value = { phase: 'sending' }
    const result = await respondExtensionDialog(target, dialogId, response)
    if (result.ok) {
      respondState.value = { phase: 'idle' }
      applySnapshot(result.data)
      return
    }
    respondState.value = { phase: 'error', message: result.error.message }
  }

  /** 关闭一条错误提示；错误在下次提交或新快照到达时清除。 */
  function clearRespondError(): void {
    if (respondState.value.phase === 'error') respondState.value = { phase: 'idle' }
  }

  /** 关闭一条通知；只影响本地展示，主进程列表仍由 Pi 驱动。 */
  function dismissNotification(id: string): void {
    notifications.value = notifications.value.filter((entry) => entry.id !== id)
  }

  /** PromptComposer 消费填充文本后调用，避免同一文本被重复写入。 */
  function markEditorTextConsumed(): void {
    editorText.value = null
  }

  /** 提交目标：已应用快照的来源实例与代际；两者缺一就不提交。 */
  function respondTarget(): { readonly runId: number; readonly runtimeId: number } | null {
    const origin = runId.value
    const generation = runtimeId.value
    if (origin === null || generation === null) return null
    return { runId: origin, runtimeId: generation }
  }

  /** 快照按序号应用：只接受前台实例，旧实例/旧序号丢弃，新快照整体替换。 */
  function applySnapshot(snapshot: ExtensionUiSnapshot): void {
    const origin = snapshot.runId ?? null
    // 后台实例的快照不覆盖前台展示；缺失来源（宿主协议载荷）按前台处理。
    if (origin !== null && origin !== useRuntimeStore().foregroundRunId) return
    // 序号只在同一实例内可比：来源实例变化时重置水位，避免跨实例回退丢帧。
    if (runId.value !== origin) appliedSeq = -1
    if (snapshot.seq <= appliedSeq) return
    appliedSeq = snapshot.seq
    runId.value = origin
    runtimeId.value = snapshot.runtimeId
    dialogs.value = snapshot.state.dialogs
    notifications.value = snapshot.state.notifications
    statuses.value = snapshot.state.statuses
    widgets.value = snapshot.state.widgets
    invalidCount.value = snapshot.state.invalidCount
    // 收起的目标已经回应或被新请求取代：清除收起态，不把入口指向旧请求。
    if (minimizedDialogId.value !== null
      && !snapshot.state.dialogs.some((entry) => entry.id === minimizedDialogId.value)) {
      minimizedDialogId.value = null
    }
    if (snapshot.state.editorText !== editorText.value) {
      editorText.value = snapshot.state.editorText
      editorTextSeq += 1
      editorTextVersion.value = editorTextSeq
    }
  }

  return {
    runId,
    runtimeId,
    dialogs,
    notifications,
    statuses,
    widgets,
    editorText,
    editorTextVersion,
    invalidCount,
    minimizedDialogId,
    respondState,
    initialize,
    dispose,
    respond,
    minimizeDialog,
    restoreDialog,
    clearRespondError,
    dismissNotification,
    markEditorTextConsumed
  }
})
