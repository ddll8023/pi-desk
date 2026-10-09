/** 保存会话面板的展示状态：当前项目的会话列表、打开动作与分叉弹层状态、分叉动作；会话文件解析与切换编排都在主进程。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ForkMessageSummary,
  SessionError,
  SessionList,
  SessionSummary
} from '../../../shared/session-api'
import { useTrustStore } from './trust'
import { getForkMessages, listSessions, openSession, startFork } from '../services/session'

/** `idle` 表示尚无当前项目、未读取列表；单次动作失败放在 `actionError`，不影响已加载的列表。 */
type SessionViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: SessionError }

export const useSessionStore = defineStore('session', () => {
  const view = ref<SessionViewState>({ phase: 'idle' })
  const sessions = ref<readonly SessionSummary[]>([])
  const skipped = ref(0)
  const truncated = ref(0)
  const actionError = ref<SessionError | null>(null)
  const opening = ref(false)
  /** 待确认的切换目标（null 表示新建会话）与是否需要用户确认中断。 */
  const pendingSessionId = ref<string | null>(null)
  const awaitingInterrupt = ref(false)
  /** 是否存在等待信任决定后重试的打开请求；与 `pendingSessionId`（可能为 null）配合使用。 */
  const awaitingTrust = ref(false)

  /** 分叉弹层的展示状态：消息加载、进行中的分叉与错误。 */
  const forkMessages = ref<readonly ForkMessageSummary[]>([])
  const forkLoading = ref(false)
  const forkBusy = ref(false)
  const forkError = ref<SessionError | null>(null)

  /** 主进程返回的列表是唯一真相；展示状态只做副本，跳过的文件数如实保留。 */
  function applyList(list: SessionList): void {
    sessions.value = list.sessions
    skipped.value = list.skipped
    truncated.value = list.truncated
  }

  /** 首次挂载读取列表；重复调用不产生并行请求。 */
  async function initialize(): Promise<void> {
    await refresh()
  }

  /** 重新读取当前项目的会话列表；项目变化或用户手动刷新时调用。 */
  async function refresh(): Promise<void> {
    if (view.value.phase !== 'ready') view.value = { phase: 'loading' }

    const result = await listSessions()
    if (!result.ok) {
      // 没有当前项目不是列表读取失败：界面按项目状态提示。
      if (result.error.code === 'INVALID_PROJECT_PATH') {
        sessions.value = []
        skipped.value = 0
        truncated.value = 0
        view.value = { phase: 'idle' }
        return
      }
      view.value = { phase: 'error', error: result.error }
      return
    }
    applyList(result.data)
    view.value = { phase: 'ready' }
  }

  /**
   * 打开或新建会话；`allowInterrupt` 表示用户已经确认可以停止运行中的操作。
   * 主进程拒绝未确认的切换时只记录待确认目标，由界面就地确认。
   */
  async function open(sessionId: string | null, allowInterrupt: boolean): Promise<void> {
    if (opening.value) return

    opening.value = true
    actionError.value = null
    try {
      const result = await openSession(sessionId, allowInterrupt)
      if (result.ok) {
        applyList(result.data)
        pendingSessionId.value = null
        awaitingInterrupt.value = false
        view.value = { phase: 'ready' }
        return
      }
      if (result.error.code === 'SESSION_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingSessionId.value = sessionId
        awaitingInterrupt.value = true
        return
      }
      if (result.error.code === 'TRUST_REQUIRED') {
        // 记住待打开目标（null 表示新建），由信任对话框决定后重试；取消则清空。
        pendingSessionId.value = sessionId
        awaitingTrust.value = true
        await useTrustStore().openPrompt()
        return
      }
      actionError.value = result.error
    } finally {
      opening.value = false
    }
  }

  /** 信任决定后重试待打开的会话（含新建）；取消时清空待确认目标。 */
  async function retryPendingAfterTrust(): Promise<void> {
    if (!awaitingTrust.value) return
    awaitingTrust.value = false
    const target = pendingSessionId.value
    pendingSessionId.value = null
    await open(target, false)
  }

  /** 用户确认中断后带 `allowInterrupt` 重试待确认的切换。 */
  function confirmPending(): void {
    if (!awaitingInterrupt.value) return
    void open(pendingSessionId.value, true)
  }

  /** 放弃待确认的切换；运行中的操作不受影响。 */
  function cancelPending(): void {
    pendingSessionId.value = null
    awaitingInterrupt.value = false
    awaitingTrust.value = false
  }

  /** 打开分叉弹层时读取可分叉消息；失败记录错误，不缓存旧列表。 */
  async function loadForkMessages(): Promise<void> {
    if (forkLoading.value) return
    forkLoading.value = true
    forkError.value = null
    try {
      const result = await getForkMessages()
      if (result.ok) {
        forkMessages.value = result.data.messages
        return
      }
      forkMessages.value = []
      forkError.value = result.error
    } finally {
      forkLoading.value = false
    }
  }

  /**
   * 从指定条目分叉；成功后主进程重启式切换到新会话，本地刷新列表并收起弹层。
   * Extension 取消与切换被拒等失败只记录错误，不改变既有会话。
   * 返回是否已完成切换；信任拦截时返回 false 并交给信任对话框流程。
   */
  async function fork(entryId: string, allowInterrupt: boolean): Promise<boolean> {
    if (forkBusy.value) return false
    forkBusy.value = true
    forkError.value = null
    try {
      const result = await startFork(entryId, allowInterrupt)
      if (result.ok) {
        applyList(result.data.list)
        forkMessages.value = []
        view.value = { phase: 'ready' }
        return true
      }
      if (result.error.code === 'TRUST_REQUIRED') {
        // 分叉的信任拦截与打开会话一致：交给信任对话框，取消后回到弹层。
        awaitingTrust.value = true
        pendingSessionId.value = null
        await useTrustStore().openPrompt()
        return false
      }
      forkError.value = result.error
      return false
    } finally {
      forkBusy.value = false
    }
  }

  /** 关闭分叉弹层时清空临时状态。 */
  function closeFork(): void {
    forkMessages.value = []
    forkError.value = null
  }
  return {
    view,
    sessions,
    skipped,
    truncated,
    actionError,
    opening,
    pendingSessionId,
    awaitingInterrupt,
    awaitingTrust,
    forkMessages,
    forkLoading,
    forkBusy,
    forkError,
    initialize,
    refresh,
    open,
    retryPendingAfterTrust,
    confirmPending,
    cancelPending,
    loadForkMessages,
    fork,
    closeFork
  }
})
