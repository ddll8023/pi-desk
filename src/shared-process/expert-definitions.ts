/**
 * 专家定义的解析、双来源合并与结构化诊断。
 *
 * 只读取随包清单给出的内置专家定义，以及产品 agent 目录下的自定义专家，合并成一份可召唤清单；
 * 单个定义损坏、身份冲突或引用了不可用技能时只影响对应条目，不中断整份清单。
 * 本模块不装配会话、不注入系统提示，也不产生任何子代理调用；清单条目到内置入口的映射、技能目录标识列举，以及写回所需的声明解析、标识校验与上限常量都由这里提供，主进程不复制第二份规则。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { agentResourcePath } from './agent-resources.ts'
import type { AgentResourceBundle } from './agent-resources.ts'

/** 单个定义文件的读取上限：正文会整段进入系统提示，超过这个体积通常意味着塞了整份文档。 */
const MAX_DEFINITION_BYTES = 262_144
/** 专家标识与目录名同形：小写字母开头，只含小写字母、数字与连字符。 */
const EXPERT_ID = /^[a-z][a-z0-9-]*$/
/**
 * 技能标识独立放宽：技能取自技能目录，允许下划线与大写；沿用专家 id 规则会把合法技能误判为写法非法，
 * 连带使整个专家定义失效。
 */
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
/** 自定义专家目录内的固定定义文件名。 */
const DEFINITION_FILE = 'expert.md'
/**
 * 正文进入系统提示的字符上限：角色定义每轮占用上下文，超过这个量级通常意味着把整份文档塞了进来。
 * 超限只截断不报诊断——规则收紧不能让已经在用的定义突然失效。
 */
const MAX_ROLE_CHARS = 4_000
/** 截断时补在正文末尾的说明：让模型知道定义被截过，也让用户明白后半段为何没有生效。 */
const TRUNCATION_NOTE = '\n\n（角色定义过长，已截断。）'

/**
 * 按上限裁剪正文。主进程视图与宿主角色段共用同一口径，避免两处长度判断漂移；
 * 定义文件本身不被改写，完整正文仍在磁盘上。
 */
export function clipExpertBody(body: string): string {
  return body.length <= MAX_ROLE_CHARS ? body : `${body.slice(0, MAX_ROLE_CHARS).trimEnd()}${TRUNCATION_NOTE}`
}

/** 一份可召唤的专家定义。 */
export interface ExpertDefinition {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  /** 声明引用的技能标识；不可用的引用仍保留在这里，另在 `unavailableSkillIds` 标出。 */
  readonly skillIds: readonly string[]
  /** 去掉声明段之后的正文：召唤时作为角色段进入系统提示。 */
  readonly body: string
  /** 正文是否超过注入上限；超限时正文仍完整保存在磁盘，只是进入系统提示时被截断。 */
  readonly truncated: boolean
  readonly source: 'builtin' | 'user'
  readonly filePath: string
  /** 派生副本的来源内置标识；手写自定义专家为 null。只用于追溯与展示，不参与加载判定。 */
  readonly derivedFrom: string | null
  /** 引用但不可用的技能：定义本身仍可用，这些引用不生效。 */
  readonly unavailableSkillIds: readonly string[]
}

export type ExpertIssueKind =
  /** 定义文件缺失、超限、缺少声明段、正文为空、或声明的标识与目录名不一致。 */
  | 'definition-invalid'
  /** 自定义专家与内置专家或另一份自定义专家的标识重复；冲突项不进入清单。 */
  | 'id-conflict'
  /** 引用的技能在主会话不可见：不存在或未被加载。 */
  | 'skill-reference-missing'
  /** 引用了只对子代理进程可见的技能：专家不得使用这类规范。 */
  | 'skill-reference-sub-agent'

/** 一条结构化诊断；只带标识与路径，不携带用户正文。 */
export interface ExpertIssue {
  readonly kind: ExpertIssueKind
  readonly expertId: string | null
  readonly skillId: string | null
  readonly path: string
}

