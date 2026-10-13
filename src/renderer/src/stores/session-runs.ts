/**
 * 保存应用内全部运行实例的粗粒度状态，并派生「某个会话当前处于什么状态」供侧栏展示。
 *
 * 状态只来自主进程登记与宿主已持有的状态，页面不自行推断占用：同一会话在应用内至多对应一个运行实例，
 * 这里按「归属项目 + 会话 id」归集。等待审批、运行中、未确认退出都必须如实展示，不把阻塞态显示成空闲。
 * 列表只含低频字段，流式期间不会逐条消息触发广播。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SessionRunState, SessionRunsSnapshot } from '../../../shared/session-run-api'
import { getSessionRuns, subscribeSessionRuns } from '../services/session-runs'

/** 单个会话的展示状态；优先级从高到低：未确认退出 → 失败 → 等待回应 → 执行中 → 已就绪 → 打开/关闭中。 */
export type SessionRunBadge =
  | 'unconfirmed'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'ready'
  | 'transitioning'

export interface SessionRunView {
  readonly runId: number
  readonly isForeground: boolean
  readonly badge: SessionRunBadge
}

export const useSessionRunsStore = defineStore('session-runs', () => {
  const runs = ref<readonly SessionRunState[]>([])
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

  /** 会话行要展示的状态；未登记的会话没有运行状态，界面按普通历史条目展示。 */
  function viewOfSession(projectPath: string | null, sessionId: string | null): SessionRunView | null {
    const run = runOfSession(projectPath, sessionId)
    if (run === null) return null
    return { runId: run.runId, isForeground: run.isForeground, badge: badgeOf(run) }
  }

  /**
   * 展示优先级：未确认退出与宿主失败是阻塞态，优先于一切活动状态；
   * 等待用户回应比「正在执行」更值得提示，因为它需要用户动作才能继续。
   */
  function badgeOf(run: SessionRunState): SessionRunBadge {
    if (run.phase === 'unconfirmed') return 'unconfirmed'
    if (run.hostState === 'failed') return 'failed'
    if (run.waitingDialogs > 0) return 'waiting'
    if (run.isStreaming) return 'running'
    if (run.phase === 'opening' || run.phase === 'closing') return 'transitioning'
    return 'ready'
  }

  return {
    runs,
    foregroundRunId,
    initialize,
    dispose,
    runOfSession,
    viewOfSession
  }
})
