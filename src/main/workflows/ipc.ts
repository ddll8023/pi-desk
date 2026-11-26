/**
 * 工作流 IPC：定义清单与读写、启动与取消运行、读取运行快照。
 *
 * 通道只做校验与转交：定义的图形判定在契约层，调度在 `runner`，落盘在 `store` 与 `run-store`。
 * 运行只允许在已添加的项目里启动，因此页面不能借运行通道在任意目录执行节点。
 * 装配时顺带收敛上次退出遗留的 `running` 记录——那是本次启动唯一需要处理的残留状态。
 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  WORKFLOWS_LIST_CHANNEL,
  WORKFLOW_DELETE_CHANNEL,
  WORKFLOW_READ_CHANNEL,
  WORKFLOW_RUN_CANCEL_CHANNEL,
  WORKFLOW_RUN_APPROVE_CHANNEL,
  WORKFLOW_RUN_READ_CHANNEL,
  WORKFLOW_RUN_START_CHANNEL,
  WORKFLOW_RUNS_CLEAR_CHANNEL,
  WORKFLOW_RUNS_LIST_CHANNEL,
  WORKFLOW_SCHEDULES_LIST_CHANNEL,
  WORKFLOW_SCHEDULE_DELETE_CHANNEL,
  WORKFLOW_SCHEDULE_RUN_CHANNEL,
  WORKFLOW_SCHEDULE_SAVE_CHANNEL,
  WORKFLOW_SAVE_CHANNEL,
  isWorkflowDeleteRequest,
  isWorkflowId,
  isWorkflowReadRequest,
  isWorkflowRunApproveRequest,
  isWorkflowRunCancelRequest,
  isWorkflowRunReadRequest,
  isWorkflowRunStartRequest,
  isWorkflowRunsListRequest,
  isWorkflowSaveRequest,
  isWorkflowSchedulesListRequest,
  isWorkflowScheduleDeleteRequest,
  isWorkflowScheduleRunRequest,
  isWorkflowScheduleSaveRequest,
  missingWorkflowParameters,
  resolveWorkflowParameters,
  validateWorkflowGraph
} from '../../shared/workflow-api'
import type {
  WorkflowDeleteOutcome,
  WorkflowReadOutcome,
  WorkflowRunOutcome,
  WorkflowRunsClearOutcome,
  WorkflowRunsListOutcome,
  WorkflowSchedulesListOutcome,
  WorkflowScheduleDeleteOutcome,
  WorkflowScheduleSaveOutcome,
  WorkflowSaveOutcome,
  WorkflowsListOutcome
} from '../../shared/workflow-api'
import { getPiAgentDir } from '../shared/pi-paths'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import {
  deleteSchedule,
  deleteWorkflowFile,
  findSchedule,
  listSchedules,
  listWorkflowFiles,
  readWorkflowFile,
  saveSchedule,
  saveWorkflowFile
} from './store'
import { pruneWorkflowRuns, clearFinishedRuns, listWorkflowRunFiles, readWorkflowRunFile, settleInterruptedRuns } from './run-store'
import { activeWorkflowRun, approveWorkflowNode, cancelWorkflowRun, hasRunningWorkflow, liveWorkflowRunIds, startWorkflowRun } from './runner'
import { runScheduleOnce } from './scheduler'

/** 依赖注入：项目清单由组合根给出，运行只接受已添加的项目。 */
export interface WorkflowHandlerOptions {
  readonly hasProject: (projectPath: string) => Promise<boolean>
}

function forbidden(message: string): { readonly ok: false; readonly error: { readonly code: 'FORBIDDEN'; readonly message: string } } {
  return { ok: false, error: { code: 'FORBIDDEN', message } }
}

function invalid(message: string): { readonly ok: false; readonly error: { readonly code: 'INVALID_REQUEST'; readonly message: string } } {
  return { ok: false, error: { code: 'INVALID_REQUEST', message } }
}

function internal(message: string): { readonly ok: false; readonly error: { readonly code: 'INTERNAL_ERROR'; readonly message: string } } {
  return { ok: false, error: { code: 'INTERNAL_ERROR', message } }
}

