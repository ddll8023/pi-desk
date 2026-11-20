/**
 * 专家能力范围的会话侧计算：把专家定义与默认基线合成一份许可集，供资源装配、MCP 连接与工具裁剪使用。
 *
 * 只有召唤了专家才计算：没有专家的会话不读基线、不裁剪任何技能、服务器或工具，行为与引入基线之前完全一致。
 * 计算本身是纯函数（`resolveExpertCapabilityScope`），这里只负责补齐可用集与基线这两个输入。
 *
 * 同一份可用集口径还产出「能力候选段」：专家草案卡片要模型给出建议名单，而模型自己可见的技能已按
 * 许可集裁剪，因此候选全集必须单独注入，不能让它把「我看不到」当成「不存在」。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentResourcePath, readAgentResourceBundle } from '../shared-process/agent-resources'
import { readExpertCapabilityDefaults } from '../shared-process/expert-capability-defaults'
import {
  parseExpertDocument, resolveExpertCapabilityScope, skillDirectoryIds
} from '../shared-process/expert-definitions'
import { globalSkillDirectories } from '../shared-process/skill-sources'
import { PROTECTED_EXPERT_TOOLS } from '../shared/expert-capability'
import type { AgentResourceBundle } from '../shared-process/agent-resources'
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

/**
 * 可被专家工具范围裁剪的工具名：只有随包清单声明过的工具。
 *
 * 内建控制工具（如 `ask_user_question`）与扩展注册的工具不在清单里，专家范围既表达不了、
 * 界面上也勾不到，装配时一律保留；把清单外的工具一起裁掉会让模型失去澄清与 MCP 管理能力。
 */
export function expertManageableToolNames(resourcesDirectory: string): ReadonlySet<string> {
  return new Set(readAgentResourceBundle(resourcesDirectory).tools.map(item => item.name))
}

/** 候选段只做提示，单个技能描述截断后拼接；文件上限防止意外读入大文件。 */
const MAX_SKILL_BYTES = 262_144
const MAX_SKILL_DESCRIPTION = 80

/** 技能与文件路径只用于提示文本；描述读不到时保留标识，不抛错阻断会话创建。 */
function readSkillDescription(path: string): string {
  try {
    if (statSync(path).size > MAX_SKILL_BYTES) return ''
    const description = parseExpertDocument(readFileSync(path, 'utf8'))?.fields.description ?? ''
    // 折叠或块标量（`>`、`|`）不展开：拿不到自然语言描述时只报标识，避免把语法符号当说明。
    if (description === '' || description === '>' || description === '|') return ''
    const text = description.replace(/\s+/g, ' ').trim()
    return text.length > MAX_SKILL_DESCRIPTION ? `${text.slice(0, MAX_SKILL_DESCRIPTION)}…` : text
  } catch {
    return ''
  }
}

/** 候选技能与许可集同一口径：随包非子代理技能在前，全局技能目录按目录名补齐并不重名。 */
function readSkillCandidates(input: {
  readonly agentDir: string
  readonly sharedAgentDir: string
}, bundle: AgentResourceBundle): { id: string; description: string }[] {
  const candidates: { id: string; description: string }[] = []
  const seen = new Set<string>()
  const push = (id: string, description: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    candidates.push({ id, description })
  }
  for (const item of bundle.skills) {
    if (item.subAgentOnly) continue
    push(item.id, readSkillDescription(agentResourcePath(bundle.root, item.entry)))
  }
  for (const directory of globalSkillDirectories(input)) {
    for (const id of skillDirectoryIds(directory)) {
      push(id, readSkillDescription(join(directory, id, 'SKILL.md')))
    }
  }
  return candidates
}

/**
 * 拼出随 `present_card` 注册的能力候选段：技能带一句描述，MCP 与工具只给名字。
 * 候选与设置页、许可集同源（随包 + 产品 agent 目录 + 共享目录）；项目技能不在候选里，
 * 因为专家是全局定义，写不出「当前项目才有的技能」。
 */
export function readCapabilityCandidateSection(input: {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly sharedAgentDir: string
  readonly mcpServerNames: readonly string[]
}): string {
  const bundle = readAgentResourceBundle(input.resourcesDirectory)
  const skills = readSkillCandidates(input, bundle)
  return [
    '能力候选（卡片上的勾选格与这份清单同源；其中包含你当前不可见的技能，不要只按自己可见的技能挑）：',
    `技能（${skills.length}）：`,
    ...skills.map(item => (item.description === '' ? `- ${item.id}` : `- ${item.id}：${item.description}`)),
    `MCP 服务器（${input.mcpServerNames.length}）：${input.mcpServerNames.length === 0
      ? '无'
      : input.mcpServerNames.join('、')}`,
    `工具（${bundle.tools.length}，带 * 的为必需）：${bundle.tools
      .map(item => (item.required ? `*${item.name}` : item.name)).join('、')}`
  ].join('\n')
}