export interface ExpertCatalog {
  readonly experts: readonly ExpertDefinition[]
  readonly issues: readonly ExpertIssue[]
}

export interface ExpertSkillContext {
  /** 本次会话可见的技能标识。 */
  readonly availableSkillIds: readonly string[]
  /** 只对子代理进程可见的技能标识：专家不得引用。 */
  readonly subAgentOnlySkillIds: readonly string[]
}

/** 随包清单给出的内置专家入口。 */
export interface BuiltinExpert {
  readonly id: string
  readonly filePath: string
}

export interface LoadExpertCatalogInput extends ExpertSkillContext {
  readonly builtin: readonly BuiltinExpert[]
  /** 自定义专家根目录；目录不存在时按没有自定义专家处理。 */
  readonly userDirectory: string
}

export interface ParsedDocument {
  readonly fields: Readonly<Record<string, string>>
  readonly body: string
}

type ReadResult =
  | { readonly ok: true; readonly definition: ExpertDefinition }
  | { readonly ok: false; readonly issue: ExpertIssue }

/**
 * 只解析本设计需要的声明子集：`key: value` 形式的标量字段，不实现完整 YAML。
 * 没有首尾分隔行时返回 null，由调用方判为无效定义而不是猜测字段来源。
 */
function parseDocument(text: string): ParsedDocument | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/.exec(line)
    const key = match?.[1]
    const value = match?.[2]
    if (key === undefined || value === undefined) continue
    fields[key] = value.trim().replace(/^['"]|['"]$/g, '')
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

/** 技能列表接受 `[]`、`[a, b]` 与 `a, b` 三种写法；返回 null 表示写法不合法。 */
function parseSkillIds(value: string | undefined): string[] | null {
  if (value === undefined || value === '' || value === '[]') return []
  const items = value.replace(/^\[/, '').replace(/\]$/, '').split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(item => item !== '')
  return items.every(item => SKILL_ID.test(item)) ? items : null
}

/** 标识与目录名同形的判定；主进程写盘与页面契约共用这一份规则。 */
export function isExpertDefinitionId(value: unknown): value is string {
  return typeof value === 'string' && EXPERT_ID.test(value)
}

/** 技能标识判定：技能目录允许下划线与大写，与专家标识不是同一套规则。 */
export function isSkillReferenceId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_ID.test(value)
}

/** 定义文件固定名与两类上限：主进程写盘与页面提示共用，不在两边各写一份常数。 */
export const EXPERT_DEFINITION_FILE = DEFINITION_FILE
export const EXPERT_LIMITS = {
  definitionBytes: MAX_DEFINITION_BYTES,
  roleChars: MAX_ROLE_CHARS
} as const

/** 解析一份定义文件的声明段与正文；返回 null 表示缺少首尾分隔行，写回前据此判断能否安全改写。 */
export function parseExpertDocument(text: string): ParsedDocument | null {
  return parseDocument(text)
}

/** 解析技能引用列表；返回 null 表示写法不合法，写回时直接拒绝而不是猜用户的意图。 */
export function parseExpertSkillIds(value: string | undefined): string[] | null {
  return parseSkillIds(value)
}

function invalid(expertId: string | null, path: string): ReadResult {
  return { ok: false, issue: { kind: 'definition-invalid', expertId, skillId: null, path } }
}

/** 解析单个定义文件；任何一步不成立都只产出诊断，不抛异常。 */
function readDefinition(input: {
  readonly id: string
  readonly filePath: string
  readonly source: 'builtin' | 'user'
}): ReadResult {
  const { id, filePath, source } = input
  // 目录名即标识：内置入口与自定义目录都按目录名命名，声明与目录不一致说明文件被搬动或复制错位。
  if (!EXPERT_ID.test(id) || basename(dirname(filePath)) !== id) return invalid(id, filePath)
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > MAX_DEFINITION_BYTES) return invalid(id, filePath)
    text = readFileSync(filePath, 'utf8')
  } catch {
    return invalid(id, filePath)
  }
  const document = parseDocument(text)
  if (document === null) return invalid(id, filePath)
  const displayName = document.fields.displayName
  const summary = document.fields.summary
  const skillIds = parseSkillIds(document.fields.skills)
  // 派生来源是可选的追溯字段；写了就必须指回一个合法的专家标识，写成任意文本按定义无效处理。
  const derivedFrom = document.fields.derivedFrom === undefined || document.fields.derivedFrom === ''
    ? null
    : document.fields.derivedFrom
  if (derivedFrom !== null && !EXPERT_ID.test(derivedFrom)) return invalid(id, filePath)
  // 声明的 name 必须等于目录名；只有引用没有正文的条目退化成技能集合，按无效处理。
  if (document.fields.name !== id || displayName === undefined || displayName === ''
    || summary === undefined || summary === '' || skillIds === null || document.body === '') {
    return invalid(id, filePath)
  }
  return {
    ok: true,
    definition: {
      id, displayName, summary, skillIds, body: document.body, truncated: document.body.length > MAX_ROLE_CHARS,
      source, filePath, derivedFrom, unavailableSkillIds: []
    }
  }
}

