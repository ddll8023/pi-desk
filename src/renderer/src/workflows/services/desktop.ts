/**
 * 工作流在页面侧的桥接：清单与定义读写、运行启动与取消、运行快照读取与订阅、清空运行记录。
 *
 * 桥接是页面唯一入口；缺失说明预加载脚本没挂上，不能当成「没有工作流」处理。
 * 响应不合契约时统一收敛为固定失败结果，页面只处理一种形状。
 */
import {
  isWorkflowDeleteOutcome,
  isWorkflowReadOutcome,
  isWorkflowRun,
  isWorkflowRunOutcome,
  isWorkflowRunsClearOutcome,
  isWorkflowRunsListOutcome,
  isWorkflowSchedulesListOutcome,
  isWorkflowScheduleDeleteOutcome,
  isWorkflowScheduleSaveOutcome,
  isWorkflowSaveOutcome,
  isWorkflowsListOutcome
} from '../../../../shared/workflow-api'
import type {
  WorkflowApi,
  WorkflowDeleteOutcome,
  WorkflowParameterValues,
  WorkflowReadOutcome,
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunsClearOutcome,
  WorkflowRunsListOutcome,
  WorkflowSchedulesListOutcome,
  WorkflowScheduleDeleteOutcome,
  WorkflowScheduleSaveOutcome,
  WorkflowScheduleSaveRequest,
  WorkflowSaveOutcome,
  WorkflowsListOutcome
} from '../../../../shared/workflow-api'

interface WorkflowBridge {
  readonly listWorkflows: WorkflowApi['listWorkflows']
  readonly readWorkflow: WorkflowApi['readWorkflow']
  readonly saveWorkflow: WorkflowApi['saveWorkflow']
  readonly deleteWorkflow: WorkflowApi['deleteWorkflow']
  readonly startWorkflowRun: WorkflowApi['startWorkflowRun']
  readonly cancelWorkflowRun: WorkflowApi['cancelWorkflowRun']
  readonly approveWorkflowRun: WorkflowApi['approveWorkflowRun']
  readonly readWorkflowRun: WorkflowApi['readWorkflowRun']
  readonly listWorkflowRuns: WorkflowApi['listWorkflowRuns']
  readonly listWorkflowSchedules: WorkflowApi['listWorkflowSchedules']
  readonly saveWorkflowSchedule: WorkflowApi['saveWorkflowSchedule']
  readonly deleteWorkflowSchedule: WorkflowApi['deleteWorkflowSchedule']
  readonly runWorkflowSchedule: WorkflowApi['runWorkflowSchedule']
  readonly clearWorkflowRuns: WorkflowApi['clearWorkflowRuns']
  readonly onWorkflowRun: WorkflowApi['onWorkflowRun']
}

function bridge(): WorkflowBridge | null {
  const value = window.desktop as Partial<WorkflowBridge> | undefined
  if (value === undefined
    || typeof value.listWorkflows !== 'function'
    || typeof value.readWorkflow !== 'function'
    || typeof value.saveWorkflow !== 'function'
    || typeof value.deleteWorkflow !== 'function'
    || typeof value.startWorkflowRun !== 'function'
    || typeof value.cancelWorkflowRun !== 'function'
    || typeof value.approveWorkflowRun !== 'function'
    || typeof value.readWorkflowRun !== 'function'
    || typeof value.listWorkflowRuns !== 'function'
    || typeof value.listWorkflowSchedules !== 'function'
    || typeof value.saveWorkflowSchedule !== 'function'
    || typeof value.deleteWorkflowSchedule !== 'function'
    || typeof value.runWorkflowSchedule !== 'function'
    || typeof value.clearWorkflowRuns !== 'function'
    || typeof value.onWorkflowRun !== 'function') return null
  return value as WorkflowBridge
}

const LIST_FALLBACK: WorkflowsListOutcome = {
  ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '无法读取工作流清单。' }
}
const READ_FALLBACK: WorkflowReadOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '读取工作流定义的请求没有送达主进程。' }
}
const SAVE_FALLBACK: WorkflowSaveOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '保存工作流的请求没有送达主进程。' }
}
const DELETE_FALLBACK: WorkflowDeleteOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '删除工作流的请求没有送达主进程。' }
}
const RUN_FALLBACK: WorkflowRunOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '运行请求没有送达主进程。' }
}
const CLEAR_FALLBACK: WorkflowRunsClearOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '清空运行记录的请求没有送达主进程。' }
}
const RUNS_LIST_FALLBACK: WorkflowRunsListOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '读取运行列表的请求没有送达主进程。' }
}
const SCHEDULES_LIST_FALLBACK: WorkflowSchedulesListOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '读取定时任务的请求没有送达主进程。' }
}
const SCHEDULE_SAVE_FALLBACK: WorkflowScheduleSaveOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '保存定时任务的请求没有送达主进程。' }
}
const SCHEDULE_DELETE_FALLBACK: WorkflowScheduleDeleteOutcome = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '删除定时任务的请求没有送达主进程。' }
}

