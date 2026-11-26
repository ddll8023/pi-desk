/** 工作流的桥接：定义清单与读写、运行启动与取消、运行快照读取与订阅。 */

import { ipcRenderer } from 'electron'
import {
  WORKFLOWS_LIST_CHANNEL,
  WORKFLOW_DELETE_CHANNEL,
  WORKFLOW_READ_CHANNEL,
  WORKFLOW_RUN_APPROVE_CHANNEL,
  WORKFLOW_RUN_CANCEL_CHANNEL,
  WORKFLOW_RUN_EVENT,
  WORKFLOW_RUN_READ_CHANNEL,
  WORKFLOW_RUN_START_CHANNEL,
  WORKFLOW_RUNS_CLEAR_CHANNEL,
  WORKFLOW_RUNS_LIST_CHANNEL,
  WORKFLOW_SCHEDULES_LIST_CHANNEL,
  WORKFLOW_SCHEDULE_DELETE_CHANNEL,
  WORKFLOW_SCHEDULE_RUN_CHANNEL,
  WORKFLOW_SCHEDULE_SAVE_CHANNEL,
  WORKFLOW_SAVE_CHANNEL,
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
} from '../shared/workflow-api'
import type {
  WorkflowApi,
  WorkflowDeleteRequest,
  WorkflowDeleteOutcome,
  WorkflowReadOutcome,
  WorkflowReadRequest,
  WorkflowRun,
  WorkflowRunApproveRequest,
  WorkflowRunCancelRequest,
  WorkflowRunOutcome,
  WorkflowRunReadRequest,
  WorkflowRunStartRequest,
  WorkflowRunsClearOutcome,
  WorkflowRunsListOutcome,
  WorkflowRunsListRequest,
  WorkflowSchedulesListOutcome,
  WorkflowScheduleDeleteOutcome,
  WorkflowScheduleDeleteRequest,
  WorkflowScheduleRunRequest,
  WorkflowScheduleSaveOutcome,
  WorkflowScheduleSaveRequest,
  WorkflowSaveOutcome,
  WorkflowSaveRequest,
  WorkflowsListOutcome
} from '../shared/workflow-api'

function invalidWorkflowResponse(): { readonly ok: false; readonly error: { readonly code: 'INVALID_RESPONSE'; readonly message: string } } {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的工作流数据不符合契约。' } }
}

