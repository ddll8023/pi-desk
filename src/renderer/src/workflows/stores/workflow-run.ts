/**
 * 工作流运行的状态：当前快照、启动与取消、审批决定、历史运行与回放选择、事件订阅。
 *
 * 运行由主进程持有，这里只保存它推来的最新快照；订阅在首次启动前挂上，
 * 收到别的运行的快照（同时开两个标签）时按 `runId` 过滤，不互相覆盖。
 * 启动失败只写一条提示，不清掉上一次运行的结果——对比两次运行是这里的正常用法。
 * 回放走同一份快照形状：历史运行读出来就是只读展示，不需要另一套渲染。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { WorkflowRun, WorkflowParameterValues, WorkflowRunSummary } from '../../../../shared/workflow-api'
import * as service from '../services/desktop'

export const useWorkflowRunStore = defineStore('workflow-runs', () => {
  const run = ref<WorkflowRun | null>(null)
  const runs = ref<readonly WorkflowRunSummary[]>([])
  const busy = ref(false)
  const error = ref<string | null>(null)
  /** 当前标签看的是哪份工作流：推送回来的快照只在它自己的标签里生效。 */
  const contextWorkflowId = ref<string | null>(null)
  let unsubscribe: (() => void) | null = null

  const active = computed(() => run.value !== null && run.value.status === 'running')
  const canCancel = computed(() => active.value && !busy.value)
  /** 等待审批的节点；运行面板据此给出通过／拒绝。 */
  const waitingNodeId = computed<string | null>(() => {
    const current = run.value
    if (current === null || current.status !== 'running') return null
    return current.nodes.find(node => node.status === 'waiting')?.nodeId ?? null
  })

  function ensureSubscription(): void {
    if (unsubscribe !== null) return
    unsubscribe = service.onWorkflowRun(snapshot => {
      // 两个工作流标签共用这一个 store：只接管属于当前标签的那份运行，
      // 否则打开 B 的标签会看到 A 的进度，切回来又对不上。
      if (contextWorkflowId.value !== null && snapshot.workflowId !== contextWorkflowId.value) return
      if (run.value !== null && run.value.runId !== snapshot.runId) return
      run.value = snapshot
    })
  }

  /** 切到另一份工作流：不属于它的快照立即清掉，避免跨图展示。 */
  function setContext(workflowId: string | null): void {
    contextWorkflowId.value = workflowId
    if (run.value !== null && workflowId !== null && run.value.workflowId !== workflowId) run.value = null
  }

  /** 启动一次运行：成功时立刻接管返回的快照，后续变化由订阅补齐。 */
  async function start(
    workflowId: string,
    projectPath: string | null,
    parameters: WorkflowParameterValues
  ): Promise<boolean> {
    if (projectPath === null) {
      error.value = '请先打开一个项目：工作流只能在项目目录里运行。'
      return false
    }
    error.value = null
    busy.value = true
    ensureSubscription()
    setContext(workflowId)
    const result = await service.startWorkflowRun(workflowId, projectPath, parameters)
    busy.value = false
    if (!result.ok) {
      error.value = result.error.message
      return false
    }
    run.value = result.data
    void loadRuns(workflowId)
    return true
  }

  /** 接管一次外部启动的运行（定时任务「立即运行」）：与 start 共用同一份面板。 */
  function adopt(snapshot: WorkflowRun): void {
    ensureSubscription()
    if (contextWorkflowId.value !== null && snapshot.workflowId !== contextWorkflowId.value) return
    run.value = snapshot
    void loadRuns(snapshot.workflowId)
  }

  async function cancel(): Promise<void> {
    const current = run.value
    if (current === null || current.status !== 'running') return
    error.value = null
    busy.value = true
    const result = await service.cancelWorkflowRun(current.runId)
    busy.value = false
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    run.value = result.data
  }

  /** 审批门的决定：通过与拒绝分别走 success 与 failure 边。 */
  async function approve(approved: boolean): Promise<void> {
    const current = run.value
    const nodeId = waitingNodeId.value
    if (current === null || nodeId === null) return
    error.value = null
    busy.value = true
    const result = await service.approveWorkflowRun(current.runId, nodeId, approved)
    busy.value = false
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    run.value = result.data
  }

  /** 读取某个工作流的历史运行列表；运行时与结束后都可刷新。 */
  async function loadRuns(workflowId: string): Promise<void> {
    const result = await service.listWorkflowRuns(workflowId)
    if (!result.ok) {
      runs.value = []
      error.value = result.error.message
      return
    }
    runs.value = result.data.runs
  }

  /** 回放：读一次已完成运行的记录，替换当前面板内容（只读展示）。 */
  async function selectRun(runId: string): Promise<void> {
    error.value = null
    busy.value = true
    ensureSubscription()
    const result = await service.readWorkflowRun(runId)
    busy.value = false
    if (!result.ok) {
      error.value = result.error.message
      return
    }
    run.value = result.data
  }

  function reset(): void {
    run.value = null
    runs.value = []
    error.value = null
  }
  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    run,
    runs,
    busy,
    error,
    active,
    canCancel,
    waitingNodeId,
    start,
    adopt,
    setContext,
    cancel,
    approve,
    loadRuns,
    selectRun,
    reset,
    dispose
  }
})
