/**
 * 专家角色段：把一个选中的专家定义包成一段系统提示，与执行模式、产品工具提示并列注入。
 *
 * 只写身份、方法与输出规范，不承诺工具集、预算或权限面的变化——专家不增删工具、不派子代理。
 * 引用了不可用技能、或快速模式剔掉了它引用的规范时，在段尾如实说明，避免模型把没加载的技能当成已加载。
 */
import { join } from 'node:path'
import { readAgentResourceBundle } from '../shared-process/agent-resources'
import { builtinExperts, clipExpertBody, loadExpertCatalog, skillDirectoryIds } from '../shared-process/expert-definitions'
import { fastModeBlockedSkillsIn } from '../shared/execution-mode-skills'
import type { ExecutionMode } from '../shared/preferences-api'
import type { ExpertDefinition } from '../shared-process/expert-definitions'

/** 该分段在系统提示里的键；与会话内其他分段并列，按轮重写。 */
export const EXPERT_SECTION_KEY = 'expert-role'

/** 角色段可选的会话上下文：快速模式会剔除部分规范，被剔除的引用要在段尾说清楚。 */
export interface ExpertRoleOptions {
  readonly mode?: ExecutionMode
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
  return lines.join('\n')
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
