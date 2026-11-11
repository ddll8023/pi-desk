/**
 * 主进程侧的专家清单读取：合并随包清单的内置专家与产品 agent 目录下的自定义专家，
 * 产出选择器可用的视图与加载诊断。
 *
 * 只读：不启动 SDK 宿主、不打开会话、不写任何文件；技能可见集取「随包非子代理专用技能 +
 * 共享目录技能」，缺失的技能引用只体现在诊断里，不让整份清单失败。
 */
import { join } from 'node:path'
import { agentResourcesDirectory, readAgentResourceBundle } from '../../shared-process/agent-resources'
import { builtinExperts, loadExpertCatalog, skillDirectoryIds } from '../../shared-process/expert-definitions'
import type { ExpertDefinition } from '../../shared-process/expert-definitions'
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
    skillIds: definition.skillIds,
    unavailableSkillIds: definition.unavailableSkillIds
  }
}

/**
 * 读取当前可用专家与诊断；随包清单缺失或内容与指纹不一致时抛出，由调用方转成失败的响应，
 * 不在这里吞掉——清单损坏属于安装问题，静默给出空列表会让人以为专家被删了。
 */
export function readExpertCatalog(): SessionExpertCatalog {
  const bundle = readAgentResourceBundle(agentResourcesDirectory(join(getSdkHostDirectory(), 'index.mjs')))
  const catalog = loadExpertCatalog({
    builtin: builtinExperts(bundle),
    userDirectory: join(getPiAgentDir(), 'experts'),
    availableSkillIds: [
      ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
      ...skillDirectoryIds(join(getSharedPiAgentDir(), 'skills'))
    ],
    subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
  })
  return {
    experts: catalog.experts.map(toView),
    issues: catalog.issues.map(issue => ({
      kind: issue.kind, expertId: issue.expertId, skillId: issue.skillId, path: issue.path
    }))
  }
}