/** 逐个判定技能引用；引用问题只标注，不让整个专家消失。 */
function judgeSkills(
  definition: ExpertDefinition,
  input: ExpertSkillContext,
  issues: ExpertIssue[]
): ExpertDefinition {
  const unavailable: string[] = []
  for (const skillId of definition.skillIds) {
    const kind: ExpertIssueKind | null = input.subAgentOnlySkillIds.includes(skillId)
      ? 'skill-reference-sub-agent'
      : input.availableSkillIds.includes(skillId)
        ? null
        : 'skill-reference-missing'
    if (kind === null) continue
    issues.push({ kind, expertId: definition.id, skillId, path: definition.filePath })
    unavailable.push(skillId)
  }
  return { ...definition, unavailableSkillIds: unavailable }
}

/** 列出目录下的技能标识；目录缺失或不可读时按没有技能处理。 */
export function skillDirectoryIds(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * 把随包清单的专家条目映射为内置入口。入口相对路径的越界与存在性由清单校验和指纹保证，
 * 这里只做形状转换，两个调用方（主进程与宿主）不各自重复拼接路径。
 */
export function builtinExperts(bundle: AgentResourceBundle): BuiltinExpert[] {
  return bundle.experts.map(item => ({ id: item.id, filePath: agentResourcePath(bundle.root, item.entry) }))
}

/** 列出自定义专家目录下的候选标识；符号链接不跟随，目录缺失视为空。 */
function listUserExpertIds(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && EXPERT_ID.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  } catch {
    return []
  }
}

/** 合并内置与自定义专家；内置在前，自定义按目录名排序。 */
export function loadExpertCatalog(input: LoadExpertCatalogInput): ExpertCatalog {
  const issues: ExpertIssue[] = []
  const experts: ExpertDefinition[] = []
  const claimed = new Set<string>()

  for (const item of input.builtin) {
    if (claimed.has(item.id)) {
      issues.push({ kind: 'id-conflict', expertId: item.id, skillId: null, path: item.filePath })
      continue
    }
    claimed.add(item.id)
    const result = readDefinition({ id: item.id, filePath: item.filePath, source: 'builtin' })
    if (!result.ok) { issues.push(result.issue); continue }
    experts.push(judgeSkills(result.definition, input, issues))
  }

  for (const id of listUserExpertIds(input.userDirectory)) {
    const filePath = join(input.userDirectory, id, DEFINITION_FILE)
    // 内置专家只读不可覆盖：同名自定义不进入清单，避免同一标识出现两种行为。
    if (claimed.has(id)) {
      issues.push({ kind: 'id-conflict', expertId: id, skillId: null, path: filePath })
      continue
    }
    claimed.add(id)
    const result = readDefinition({ id, filePath, source: 'user' })
    if (!result.ok) { issues.push(result.issue); continue }
    experts.push(judgeSkills(result.definition, input, issues))
  }

  return { experts, issues }
}
