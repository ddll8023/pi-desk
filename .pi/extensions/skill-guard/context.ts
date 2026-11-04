/**
 * Skill 加载证据：只认生成工具调用之前的有效模型上下文，不认旧布尔标志或自我声明。
 * 工具完成与选择登记均不补造证据；同批并行读取必须等到下一次模型请求才能形成放行证据。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { ContextWithSystemEvent, Skill } from '@earendil-works/pi-coding-agent'
import { canonicalPath, isRecord } from './routing.ts'
import type { Requirement } from './routing.ts'
import { referenceCandidates } from './references.ts'
import type { ReferenceRequirement } from './references.ts'

/** 指纹在模块求值时固定，后续文件更新不会改写这一加载记录。 */
export const CONTEXT_IMPLEMENTATION = Object.freeze({ url: import.meta.url,
  sha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') })

type Messages = ContextWithSystemEvent['messages']
export type LoadSource = 'model-read' | 'explicit' | 'host-injected'

export interface SkillDocument {
  name: string
  path: string
  baseDir: string
  raw: string
  body: string
  sha256: string
}

export interface LoadEvidence {
  name: string
  path: string
  sha256: string
  source: LoadSource
  /** 仅包含证据来源标识，不保存用户代码或工具输出副本。 */
  via: string[]
  kind?: 'skill' | 'reference'
}

export interface MissingSkill extends Requirement {
  path?: string
  error?: string
}

interface ReadContribution {
  name: string
  id: string
  output: string
  offset: number
  direct: boolean
}

/** 保留正文内容，统一换行与BOM，避免平台换行差异造成错误的版本比较。 */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/** 计算内容版本；摘要只用于比对，不作为正文加载证明。 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 只读取当前需要的已发现技能，不根据目录名另行搜集技能。 */
export function readSkillDocument(skill: Skill, cwd: string): SkillDocument {
  const path = canonicalPath(skill.filePath, cwd)
  if (!statSync(path).isFile()) throw new Error('Skill入口不是普通文件')
  const raw = normalize(readFileSync(path, 'utf8'))
  const body = stripFrontmatter(raw).trim()
  if (!body) throw new Error('Skill正文为空')
  return { name: skill.name, path, baseDir: skill.baseDir, raw, body, sha256: fingerprint(raw) }
}

/** 引用按完整原文核对；不把文件路径或摘要当作阅读证据。 */
function readReferenceDocument(reference: ReferenceRequirement): SkillDocument {
  if (!statSync(reference.path).isFile()) throw new Error('必读引用不是普通文件')
  const raw = normalize(readFileSync(reference.path, 'utf8'))
  if (!raw.trim()) throw new Error('必读引用正文为空')
  return { name: reference.name, path: reference.path, baseDir: '', raw, body: raw.trim(), sha256: fingerprint(raw) }
}

/** 从消息内容中取纯文本；不把thinking、图片或任意对象序列化成加载证据。 */
export function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(item => isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map(item => (item as { text: string }).text).join('\n')
}

/** 属性转义只用于宿主生成的边界标签，不更改技能正文。 */
function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 注入正文时携带真实位置与版本，明确相对引用的解析基准。 */
export function renderSkillDocument(document: SkillDocument): string {
  return `<loaded_skill name="${attribute(document.name)}" path="${attribute(document.path)}" sha256="${document.sha256}">\nReferences are relative to ${document.baseDir}.\n\n${document.body}\n</loaded_skill>`
}

/** 重放system section补丁；已经被移除或替换的旧技能段落不能继续作为证据。 */
function effectiveSystemText(messages: Messages): string {
  const additions: string[] = []
  const sections = new Map<string, string>()
  for (const message of messages) if (message.role === 'system') {
    const content = textContent(message.content)
    if (content) additions.push(content)
    for (const [key, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(key)
      else sections.set(key, value)
    }
  }
  return [...additions, ...sections.values()].join('\n\n')
}

/** 只接受Pi显式技能块；普通用户摘要、助手声称已读、技能目录均不构成证据。 */
function explicitBlock(text: string): { name: string; path: string; body: string } | undefined {
  const match = text.match(/^<skill name="([^"<>]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n[\s\S]*)?$/)
  if (!match) return undefined
  return { name: match[1], path: match[2], body: match[3].replace(/^References are relative to [^\n]+\.\n\n/, '').trim() }
}

/** 将顶层或有记录的嵌套read与实际返回给模型的文本关联，不使用隐藏的嵌套结果。 */
function readContributions(messages: Messages, documents: readonly { name: string; path: string }[], cwd: string): ReadContribution[] {
  const paths = new Map(documents.map(document => [canonicalPath(document.path, cwd), document.name]))
  const calls = new Map<string, Record<string, unknown>>()
  const result: ReadContribution[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'toolCall' && part.name === 'read' && isRecord(part.arguments)) calls.set(part.id, part.arguments)
      continue
    }
    if (message.role !== 'toolResult' || message.isError !== false) continue
    const output = normalize(textContent(message.content))
    const add = (id: string, args: Record<string, unknown>, direct: boolean): void => {
      if (typeof args.path !== 'string') return
      const name = paths.get(canonicalPath(args.path, cwd))
      if (!name) return
      const offset = typeof args.offset === 'number' && Number.isInteger(args.offset) && args.offset >= 1 ? args.offset - 1 : 0
      result.push({ name, id, output, offset, direct })
    }
    const args = calls.get(message.toolCallId)
    if (message.toolName === 'read' && args) add(message.toolCallId, args, true)
    for (const nested of message.nestedCalls?.calls ?? []) {
      if (nested.name === 'read' && nested.status === 'ok' && isRecord(nested.arguments)) add(nested.id, nested.arguments, false)
    }
  }
  return result
}

