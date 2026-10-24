/** 会话列表、开关与运行状态：preload 的 sessions 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { SESSION_DELETE_CHANNEL, SESSION_LIST_CHANNEL, SESSION_OPEN_CHANNEL, SESSION_HISTORY_CHANNEL, SESSION_RELOAD_CHANNEL, isSessionListResult, isSessionOpenResult, isSessionHistoryResult } from '../shared/session-api'
import { SESSION_RUNS_STATE_CHANNEL, SESSION_RUNS_EVENT, SESSION_RUN_RELEASE_CHANNEL, SESSION_RUN_CLOSE_CHANNEL, isSessionRunsEvent, isSessionRunsResult, isSessionRunReleaseResult } from '../shared/session-run-api'
import type { SessionDeleteRequest, SessionListRequest, SessionListResult, SessionOpenRequest, SessionHistoryRequest } from '../shared/session-api'
import type { SessionRunReleaseRequest, SessionRunReleaseResult, SessionRunsResult, SessionRunsSnapshot } from '../shared/session-run-api'
import type { SessionApi } from '../shared/session-api'
import type { SessionRunApi } from '../shared/session-run-api'

const INVALID_SESSION_LIST_RESPONSE = '桌面接口返回了无法识别的会话列表。'
const INVALID_SESSION_RUNS_RESPONSE = '桌面接口返回了无法识别的会话运行状态。'

function invalidSessionResponse(): Extract<SessionListResult, { ok: false }> {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_SESSION_LIST_RESPONSE } }
}

function invalidSessionRunsResponse(): SessionRunsResult {
  return { ok: false, error: { code: 'INTERNAL_ERROR', message: INVALID_SESSION_RUNS_RESPONSE } }
}

function invalidSessionRunReleaseResponse(): SessionRunReleaseResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_SESSION_RUNS_RESPONSE } }
}

export const sessionsApi = {
  async listSessions(request: SessionListRequest) {
    const payload: SessionListRequest = { projectPath: request.projectPath, limit: request.limit }
    const response: unknown = await ipcRenderer.invoke(SESSION_LIST_CHANNEL, payload)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  async readSessionHistory(request: SessionHistoryRequest) {
    const payload: SessionHistoryRequest = {
      projectPath: request.projectPath, sessionId: request.sessionId, query: request.query
    }
    const response: unknown = await ipcRenderer.invoke(SESSION_HISTORY_CHANNEL, payload)
    return isSessionHistoryResult(response) ? response : invalidSessionResponse()
  },

  async openSession(request: SessionOpenRequest) {
    const payload: SessionOpenRequest = {
      projectPath: request.projectPath, sessionId: request.sessionId,
      allowInterrupt: request.allowInterrupt
    }
    const response: unknown = await ipcRenderer.invoke(SESSION_OPEN_CHANNEL, payload)
    return isSessionOpenResult(response) ? response : invalidSessionResponse()
  },

  async reloadSession(allowInterrupt: boolean) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RELOAD_CHANNEL, { allowInterrupt })
    return isSessionOpenResult(response) ? response : invalidSessionResponse()
  },

  async deleteSession(request: SessionDeleteRequest) {
    const payload: SessionDeleteRequest = {
      projectPath: request.projectPath,
      sessionId: request.sessionId,
      allowInterrupt: request.allowInterrupt,
      listLimit: request.listLimit
    }
    const response: unknown = await ipcRenderer.invoke(SESSION_DELETE_CHANNEL, payload)
    return isSessionListResult(response) ? response : invalidSessionResponse()
  },

  async getSessionRuns() {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUNS_STATE_CHANNEL)
    return isSessionRunsResult(response) ? response : invalidSessionRunsResponse()
  },

  onSessionRunsChanged(listener: (snapshot: SessionRunsSnapshot) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：契约不符时丢弃，由下一次查询或事件收敛。
      if (!isSessionRunsEvent(payload)) return
      listener(payload)
    }
    ipcRenderer.on(SESSION_RUNS_EVENT, handler)
    return () => {
      ipcRenderer.off(SESSION_RUNS_EVENT, handler)
    }
  },

  async releaseSessionRun(request: SessionRunReleaseRequest) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUN_RELEASE_CHANNEL, { runId: request.runId })
    return isSessionRunReleaseResult(response) ? response : invalidSessionRunReleaseResponse()
  },

  async closeSessionRun(request: SessionRunReleaseRequest) {
    const response: unknown = await ipcRenderer.invoke(SESSION_RUN_CLOSE_CHANNEL, { runId: request.runId })
    return isSessionRunReleaseResult(response) ? response : invalidSessionRunReleaseResponse()
  }
} satisfies SessionApi & SessionRunApi
