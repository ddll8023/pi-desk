/**
 * 团队定义的写操作：读取与保存自定义团队定义、删除自定义团队。
 *
 * 写入面只到 `<agentDir>/teams/<id>/team.md`：标识先过格式校验（不含分隔符，拼接无法逃逸），
 * 目标再复核必须落在 teams 根下的一级目录。内置团队在随包目录里只读，这里既不覆盖也不删除。
 * 字段口径由 `shared-process/team-definitions.ts` 的生成与草稿校验给出，本模块只做文件读写与体积检查，
 * 不复制第二套字段规则；保存保留声明段里本模块不认识的字段，避免把用户手写的说明洗掉。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EXPERT_LIMITS,
  isExpertDefinitionId,
  parseExpertDocument
} from '../../shared-process/expert-definitions'
import {
  TEAM_DEFINITION_FILE,
  buildTeamDocument,
  normalizeTeamMembers,
  parseTeamMemberRefs,
  validateTeamDraft
} from '../../shared-process/team-definitions'
import type { TeamDeleteResult, TeamErrorCode, TeamReadResult, TeamSaveResult } from '../../shared/teams-api'

function failure(code: TeamErrorCode, message: string) {
  return { ok: false as const, error: { code, message } }
}

function userTeamDirectory(agentDir: string, teamId: string): string {
  return join(agentDir, 'teams', teamId)
}

/** 新建时分配一个没被占用的标识；内置标识都是语义名，不会与 `team-<序号>` 撞上。 */
function nextAutoTeamId(agentDir: string): string {
  const root = join(agentDir, 'teams')
  let index = 1
  while (existsSync(join(root, `team-${index}`))) index += 1
  return `team-${index}`
}

/**
 * 读取一份自定义团队的声明与正文，供设置页编辑。
 * 读不到按不存在处理；正文为空仍返回，用户可以在界面里补上而不是只能手工改文件。
 */
export function readUserTeamDefinition(input: {
  readonly agentDir: string
  readonly teamId: string
}): TeamReadResult {
  if (!isExpertDefinitionId(input.teamId)) return failure('INVALID_REQUEST', '团队标识写法不合法。')
  const filePath = join(userTeamDirectory(input.agentDir, input.teamId), TEAM_DEFINITION_FILE)
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile()) return failure('NOT_FOUND', '没有找到这份自定义团队；内置团队不能在这里编辑。')
    if (info.size > EXPERT_LIMITS.definitionBytes) {
      return failure('INVALID_DEFINITION', '定义文件超出体积上限，请先手工精简再回来编辑。')
    }
    text = readFileSync(filePath, 'utf8')
  } catch {
    return failure('NOT_FOUND', '没有找到这份自定义团队；内置团队不能在这里编辑。')
  }
  const document = parseExpertDocument(text)
  if (document === null) {
    return failure('INVALID_DEFINITION', '定义文件缺少首尾分隔行，先在编辑器里补上再回来编辑。')
  }
  if (document.fields.name !== input.teamId) {
    return failure('INVALID_DEFINITION', '声明段的 name 与目录名不一致，先手工修正再回来编辑。')
  }
  const leadExpertId = document.fields.lead
  if (leadExpertId === undefined || !isExpertDefinitionId(leadExpertId)) {
    return failure('INVALID_DEFINITION', '声明段缺少合法的 lead 团长字段，先手工修正再回来编辑。')
  }
  const memberExpertIds = parseTeamMemberRefs(document.fields.members ?? '')
  if (memberExpertIds === null) {
    return failure('INVALID_DEFINITION', '声明段的 members 写法不合法，先手工修正再回来编辑。')
  }
  return {
    ok: true,
    data: {
      id: input.teamId,
      displayName: document.fields.displayName ?? '',
      summary: document.fields.summary ?? '',
      leadExpertId,
      memberExpertIds: normalizeTeamMembers(leadExpertId, memberExpertIds),
      body: document.body
    }
  }
}

/**
 * 新建或保存一份自定义团队：新建由主进程分配标识，保存只改声明字段与正文。
 * 拒绝落盘的条件都是写入前就能判定的：字段为空、引用不存在的专家、成员为空或超限、超出体积。
 */
