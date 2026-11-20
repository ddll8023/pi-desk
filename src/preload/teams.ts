/**
 * 团队与成员会话的桥接：只读团队清单、成员清单与成员内容。
 *
 * 只读：本文件不提供团队编辑、开团、派活或取消入口；
 * 主进程返回的形状不合契约时统一转成固定失败结果，页面不按半成品渲染。
 */

import { ipcRenderer } from 'electron'
import { TEAMS_LIST_CHANNEL, isTeamsListResult } from '../shared/teams-api'
import type { TeamApi, TeamsListResult } from '../shared/teams-api'
import {
  TEAM_SESSIONS_LIST_CHANNEL,
  TEAM_SESSION_HISTORY_CHANNEL,
  TEAM_SESSION_READ_CHANNEL,
  isTeamSessionHistoryResult,
  isTeamSessionReadResult,
  isTeamSessionsListResult
} from '../shared/team-session-api'
import type {
  TeamSessionApi,
  TeamSessionHistoryRequest,
  TeamSessionHistoryResult,
  TeamSessionReadRequest,
  TeamSessionReadResult,
  TeamSessionsListRequest,
  TeamSessionsListResult
} from '../shared/team-session-api'

/** 主进程返回的形状不合契约时统一转成 INVALID_RESPONSE，页面不按半成品渲染。 */
function invalidTeamResponse(): TeamsListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的团队数据不符合契约。' } }
}

function invalidTeamSessionsResponse(): TeamSessionsListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的成员会话清单不符合契约。' } }
}

function invalidTeamSessionResponse(): TeamSessionReadResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的成员会话内容不符合契约。' } }
}

function invalidTeamSessionHistoryResponse(): TeamSessionHistoryResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: '主进程返回的成员会话正文不符合契约。' } }
}

export const teamsApi: TeamApi & TeamSessionApi = {
  async listTeams(): Promise<TeamsListResult> {
    const response: unknown = await ipcRenderer.invoke(TEAMS_LIST_CHANNEL)
    return isTeamsListResult(response) ? response : invalidTeamResponse()
  },

  async listTeamSessions(request: TeamSessionsListRequest): Promise<TeamSessionsListResult> {
    const response: unknown = await ipcRenderer.invoke(TEAM_SESSIONS_LIST_CHANNEL, request)
    return isTeamSessionsListResult(response) ? response : invalidTeamSessionsResponse()
  },

  async readTeamSession(request: TeamSessionReadRequest): Promise<TeamSessionReadResult> {
    const response: unknown = await ipcRenderer.invoke(TEAM_SESSION_READ_CHANNEL, request)
    return isTeamSessionReadResult(response) ? response : invalidTeamSessionResponse()
  },

  async readTeamSessionHistory(request: TeamSessionHistoryRequest): Promise<TeamSessionHistoryResult> {
    const response: unknown = await ipcRenderer.invoke(TEAM_SESSION_HISTORY_CHANNEL, request)
    return isTeamSessionHistoryResult(response) ? response : invalidTeamSessionHistoryResponse()
  }
}
