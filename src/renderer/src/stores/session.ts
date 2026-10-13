/** 保存会话面板的展示状态：当前项目的会话列表、打开与重新加载动作；会话文件解析与切换编排都在主进程。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionError, SessionList, SessionSummary } from '../../../shared/session-api'
import { useTrustStore } from './trust'
import { listSessions, openSession, reloadSession } from '../services/session'

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
  /** 待确认的重载请求：与打开共用中断确认弹窗，但目标是重启当前 Runtime。 */
  const pendingReload = ref(false)

  /** /resume 与顶栏会话 chip 共用的会话选择弹层。 */
  const showSessionPicker = ref(false)

  function openSessionPicker(): void {
    showSessionPicker.value = true
  }

  function closeSessionPicker(): void {
    showSessionPicker.value = false
  }

  /** 主进程返回的列表是唯一真相；展示状态只做副本，跳过的文件数如实保留。 */
  function applyList(list: SessionList): void {
    sessions.value = list.sessions
    skipped.value = list.skipped
    truncated.value = list.truncated
  }

  /** 首次挂载读取列表；这里不去重，重复调用会各自读取一次。 */
  async function initialize(): Promise<void> {
    await refresh()
  }

  /** 重新读取当前项目的会话列表；项目变化、用户手动刷新与新建会话落盘后的补读都走这里。 */
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

  /** 已经核过列表的会话 id；同一会话不再补读。 */
  let reconciledSessionId: string | null = null

  /**
   * 当前会话不在列表里时补读一次列表：Pi 新建会话只分配身份，会话文件到首次写入才创建，
   * 因此「新建」返回的列表快照可能不含它；调用方应在确有消息落盘后触发。
   */
  async function reconcileCurrentSession(sessionId: string | null): Promise<void> {
    if (sessionId === null || reconciledSessionId === sessionId) return
    if (sessions.value.some((session) => session.sessionId === sessionId)) {
      reconciledSessionId = sessionId
      return
    }

    reconciledSessionId = sessionId
    await refresh()
    // 补读后仍未列出（读取失败等）时清空记账，下一轮结束再试一次。
    if (!sessions.value.some((session) => session.sessionId === sessionId)) reconciledSessionId = null
  }

  /**
   * 打开或新建会话；`allowInterrupt` 表示用户已经确认可以停止运行中的操作。
   * 新会话的默认模型由 Pi 自己的 settings.json 决定；信任或中断确认期间只保留目标，重试不重新选择。
   */
  async function open(sessionId: string | null, allowInterrupt: boolean): Promise<void> {
    if (opening.value) return

    opening.value = true
    pendingReload.value = false
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

  /**
   * 重新加载 Pi 资源：重启 Runtime 并尽量恢复当前会话。
   * RPC 没有重载命令，资源只在进程启动时读取，因此唯一的重载方式是重启。
   */
  async function reloadCurrent(allowInterrupt = false): Promise<void> {
    if (opening.value) return

    opening.value = true
    pendingReload.value = false
    actionError.value = null
    try {
      const result = await reloadSession(allowInterrupt)
      if (result.ok) {
        applyList(result.data)
        pendingReload.value = false
        awaitingInterrupt.value = false
        view.value = { phase: 'ready' }
        return
      }
      if (result.error.code === 'SESSION_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingReload.value = true
        awaitingInterrupt.value = true
        return
      }
      if (result.error.code === 'TRUST_REQUIRED') {
        pendingReload.value = true
        awaitingTrust.value = true
        await useTrustStore().openPrompt()
        return
      }
      actionError.value = result.error
    } finally {
      opening.value = false
    }
  }

  /** 信任决定后重试待打开的会话（含新建）或待重载的 Runtime；取消时清空待确认目标。 */
  async function retryPendingAfterTrust(): Promise<void> {
    if (!awaitingTrust.value) return
    awaitingTrust.value = false
    if (pendingReload.value) {
      await reloadCurrent(false)
      return
    }
    const target = pendingSessionId.value
    pendingSessionId.value = null
    await open(target, false)
  }

  /** 用户确认中断后带 `allowInterrupt` 重试待确认的切换或重载。 */
  function confirmPending(): void {
    if (!awaitingInterrupt.value) return
    if (pendingReload.value) {
      void reloadCurrent(true)
      return
    }
    void open(pendingSessionId.value, true)
  }

  /** 放弃待确认的切换；运行中的操作不受影响。 */
  function cancelPending(): void {
    pendingSessionId.value = null
    pendingReload.value = false
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
    pendingReload,
    showSessionPicker,
    initialize,
    refresh,
    reconcileCurrentSession,
    open,
    reloadCurrent,
    retryPendingAfterTrust,
    confirmPending,
    cancelPending,
    openSessionPicker,
    closeSessionPicker
  }
})
