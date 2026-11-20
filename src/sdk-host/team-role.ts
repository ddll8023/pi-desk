/**
 * 团队角色段与团长的装配期收窄：把一个可开团的团队包成一段系统提示，并给出团长要移出的工具。
 *
 * 团长只做拆解、分配、验收与整合，不生产交付物，因此它比普通专家多一层收窄：
 * 写类与委派工具在装配期直接移出激活集合，写入范围按只读处理——两条都必须做，
 * 工具范围管「有没有这个工具」，写入范围管「写到哪」，只做一半仍有越界路径。
 * 段内只写标识与规则：成员会话、账本与派活各自有别的扩展或宿主代码，这里不让模型以为它们是本文件的能力。
 */
import { join } from 'node:path'
import { readAgentResourceBundle } from '../shared-process/agent-resources'
import { builtinExperts, loadExpertCatalog, skillDirectoryIds } from '../shared-process/expert-definitions'
import { builtinTeams, loadTeamCatalog } from '../shared-process/team-definitions'
import type { TeamDefinition } from '../shared-process/team-definitions'
import { DELEGATION_TOOL_NAME } from './sub-agent/delegation-extension'

/** 团队分段在系统提示里的键；与专家段并列，按轮重写。 */
export const TEAM_SECTION_KEY = 'team-role'

/**
 * 团长在装配期被移出的工具：写入与委派都不该出现在团长手里。
 * 保留读取类工具用于验收——无法核实的打回只会降低质量。
 */
export const LEAD_BLOCKED_TOOLS: readonly string[] = ['write', 'edit', 'bash', DELEGATION_TOOL_NAME]

/**
 * 读取本次要用的团队定义；未开团、标识失效、团队不可开团或清单读不出来都返回 null。
 * 只读一次，与专家定义同批读取，不在每轮重新解析。
 */
export function readSelectedTeam(input: {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly sharedAgentDir: string
  readonly teamId: string
}): TeamDefinition | null {
  const bundle = readAgentResourceBundle(input.resourcesDirectory)
  const catalog = loadTeamCatalog({
    builtin: builtinTeams(bundle),
    userDirectory: join(input.agentDir, 'teams'),
    availableExpertIds: loadExpertCatalog({
      builtin: builtinExperts(bundle),
      userDirectory: join(input.agentDir, 'experts'),
      availableSkillIds: [
        ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
        ...skillDirectoryIds(join(input.sharedAgentDir, 'skills'))
      ],
      subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
    }).experts.map(item => item.id)
  })
  const team = catalog.teams.find(item => item.id === input.teamId) ?? null
  // 不可开团的团队不注入团队段：团长缺席或没有成员时，团队边界无从执行。
  return team !== null && team.ready ? team : null
}

/** 团队段文本：身份、团长职责与边界、成员清单、派活与验收规则；账本摘要由独立分段给出。 */
export function teamRoleSection(team: TeamDefinition): string {
  const members = team.memberExpertIds.length === 0
    ? '（暂无可用成员）'
    : team.memberExpertIds.join('、')
  return [
    `当前会话是一个团队：${team.displayName}`,
    `团队目标：${team.summary}`,
    `团长：${team.leadExpertId}（本会话身份）`,
    `成员：${members}`,
    '',
    '团长职责：拆解任务、分配给成员、验收成员产出、整合并交付。',
    '团长不生产交付物：不直接写文件、不执行命令、不自行委派子代理；需要产出时交给成员会话。',
    '团长保留读取能力用于验收：打回必须指出具体问题并附可核查的证据，不能只说「不合格」。',
    '',
    '任务状态只以任务账本（`team_board`）为准：拆解后先提交账本再开始分工，状态变化立刻重新提交整份。',
    '账本条目状态：pending → assigned → running → review → done，失败走 failed 并在 note 写一句原因；验收项只在 review 阶段勾选。',
    '派活只用 `team_assign`：条目必须有验收项、依赖全部完成才能派；任务说明写清目标、产出形式、验收项与边界，成员看不到账本全貌。',
    '成员一轮结束后的终态、结论与写入文件由宿主记录，不采信成员自述；验收项没勾完的条目置 done 会被退回 review。',
    '打回只有一次机会：带未满足的验收项与证据位置再派一次，用尽后改派或上报用户；用户要求停下时用 `team_stop`。',
    '每轮开工前自省五问，不写成流程记录：目标是什么、哪些条目在动、谁在等谁、哪些卡在验收、下一步派给谁。'
  ].join('\n')
}
