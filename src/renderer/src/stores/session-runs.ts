/**
 * 保存应用内全部运行实例的粗粒度状态，并派生「某个会话当前处于什么状态」供侧栏展示。
 *
 * 状态只来自主进程登记与宿主已持有的状态，页面不自行推断占用：同一会话在应用内至多对应一个运行实例，
 * 这里按「归属项目 + 会话 id」归集。等待审批、运行中、未确认退出都必须如实展示，不把阻塞态显示成空闲。
 * 列表只含低频字段，流式期间不会逐条消息触发广播。
 * 释放与结束都经本模块提交：释放只解除登记，结束额外中断在途工作并关闭宿主，两者的失败原因都如实保留。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionRunState, SessionRunsSnapshot } from '../../../shared/session-run-api'
import { getSessionRuns, releaseSessionRun, closeSessionRun, subscribeSessionRuns } from '../services/session-runs'

/** 单个会话的展示状态；优先级从高到低：未确认退出 → 失败 → 等待回应 → 执行中 → 已就绪 → 已回收 → 打开/关闭中。 */
export type SessionRunBadge =
  | 'unconfirmed'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'ready'
  | 'suspended'
  | 'transitioning'

export interface SessionRunView {
  readonly runId: number
  readonly isForeground: boolean
  readonly badge: SessionRunBadge
}

/** 未绑定会话的运行实例：点了「新建」但还没发出第一条消息，没有会话身份也没有文件条目。 */
export interface UnboundSessionRun {
  readonly runId: number
  readonly projectPath: string | null
  readonly badge: SessionRunBadge
}

/**
 * 展示优先级：未确认退出与宿主失败是阻塞态，优先于一切活动状态；
 * 等待用户回应比「正在执行」更值得提示，因为它需要用户动作才能继续。
 * 已回收（宿主进程被空闲释放但会话仍被占用）与真正就绪分开：前者下一次发送会重建宿主。
 * 侧栏树与状态点都复用这一份判定，不在展示层重复推导。
 */
export function sessionRunBadge(run: SessionRunState): SessionRunBadge {
  if (run.phase === 'unconfirmed') return 'unconfirmed'
  if (run.hostState === 'failed') return 'failed'
  if (run.waitingDialogs > 0) return 'waiting'
  if (run.isStreaming) return 'running'
  if (run.phase === 'opening' || run.phase === 'closing') return 'transitioning'
  if (run.hostState === 'none' && run.sessionId !== null) return 'suspended'
  return 'ready'
}

export const useSessionRunsStore = defineStore('session-runs', () => {
  const runs = ref<readonly SessionRunState[]>([])
  /** 最近一次释放动作的失败原因；只在侧栏展示，不改变运行状态本身。 */
  const releaseError = ref<string | null>(null)
  const releasing = ref(false)
  /** 最近一次结束动作的失败原因；结束失败时占用仍被保留，界面据此提示而不是假装已收尾。 */
  const closeError = ref<string | null>(null)
  const closing = ref(false)
  let releaseSubscription: (() => void) | null = null

  /** 先订阅、再取快照，避免初始化期间漏掉通知。 */
  async function initialize(): Promise<void> {
    if (releaseSubscription === null) {
      releaseSubscription = subscribeSessionRuns(applySnapshot)
    }
    const result = await getSessionRuns()
    if (result.ok) applySnapshot(result.data)
  }

  /** 页面卸载时释放订阅；重复调用无副作用。 */
  function dispose(): void {
    releaseSubscription?.()
    releaseSubscription = null
  }

  /** 主进程列表是唯一真相；整体替换，不保留已释放实例的展示状态。 */
  function applySnapshot(snapshot: SessionRunsSnapshot): void {
    runs.value = snapshot.runs
  }

  /** 按「归属项目 + 会话 id」查找运行实例；未命名会话（尚未落盘）没有可匹配的会话身份。 */
  function runOfSession(projectPath: string | null, sessionId: string | null): SessionRunState | null {
    if (projectPath === null || sessionId === null) return null
    return runs.value.find(run => run.projectPath === projectPath && run.sessionId === sessionId) ?? null
  }

  /** 前台运行实例身份；没有前台实例时为 null。 */
  const foregroundRunId = computed<number | null>(() => (
    runs.value.find(run => run.isForeground)?.runId ?? null
  ))

  /**
   * 释放一个未确认退出或宿主已失败的运行实例，让它回到可重新打开的状态。
   * 只解除登记：不中断在途工作、不删除历史、不移除侧栏条目；失败原因如实保留。
   */
  async function release(runId: number): Promise<boolean> {
    if (releasing.value) return false
    releasing.value = true
    releaseError.value = null
    try {
      const result = await releaseSessionRun(runId)
      if (!result.ok) {
        releaseError.value = result.error.message
        return false
      }
      applySnapshot(result.data)
      return true
    } finally {
      releasing.value = false
    }
  }

  /** 关闭释放失败的提示；不重试、不改写占用状态。 */
  function clearReleaseError(): void {
    releaseError.value = null
  }

  /**
   * 结束一个运行实例：中断在途工作、解除占用并关闭它的宿主进程，保留会话历史文件。
   * 与释放的区别是不再让宿主留在空闲池里复用；失败原因如实保留，调用方据此决定是否继续收起界面。
   */
  async function close(runId: number): Promise<boolean> {
    if (closing.value) return false
    closing.value = true
    closeError.value = null
    try {
      const result = await closeSessionRun(runId)
      if (!result.ok) {
        closeError.value = result.error.message
        return false
      }
      applySnapshot(result.data)
      return true
    } finally {
      closing.value = false
    }
  }

  /** 关闭结束失败的提示；不重试、不改写占用状态。 */
  function clearCloseError(): void {
    closeError.value = null
  }

  /** 会话行要展示的状态；未登记的会话没有运行状态，界面按普通历史条目展示。 */
  function viewOfSession(projectPath: string | null, sessionId: string | null): SessionRunView | null {
    const run = runOfSession(projectPath, sessionId)
    if (run === null) return null
    return { runId: run.runId, isForeground: run.isForeground, badge: badgeOf(run) }
  }

  /**
   * 展示优先级与 `sessionRunBadge` 一致；保留同名包装只是为了让 store 内部调用读起来连贯。
   */
  function badgeOf(run: SessionRunState): SessionRunBadge {
    return sessionRunBadge(run)
  }

  return {
    runs,
    foregroundRunId,
    releaseError,
    releasing,
    closeError,
    closing,
    initialize,
    dispose,
    release,
    clearReleaseError,
    close,
    clearCloseError,
    runOfSession,
    viewOfSession
  }
})