/** 仅移除read工具的固定续读提示，截断或其他内容改写仍需逐行证明覆盖范围。 */
function readPayload(output: string): string {
  return output.replace(/\n\n\[(?:\d+ more lines in file\. Use offset=\d+ to continue\.|Showing lines \d+-\d+ of \d+(?: \([^\n]*\))?\. Use offset=\d+ to continue\.)\]$/, '')
}

/** 分段read需在当前上下文中合并覆盖全部正文；单次部分读取不能放行。 */
function completeRead(document: SkillDocument, reads: readonly ReadContribution[]): string[] | undefined {
  const lines = document.raw.split('\n')
  const startIndex = document.raw.indexOf(document.body)
  if (startIndex < 0) return undefined
  const firstBodyLine = document.raw.slice(0, startIndex).split('\n').length - 1
  const lastBodyLine = firstBodyLine + document.body.split('\n').length - 1
  const covered = new Set<number>()
  const used: string[] = []
  for (const read of reads) {
    if (read.output.includes(document.body)) return [read.id]
    // 嵌套read只有完整正文被外层工具实际转交时才算加载，不能只凭nestedCalls状态放行。
    if (!read.direct) continue
    const payload = readPayload(read.output)
    if (!payload) continue
    const remaining = lines.slice(read.offset).join('\n')
    if (payload !== remaining && !remaining.startsWith(`${payload}\n`)) continue
    const count = payload.split('\n').length
    for (let line = read.offset; line < Math.min(lines.length, read.offset + count); line++) covered.add(line)
    used.push(read.id)
  }
  for (let line = firstBodyLine; line <= lastBodyLine; line++) if (!covered.has(line)) return undefined
  return used.length ? used : undefined
}

/**
 * 每次模型请求都重建证据。只读取必需项、当前注入项、显式项和实际read过的候选正文；
 * 不因历史日志写着loaded就恢复放行，也不无条件加载全部Skill。
 */
export class SkillContext {
  generation = 0
  loaded = new Map<string, LoadEvidence>()

  /** 清除分支切换、压缩或新运行之前的请求快照，等待下一次context事件重建。 */
  reset(): void {
    this.loaded.clear()
  }

