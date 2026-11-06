/**
 * Skill 动态选择登记：只校验宿主候选、执行角色与显式调用资格，不内置技能名称或业务匹配规则。
 * 适用性由当前主模型根据技能描述和任务事实判断；登记不代表正文已经加载。
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'

/** 在本模块实际求值时记录源码版本，不用后续磁盘版本冒充内存版本。 */
export const ROUTING_IMPLEMENTATION = Object.freeze({ url: import.meta.url,
  sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') })

export interface Requirement {
  name: string
  reason: string
  origin: 'task' | 'explicit' | 'target'
}

export interface SkillChoice {
  name: string
  reason: string
}

export interface ReferenceChoice {
  skill: string
  path: string
  reason: string
}

export interface SelectionRequest {
  skills: SkillChoice[]
  subjects: SkillChoice[]
  references: ReferenceChoice[]
  reason: string
}

export interface SelectionDecision {
  required: Requirement[]
  subjects: string[]
  reason: string
}

export interface FileTarget {
  path: string
}

/** 将工具路径和技能目录路径归一；新文件不存在时保留绝对路径。 */
export function canonicalPath(path: string, cwd: string): string {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path
  const absolute = resolve(cwd, expanded)
  try { return realpathSync(absolute) } catch { return absolute }
}

/** 只识别用户显式调用的协议外壳，不猜测自然语言中的技能意图。 */
export function explicitSkillName(prompt: string): string | undefined {
  return prompt.match(/^\/skill:([^\s/]+)(?:\s|$)/)?.[1]
    ?? prompt.match(/^<skill name="([^"<>]+)" location="[^"]+">\n/)?.[1]
}

/** 选择理由用于本轮解释，不把空白字符串当作已完成适用性判断。 */
export function selectionReason(value: string, label: string): string {
  const reason = value.trim()
  if (!reason) throw new Error(`${label}不能为空`)
  return reason
}

/** 只允许从当前宿主候选中登记；审查对象与执行规范必须由模型明确区分。 */
export function validateSelection(request: SelectionRequest, skills: readonly Skill[],
  explicit: string | undefined, explicitLoads: ReadonlySet<string>): SelectionDecision {
  const reason = selectionReason(request.reason, '本轮选择理由')
  const available = new Map(skills.map(skill => [skill.name, skill]))
  const required: Requirement[] = []
  const executionNames = new Set<string>()
  for (const choice of request.skills) {
    const skill = available.get(choice.name)
    if (!skill) throw new Error(`执行技能未被当前宿主发现：${choice.name}`)
    if (executionNames.has(skill.name)) throw new Error(`执行技能重复登记：${skill.name}`)
    if (skill.disableModelInvocation && skill.name !== explicit && !explicitLoads.has(skill.name)) {
      throw new Error(`该技能禁止自动调用，须由用户显式加载：${skill.name}`)
    }
    executionNames.add(skill.name)
    required.push({ name: skill.name, reason: selectionReason(choice.reason, `${skill.name} 的选择理由`),
      origin: skill.name === explicit || explicitLoads.has(skill.name) ? 'explicit' : 'task' })
  }
  // 当前用户显式加载的技能不能通过提交空选择或改成审查对象而被静默排除。
  if (explicit && !executionNames.has(explicit)) {
    if (!available.has(explicit)) throw new Error(`用户显式加载的技能未被当前宿主发现：${explicit}`)
    executionNames.add(explicit)
    required.push({ name: explicit, reason: '用户显式加载该技能', origin: 'explicit' })
  }
  const subjects: string[] = []
  for (const choice of request.subjects) {
    if (!available.has(choice.name)) throw new Error(`审查对象未被当前宿主发现：${choice.name}`)
    selectionReason(choice.reason, `${choice.name} 的审查对象说明`)
    if (executionNames.has(choice.name)) throw new Error(`同一技能不能同时登记为执行规范和仅审查对象：${choice.name}`)
    if (subjects.includes(choice.name)) throw new Error(`审查对象重复登记：${choice.name}`)
    subjects.push(choice.name)
  }
  return { required, subjects, reason }
}

/** 仅为文件修改审计提取结构化路径，不据此推断技术栈或要求任何技能。 */
export function extractFileTargets(input: Record<string, unknown>): FileTarget[] {
  const result: FileTarget[] = []
  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value) || depth > 4) return
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:path|filePath|file_path|filename|source|destination|target)$/.test(key) && typeof item === 'string' && item.length > 0 && !/^\w+:\/\//.test(item)) {
        result.push({ path: item })
      } else if (/^(?:args|arguments|parameters|edits|files|paths)$/.test(key)) {
        if (Array.isArray(item)) for (const child of item) {
          if (typeof child === 'string' && (key === 'paths' || key === 'files')) result.push({ path: child })
          else visit(child, depth + 1)
        }
        else visit(item, depth + 1)
      }
    }
  }
  visit(input, 0)
  return result.filter((target, index) => result.findIndex(other => other.path === target.path) === index)
}

/**
 * 扩展名到技术栈族的归并只用于判断沿用的登记是否仍适配当前改动目标；
 * 不映射到具体技能名，不代替模型判断适用规范。配置与文档类格式不参与比较。
 */
const STACK_FAMILIES: Readonly<Record<string, string>> = Object.freeze({
  '.js': 'web', '.jsx': 'web', '.mjs': 'web', '.cjs': 'web', '.ts': 'web', '.tsx': 'web', '.mts': 'web', '.cts': 'web',
  '.vue': 'web', '.svelte': 'web', '.astro': 'web', '.css': 'web', '.scss': 'web', '.sass': 'web', '.less': 'web', '.html': 'web',
  '.py': 'python', '.pyi': 'python', '.java': 'java', '.kt': 'jvm', '.kts': 'jvm', '.scala': 'jvm', '.groovy': 'jvm',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.cs': 'dotnet', '.fs': 'dotnet', '.vb': 'dotnet',
  '.swift': 'swift', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.m': 'objc', '.mm': 'objc',
  '.sql': 'sql', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'shell', '.cmd': 'shell', '.bat': 'shell'
})

/** 无扩展名、文档、配置与锁文件视为栈中性，返回空数组以免误撤销沿用的登记。 */
export function stackFamilies(paths: readonly string[]): string[] {
  const families = new Set<string>()
  for (const path of paths) {
    const match = /(\.[^./\\]+)$/.exec(path)
    const family = match ? STACK_FAMILIES[match[1].toLowerCase()] : undefined
    if (family) families.add(family)
  }
  return [...families]
}

/** 为不可信的 JSON 与工具参数做窄化，不调用其中的任何内容。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