export function registerWorkflowHandlers(pageUrl: string, options: WorkflowHandlerOptions): void {
  // 只收敛一次：装配期就是启动期，此后不会再有「上次退出遗留」的运行。
  void settleInterruptedRuns(getPiAgentDir())
  void pruneWorkflowRuns(getPiAgentDir())

  handle(
    WORKFLOWS_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowsListOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      if (args.length !== 0) return invalid('工作流清单读取不接受参数。')
      try {
        return { ok: true, data: { workflows: await listWorkflowFiles(getPiAgentDir()) } }
      } catch {
        return internal('读取工作流清单失败。')
      }
    }
  )

  handle(
    WORKFLOW_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowReadOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowReadRequest(request)) return invalid('工作流读取请求不合法。')
      const definition = await readWorkflowFile(getPiAgentDir(), request.workflowId)
      if (definition === null) return { ok: false, error: { code: 'NOT_FOUND', message: '没有这份工作流定义。' } }
      return { ok: true, data: definition }
    }
  )

  handle(
    WORKFLOW_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowSaveOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowSaveRequest(request)) return invalid('工作流保存请求不合法。')
      const issues = validateWorkflowGraph(request)
      if (issues.length > 0) {
        return { ok: false, error: { code: 'INVALID_DEFINITION', message: '工作流定义未通过校验。' }, issues }
      }
      try {
        const saved = await saveWorkflowFile(getPiAgentDir(), {
          workflowId: request.workflowId,
          name: request.name,
          summary: request.summary,
          parameters: request.parameters,
          nodes: request.nodes,
          edges: request.edges
        })
        if (!saved.ok) {
          return saved.reason === 'not-found'
            ? { ok: false, error: { code: 'NOT_FOUND', message: '这份工作流已经被删除或移走。' } }
            : { ok: false, error: { code: 'INVALID_DEFINITION', message: '工作流定义未通过校验。' }, issues: saved.issues }
        }
        return { ok: true, data: { workflowId: saved.workflowId } }
      } catch {
        return internal('保存工作流定义失败，检查产品 agent 目录是否可写。')
      }
    }
  )

  handle(
    WORKFLOW_DELETE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowDeleteOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowDeleteRequest(request) || !isWorkflowId(request.workflowId)) {
        return invalid('工作流删除请求不合法。')
      }
      const removed = await deleteWorkflowFile(getPiAgentDir(), request.workflowId)
      if (!removed) return internal('删除工作流定义失败，文件可能正被占用。')
      return { ok: true, data: {} }
    }
  )

  handle(
    WORKFLOW_RUN_START_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowRunOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowRunStartRequest(request)) return invalid('工作流运行请求不合法。')
      const definition = await readWorkflowFile(getPiAgentDir(), request.workflowId)
      if (definition === null) return { ok: false, error: { code: 'NOT_FOUND', message: '没有这份工作流定义。' } }
      const issues = validateWorkflowGraph(definition)
      if (issues.length > 0) {
        return { ok: false, error: { code: 'INVALID_DEFINITION', message: '工作流定义未通过校验，不能运行。' } }
      }
      // 只接受已添加项目：节点子进程的工作目录就是它。
      if (!await options.hasProject(request.projectPath)) {
        return { ok: false, error: { code: 'PROJECT_UNAVAILABLE', message: '只能运行已添加项目里的工作流。' } }
      }
      try {
        const values = resolveWorkflowParameters(definition.parameters, request.parameters)
        const missing = missingWorkflowParameters(definition.parameters, values)
        if (missing.length > 0) {
          return {
            ok: false,
            error: { code: 'MISSING_PARAMETERS', message: `缺少必填参数：${missing.join('、')}。` }
          }
        }
        // 同一份工作流不并行开第二次：连续点击会成倍放大子进程与事件缓冲。
        if (hasRunningWorkflow(request.workflowId)) {
          return {
            ok: false,
            error: { code: 'ALREADY_RUNNING', message: '这份工作流已有运行在推进，等它结束再启动。' }
          }
        }
        return { ok: true, data: startWorkflowRun(definition, request.projectPath, values) }
      } catch {
        return internal('启动工作流运行失败。')
      }
    }
  )

  handle(
    WORKFLOW_RUN_CANCEL_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): WorkflowRunOutcome => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowRunCancelRequest(request)) return invalid('取消请求不合法。')
      const run = cancelWorkflowRun(request.runId)
      if (run === null) return { ok: false, error: { code: 'RUN_SETTLED', message: '这次运行已经结束。' } }
      return { ok: true, data: run }
    }
  )

  handle(
    WORKFLOW_SCHEDULES_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowSchedulesListOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowSchedulesListRequest(request)) return invalid('定时任务读取请求不合法。')
      try {
        return { ok: true, data: { schedules: await listSchedules(getPiAgentDir(), request.workflowId) } }
      } catch {
        return internal('读取定时任务失败。')
      }
    }
  )

  handle(
    WORKFLOW_SCHEDULE_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowScheduleSaveOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowScheduleSaveRequest(request)) return invalid('定时任务保存请求不合法。')
      if (!await options.hasProject(request.projectPath)) {
        return { ok: false, error: { code: 'PROJECT_UNAVAILABLE', message: '只能为已添加项目创建定时任务。' } }
      }
      const definition = await readWorkflowFile(getPiAgentDir(), request.workflowId)
      if (definition === null) return { ok: false, error: { code: 'NOT_FOUND', message: '没有这份工作流定义。' } }
      const values = resolveWorkflowParameters(definition.parameters, request.parameters)
      const missing = missingWorkflowParameters(definition.parameters, values)
      if (missing.length > 0) {
        return {
          ok: false,
          error: { code: 'MISSING_PARAMETERS', message: `定时任务缺少必填参数：${missing.join('、')}。` }
        }
      }
      try {
        const saved = await saveSchedule(getPiAgentDir(), {
          scheduleId: request.scheduleId,
          workflowId: request.workflowId,
          cron: request.cron,
          projectPath: request.projectPath,
          parameters: values,
          enabled: request.enabled
        })
        if (!saved.ok) {
          return {
            ok: false,
            error: saved.reason === 'full'
              ? { code: 'INVALID_REQUEST', message: '这份工作流的定时任务已达上限。' }
              : { code: 'NOT_FOUND', message: '没有这个定时任务。' }
          }
        }
        return { ok: true, data: { scheduleId: saved.schedule.id } }
      } catch {
        return internal('保存定时任务失败。')
      }
    }
  )

  handle(
    WORKFLOW_SCHEDULE_DELETE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowScheduleDeleteOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowScheduleDeleteRequest(request)) return invalid('定时任务删除请求不合法。')
      try {
        await deleteSchedule(getPiAgentDir(), request.scheduleId)
        return { ok: true, data: {} }
      } catch {
        return internal('删除定时任务失败。')
      }
    }
  )

  handle(
    WORKFLOW_SCHEDULE_RUN_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowRunOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowScheduleRunRequest(request)) return invalid('立即运行请求不合法。')
      const found = await findSchedule(getPiAgentDir(), request.scheduleId)
      if (found === null) return { ok: false, error: { code: 'NOT_FOUND', message: '没有这个定时任务。' } }
      try {
        const run = await runScheduleOnce(request.scheduleId)
        if (run === null) {
          return {
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: '这次触发被跳过：项目不可用、定义不合法、参数缺值，或这份工作流已有运行在推进。'
            }
          }
        }
        return { ok: true, data: run }
      } catch {
        return internal('按定时任务启动运行失败。')
      }
    }
  )

  handle(
    WORKFLOW_RUNS_CLEAR_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowRunsClearOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      if (args.length !== 0) return invalid('清空运行记录不接受参数。')
      try {
        const removed = await clearFinishedRuns(getPiAgentDir(), liveWorkflowRunIds())
        return { ok: true, data: { removed } }
      } catch {
        return internal('清空运行记录失败。')
      }
    }
  )

  handle(
    WORKFLOW_RUN_APPROVE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): WorkflowRunOutcome => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowRunApproveRequest(request)) return invalid('审批请求不合法。')
      const run = approveWorkflowNode(request.runId, request.nodeId, request.approved)
      if (run === null) {
        return { ok: false, error: { code: 'NO_PENDING_APPROVAL', message: '这次运行里没有等待审批的该节点。' } }
      }
      return { ok: true, data: run }
    }
  )

  handle(
    WORKFLOW_RUNS_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowRunsListOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowRunsListRequest(request)) return invalid('运行列表请求不合法。')
      try {
        return { ok: true, data: { runs: await listWorkflowRunFiles(getPiAgentDir(), request.workflowId) } }
      } catch {
        return internal('读取运行记录失败。')
      }
    }
  )

  handle(
    WORKFLOW_RUN_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorkflowRunOutcome> => {
      if (!isTrustedCaller(event, pageUrl)) return forbidden('不允许此页面调用桌面接口。')
      const request: unknown = args[0]
      if (args.length !== 1 || !isWorkflowRunReadRequest(request)) return invalid('运行读取请求不合法。')
      const live = activeWorkflowRun(request.runId)
      if (live !== null) return { ok: true, data: live }
      const stored = await readWorkflowRunFile(getPiAgentDir(), request.runId)
      if (stored === null) return { ok: false, error: { code: 'NOT_FOUND', message: '没有这次运行的记录。' } }
      return { ok: true, data: stored }
    }
  )
}