  /** 观察完整有效上下文；不改写其他扩展的消息、系统提示或工具声明。 */
  observe(messages: Messages, skills: readonly Skill[], required: readonly Requirement[], cwd: string,
    references: readonly ReferenceRequirement[] = []): Map<string, LoadEvidence> {
    this.generation++
    const system = effectiveSystemText(messages)
    const explicit = messages.flatMap(message => {
      if (message.role !== 'user') return []
      const block = explicitBlock(normalize(textContent(message.content)))
      return block ? [block] : []
    })
    const readPaths: string[] = []
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const part of message.content) if (part.type === 'toolCall' && part.name === 'read'
          && isRecord(part.arguments) && typeof part.arguments.path === 'string') readPaths.push(part.arguments.path)
      } else if (message.role === 'toolResult') {
        for (const nested of message.nestedCalls?.calls ?? []) if (nested.name === 'read' && nested.status === 'ok'
          && isRecord(nested.arguments) && typeof nested.arguments.path === 'string') readPaths.push(nested.arguments.path)
      }
    }
    // 候选来自本次模型请求的真实消息；工具调用阶段不追加新结果，仍阻断同批读写。
    const candidatesByPath = new Map([...referenceCandidates(readPaths, skills, cwd), ...references].map(item => [item.path, item]))
    const observedReferences = [...candidatesByPath.values()]
    const reads = readContributions(messages, [
      ...skills.map(skill => ({ name: skill.name, path: skill.filePath })), ...observedReferences
    ], cwd)
    const candidates = new Set([...required.map(item => item.name), ...explicit.map(item => item.name), ...reads.map(item => item.name)])
    for (const match of system.matchAll(/<loaded_skill name="([^"<>]+)" path="[^"]*" sha256="[a-f0-9]+">/g)) candidates.add(match[1])
    const loaded = new Map<string, LoadEvidence>()
    for (const name of candidates) {
      const skill = skills.find(candidate => candidate.name === name)
      if (!skill) continue
      let document: SkillDocument
      try { document = readSkillDocument(skill, cwd) } catch { continue }
      const evidence = (source: LoadSource, via: string[]): void => {
        loaded.set(name, { name, path: document.path, sha256: document.sha256, source, via })
      }
      if (explicit.some(block => block.name === name && canonicalPath(block.path, cwd) === document.path && block.body === document.body)) {
        evidence('explicit', ['user-skill-block'])
      } else {
        const via = completeRead(document, reads.filter(read => read.name === name))
        if (via) evidence('model-read', via)
        else if (system.includes(renderSkillDocument(document))) evidence('host-injected', ['system:skill_guard'])
      }
    }
    for (const reference of observedReferences) {
      try {
        const document = readReferenceDocument(reference)
        const via = completeRead(document, reads.filter(read => read.name === reference.name))
        if (via) loaded.set(reference.name, { name: reference.name, path: document.path, sha256: document.sha256,
          source: 'model-read', via, kind: 'reference' })
      } catch { /* 缺失或不可读的引用由missingReferences明确阻断。 */ }
    }
    this.loaded = loaded
    return loaded
  }

  /** 登记只接受当前已有的完整入口证据，不能通过提交名称或内容摘要冒充加载。 */
  selectionEvidence(required: readonly Requirement[], skills: readonly Skill[], cwd: string): LoadEvidence[] {
    const missing = this.missing(required, skills, cwd)
    if (missing.length) {
      throw new Error(`登记前须完整加载执行技能入口：\n${missing.map(item => `${item.name}${item.path ? `：${item.path}` : ''}（${item.error ?? '当前版本正文尚未完整进入有效模型上下文'}）`).join('\n')}`)
    }
    return required.map(item => {
      const evidence = this.loaded.get(item.name)
      if (!evidence) throw new Error(`执行技能缺少当前加载证据：${item.name}`)
      return { ...evidence, via: [...evidence.via] }
    })
  }

  /** 已选技能的路径、版本或候选身份变化时，旧引用选择不能自动沿用。 */
  changedSelection(selected: readonly LoadEvidence[], skills: readonly Skill[], cwd: string): MissingSkill[] {
    const changed: MissingSkill[] = []
    for (const evidence of selected) {
      const requirement: Requirement = { name: evidence.name, reason: '登记后技能发生变化，须重新判断技能与必读引用', origin: 'task' }
      const skill = skills.find(candidate => candidate.name === evidence.name)
      if (!skill) {
        changed.push({ ...requirement, error: '已登记技能不再属于当前宿主候选' })
        continue
      }
      try {
        const document = readSkillDocument(skill, cwd)
        if (document.path !== evidence.path || document.sha256 !== evidence.sha256) {
          changed.push({ ...requirement, path: document.path, error: '技能路径或内容版本已变化' })
        }
      } catch (error) {
        changed.push({ ...requirement, path: skill.filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return changed
  }

  /** 必读引用来自模型登记；这里仅核对当前版本全文，不推断条件是否齐全。 */
  missingReferences(references: readonly ReferenceRequirement[]): MissingSkill[] {
    const missing: MissingSkill[] = []
    for (const reference of references) {
      try {
        const document = readReferenceDocument(reference)
        const evidence = this.loaded.get(reference.name)
        if (!evidence || evidence.path !== document.path || evidence.sha256 !== document.sha256) {
          missing.push({ ...reference, error: '必读引用尚未以当前版本完整进入有效模型上下文' })
        }
      } catch (error) { missing.push({ ...reference, error: error instanceof Error ? error.message : String(error) }) }
    }
    return missing
  }

  /** 修改前重新核对磁盘版本；读取事件完成但尚未进入模型请求时，此处仍判缺失。 */
  missing(required: readonly Requirement[], skills: readonly Skill[], cwd: string): MissingSkill[] {
    const missing: MissingSkill[] = []
    for (const requirement of required) {
      const skill = skills.find(candidate => candidate.name === requirement.name)
      if (!skill) { missing.push({ ...requirement, error: '该技能不在当前Pi已发现的候选中' }); continue }
      try {
        const document = readSkillDocument(skill, cwd)
        const evidence = this.loaded.get(requirement.name)
        if (!evidence || evidence.path !== document.path || evidence.sha256 !== document.sha256) missing.push({ ...requirement, path: document.path })
      } catch (error) {
        missing.push({ ...requirement, path: skill.filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return missing
  }
}
