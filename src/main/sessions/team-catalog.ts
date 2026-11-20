/**
 * 主进程侧的团队清单读取：把随包内置团队与产品 agent 目录下的自定义团队合并成一份可开团清单。
 *
 * 只读，不开会话、不写盘。专家可用集取自专家清单——与设置页看到的是同一份，
 * 定义无效或标识冲突的专家不算可用，团队据此标为不可开团而不是消失。
 * 随包清单缺失或内容与指纹不一致时抛出，由调用方转成失败响应；静默给出空列表会让人以为团队被删了。
 */
import { join } from 'node:path'
import { agentResourcesDirectory, readAgentResourceBundle } from '../../shared-process/agent-resources'
import { builtinTeams, loadTeamCatalog } from '../../shared-process/team-definitions'
import type { TeamDefinition } from '../../shared-process/team-definitions'
import type { TeamCatalogView, TeamView } from '../../shared/teams-api'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { getPiAgentDir } from '../shared/pi-paths'
import { readExpertCatalog } from './expert-catalog'

/** 结构条目转视图：只出清单需要的字段，正文与构造细节留在服务端。 */
function toTeamView(team: TeamDefinition): TeamView {
  return {
    id: team.id,
    displayName: team.displayName,
    summary: team.summary,
    leadExpertId: team.leadExpertId,
    memberExpertIds: team.memberExpertIds,
    source: team.source,
    ready: team.ready
  }
}

/**
 * 读取团队清单与诊断。
 * 随包清单读一次用于内置团队入口；专家清单单独读一次，因为它同时产出可用与诊断，
 * 两处口径不同，不复用同一份中间结果。
 */
export function readTeamCatalog(): TeamCatalogView {
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const availableExpertIds = readExpertCatalog().experts.map(item => item.id)
  const catalog = loadTeamCatalog({
    builtin: builtinTeams(bundle),
    userDirectory: join(getPiAgentDir(), 'teams'),
    availableExpertIds
  })
  return {
    teams: catalog.teams.map(toTeamView),
    issues: catalog.issues.map(issue => ({
      kind: issue.kind, teamId: issue.teamId, expertId: issue.expertId, path: issue.path
    }))
  }
}
