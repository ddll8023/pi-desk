/**
 * 团队定义的解析、双来源合并与结构化诊断。
 *
 * 只读取随包清单给出的内置团队定义，以及产品 agent 目录下的自定义团队，合并成一份可开团清单；
 * 单个定义损坏或标识冲突只影响对应条目，不中断整份清单。
 * 团长与成员的专家引用只做诊断：引用失效不让团队消失，但会让它不可开团（`ready` 为假）。
 * 本模块不装配会话、不创建成员会话，也不读写任务账本；文档解析与标识规则复用专家层那一份，
 * 主进程不复制第二条解析路径。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { agentResourcePath } from './agent-resources.ts'
import type { AgentResourceBundle } from './agent-resources.ts'
import { EXPERT_LIMITS, isExpertDefinitionId, parseExpertDocument } from './expert-definitions.ts'

/** 自定义团队目录内的固定定义文件名。 */
export const TEAM_DEFINITION_FILE = 'team.md'
/** 单个定义文件的读取上限：与专家定义共用同一口径，团队正文不进入系统提示，不需要更宽。 */
const MAX_DEFINITION_BYTES = EXPERT_LIMITS.definitionBytes

/** 一份可开团的团队定义。 */
export interface TeamDefinition {
  readonly id: string
  readonly displayName: string
  readonly summary: string
  /** 团长：必须是一个存在的专家标识；它是开团时根会话绑定的专家。 */
  readonly leadExpertId: string
  /** 成员：允许为空（此时不可开团），也允许部分引用失效。 */
  readonly memberExpertIds: readonly string[]
  /** 协作约定正文：可选，不进入系统提示，只供编辑与展示。 */
  readonly body: string
  readonly source: 'builtin' | 'user'
  readonly filePath: string
  /** 团长与至少一名成员都在专家清单里时才可开团；引用缺失只影响这一项判定。 */
  readonly ready: boolean
}

export type TeamIssueKind =
  /** 定义文件缺失、超限、缺少声明段、声明与目录名不一致，或名称、简介、团长写法不合法。 */
  | 'definition-invalid'
  /** 自定义团队与内置团队或另一份自定义团队的标识重复；冲突项不进入清单。 */
  | 'id-conflict'
  /** 声明的团长在专家清单里不存在（或该专家自身定义无效）。 */
  | 'lead-reference-missing'
  /** 声明的成员在专家清单里不存在（或该专家自身定义无效）。 */
  | 'member-reference-missing'
  /** 团长之外没有任何可用成员：团队保留在清单里，但不可开团。 */
  | 'no-usable-member'

/** 一条结构化诊断；只带标识与路径，不携带用户正文。 */
export interface TeamIssue {
  readonly kind: TeamIssueKind
  readonly teamId: string | null
  /** 引用类诊断指向的专家标识；其余诊断固定为 null。 */
  readonly expertId: string | null
  readonly path: string
}

export interface TeamCatalog {
  readonly teams: readonly TeamDefinition[]
  readonly issues: readonly TeamIssue[]
}

/** 随包清单给出的内置团队入口。 */
export interface BuiltinTeam {
  readonly id: string
  readonly filePath: string
}

export interface LoadTeamCatalogInput {
  readonly builtin: readonly BuiltinTeam[]
  /** 自定义团队根目录；目录不存在时按没有自定义团队处理。 */
  readonly userDirectory: string
  /** 当前专家清单里的标识；引用判定只认这份集合，不另读一次专家目录。 */
  readonly availableExpertIds: readonly string[]
}

type ReadResult =
  | { readonly ok: true; readonly definition: TeamDefinition }
  | { readonly ok: false; readonly issue: TeamIssue }

function invalid(teamId: string | null, path: string): ReadResult {
  return { ok: false, issue: { kind: 'definition-invalid', teamId, expertId: null, path } }
}

/**
 * 专家组引用的写法解析：接受 `[]`、`[a, b]` 与 `a, b` 三种写法。
 * 与技能引用不同，这里必须是专家标识规则（小写字母开头、只含小写字母、数字与连字符），
 * 写成技能风格的大写或下划线属于无效定义，不做猜测。返回 null 表示写法不合法。
 */
function parseTeamRefs(value: string | undefined): string[] | null {
  if (value === undefined || value === '' || value === '[]') return []
  const items = value.replace(/^\[/, '').replace(/\]$/, '').split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(item => item !== '')
  if (!items.every(item => isExpertDefinitionId(item))) return null
  return [...new Set(items)]
}