async function call<Result>(
  work: (target: WorkflowBridge) => Promise<unknown>,
  validate: (value: unknown) => value is Result,
  failure: Result
): Promise<Result> {
  const target = bridge()
  if (target === null) return failure
  try {
    const response = await work(target)
    return validate(response) ? response : failure
  } catch {
    return failure
  }
}

export function listWorkflows(): Promise<WorkflowsListOutcome> {
  return call(target => target.listWorkflows(), isWorkflowsListOutcome, LIST_FALLBACK)
}

export function readWorkflow(workflowId: string): Promise<WorkflowReadOutcome> {
  return call(target => target.readWorkflow({ workflowId }), isWorkflowReadOutcome, READ_FALLBACK)
}

export function saveWorkflow(request: Parameters<WorkflowApi['saveWorkflow']>[0]): Promise<WorkflowSaveOutcome> {
  return call(target => target.saveWorkflow(request), isWorkflowSaveOutcome, SAVE_FALLBACK)
}

export function deleteWorkflow(workflowId: string): Promise<WorkflowDeleteOutcome> {
  return call(target => target.deleteWorkflow({ workflowId }), isWorkflowDeleteOutcome, DELETE_FALLBACK)
}

export function startWorkflowRun(
  workflowId: string,
  projectPath: string,
  parameters: WorkflowParameterValues
): Promise<WorkflowRunOutcome> {
  return call(
    target => target.startWorkflowRun({ workflowId, projectPath, parameters }),
    isWorkflowRunOutcome,
    RUN_FALLBACK
  )
}

export function cancelWorkflowRun(runId: string): Promise<WorkflowRunOutcome> {
  return call(target => target.cancelWorkflowRun({ runId }), isWorkflowRunOutcome, RUN_FALLBACK)
}

/** 审批门的一次决定：通过与拒绝分别走 success 与 failure 边。 */
export function approveWorkflowRun(runId: string, nodeId: string, approved: boolean): Promise<WorkflowRunOutcome> {
  return call(
    target => target.approveWorkflowRun({ runId, nodeId, approved }),
    isWorkflowRunOutcome,
    RUN_FALLBACK
  )
}

export function listWorkflowRuns(workflowId: string): Promise<WorkflowRunsListOutcome> {
  return call(target => target.listWorkflowRuns({ workflowId }), isWorkflowRunsListOutcome, RUNS_LIST_FALLBACK)
}

export function readWorkflowRun(runId: string): Promise<WorkflowRunOutcome> {
  return call(target => target.readWorkflowRun({ runId }), isWorkflowRunOutcome, RUN_FALLBACK)
}

export function clearWorkflowRuns(): Promise<WorkflowRunsClearOutcome> {
  return call(target => target.clearWorkflowRuns(), isWorkflowRunsClearOutcome, CLEAR_FALLBACK)
}

export function listWorkflowSchedules(workflowId: string): Promise<WorkflowSchedulesListOutcome> {
  return call(
    target => target.listWorkflowSchedules({ workflowId }),
    isWorkflowSchedulesListOutcome,
    SCHEDULES_LIST_FALLBACK
  )
}

export function saveWorkflowSchedule(request: WorkflowScheduleSaveRequest): Promise<WorkflowScheduleSaveOutcome> {
  return call(target => target.saveWorkflowSchedule(request), isWorkflowScheduleSaveOutcome, SCHEDULE_SAVE_FALLBACK)
}

export function deleteWorkflowSchedule(scheduleId: string): Promise<WorkflowScheduleDeleteOutcome> {
  return call(
    target => target.deleteWorkflowSchedule({ scheduleId }),
    isWorkflowScheduleDeleteOutcome,
    SCHEDULE_DELETE_FALLBACK
  )
}

/** 立即按某个定时任务的配置跑一次。 */
export function runWorkflowSchedule(scheduleId: string): Promise<WorkflowRunOutcome> {
  return call(target => target.runWorkflowSchedule({ scheduleId }), isWorkflowRunOutcome, RUN_FALLBACK)
}

/** 订阅运行快照；桥接缺失时返回一个空订阅，页面不必区分两种来源。 */
export function onWorkflowRun(listener: (run: WorkflowRun) => void): () => void {
  const target = bridge()
  if (target === null) return () => {}
  try {
    return target.onWorkflowRun(run => {
      if (isWorkflowRun(run)) listener(run)
    })
  } catch {
    return () => {}
  }
}
