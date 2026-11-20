/**
 * 团队资源与成员会话的 IPC：读团队清单与加载诊断，读写删自定义团队，以及成员会话清单与内容。
 *
 * 写通道只到 `<agentDir>/teams/` 下的自定义团队；内置团队只读。派活与停止由宿主内的团队工具完成，不经本通道。
 * 成员会话按「项目路径 + 根会话标识 + 成员登记标识」定位，不接受文件路径，
 * 因此读不到登记之外的会话文件，也读不到未添加项目的目录。
 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  TEAMS_DELETE_CHANNEL,
  TEAMS_LIST_CHANNEL,
  TEAMS_READ_CHANNEL,
  TEAMS_SAVE_CHANNEL,
  isTeamDeleteRequest,
  isTeamReadRequest,
  isTeamSaveRequest
} from '../../shared/teams-api'
import type { TeamDeleteResult, TeamReadResult, TeamSaveResult, TeamsListResult } from '../../shared/teams-api'
import {
  TEAM_SESSIONS_LIST_CHANNEL,
  TEAM_SESSION_HISTORY_CHANNEL,
  TEAM_SESSION_READ_CHANNEL,
  isTeamSessionHistoryRequest,
  isTeamSessionReadRequest,
  isTeamSessionsListRequest
} from '../../shared/team-session-api'
import type { TeamSessionHistoryResult, TeamSessionReadResult, TeamSessionsListResult } from '../../shared/team-session-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { getPiAgentDir } from '../shared/pi-paths'
import { readTeamCatalog } from './team-catalog'
import { deleteUserTeam, readUserTeamDefinition, saveUserTeamDefinition } from './team-files'
import { readExpertCatalog } from './expert-catalog'
import { listTeamSessions, readTeamSession, readTeamSessionHistory } from './team-sessions'
import type { TeamSessionBindings } from './team-sessions'

/** 依赖注入：成员登记读写口与项目清单，均由 `app-lifecycle` 在注册时给出。 */
export interface TeamHandlerOptions {
  readonly teamSessions: TeamSessionBindings
  readonly hasProject: (projectPath: string) => Promise<boolean>
}

export function registerTeamHandlers(pageUrl: string, options: TeamHandlerOptions): void {
  /** 清单：一次返回全部团队与诊断，不做分页，也不接受参数。 */
  handle(
    TEAMS_LIST_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamsListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 0) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '团队清单读取不接受参数。' } })
      }
      try {
        return Promise.resolve({ ok: true, data: readTeamCatalog() })
      } catch {
        return Promise.resolve({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: '读取团队清单失败，检查随包资源是否完整。' }
        })
      }
    }
  )

  /** 成员清单：按根会话读取登记，并补上每条的文件状态。 */
  handle(
    TEAM_SESSIONS_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamSessionsListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      const request: unknown = args[0]
      if (args.length !== 1 || !isTeamSessionsListRequest(request)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '成员会话清单请求不合法。' } }
      }
      // 只接受已添加项目：页面不能借这个通道探测任意目录的会话文件。
      if (!await options.hasProject(request.projectPath)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能读取已添加项目的成员会话。' } }
      }
      try {
        const sessions = await listTeamSessions({
          bindings: options.teamSessions, projectPath: request.projectPath, rootSessionId: request.rootSessionId
        })
        return { ok: true, data: { sessions } }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '读取成员会话清单失败。' } }
      }
    }
  )

  /** 成员内容：只给头部与首条预览，不返回完整对话。 */
  handle(
    TEAM_SESSION_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamSessionReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      const request: unknown = args[0]
      if (args.length !== 1 || !isTeamSessionReadRequest(request)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '成员会话读取请求不合法。' } }
      }
      if (!await options.hasProject(request.projectPath)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能读取已添加项目的成员会话。' } }
      }
      try {
        const content = await readTeamSession({
          bindings: options.teamSessions,
          projectPath: request.projectPath,
          rootSessionId: request.rootSessionId,
          teamSessionId: request.teamSessionId
        })
        if (content === null) {
          return { ok: false, error: { code: 'NOT_FOUND', message: '没有这条成员会话登记。' } }
        }
        return { ok: true, data: content }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '读取成员会话失败。' } }
      }
    }
  )

  /** 成员正文：最近若干条消息，更早的不返回，由 `truncated` 标出。 */
  handle(
    TEAM_SESSION_HISTORY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamSessionHistoryResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      const request: unknown = args[0]
      if (args.length !== 1 || !isTeamSessionHistoryRequest(request)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '成员会话正文请求不合法。' } }
      }
      if (!await options.hasProject(request.projectPath)) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '只能读取已添加项目的成员会话。' } }
      }
      try {
        const history = await readTeamSessionHistory({
          bindings: options.teamSessions,
          projectPath: request.projectPath,
          rootSessionId: request.rootSessionId,
          teamSessionId: request.teamSessionId,
          limit: request.limit
        })
        if (history === null) {
          return { ok: false, error: { code: 'NOT_FOUND', message: '该成员会话还没有内容。' } }
        }
        return { ok: true, data: history }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '读取成员会话正文失败。' } }
      }
    }
  )

  /** 读取一份自定义团队的声明与正文，供设置页编辑。 */
  handle(
    TEAMS_READ_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isTeamReadRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '团队读取请求只接受一个团队标识。' } })
      }
      try {
        return Promise.resolve(readUserTeamDefinition({ agentDir: getPiAgentDir(), teamId: args[0].teamId }))
      } catch {
        return Promise.resolve({
          ok: false, error: { code: 'INTERNAL_ERROR', message: '读取团队定义失败，检查应用数据目录。' }
        })
      }
    }
  )

  /** 新建或保存一份自定义团队；团长与成员必须是当前专家清单里的标识。 */
  handle(
    TEAMS_SAVE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamSaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isTeamSaveRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '团队保存请求不合法。' } })
      }
      try {
        const availableExpertIds = readExpertCatalog().experts.map(item => item.id)
        return Promise.resolve(saveUserTeamDefinition({ ...args[0], agentDir: getPiAgentDir(), availableExpertIds }))
      } catch {
        return Promise.resolve({
          ok: false, error: { code: 'INTERNAL_ERROR', message: '保存团队定义失败，检查应用数据目录是否可写。' }
        })
      }
    }
  )

  /** 删除一份自定义团队；只删定义文件，目录里还有别的文件时整体拒绝。 */
  handle(
    TEAMS_DELETE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TeamDeleteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return Promise.resolve({ ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } })
      }
      if (args.length !== 1 || !isTeamDeleteRequest(args[0])) {
        return Promise.resolve({ ok: false, error: { code: 'INVALID_REQUEST', message: '团队删除请求只接受一个团队标识。' } })
      }
      try {
        return Promise.resolve(deleteUserTeam({ agentDir: getPiAgentDir(), teamId: args[0].teamId }))
      } catch {
        return Promise.resolve({
          ok: false, error: { code: 'INTERNAL_ERROR', message: '删除团队定义失败，检查应用数据目录。' }
        })
      }
    }
  )
}