/** 解析单个团队定义文件；任何一步不成立都只产出诊断，不抛异常。 */
function readDefinition(input: {
  readonly id: string
  readonly filePath: string
  readonly source: 'builtin' | 'user'
  readonly availableExpertIds: readonly string[]
  readonly issues: TeamIssue[]
}): ReadResult {
  const { id, filePath, source, availableExpertIds } = input
  // 目录名即标识：声明与目录不一致说明文件被搬动或复制错位。
  if (!isExpertDefinitionId(id) || basename(dirname(filePath)) !== id) return invalid(id, filePath)
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > MAX_DEFINITION_BYTES) return invalid(id, filePath)
    text = readFileSync(filePath, 'utf8')
  } catch {
    return invalid(id, filePath)
  }
  const document = parseExpertDocument(text)
  if (document === null) return invalid(id, filePath)
  const displayName = document.fields.displayName
  const summary = document.fields.summary
  const leadExpertId = document.fields.lead
  const memberExpertIds = parseTeamRefs(document.fields.members)
  // 声明的 name 必须等于目录名；团长必填；成员列表写法必须合法（可以为空）。
  if (document.fields.name !== id || displayName === undefined || displayName === ''
    || summary === undefined || summary === '' || leadExpertId === undefined
    || !isExpertDefinitionId(leadExpertId) || memberExpertIds === null) {
    return invalid(id, filePath)
  }
  const available = new Set(availableExpertIds)
  // 团长与成员的引用只影响可开团判定：同级引用问题各报一条，团队条目本身保留。
  const leadAvailable = available.has(leadExpertId)
  if (!leadAvailable) {
    input.issues.push({ kind: 'lead-reference-missing', teamId: id, expertId: leadExpertId, path: filePath })
  }
  let membersAvailable = 0
  for (const memberId of memberExpertIds) {
    if (available.has(memberId)) { membersAvailable += 1; continue }
    input.issues.push({ kind: 'member-reference-missing', teamId: id, expertId: memberId, path: filePath })
  }
  if (membersAvailable === 0) {
    input.issues.push({ kind: 'no-usable-member', teamId: id, expertId: null, path: filePath })
  }
  return {
    ok: true,
    definition: {
      id, displayName, summary, leadExpertId, memberExpertIds,
      body: document.body, source, filePath,
      ready: leadAvailable && membersAvailable > 0
    }
  }
}

/** 把随包清单的团队条目映射为内置入口；路径拼接只在这里做一次。 */
export function builtinTeams(bundle: AgentResourceBundle): BuiltinTeam[] {
  return bundle.teams.map(item => ({ id: item.id, filePath: agentResourcePath(bundle.root, item.entry) }))
}

/** 列出自定义团队目录下的候选标识；符号链接不跟随，目录缺失视为空。 */
function listUserTeamIds(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && isExpertDefinitionId(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  } catch {
    return []
  }
}

/** 合并内置与自定义团队；内置在前，自定义按目录名排序。 */
export function loadTeamCatalog(input: LoadTeamCatalogInput): TeamCatalog {
  const issues: TeamIssue[] = []
  const teams: TeamDefinition[] = []
  const claimed = new Set<string>()

  for (const item of input.builtin) {
    if (claimed.has(item.id)) {
      issues.push({ kind: 'id-conflict', teamId: item.id, expertId: null, path: item.filePath })
      continue
    }
    claimed.add(item.id)
    const result = readDefinition({
      id: item.id, filePath: item.filePath, source: 'builtin',
      availableExpertIds: input.availableExpertIds, issues
    })
    if (!result.ok) { issues.push(result.issue); continue }
    teams.push(result.definition)
  }

  for (const id of listUserTeamIds(input.userDirectory)) {
    const filePath = join(input.userDirectory, id, TEAM_DEFINITION_FILE)
    // 内置团队只读不可覆盖：同名自定义不进入清单，避免同一标识出现两种行为。
    if (claimed.has(id)) {
      issues.push({ kind: 'id-conflict', teamId: id, expertId: null, path: filePath })
      continue
    }
    claimed.add(id)
    const result = readDefinition({
      id, filePath, source: 'user', availableExpertIds: input.availableExpertIds, issues
    })
    if (!result.ok) { issues.push(result.issue); continue }
    teams.push(result.definition)
  }

  return { teams, issues }
}
