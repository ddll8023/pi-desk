/**
 * 保存 Extension UI 的展示状态：dialog 队列与收起态、通知、状态条、widget 与编辑器填充文本。
 * 只做状态映射、收起/恢复与响应提交，不持有 Runtime 所有权；过期快照按序号丢弃，契约不符时换取快照。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ExtensionDialogRequest,
  ExtensionDialogResponseInput,
  ExtensionUiSnapshot
} from '../../../shared/extension-ui-api'
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
  let appliedSeq = -1

  /** 先订阅、再取快照，避免初始化期间漏掉通知。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeExtensionUi(applySnapshot)
    }
    const result = await getExtensionUiState()
    if (result.ok) applySnapshot(result.data)
  }

  /** 页面卸载时释放订阅；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
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

  /** 提交 dialog 响应；只有 sending 之外的空闲状态才发起，避免重复提交。 */
  async function respond(dialogId: string, response: ExtensionDialogResponseInput): Promise<void> {
    if (respondState.value.phase === 'sending') return
    respondState.value = { phase: 'sending' }
    const result = await respondExtensionDialog(dialogId, response)
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

  /** 快照按序号应用：旧快照丢弃，新快照整体替换；编辑器文本变化时递增版本号。 */
  function applySnapshot(snapshot: ExtensionUiSnapshot): void {
    if (snapshot.seq <= appliedSeq) return
    appliedSeq = snapshot.seq
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
