/**
 * 专家清单与设置页辅助读取：合并随包清单的内置专家与产品 agent 目录下的自定义专家，
 * 产出选择器可用的视图与加载诊断，并回答「快速模式会剔除哪些用户级技能」。
 *
 * 只读：不启动 SDK 宿主、不打开会话、不写任何文件；技能可见集取「随包非子代理专用技能 +
 * 全局技能目录（产品 agent 目录与共享目录）」，缺失的技能引用只体现在诊断里，不让整份清单失败。
 * 能力候选也由这里给：技能候选、全局 MCP 服务器与当前默认基线，页面不自己拼路径也不自己读文件。
 * 项目技能不进候选：专家是全局定义，项目来源随工作区变化，候选会因此随项目漂移。
 */
import { join, resolve } from 'node:path'
import { agentResourcesDirectory, readAgentResourceBundle } from '../../shared-process/agent-resources'
import type { AgentResourceBundle } from '../../shared-process/agent-resources'
import { builtinExperts, loadExpertCatalog, skillDirectoryIds } from '../../shared-process/expert-definitions'
import type { ExpertDefinition } from '../../shared-process/expert-definitions'
import { readExpertCapabilityDefaults } from '../../shared-process/expert-capability-defaults'
import { globalSkillDirectories } from '../../shared-process/skill-sources'
import { fastModeBlockedSkillsIn } from '../../shared/execution-mode-skills'
import type {
  ExpertCapabilities, ExpertMcpCandidate, ExpertSkillCandidate
} from '../../shared/experts-api'
import type { SessionExpertCatalog, SessionExpertView } from '../../shared/session-api'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { getPiAgentDir, getSharedPiAgentDir } from '../shared/pi-paths'
import { readConfiguredMcpServers } from '../resources/mcp-config-reader'

/** 正文只在宿主侧进入系统提示，视图里不带正文与磁盘路径。 */
function toView(definition: ExpertDefinition): SessionExpertView {
  return {
    id: definition.id,
    displayName: definition.displayName,
    summary: definition.summary,
    source: definition.source,
    derivedFrom: definition.derivedFrom,
    truncated: definition.truncated,
    skillIds: definition.skillIds,
    unavailableSkillIds: definition.unavailableSkillIds,
    skillsMode: definition.skillsMode,
    skillAddIds: definition.skillAddIds,
    skillRemoveIds: definition.skillRemoveIds,
    mcpMode: definition.mcpMode,
    mcpServerIds: definition.mcpServerIds,
    mcpAddIds: definition.mcpAddIds,
    mcpRemoveIds: definition.mcpRemoveIds
  }
}

/**
 * 主会话可见技能与子代理专用技能：清单诊断与保存期校验共用同一份口径，
 * 否则会出现「清单说技能可用、保存却说不可用」的两套结论。
 */
export interface ExpertSkillContext {
  readonly availableSkillIds: readonly string[]
  readonly subAgentOnlySkillIds: readonly string[]
}

/** 从已读到的随包清单算技能上下文；调用方已经持有清单时用它，不重复读一次清单。 */
export function expertSkillContextOf(bundle: AgentResourceBundle): ExpertSkillContext {
  return {
    availableSkillIds: availableSkillIdsOf(bundle),
    subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
  }
}

/** 可用技能标识：随包在前，全局目录在后，同一标识只留一次（同名副本不重复计数）。 */
function availableSkillIdsOf(bundle: AgentResourceBundle): string[] {
  const ids = new Set(bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id))
  for (const directory of globalSkillDirectories({
    agentDir: getPiAgentDir(), sharedAgentDir: getSharedPiAgentDir()
  })) {
    for (const id of skillDirectoryIds(directory)) ids.add(id)
  }
  return [...ids]
}

/** 自取随包清单的技能上下文；保存校验只需要这一份数据时用它。 */
export function readExpertSkillContext(): ExpertSkillContext {
  return expertSkillContextOf(readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs'))))
}

/**
 * 读取当前可用专家与诊断；随包清单缺失或内容与指纹不一致时抛出，由调用方转成失败的响应，
 * 不在这里吞掉——清单损坏属于安装问题，静默给出空列表会让人以为专家被删了。
 */
export function readExpertCatalog(): SessionExpertCatalog {
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const skillContext = expertSkillContextOf(bundle)
  const catalog = loadExpertCatalog({
    builtin: builtinExperts(bundle),
    userDirectory: join(getPiAgentDir(), 'experts'),
    availableSkillIds: [...skillContext.availableSkillIds],
    subAgentOnlySkillIds: [...skillContext.subAgentOnlySkillIds],
    // 只拿全局配置的服务器作诊断口径；项目级服务器因项目而异，由会话装配按实际配置求交。
    availableMcpServers: readConfiguredMcpServers().map(server => server.name)
  })
  return {
    experts: catalog.experts.map(toView),
    issues: catalog.issues.map(issue => ({
      kind: issue.kind, expertId: issue.expertId, skillId: issue.skillId,
      serverName: issue.serverName, path: issue.path
    }))
  }
}

/**
 * 读取能力候选与当前默认基线：技能候选分随包、产品 agent 目录、共享目录三个来源，
 * 同名技能按这个顺序只列一次；MCP 只列全局配置，
 * 基线文件缺失或损坏时按「不限制」回退，并在 UI 上仍能保存成新值。
 */
export function readExpertCapabilities(): ExpertCapabilities {
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const agentSkillsDirectory = resolve(join(getPiAgentDir(), 'skills'))
  const seen = new Set<string>()
  const skills: ExpertSkillCandidate[] = []
  const pushSkill = (id: string, source: ExpertSkillCandidate['source']): void => {
    if (seen.has(id)) return
    seen.add(id)
    skills.push({ id, source })
  }
  for (const item of bundle.skills) {
    if (!item.subAgentOnly) pushSkill(item.id, 'builtin')
  }
  for (const directory of globalSkillDirectories({
    agentDir: getPiAgentDir(), sharedAgentDir: getSharedPiAgentDir()
  })) {
    const source = resolve(directory) === agentSkillsDirectory ? 'product' : 'shared'
    for (const id of skillDirectoryIds(directory)) pushSkill(id, source)
  }
  const mcpServers: ExpertMcpCandidate[] = readConfiguredMcpServers()
    .map(server => ({ name: server.name, scope: 'global' as const, enabled: server.enabled }))
  return { skills, mcpServers, defaults: readExpertCapabilityDefaults(getPiAgentDir()) }
}

/**
 * 快速模式下会被剔除的用户级技能：与宿主用的是同一份名单与同一层目录，
 * 因此设置页写出的就是实际发生的；目录里没有这些技能时返回空数组，页面据此说明「当前没有可剔除项」。
 * 项目技能不在设置页的当前项目上下文里，只统计全局目录。
 */
export function readFastModeExclusions(): string[] {
  return fastModeBlockedSkillsIn([
    ...globalSkillDirectories({ agentDir: getPiAgentDir(), sharedAgentDir: getSharedPiAgentDir() })
  ])
}
