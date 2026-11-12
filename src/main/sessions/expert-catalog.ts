/**
 * 专家清单与设置页辅助读取：合并随包清单的内置专家与产品 agent 目录下的自定义专家，
 * 产出选择器可用的视图与加载诊断，并回答「快速模式会剔除哪些用户级技能」。
 *
 * 只读：不启动 SDK 宿主、不打开会话、不写任何文件；技能可见集取「随包非子代理专用技能 +
 * 共享目录技能」，缺失的技能引用只体现在诊断里，不让整份清单失败。
 */
import { join } from 'node:path'
import { agentResourcesDirectory, readAgentResourceBundle } from '../../shared-process/agent-resources'
import type { AgentResourceBundle } from '../../shared-process/agent-resources'
import { builtinExperts, loadExpertCatalog, skillDirectoryIds } from '../../shared-process/expert-definitions'
import type { ExpertDefinition } from '../../shared-process/expert-definitions'
import { fastModeBlockedSkillsIn } from '../../shared/execution-mode-skills'
import type { SessionExpertCatalog, SessionExpertView } from '../../shared/session-api'
import { getSdkHostDirectory } from '../shared/pi-cli-process'
import { getPiAgentDir, getSharedPiAgentDir } from '../shared/pi-paths'

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
    unavailableSkillIds: definition.unavailableSkillIds
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
    availableSkillIds: [
      ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
      ...skillDirectoryIds(join(getSharedPiAgentDir(), 'skills'))
    ],
    subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
  }
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
    subAgentOnlySkillIds: [...skillContext.subAgentOnlySkillIds]
  })
  return {
    experts: catalog.experts.map(toView),
    issues: catalog.issues.map(issue => ({
      kind: issue.kind, expertId: issue.expertId, skillId: issue.skillId, path: issue.path
    }))
  }
}

/**
 * 快速模式下会被剔除的用户级技能：与宿主用的是同一份名单与同一层目录，
 * 因此设置页写出来的就是实际发生的；目录里没有这些技能时返回空数组，页面据此说明「当前没有可剔除项」。
 */
export function readFastModeExclusions(): string[] {
  return fastModeBlockedSkillsIn([
    ...skillDirectoryIds(join(getPiAgentDir(), 'skills')),
    ...skillDirectoryIds(join(getSharedPiAgentDir(), 'skills'))
  ])
}
