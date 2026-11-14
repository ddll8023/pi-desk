/**
 * 专家能力范围的会话侧计算：把专家定义与默认基线合成一份许可集，供资源装配、MCP 连接与工具裁剪使用。
 *
 * 只有召唤了专家才计算：没有专家的会话不读基线、不裁剪任何技能、服务器或工具，行为与引入基线之前完全一致。
 * 计算本身是纯函数（`resolveExpertCapabilityScope`），这里只负责补齐可用集与基线这两个输入。
 */
import { readAgentResourceBundle } from '../shared-process/agent-resources'
import { readExpertCapabilityDefaults } from '../shared-process/expert-capability-defaults'
import { resolveExpertCapabilityScope, skillDirectoryIds } from '../shared-process/expert-definitions'
import { globalSkillDirectories } from '../shared-process/skill-sources'
import { PROTECTED_EXPERT_TOOLS } from '../shared/expert-capability'
import type { ExpertCapabilityScope, ExpertDefinition } from '../shared-process/expert-definitions'

/** 不做任何限制：技能、MCP 服务器与工具都按会话原有的装配结果。 */
export const UNRESTRICTED_SCOPE: ExpertCapabilityScope = { skills: null, mcpServers: null, tools: null }

/**
 * 计算本次会话的许可集。
 *
 * `availableMcpServers` 由调用方按会话实际项目配置给出：专家引用别的项目才有的服务器时只会在设置页诊断，
 * 不会被当成可用能力。可用技能按「随包非子代理专用技能 + 全局技能目录（产品 agent 目录与共享目录）」算，
 * 与清单读取、设置页候选同一口径；项目技能属于工作区，不进许可集。
 * 可用工具取随包清单的工具声明：受保护工具始终在内，范围外的工具在装配期从激活集合移除。
 */
export function resolveSessionCapabilityScope(input: {
  readonly expert: ExpertDefinition | null
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly sharedAgentDir: string
  readonly availableMcpServers: readonly string[]
}): ExpertCapabilityScope {
  if (input.expert === null) return UNRESTRICTED_SCOPE
  const bundle = readAgentResourceBundle(input.resourcesDirectory)
  const availableSkillIds = [
    ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
    ...globalSkillDirectories({ agentDir: input.agentDir, sharedAgentDir: input.sharedAgentDir })
      .flatMap(directory => skillDirectoryIds(directory))
  ]
  // 受保护工具即使没在清单里（旧产物）也按可用处理：它们由扩展注册，排除会让会话断裂。
  const availableToolNames = [...new Set([...bundle.tools.map(item => item.name), ...PROTECTED_EXPERT_TOOLS])]
  return resolveExpertCapabilityScope({
    definition: input.expert,
    defaults: readExpertCapabilityDefaults(input.agentDir),
    availableSkillIds,
    availableMcpServers: input.availableMcpServers,
    availableToolNames
  })
}