export const workflowsApi: WorkflowApi = {
  async listWorkflows(): Promise<WorkflowsListOutcome> {
    const response: unknown = await ipcRenderer.invoke(WORKFLOWS_LIST_CHANNEL)
    return isWorkflowsListOutcome(response) ? response : invalidWorkflowResponse()
  },

  async readWorkflow(request: WorkflowReadRequest): Promise<WorkflowReadOutcome> {
    const payload: WorkflowReadRequest = { workflowId: request.workflowId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_READ_CHANNEL, payload)
    return isWorkflowReadOutcome(response) ? response : invalidWorkflowResponse()
  },

  async saveWorkflow(request: WorkflowSaveRequest): Promise<WorkflowSaveOutcome> {
    const payload: WorkflowSaveRequest = {
      workflowId: request.workflowId,
      name: request.name,
      summary: request.summary,
      nodes: request.nodes.map(node => ({
        ...node,
        writeScope: node.writeScope === null ? null : [...node.writeScope]
      })),
      edges: request.edges.map(edge => ({ ...edge }))
    }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_SAVE_CHANNEL, payload)
    return isWorkflowSaveOutcome(response) ? response : invalidWorkflowResponse()
  },

  async deleteWorkflow(request: WorkflowDeleteRequest): Promise<WorkflowDeleteOutcome> {
    const payload: WorkflowDeleteRequest = { workflowId: request.workflowId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_DELETE_CHANNEL, payload)
    return isWorkflowDeleteOutcome(response) ? response : invalidWorkflowResponse()
  },

  async startWorkflowRun(request: WorkflowRunStartRequest): Promise<WorkflowRunOutcome> {
    const payload: WorkflowRunStartRequest = {
      workflowId: request.workflowId,
      projectPath: request.projectPath,
      parameters: { ...request.parameters }
    }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUN_START_CHANNEL, payload)
    return isWorkflowRunOutcome(response) ? response : invalidWorkflowResponse()
  },

  async cancelWorkflowRun(request: WorkflowRunCancelRequest): Promise<WorkflowRunOutcome> {
    const payload: WorkflowRunCancelRequest = { runId: request.runId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUN_CANCEL_CHANNEL, payload)
    return isWorkflowRunOutcome(response) ? response : invalidWorkflowResponse()
  },

  async approveWorkflowRun(request: WorkflowRunApproveRequest): Promise<WorkflowRunOutcome> {
    const payload: WorkflowRunApproveRequest = {
      runId: request.runId,
      nodeId: request.nodeId,
      approved: request.approved
    }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUN_APPROVE_CHANNEL, payload)
    return isWorkflowRunOutcome(response) ? response : invalidWorkflowResponse()
  },

  async listWorkflowRuns(request: WorkflowRunsListRequest): Promise<WorkflowRunsListOutcome> {
    const payload: WorkflowRunsListRequest = { workflowId: request.workflowId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUNS_LIST_CHANNEL, payload)
    return isWorkflowRunsListOutcome(response) ? response : invalidWorkflowResponse()
  },

  async readWorkflowRun(request: WorkflowRunReadRequest): Promise<WorkflowRunOutcome> {
    const payload: WorkflowRunReadRequest = { runId: request.runId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUN_READ_CHANNEL, payload)
    return isWorkflowRunOutcome(response) ? response : invalidWorkflowResponse()
  },

  async clearWorkflowRuns(): Promise<WorkflowRunsClearOutcome> {
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_RUNS_CLEAR_CHANNEL)
    return isWorkflowRunsClearOutcome(response) ? response : invalidWorkflowResponse()
  },

  async listWorkflowSchedules(request: WorkflowSchedulesListRequest): Promise<WorkflowSchedulesListOutcome> {
    const payload: WorkflowSchedulesListRequest = { workflowId: request.workflowId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_SCHEDULES_LIST_CHANNEL, payload)
    return isWorkflowSchedulesListOutcome(response) ? response : invalidWorkflowResponse()
  },

  async saveWorkflowSchedule(request: WorkflowScheduleSaveRequest): Promise<WorkflowScheduleSaveOutcome> {
    const payload: WorkflowScheduleSaveRequest = {
      scheduleId: request.scheduleId,
      workflowId: request.workflowId,
      cron: request.cron,
      projectPath: request.projectPath,
      parameters: { ...request.parameters },
      enabled: request.enabled
    }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_SCHEDULE_SAVE_CHANNEL, payload)
    return isWorkflowScheduleSaveOutcome(response) ? response : invalidWorkflowResponse()
  },

  async deleteWorkflowSchedule(request: WorkflowScheduleDeleteRequest): Promise<WorkflowScheduleDeleteOutcome> {
    const payload: WorkflowScheduleDeleteRequest = { scheduleId: request.scheduleId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_SCHEDULE_DELETE_CHANNEL, payload)
    return isWorkflowScheduleDeleteOutcome(response) ? response : invalidWorkflowResponse()
  },

  async runWorkflowSchedule(request: WorkflowScheduleRunRequest): Promise<WorkflowRunOutcome> {
    const payload: WorkflowScheduleRunRequest = { scheduleId: request.scheduleId }
    const response: unknown = await ipcRenderer.invoke(WORKFLOW_SCHEDULE_RUN_CHANNEL, payload)
    return isWorkflowRunOutcome(response) ? response : invalidWorkflowResponse()
  },

  onWorkflowRun(listener: (run: WorkflowRun) => void): () => void {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isWorkflowRun(value)) listener(value)
    }
    ipcRenderer.on(WORKFLOW_RUN_EVENT, receive)
    return () => ipcRenderer.removeListener(WORKFLOW_RUN_EVENT, receive)
  }
}
