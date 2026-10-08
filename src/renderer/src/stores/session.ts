/** 保存会话面板的展示状态：当前项目的会话列表与打开动作；会话文件解析与切换编排都在主进程。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionError, SessionList, SessionSummary } from '../../../shared/session-api'
import { useTrustStore } from './trust'
import { listSessions, openSession } from '../services/session'

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
    initialize,
    refresh,
    open,
    retryPendingAfterTrust,
    confirmPending,
    cancelPending
  }
})