export function saveUserTeamDefinition(input: {
  readonly agentDir: string
  readonly teamId: string | null
  readonly displayName: string
  readonly summary: string
  readonly leadExpertId: string
  readonly memberExpertIds: readonly string[]
  readonly body: string
  readonly availableExpertIds: readonly string[]
}): TeamSaveResult {
  const { agentDir } = input
  if (input.teamId !== null && !isExpertDefinitionId(input.teamId)) {
    return failure('INVALID_REQUEST', '团队标识写法不合法。')
  }
  const invalid = validateTeamDraft(input, input.availableExpertIds)
  if (invalid !== null) return failure('INVALID_DEFINITION', invalid)

  const teamId = input.teamId ?? nextAutoTeamId(agentDir)
  const directory = userTeamDirectory(agentDir, teamId)
  const filePath = join(directory, TEAM_DEFINITION_FILE)
  let headerLines: readonly string[] = []
  if (input.teamId !== null) {
    let existingText: string
    try {
      // 与删除同一口径：符号链接与非常规目录不当作自定义团队，避免写盘顺着链接逸出 teams 根。
      const info = statSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return failure('NOT_USER_TEAM', '目标不是自定义团队目录。')
      }
      existingText = readFileSync(filePath, 'utf8')
    } catch {
      return failure('NOT_FOUND', '没有找到这份自定义团队；内置团队不能在这里编辑。')
    }
    // 声明段损坏时按空头部重建：用户正是来修定义的，拦下来只会让文件永远改不动。
    headerLines = parseHeaderLines(existingText)
  }
  const text = buildTeamDocument({
    headerLines,
    id: teamId,
    displayName: input.displayName,
    summary: input.summary,
    leadExpertId: input.leadExpertId,
    memberExpertIds: input.memberExpertIds,
    body: input.body
  })
  if (Buffer.byteLength(text, 'utf8') > EXPERT_LIMITS.definitionBytes) {
    return failure('INVALID_DEFINITION', '定义文件超出体积上限，请精简正文后再保存。')
  }
  // 先写临时文件再改名：写到一半失败时不会留下半份定义，已打开的会话下一轮仍读到旧版本。
  const tempPath = `${filePath}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(tempPath, text, 'utf8')
    renameSync(tempPath, filePath)
  } catch {
    rmSync(tempPath, { force: true })
    return failure('INTERNAL_ERROR', '保存团队定义失败，检查应用数据目录是否可写。')
  }
  return { ok: true, data: { teamId } }
}

/** 取出现有声明段的行；文件不成立或没有首尾分隔行时按空头部处理。 */
function parseHeaderLines(text: string): readonly string[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return []
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  return end < 0 ? [] : lines.slice(1, end)
}

/**
 * 删除一份自定义团队；只删该目录下的 `team.md`，目录里还有别的文件时整体拒绝，
 * 不替用户删除来源不明的素材。内置团队不在这个根下，因此不会被误删。
 */
export function deleteUserTeam(input: { readonly agentDir: string; readonly teamId: string }): TeamDeleteResult {
  if (!isExpertDefinitionId(input.teamId)) return failure('INVALID_REQUEST', '团队标识写法不合法。')
  const directory = userTeamDirectory(input.agentDir, input.teamId)
  let entries: string[]
  try {
    const info = statSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return failure('NOT_USER_TEAM', '目标不是自定义团队目录。')
    }
    entries = readdirSync(directory)
  } catch {
    return failure('NOT_USER_TEAM', '没有找到这份自定义团队；内置团队不能通过这里删除。')
  }
  if (entries.some(entry => entry !== TEAM_DEFINITION_FILE)) {
    return failure('NOT_USER_TEAM', '这个团队目录里还有其他文件，先手工整理再删除。')
  }
  try {
    rmSync(join(directory, TEAM_DEFINITION_FILE), { force: true })
    // 目录只剩定义文件时一并收掉；上面的检查已保证这里不会碰到别的素材。
    rmdirSync(directory)
  } catch {
    return failure('INTERNAL_ERROR', '删除团队定义失败，检查应用数据目录是否可写。')
  }
  return { ok: true, data: { teamId: input.teamId } }
}
