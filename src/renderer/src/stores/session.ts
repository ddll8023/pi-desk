/**
 * 保存会话面板的展示状态：按项目保存的会话列表窗口、打开、重新加载与删除动作；会话文件解析、切换与删除编排都在主进程。
 *
 * 侧栏按项目树展示会话，因此列表按项目分片保存（键是项目路径）：展开其他项目时懒读取，
 * 已读过的分片在应用内保留，切换项目不需要重新读取。分片只登记主进程回报的项目路径对应的结果，
 * 迟到响应不会写进其他项目的分片。
 * 每个分片保存的是“最近 limit 条”的窗口而不是全量：首屏只取一页，界面触底或点“加载更多”时按页扩大窗口，
 * 上限由 MAX_SESSION_WINDOW 约束；窗口是前缀，所以每次响应都能整体替换分片，不需要偏移量或追加合并，
 * 两次请求之间列表重排、新增或删除也不会产生重复行或空洞。
 * 单次动作失败放在 `actionError`，不影响已加载的列表。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { MAX_SESSION_WINDOW, SESSION_PAGE_SIZE } from '../../../shared/session-api'
import type { SessionError, SessionList, SessionSummary } from '../../../shared/session-api'
import type { ProjectError } from '../../../shared/project-api'
import { useTrustStore } from './trust'
import { useProjectStore } from './project'
import { usePreferencesStore } from './preferences'
import { useRuntimeStore } from './runtime'
import { listSessions, openSession, reloadSession, deleteSession } from '../services/session'
import { useWorkspaceTabsStore } from './workspace-tabs'

/** `idle` 表示尚未读取该项目的列表；读取中、成功与失败各占一档。 */
type SessionSlicePhase = 'idle' | 'loading' | 'ready' | 'error'

/** 单个项目的会话列表分片；内容与读取状态一起保存，界面按项目取用。 */
interface SessionListSlice {
  readonly phase: SessionSlicePhase
  readonly sessions: readonly SessionSummary[]
  /** 当前窗口大小（最近 limit 条）：加载更多时按页扩大，刷新与变更回传都沿用，列表不会塌回首屏。 */
  readonly limit: number
  readonly skipped: number
  /** 窗口之外仍未读取的会话文件数；大于 0 时界面提供“加载更多”。 */
  readonly remaining: number
  /** 正在扩大窗口；与首屏读取的 `phase === 'loading'` 分开，已有列表时不退回加载态。 */
  readonly loadingMore: boolean
  readonly error: SessionError | null
}

/** `idle` 表示尚无当前项目或该项目列表未读取；单次动作失败放在 `actionError`。 */
export type SessionViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; error: SessionError }

const EMPTY_SLICE: SessionListSlice = {
  phase: 'idle',
  sessions: [],
  limit: SESSION_PAGE_SIZE,
  skipped: 0,
  remaining: 0,
  loadingMore: false,
  error: null
}

