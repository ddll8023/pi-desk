/**
 * 快速模式剔除的用户级规范 Skill：名单与求交函数放在跨进程共享处。
 *
 * 宿主据此过滤实际加载的 Skill，设置页据此解释「快速模式少加载了什么」，两处读同一份名单，
 * 不在文案里再手写一遍技能名。只作用于用户级 Skill：随包产品 Skill 是必要能力，剔除会让装配校验失败。
 */

/** 快速模式不加载的用户级规范 Skill 标识。 */
export const FAST_MODE_BLOCKED_SKILLS: readonly string[] = [
  'design-protocol',
  'code-doc-sync',
  'architecture-redesign'
]

/**
 * 从给定的技能标识里挑出快速模式会剔除的那些。
 * 顺序跟随入参，重复标识只保留一次；入参通常是用户级目录里实际存在的技能，因此结果可以是空数组。
 */
export function fastModeBlockedSkillsIn(skillIds: readonly string[]): string[] {
  const blocked = new Set(FAST_MODE_BLOCKED_SKILLS)
  const found = new Set<string>()
  for (const skillId of skillIds) {
    if (blocked.has(skillId)) found.add(skillId)
  }
  return [...found]
}
