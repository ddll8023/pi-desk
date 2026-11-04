/** 从官方当前分支读取任务快照；不写日志、不启动会话，也不把历史运行标记当成当前执行。 */
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { isTaskFlow, TASK_FLOW_ENTRY_TYPE, TASK_FLOW_MAX_FLOWS } from '../../shared/task-flow'
import type { TaskFlow, TaskFlowStep } from '../../shared/task-flow'

export function readTaskFlowHistory(branch: readonly SessionEntry[], selected?: ReadonlySet<string>): TaskFlow[] {
  const latest = new Map<string, TaskFlow>()
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== TASK_FLOW_ENTRY_TYPE || !isTaskFlow(entry.data)) continue
    const previous = latest.get(entry.data.id)
    if (previous === undefined || previous.revision <= entry.data.revision) latest.set(entry.data.id, entry.data)
  }
  const flows = [...latest.values()].filter(flow => selected === undefined
    || (flow.originEntryId !== null && selected.has(flow.originEntryId))
    || flow.steps.some(step => (step.promptEntryId !== null && selected.has(step.promptEntryId))
      || (step.resultEntryId !== null && selected.has(step.resultEntryId))))
  return selected === undefined ? flows : flows.slice(-TASK_FLOW_MAX_FLOWS)
}
/** 恢复时仅把未确认结束的运行态转为中断，待执行与等待状态的计划予以保持，不自动重跑；未启动或等待续接的计划仍可由用户明确操作。 */
export function interruptHistoricalFlow(flow: TaskFlow): TaskFlow {
  if (flow.phase !== 'running' && flow.phase !== 'stopping') return flow
  return { ...flow, revision: flow.revision + 1, phase: 'interrupted', steps: flow.steps.map<TaskFlowStep>(step =>
    step.phase === 'running' || step.phase === 'stopping'
      ? { ...step, phase: 'interrupted', error: '上次执行没有确认结束；不会自动重跑。' }
      : step) }
}