export const useSessionStore = defineStore('session', () => {
  /** 按项目路径保存的列表分片；键即主进程回报的项目路径。 */
  const lists = ref<Readonly<Record<string, SessionListSlice>>>({})
  /**
   * 已加载的会话身份集合（跨项目分片）：工作区标签据此判断某个会话是否已经落盘，
   * 未落盘的新会话不会被当成标签身份，标题也就能继续显示「新对话」。
   */
  const loadedSessionIds = computed(() => new Set(
    Object.values(lists.value).flatMap(slice => slice.sessions.map(session => session.sessionId))
  ))
  /**
   * 单次动作失败：打开会话会先切项目，因此失败原因也可能来自 Project 模块；错误码原样保留，
   * 界面只消费 message。
   */
  const actionError = ref<SessionError | ProjectError | null>(null)
  const opening = ref(false)
  /** 最新打开意图固定项目与标签；已发出的请求收敛后才执行下一次，不并发改前台。 */
  const openingProjectPath = ref<string | null>(null)
  let openSequence = 0
  let queuedActions = 0
  let actionTail: Promise<void> = Promise.resolve()
  let pendingTabKey: string | null = null
  /** 删除动作进行中；与打开互斥，避免同一会话同时被打开与删除。 */
  const deleting = ref(false)
  /** 待确认的切换目标（null 表示新建会话）、目标项目与是否需要用户确认中断。 */
  const pendingSessionId = ref<string | null>(null)
  const pendingProjectPath = ref<string | null>(null)
  const awaitingInterrupt = ref(false)
  /** 是否存在等待信任决定后重试的打开请求；与 `pendingSessionId`（可能为 null）配合使用。 */
  const awaitingTrust = ref(false)
  /** 待确认的重载请求：与打开共用中断确认弹窗，但目标是重启当前 Runtime。 */
  const pendingReload = ref(false)
  /** 每个项目同时只允许一次列表读取（首屏、刷新与扩大窗口都算），同一项目的重复请求复用同一个等待。 */
  const inflight = new Map<string, Promise<void>>()

  /** 顶栏会话 chip 使用的会话选择弹层。 */
  const showSessionPicker = ref(false)

  function openSessionPicker(): void {
    showSessionPicker.value = true
  }

  function closeSessionPicker(): void {
    showSessionPicker.value = false
  }

  function currentProjectPath(): string | null {
    return useProjectStore().currentProject?.path ?? null
  }

  function sliceOf(projectPath: string): SessionListSlice {
    return lists.value[projectPath] ?? EMPTY_SLICE
  }

  /** 某个项目的列表分片；未读取过时是空闲分片。 */
  function sessionsOf(projectPath: string): readonly SessionSummary[] {
    return sliceOf(projectPath).sessions
  }

  /** 某个项目的读取状态；供侧栏按项目展示空态、错误与重试入口。 */
  function viewOf(projectPath: string): SessionViewState {
    const slice = sliceOf(projectPath)
    if (slice.phase === 'error') {
      return {
        phase: 'error',
        error: slice.error ?? { code: 'INTERNAL_ERROR', message: '读取会话列表失败，可以重试。' }
      }
    }
    if (slice.phase === 'loading') return { phase: 'loading' }
    if (slice.phase === 'ready') return { phase: 'ready' }
    return { phase: 'idle' }
  }

  /** 某个项目下被跳过的文件数、窗口外剩余的会话文件数与当前窗口大小；供侧栏与选择弹层展示分页状态。 */
  function countsOf(projectPath: string): {
    readonly skipped: number
    readonly remaining: number
    readonly limit: number
  } {
    const slice = sliceOf(projectPath)
    return { skipped: slice.skipped, remaining: slice.remaining, limit: slice.limit }
  }

  /** 某个项目是否正在扩大窗口；界面据此把“加载更多”显示为进行中。 */
  function loadingMoreOf(projectPath: string): boolean {
    return sliceOf(projectPath).loadingMore
  }

  /** 某个项目的窗口是否已达上限；到上限后不再提供加载更多，避免无界读取与无界渲染。 */
  function windowFullOf(projectPath: string): boolean {
    return sliceOf(projectPath).limit >= MAX_SESSION_WINDOW
  }

  function applySlice(projectPath: string, slice: SessionListSlice): void {
    lists.value = { ...lists.value, [projectPath]: slice }
  }

  /** 主进程返回的窗口是唯一真相；只写入它回报的项目分片，跳过的文件数与窗口大小如实保留。 */
  function applyList(list: SessionList): void {
    const projectPath = list.projectPath ?? currentProjectPath()
    if (projectPath === null) return
    applySlice(projectPath, {
      phase: 'ready',
      sessions: list.sessions,
      limit: list.limit,
      skipped: list.skipped,
      remaining: list.remaining,
      loadingMore: false,
      error: null
    })
  }

  /** 当前项目的会话列表分片；顶栏与会话选择弹层都读这一份。 */
  const sessions = computed<readonly SessionSummary[]>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? [] : sliceOf(projectPath).sessions
  })

  /** 当前项目的列表读取状态。 */
  const view = computed<SessionViewState>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? { phase: 'idle' } : viewOf(projectPath)
  })

  const skipped = computed<number>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? 0 : sliceOf(projectPath).skipped
  })

  /** 当前项目窗口外仍未读取的会话文件数；大于 0 时选择弹层提供“加载更多”。 */
  const remaining = computed<number>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? 0 : sliceOf(projectPath).remaining
  })

  /** 当前项目是否正在扩大窗口。 */
  const loadingMore = computed<boolean>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? false : sliceOf(projectPath).loadingMore
  })

  /** 当前项目的窗口是否已达上限；界面据此停止提供“加载更多”。 */
  const windowFull = computed<boolean>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? false : windowFullOf(projectPath)
  })

  /** 当前项目的窗口大小；界面用它判断一次“加载更多”是否真的推进了窗口。 */
  const windowLimit = computed<number>(() => {
    const projectPath = currentProjectPath()
    return projectPath === null ? SESSION_PAGE_SIZE : sliceOf(projectPath).limit
  })

  /** 首次挂载读取当前项目的列表；没有当前项目时不做任何读取。 */
  async function initialize(): Promise<void> {
    const projectPath = currentProjectPath()
    if (projectPath !== null) await ensureLoaded(projectPath)
  }

  /**
   * 确保某个项目的列表已读取；`force` 用于手动刷新与新建会话落盘后的补读。
   * 读取窗口取该分片当前的 `limit`：刷新不会把已经展开的列表收回首屏。
   * 同一项目并发调用复用同一次读取，不产生并行请求。
   */
  async function ensureLoaded(projectPath: string, force = false): Promise<void> {
    const pending = inflight.get(projectPath)
    if (pending !== undefined) return pending
    const slice = sliceOf(projectPath)
    if (!force && slice.phase !== 'idle') return

    const request = load(projectPath, slice.limit)
    inflight.set(projectPath, request)
    try {
      await request
    } finally {
      inflight.delete(projectPath)
    }
  }

  /**
   * 扩大某个项目的列表窗口：每次多取一页，到 `MAX_SESSION_WINDOW` 后不再扩大。
   * 不传项目路径时按当前项目处理。窗口是“最近 limit 条”的前缀，所以不需要偏移量或追加合并；
   * 已经在读取时复用同一次读取，不并发请求。
   */
  async function loadMore(projectPath?: string): Promise<void> {
    const target = projectPath ?? currentProjectPath()
    if (target === null) return
    const pending = inflight.get(target)
    if (pending !== undefined) return pending
    const slice = sliceOf(target)
    if (slice.remaining <= 0 || slice.limit >= MAX_SESSION_WINDOW) return

    const request = load(target, Math.min(slice.limit + SESSION_PAGE_SIZE, MAX_SESSION_WINDOW))
    inflight.set(target, request)
    try {
      await request
    } finally {
      inflight.delete(target)
    }
  }

  /**
   * 读取一次窗口并写入该项目分片；没有当前项目不是列表读取失败，界面按项目状态提示。
   * 已有内容的刷新或扩大窗口既不退回加载态、失败也不清空列表：切换项目与补读不该让正在看的列表先折叠再恢复。
   */
  async function load(projectPath: string, limit: number): Promise<void> {
    const current = sliceOf(projectPath)
    if (current.phase !== 'ready' || current.sessions.length === 0) {
      applySlice(projectPath, { ...current, phase: 'loading', limit })
    } else {
      // 已有内容时只标记“正在扩大窗口”，列表本身保持不变。
      applySlice(projectPath, { ...current, loadingMore: true })
    }
    const result = await listSessions(projectPath, limit)
    if (!result.ok) {
      if (result.error.code === 'INVALID_PROJECT_PATH') {
        applySlice(projectPath, EMPTY_SLICE)
        return
      }
      // 保留本次读取期间已写入的列表，只记录失败；界面按「有内容」同时展示列表与提示。
      applySlice(projectPath, {
        ...sliceOf(projectPath), phase: 'error', loadingMore: false, error: result.error
      })
      return
    }
    // 主进程回报实际读取的项目路径；与请求不符时丢弃，不把别的项目的结果写进本分片。
    if (result.data.projectPath !== projectPath) return
    applyList(result.data)
  }

  /** 重新读取当前项目的会话列表窗口；手动刷新、回退与新建会话落盘后的补读都走这里。 */
  async function refresh(): Promise<void> {
    const projectPath = currentProjectPath()
    if (projectPath !== null) await ensureLoaded(projectPath, true)
  }

  /** 已经核过列表的会话 id；同一会话不再补读。 */
  let reconciledSessionId: string | null = null

  /**
   * 当前会话不在列表里时补读一次该项目的列表：Pi 新建会话只分配身份，会话文件到首次写入才创建，
   * 因此「新建」返回的列表快照可能不含它；调用方应在确有消息落盘后触发。
   */
  async function reconcileCurrentSession(sessionId: string | null): Promise<void> {
    if (sessionId === null || reconciledSessionId === sessionId) return
    const projectPath = currentProjectPath()
    if (projectPath === null) return
    if (sliceOf(projectPath).sessions.some((session) => session.sessionId === sessionId)) {
      reconciledSessionId = sessionId
      return
    }

    reconciledSessionId = sessionId
    await ensureLoaded(projectPath, true)
    // 补读后仍未列出（读取失败等）时清空记账，下一轮结束再试一次。
    if (!sliceOf(projectPath).sessions.some((session) => session.sessionId === sessionId)) reconciledSessionId = null
  }

  /**
   * 打开或新建会话；`projectPath` 给出时表示目标会话所属项目，与当前项目不同则先切换当前项目。
   * 打开其他会话不中断任何正在运行的会话，`allowInterrupt` 仅在用户已确认必须改变现有绑定时为真。
   * `preferredTabKey` 是调用方指名要复用的对话标签（`/new` 与新建入口已经建好或重置过它），
   * 只在新建会话时生效，用来避免按会话身份反查标签时落空并多出一个标签。
   * 新会话的默认模型由 Pi 自己的 settings.json 决定；信任或中断确认期间只保留目标，重试不重新选择。
   */
  async function open(
    sessionId: string | null,
    allowInterrupt: boolean,
    projectPath?: string,
    preferredTabKey: string | null = null
  ): Promise<void> {
    const targetPath = projectPath ?? currentProjectPath()
    if (targetPath === null) return
    const tabs = useWorkspaceTabsStore()
    const key = tabs.prepareOpenTab(targetPath, sessionId, preferredTabKey)
    if (key === null) return
    const sequence = ++openSequence
    openingProjectPath.value = targetPath
    clearPendingTarget()
    pendingReload.value = false
    actionError.value = null
    await enqueueAction(async () => {
      if (sequence !== openSequence || !tabs.hasChatTabKey(targetPath, key)) return
      const projectStore = useProjectStore()
      if (targetPath !== currentProjectPath()) await projectStore.select(targetPath, false, 'session')
      if (sequence !== openSequence) return
      if (currentProjectPath() !== targetPath) {
        actionError.value = projectStore.actionError
          ?? { code: 'INVALID_PROJECT_PATH', message: '切换项目失败，未打开该会话。' }
        return
      }
      // 同一空标签的前一次打开可能刚收敛；此时复用实际身份，不能再次按 null 新建并遗留旧实例。
      const requestedSessionId = sessionId ?? tabs.sessionIdForTab(targetPath, key)
      const result = await openSession(targetPath, requestedSessionId, allowInterrupt, sliceOf(targetPath).limit)
      if (result.ok) {
        if (result.data.projectPath !== targetPath) {
          if (sequence === openSequence) actionError.value = {
            code: 'INVALID_RESPONSE', message: '打开结果的项目归属不一致，未采纳该结果。'
          }
          return
        }
        const projectAlive = projectStore.projects.some(project => project.path === targetPath)
        if (projectAlive) applyList(result.data)
        // 实例身份即使迟到也只能绑定原标签，不能按新的前台或空标签重新猜测。
        const bound = projectAlive && tabs.syncOpenTab(result.data.openedSessionId, targetPath, key,
          result.data.runId, sequence === openSequence && currentProjectPath() === targetPath)
        if (!bound && !tabs.hasRunTab(result.data.runId)) {
          // 用户在打开期间已关闭目标标签：收敛该打开动作，不留下无标签的运行实例。
          await tabs.closeChatRun(result.data.runId)
        }
        if (sequence === openSequence) clearPendingTarget()
        return
      }
      if (sequence !== openSequence || currentProjectPath() !== targetPath) return
      if (result.error.code === 'SESSION_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingSessionId.value = requestedSessionId
        pendingProjectPath.value = targetPath
        pendingTabKey = key
        awaitingInterrupt.value = true
        return
      }
      if (result.error.code === 'TRUST_REQUIRED') {
        pendingSessionId.value = requestedSessionId
        pendingProjectPath.value = targetPath
        pendingTabKey = key
        awaitingTrust.value = true
        const shown = await useTrustStore().openPrompt()
        if (!shown && sequence === openSequence) {
          awaitingTrust.value = false
          actionError.value = { code: 'TRUST_REQUIRED', message: useTrustStore().actionError ?? result.error.message }
        }
        return
      }
      actionError.value = result.error
    })
  }

  /** 序列化会话动作；计数覆盖等待中的请求，不能在旧请求 finally 中提前开放输入。 */
  async function enqueueAction(action: () => Promise<void>): Promise<void> {
    queuedActions += 1
    opening.value = true
    const pending = actionTail.then(action)
    actionTail = pending.catch(() => {})
    try {
      await pending
    } finally {
      queuedActions -= 1
      opening.value = queuedActions > 0
      if (!opening.value) openingProjectPath.value = null
    }
  }

  /** 关闭一个尚在打开中的标签前，先等待已提交动作报告其实际实例身份。 */
  function waitForOpenActions(): Promise<void> {
    return actionTail
  }

  function clearPendingTarget(): void {
    pendingSessionId.value = null
    pendingProjectPath.value = null
    pendingTabKey = null
    awaitingInterrupt.value = false
    awaitingTrust.value = false
  }

  /** 切到文件、终端或另一项目时，只取消选择意图，不中断已发送的宿主动作。 */
  function invalidateOpenSelection(): void {
    if (awaitingTrust.value) useTrustStore().cancel()
    openSequence += 1
    openingProjectPath.value = null
    clearPendingTarget()
    actionError.value = null
  }

  /**
   * 重新加载 Pi 资源：在同一 SDK 宿主进程内重建该会话的 services（重新读取 Skills、Prompt Templates、
   * MCP 配置与 Extension），并尽量恢复当前会话。
   * 回传列表保持当前窗口深度，避免重载后侧栏列表收回首屏。
   * 返回是否真的重建成功：被中断确认或信任流程拦下、有在途动作、结果已过期时都算未完成，
   * 调用方（如设置页的「立即重新加载」）据此给出反馈，而不是当成已生效。
   */
  async function reloadCurrent(allowInterrupt = false): Promise<boolean> {
    if (opening.value) return false

    const sequence = ++openSequence
    pendingReload.value = false
    actionError.value = null
    let reloaded = false
    await enqueueAction(async () => {
      const result = await reloadSession(allowInterrupt, windowLimit.value)
      if (sequence !== openSequence) return
      if (result.ok) {
        applyList(result.data)
        pendingReload.value = false
        awaitingInterrupt.value = false
        // 会话已重建，它读到的就是已保存的开关值：在这里收敛「待重新加载」状态。
        // 模型页、资源页与设置页都走同一个入口，不靠调用方各自标记。
        const preferencesStore = usePreferencesStore()
        preferencesStore.markGenuiApplied(preferencesStore.genuiSavedEnabled)
        reloaded = true
        return
      }
      if (result.error.code === 'SESSION_SWITCH_BLOCKED' && !allowInterrupt) {
        pendingReload.value = true
        awaitingInterrupt.value = true
        return
      }
      if (result.error.code === 'TRUST_REQUIRED') {
        // 重载的目标是前台实例绑定的会话，它的归属项目可能不是当前项目；信任提示按该实例解析。
        pendingReload.value = true
        awaitingTrust.value = true
        await useTrustStore().openPrompt(useRuntimeStore().foregroundRunId)
        return
      }
      actionError.value = result.error
    })
    return reloaded
  }

  /**
   * 删除会话：`projectPath` 是会话所属项目路径，成功时把主进程回报的删除后列表写入对应项目分片。
   * `allowInterrupt` 表示用户已在确认弹层中同意中断该会话的在途操作；失败只记录在 actionError，
   * 已加载的列表与运行实例不受影响。回传列表保持该项目的当前窗口深度。
   */
  async function removeSession(projectPath: string, sessionId: string, allowInterrupt: boolean): Promise<boolean> {
    if (deleting.value) return false

    deleting.value = true
    actionError.value = null
    try {
      const result = await deleteSession(projectPath, sessionId, allowInterrupt, sliceOf(projectPath).limit)
      if (!result.ok) {
        actionError.value = result.error
        return false
      }
      // 主进程回报实际读取的项目路径；与请求不符时丢弃，不把别的项目的结果写进本分片。
      if (result.data.projectPath === projectPath) applyList(result.data)
      // 会话文件已删除，它的标签随之消失；标签承载的实例已由删除链收敛。
      useWorkspaceTabsStore().dropSession(projectPath, sessionId)
      return true
    } finally {
      deleting.value = false
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
    const projectPath = pendingProjectPath.value
    const key = pendingTabKey
    clearPendingTarget()
    await open(target, false, projectPath ?? undefined, key)
  }

  /** 用户确认中断后带 `allowInterrupt` 重试待确认的切换或重载。 */
  function confirmPending(): void {
    if (!awaitingInterrupt.value) return
    if (pendingReload.value) {
      void reloadCurrent(true)
      return
    }
    void open(pendingSessionId.value, true, pendingProjectPath.value ?? undefined, pendingTabKey)
  }

  /** 放弃待确认的切换；运行中的操作不受影响。 */
  function cancelPending(): void {
    clearPendingTarget()
    pendingReload.value = false
  }

  return {
    view,
    sessions,
    loadedSessionIds,
    skipped,
    remaining,
    loadingMore,
    windowFull,
    windowLimit,
    actionError,
    opening,
    openingProjectPath,
    invalidateOpenSelection,
    waitForOpenActions,
    deleting,
    pendingSessionId,
    awaitingInterrupt,
    awaitingTrust,
    pendingReload,
    showSessionPicker,
    initialize,
    ensureLoaded,
    loadMore,
    refresh,
    sessionsOf,
    viewOf,
    countsOf,
    loadingMoreOf,
    windowFullOf,
    reconcileCurrentSession,
    open,
    removeSession,
    reloadCurrent,
    retryPendingAfterTrust,
    confirmPending,
    cancelPending,
    openSessionPicker,
    closeSessionPicker
  }
})
