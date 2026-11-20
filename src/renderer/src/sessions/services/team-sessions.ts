/**
 * 成员会话只读通道的渲染层包装。
 *
 * 三条通道（清单、头部、近期正文）共用一份失败收敛口径：桥接缺失、调用抛错、响应不合契约
 * 都收敛成固定失败结果，页面只处理一种形状。成员会话是只读的，这里不提供任何写入或启动入口。
 */
import {
  isTeamSessionHistoryResult,
  isTeamSessionReadResult,
  isTeamSessionsListResult
} from '../../../../shared/team-session-api'
import type {
  TeamSessionApi,
  TeamSessionHistoryResult,
  TeamSessionReadResult,
  TeamSessionsListResult
} from '../../../../shared/team-session-api'

/** 桥接是页面唯一入口；缺失说明预加载脚本没挂上，不能当成「没有成员」处理。 */
interface TeamSessionsBridge {
  readonly listTeamSessions: TeamSessionApi['listTeamSessions']
  readonly readTeamSession: TeamSessionApi['readTeamSession']
  readonly readTeamSessionHistory: TeamSessionApi['readTeamSessionHistory']
}

function bridge(): TeamSessionsBridge | null {
  const value = window.desktop as Partial<TeamSessionsBridge> | undefined
  if (value === undefined || typeof value.listTeamSessions !== 'function'
    || typeof value.readTeamSession !== 'function' || typeof value.readTeamSessionHistory !== 'function') {
    return null
  }
  return value as TeamSessionsBridge
}

const UNAVAILABLE = { code: 'BRIDGE_UNAVAILABLE', message: '无法读取成员会话。' } as const

const LIST_FALLBACK: TeamSessionsListResult = { ok: false, error: UNAVAILABLE }
const READ_FALLBACK: TeamSessionReadResult = { ok: false, error: UNAVAILABLE }
const HISTORY_FALLBACK: TeamSessionHistoryResult = { ok: false, error: UNAVAILABLE }

/** 一个根会话下的全部成员登记。 */
export async function listTeamSessions(projectPath: string, rootSessionId: string): Promise<TeamSessionsListResult> {
  const target = bridge()
  if (target === null) return LIST_FALLBACK
  try {
    const response = await target.listTeamSessions({ projectPath, rootSessionId })
    return isTeamSessionsListResult(response) ? response : LIST_FALLBACK
  } catch {
    return LIST_FALLBACK
  }
}

/** 单个成员会话的头部与首条预览。 */
export async function readTeamSession(
  projectPath: string,
  rootSessionId: string,
  teamSessionId: string
): Promise<TeamSessionReadResult> {
  const target = bridge()
  if (target === null) return READ_FALLBACK
  try {
    const response = await target.readTeamSession({ projectPath, rootSessionId, teamSessionId })
    return isTeamSessionReadResult(response) ? response : READ_FALLBACK
  } catch {
    return READ_FALLBACK
  }
}

/** 成员会话最近若干条消息；更早的消息由 `truncated` 标出。 */
export async function readTeamSessionHistory(
  projectPath: string,
  rootSessionId: string,
  teamSessionId: string,
  limit: number
): Promise<TeamSessionHistoryResult> {
  const target = bridge()
  if (target === null) return HISTORY_FALLBACK
  try {
    const response = await target.readTeamSessionHistory({ projectPath, rootSessionId, teamSessionId, limit })
    return isTeamSessionHistoryResult(response) ? response : HISTORY_FALLBACK
  } catch {
    return HISTORY_FALLBACK
  }
}
