/**
 * 通用必读引用登记：由模型依据已加载技能正文列出引用，只校验归属和路径边界。
 * 不内置技能名称、引用文件名或自然语言条件，不把路径登记当作全文加载证据。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { canonicalPath, selectionReason } from './routing.ts'
import type { ReferenceChoice, Requirement } from './routing.ts'

/** 加载指纹只标识本模块，不作为正文已读证明。 */
export const REFERENCES_IMPLEMENTATION = Object.freeze({ url: import.meta.url,
  sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') })

export interface ReferenceRequirement extends Requirement {
  path: string
  skillName: string
}

/** 实际路径必须位于所属技能内；符号链接指向目录外时同样拒绝。 */
function localReference(path: string, skill: Skill, cwd: string): string | undefined {
  const base = canonicalPath(skill.baseDir, cwd)
  const local = relative(base, path)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
  return local.split(sep).join('/')
}

/** 只登记已选执行技能的引用；缺失文件由加载证据核对报告，不因此跳过。 */
export function registeredReferences(choices: readonly ReferenceChoice[], required: readonly Requirement[],
  skills: readonly Skill[], cwd: string): ReferenceRequirement[] {
  const selected = new Set(required.map(item => item.name))
  const entries = new Set(skills.map(skill => canonicalPath(skill.filePath, cwd)))
  const result = new Map<string, ReferenceRequirement>()
  for (const choice of choices) {
    const skill = skills.find(item => item.name === choice.skill)
    if (!skill || !selected.has(skill.name)) throw new Error(`引用必须属于本轮已登记的执行技能：${choice.skill}`)
    const input = selectionReason(choice.path, '引用路径')
    const path = canonicalPath(input, canonicalPath(skill.baseDir, cwd))
    const local = localReference(path, skill, cwd)
    if (!local) throw new Error(`引用路径超出所属技能目录：${choice.skill} / ${input}`)
    if (entries.has(path)) throw new Error(`Skill 入口应登记为执行技能，不应登记为引用：${input}`)
    const reason = selectionReason(choice.reason, `${choice.skill} 引用的必读理由`)
    const previous = result.get(path)
    if (previous && previous.skillName !== skill.name) throw new Error(`同一引用不能登记给不同技能：${input}`)
    result.set(path, { name: `${skill.name}/${local}`, skillName: skill.name, path, reason, origin: 'target' })
  }
  return [...result.values()]
}

/** 从真实 read 路径建立证据候选，不扫描技能目录，也不限于某个固定子目录或文件名。 */
export function referenceCandidates(paths: readonly string[], skills: readonly Skill[], cwd: string): ReferenceRequirement[] {
  const result = new Map<string, ReferenceRequirement>()
  const entries = new Set(skills.map(skill => canonicalPath(skill.filePath, cwd)))
  // 嵌套技能优先认领自己的文件；显式登记的归属仍由调用方合并时优先采用。
  const owners = skills.map(skill => ({ skill, base: canonicalPath(skill.baseDir, cwd) }))
    .sort((left, right) => right.base.length - left.base.length)
  for (const input of paths) {
    const path = canonicalPath(input, cwd)
    if (entries.has(path)) continue
    for (const { skill } of owners) {
      const local = localReference(path, skill, cwd)
      if (!local) continue
      result.set(path, { name: `${skill.name}/${local}`, skillName: skill.name,
        path, reason: '有效上下文中实际读取过的技能资源候选', origin: 'target' })
      break
    }
  }
  return [...result.values()]
}
