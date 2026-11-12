/**
 * 专家角色段：把一个选中的专家定义包成一段系统提示，与执行模式、产品工具提示并列注入。
 *
 * 只写身份、方法与输出规范，不增删工具、不改预算与权限——技能与 MCP 范围的收窄由装配层（`expert-capability`）完成，
 * 这里只把结果如实写成一句范围说明，避免模型把未加载的能力当成可用；专家也不派子代理。
 * 引用了不可用技能、或快速模式剔掉了它引用的规范时，在段尾说明，避免模型把没加载的技能当成已加载。
 */
import { join } from 'node:path'
import { readAgentResourceBundle } from '../shared-process/agent-resources'
import { builtinExperts, clipExpertBody, loadExpertCatalog, skillDirectoryIds } from '../shared-process/expert-definitions'
import { fastModeBlockedSkillsIn } from '../shared/execution-mode-skills'
import type { ExecutionMode } from '../shared/preferences-api'
import type { ExpertCapabilityScope, ExpertDefinition } from '../shared-process/expert-definitions'

/** 该分段在系统提示里的键；与会话内其他分段并列，按轮重写。 */
export const EXPERT_SECTION_KEY = 'expert-role'

/** 角色段可选的会话上下文：快速模式会剔除部分规范，被剔除的引用要在段尾说清楚。 */
export interface ExpertRoleOptions {
  readonly mode?: ExecutionMode
  /** 本次会话的能力范围；缺省或不限制时不写额外说明。 */
  readonly scope?: ExpertCapabilityScope
}

/** 角色段文本：专家正文按统一上限裁剪后进入，不摘缩也不改写定义文件；改定义文件即改变下一轮的角色。 */
export function expertRoleSection(definition: ExpertDefinition, options: ExpertRoleOptions = {}): string {
  const lines = [
    `当前会话使用的专家：${definition.displayName}`,
    `定位：${definition.summary}`,
    '',
    clipExpertBody(definition.body)
  ]
  if (definition.unavailableSkillIds.length > 0) {
    lines.push('', `以下技能本次未加载，不要当成可用能力：${definition.unavailableSkillIds.join('、')}。`)
  }
  // 快速模式在装配阶段就剔掉了这些 Skill，清单里仍标为可用，因此单独说明与不可用技能的区别。
  const excluded = options.mode === 'fast' ? fastModeBlockedSkillsIn(definition.skillIds) : []
  if (excluded.length > 0) {
    lines.push('', `快速模式未加载：${excluded.join('、')}；需要这些规范时改用标准模式新建会话。`)
  }
  // 收窄是装配层做的，模型看不到范围外的技能与服务器；不说清会反复尝试调用不存在的能力。
  const scopeNote = describeScope(options.scope)
  if (scopeNote !== null) lines.push('', scopeNote)
  return lines.join('\n')
}

/** 能力范围的一句话说明；两个维度都不限制时返回 null，不为普通会话多写一段。 */
function describeScope(scope: ExpertCapabilityScope | undefined): string | null {
  if (scope === undefined) return null
  const notes: string[] = []
  if (scope.skills !== null) {
    notes.push(scope.skills.length === 0
      ? '本会话没有加载任何技能'
      : `本会话只加载 ${scope.skills.length} 个技能，范围外的技能不可用`)
  }
  if (scope.mcpServers !== null) {
    notes.push(scope.mcpServers.length === 0
      ? '本会话停用了全部 MCP 服务器'
      : `本会话只连接 ${scope.mcpServers.length} 个 MCP 服务器，其余已停用`)
  }
  return notes.length === 0 ? null : `能力范围：${notes.join('；')}。`
}

/**
 * 按标识读取本次要用的专家定义；标识不存在时返回 null，由调用方决定跳过注入并留诊断。
 * 只在确实选了专家时才读清单：没有专家的会话不为它多算一遍资源指纹与哈希。
 */
export function readSelectedExpert(input: {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly sharedAgentDir: string
  readonly expertId: string
}): ExpertDefinition | null {
  const bundle = readAgentResourceBundle(input.resourcesDirectory)
  const catalog = loadExpertCatalog({
    builtin: builtinExperts(bundle),
    userDirectory: join(input.agentDir, 'experts'),
    availableSkillIds: [
      ...bundle.skills.filter(item => !item.subAgentOnly).map(item => item.id),
      ...skillDirectoryIds(join(input.sharedAgentDir, 'skills'))
    ],
    subAgentOnlySkillIds: bundle.skills.filter(item => item.subAgentOnly).map(item => item.id)
  })
  return catalog.experts.find(item => item.id === input.expertId) ?? null
}
