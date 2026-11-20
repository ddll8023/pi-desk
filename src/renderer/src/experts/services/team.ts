/**
 * 设置页「专家与专家团」分节里团队部分的桥接：清单、读取、保存与删除。
 *
 * 写面只到自定义团队；内置团队只读，开团与派活仍由会话侧完成。
 * 桥接缺失或响应不合契约时统一收敛为固定失败结果，页面只处理一种形状。
 */
import {
  isTeamDeleteResult,
  isTeamReadResult,
  isTeamSaveResult,
  isTeamsListResult
} from '../../../../shared/teams-api'
import type {
  TeamApi,
  TeamDeleteResult,
  TeamReadResult,
  TeamSaveRequest,
  TeamSaveResult,
  TeamsListResult
} from '../../../../shared/teams-api'

/** 桥接是页面唯一入口；缺失说明预加载脚本没挂上，不能当成「没有团队」处理。 */
interface TeamBridge {
  readonly listTeams: TeamApi['listTeams']
  readonly readTeamDefinition: TeamApi['readTeamDefinition']
  readonly saveTeam: TeamApi['saveTeam']
  readonly deleteTeam: TeamApi['deleteTeam']
}

function bridge(): TeamBridge | null {
  const value = window.desktop as Partial<TeamBridge> | undefined
  if (value === undefined
    || typeof value.listTeams !== 'function'
    || typeof value.readTeamDefinition !== 'function'
    || typeof value.saveTeam !== 'function'
    || typeof value.deleteTeam !== 'function') return null
  return value as TeamBridge
}

/** 固化的失败结果；先声明类型，避免对象字面量的 code 被拓成 string。 */
const LIST_FALLBACK: TeamsListResult = {
  ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '无法读取团队清单。' }
}
const READ_FALLBACK: TeamReadResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '读取团队定义的请求没有送达主进程。' }
}
const SAVE_FALLBACK: TeamSaveResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '保存团队的请求没有送达主进程。' }
}
const DELETE_FALLBACK: TeamDeleteResult = {
  ok: false, error: { code: 'INTERNAL_ERROR', message: '删除团队的请求没有送达主进程。' }
}

async function call<Result>(
  work: (target: TeamBridge) => Promise<unknown>,
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

export function listTeams(): Promise<TeamsListResult> {
  return call(
    target => target.listTeams(),
    isTeamsListResult,
    LIST_FALLBACK
  )
}

export function readTeamDefinition(teamId: string): Promise<TeamReadResult> {
  return call(
    target => target.readTeamDefinition({ teamId }),
    isTeamReadResult,
    READ_FALLBACK
  )
}

export function saveTeam(request: TeamSaveRequest): Promise<TeamSaveResult> {
  return call(
    target => target.saveTeam(request),
    isTeamSaveResult,
    SAVE_FALLBACK
  )
}

export function deleteTeam(teamId: string): Promise<TeamDeleteResult> {
  return call(
    target => target.deleteTeam({ teamId }),
    isTeamDeleteResult,
    DELETE_FALLBACK
  )
}
