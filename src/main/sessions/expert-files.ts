/**
 * 专家定义的写操作：把内置专家复制成本地可编辑的派生副本，读取与保存自定义专家定义，删除自定义专家。
 *
 * 写入面只到 `<agentDir>/experts/<id>/expert.md`：标识先过格式校验（不含分隔符，拼接无法逃逸），
 * 目标再复核必须落在 experts 根下的一级目录。内置专家在随包目录里只读，这里既不覆盖也不删除。
 * 派生只复制正文并补 `derivedFrom`，此后副本自行演进，不跟随内置升级；
 * 保存保留声明段里本模块不认识的字段，避免把用户手写的说明洗掉。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentResourceBundle } from '../../shared-process/agent-resources'
import {
  EXPERT_DEFINITION_FILE,
  EXPERT_LIMITS,
  builtinExperts,
  isExpertDefinitionId,
  isSkillReferenceId,
  parseExpertDocument,
  parseExpertSkillIds
} from '../../shared-process/expert-definitions'
import { MAX_EXPERT_SKILL_REFS } from '../../shared/experts-api'
import type { ExpertDeleteResult, ExpertDeriveResult, ExpertReadResult, ExpertSaveResult } from '../../shared/experts-api'

/** 派生副本的标识后缀；被占用时顺延编号。 */
const DERIVE_SUFFIX = '-copy'

type DocumentParts = {
  readonly headerLines: readonly string[]
  readonly body: string
}

function failure(
  code: 'BUILTIN_NOT_FOUND' | 'INVALID_REQUEST' | 'NOT_USER_EXPERT' | 'NOT_FOUND' | 'INVALID_DEFINITION' | 'INTERNAL_ERROR',
  message: string
) {
  return { ok: false as const, error: { code, message } }
}

/**
 * 拆出 `---` 声明段与正文；没有首尾分隔行时返回 null——派生一个解析层也读不出来的文件没有意义。
 */
function splitDocument(text: string): DocumentParts | null {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return null
  return { headerLines: lines.slice(1, end), body: lines.slice(end + 1).join('\n') }
}

/**
 * 重写声明段：`name` 必须等于目录名，否则副本会被解析层判为无效；`derivedFrom` 指向来源内置专家。
 * 其余字段原样保留，用户自己加的说明不会在派生时丢失。
 */
function rewriteHeader(headerLines: readonly string[], id: string, derivedFrom: string): string[] {
  const kept = headerLines.filter(line => !/^name\s*:/.test(line) && !/^derivedFrom\s*:/.test(line))
  return [`name: ${id}`, `derivedFrom: ${derivedFrom}`, ...kept]
}

function userExpertDirectory(agentDir: string, expertId: string): string {
  return join(agentDir, 'experts', expertId)
}

/** 挑一个没被占用的副本标识：内置与已有自定义目录都算占用，避免派生后立刻变成 id-conflict。 */
function nextDerivedId(input: { readonly agentDir: string; readonly takenIds: ReadonlySet<string>; readonly builtinId: string }): string {
  const base = `${input.builtinId}${DERIVE_SUFFIX}`
  let candidate = base
  let index = 2
  while (input.takenIds.has(candidate) || existsSync(userExpertDirectory(input.agentDir, candidate))) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

/**
 * 派生一份内置专家到自定义目录；返回新标识，供页面立即刷新清单。
 * 清单损坏、内置条目缺失或写盘失败都转成固定错误码，由通道层按契约返回，不抛到调用方。
 */
export function deriveBuiltinExpert(input: {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly builtinId: string
}): ExpertDeriveResult {
  if (!isExpertDefinitionId(input.builtinId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
  let builtinFilePath: string | null = null
  const takenIds = new Set<string>()
  try {
    const bundle = readAgentResourceBundle(input.resourcesDirectory)
    for (const item of builtinExperts(bundle)) takenIds.add(item.id)
    builtinFilePath = builtinExperts(bundle).find(item => item.id === input.builtinId)?.filePath ?? null
  } catch {
    return failure('INTERNAL_ERROR', '随包资源清单读取失败，无法派生内置专家。')
  }
  if (builtinFilePath === null) {
    return failure('BUILTIN_NOT_FOUND', '随包清单里没有这个内置专家；重新构建资源后才有。')
  }
  let parts: DocumentParts | null
  try {
    parts = splitDocument(readFileSync(builtinFilePath, 'utf8'))
  } catch {
    return failure('INTERNAL_ERROR', '内置专家定义读取失败。')
  }
  if (parts === null) return failure('INTERNAL_ERROR', '内置专家定义缺少声明段，无法派生。')

  const expertId = nextDerivedId({ agentDir: input.agentDir, takenIds, builtinId: input.builtinId })
  const directory = userExpertDirectory(input.agentDir, expertId)
  const text = ['---', ...rewriteHeader(parts.headerLines, expertId, input.builtinId), '---', parts.body, ''].join('\n')
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, EXPERT_DEFINITION_FILE), text, 'utf8')
  } catch {
    return failure('INTERNAL_ERROR', '写入派生副本失败，检查应用数据目录是否可写。')
  }
  return { ok: true, data: { expertId } }
}

/**
 * 删除一份自定义专家；只删该目录下的 `expert.md`，目录里还有别的文件时整体拒绝，
 * 不替用户删除来源不明的素材。内置专家不在这个根下，因此不会被误删。
 */
export function deleteUserExpert(input: { readonly agentDir: string; readonly expertId: string }): ExpertDeleteResult {
  if (!isExpertDefinitionId(input.expertId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
  const directory = userExpertDirectory(input.agentDir, input.expertId)
  let entries: string[]
  try {
    const info = statSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      return failure('NOT_USER_EXPERT', '目标不是自定义专家目录。')
    }
    entries = readdirSync(directory)
  } catch {
    return failure('NOT_USER_EXPERT', '没有找到这份自定义专家；内置专家不能通过这里删除。')
  }
  if (entries.some(entry => entry !== EXPERT_DEFINITION_FILE)) {
    return failure('NOT_USER_EXPERT', '这个专家目录里还有其他文件，先手工整理再删除。')
  }
  try {
    rmSync(join(directory, EXPERT_DEFINITION_FILE), { force: true })
    // 目录只剩定义文件时一并收掉；上面的检查已保证这里不会碰到别的素材。
    rmdirSync(directory)
  } catch {
    return failure('INTERNAL_ERROR', '删除专家定义失败，检查应用数据目录是否可写。')
  }
  return { ok: true, data: { expertId: input.expertId } }
}

/**
 * 读取一份自定义专家的声明与正文，供设置页编辑。
 * 读不到按不存在处理；正文为空仍返回，让用户能在界面里补上而不是只能手工改文件。
 */
export function readUserExpertDefinition(input: {
  readonly agentDir: string
  readonly expertId: string
}): ExpertReadResult {
  if (!isExpertDefinitionId(input.expertId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
  const filePath = join(userExpertDirectory(input.agentDir, input.expertId), EXPERT_DEFINITION_FILE)
  let text: string
  try {
    const info = statSync(filePath)
    if (!info.isFile()) return failure('NOT_FOUND', '没有找到这份自定义专家；内置专家不能在这里编辑。')
    if (info.size > EXPERT_LIMITS.definitionBytes) {
      return failure('INVALID_DEFINITION', '定义文件超出体积上限，请先手工精简再回来编辑。')
    }
    text = readFileSync(filePath, 'utf8')
  } catch {
    return failure('NOT_FOUND', '没有找到这份自定义专家；内置专家不能在这里编辑。')
  }
  const document = parseExpertDocument(text)
  if (document === null) {
    return failure('INVALID_DEFINITION', '定义文件缺少首尾分隔行，先在编辑器里补上再回来编辑。')
  }
  const skillIds = parseExpertSkillIds(document.fields.skills)
  if (skillIds === null) {
    return failure('INVALID_DEFINITION', '声明段的 skills 写法不合法，先手工修正再回来编辑。')
  }
  const derivedFrom = document.fields.derivedFrom
  return {
    ok: true,
    data: {
      id: input.expertId,
      displayName: document.fields.displayName ?? '',
      summary: document.fields.summary ?? '',
      skillIds,
      body: document.body,
      derivedFrom: derivedFrom !== undefined && isExpertDefinitionId(derivedFrom) ? derivedFrom : null
    }
  }
}

/** 新建时分配一个没被占用的标识；内置标识都是语义名，不会与 `expert-<序号>` 撞上。 */
function nextAutoExpertId(agentDir: string): string {
  const root = join(agentDir, 'experts')
  let index = 1
  while (existsSync(join(root, `expert-${index}`))) index += 1
  return `expert-${index}`
}

/**
 * 重写声明段：只动本设计认识的四个字段，其余行（`derivedFrom` 与用户自加的说明）原样保留。
 * 字段顺序固定，避免每次保存都产生无意义的 diff。
 */
function rebuildHeader(input: {
  readonly headerLines: readonly string[]
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
}): string[] {
  const managed = /^(name|displayName|summary|skills)\s*:/
  const kept = input.headerLines.filter(line => !managed.test(line))
  const skills = input.skillIds.length === 0 ? '[]' : `[${input.skillIds.join(', ')}]`
  return [
    `name: ${input.id}`,
    `displayName: ${input.displayName}`,
    `summary: ${input.summary}`,
    `skills: ${skills}`,
    ...kept
  ]
}

/**
 * 新建或保存一份自定义专家：新建由主进程分配标识，保存只改声明的四个字段与正文。
 * 拒绝落盘的条件都是写入前就能判定的（字段为空、写法不合法、引用子代理专用技能、超出体积）；
 * 引用了当前不可见的技能与正文超长只回报，不拦——用户可能先写引用、后补技能。
 */
export function saveUserExpertDefinition(input: {
  readonly agentDir: string
  readonly expertId: string | null
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly body: string
  readonly availableSkillIds: readonly string[]
  readonly subAgentOnlySkillIds: readonly string[]
}): ExpertSaveResult {
  const { agentDir } = input
  if (input.expertId !== null && !isExpertDefinitionId(input.expertId)) {
    return failure('INVALID_REQUEST', '专家标识写法不合法。')
  }
  if (input.skillIds.length > MAX_EXPERT_SKILL_REFS) {
    return failure('INVALID_DEFINITION', `技能引用最多 ${MAX_EXPERT_SKILL_REFS} 个。`)
  }
  if (!input.skillIds.every(isSkillReferenceId)) {
    return failure('INVALID_DEFINITION', '技能引用里有写法不合法的标识。')
  }
  const blocked = input.skillIds.filter(id => input.subAgentOnlySkillIds.includes(id))
  if (blocked.length > 0) {
    return failure('INVALID_DEFINITION', `不能引用只对子代理可见的技能：${blocked.join('、')}。`)
  }
  if (input.body.trim() === '') {
    return failure('INVALID_DEFINITION', '正文不能为空；只有技能清单的专家会退化成技能集合。')
  }

  const expertId = input.expertId ?? nextAutoExpertId(agentDir)
  const directory = userExpertDirectory(agentDir, expertId)
  const filePath = join(directory, EXPERT_DEFINITION_FILE)
  let headerLines: readonly string[] = []
  if (input.expertId !== null) {
    let existingText: string
    try {
      // 与删除同一口径：符号链接与非常规目录不当作自定义专家，避免写盘顺着链接逸出 experts 根。
      const info = statSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return failure('NOT_USER_EXPERT', '目标不是自定义专家目录。')
      }
      existingText = readFileSync(filePath, 'utf8')
    } catch {
      return failure('NOT_FOUND', '没有找到这份自定义专家；内置专家不能在这里编辑。')
    }
    // 声明段损坏时按空头部重建：用户正是来修定义的，拦下来只会让文件永远改不动。
    headerLines = splitDocument(existingText)?.headerLines ?? []
  }
  const body = input.body.replace(/\r\n?/g, '\n').trim()
  const header = rebuildHeader({
    headerLines,
    id: expertId,
    displayName: input.displayName.trim(),
    summary: input.summary.trim(),
    skillIds: input.skillIds
  })
  const text = ['---', ...header, '---', '', body, ''].join('\n')
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
    return failure('INTERNAL_ERROR', '保存专家定义失败，检查应用数据目录是否可写。')
  }
  return {
    ok: true,
    data: {
      expertId,
      unavailableSkillIds: input.skillIds.filter(id => !input.availableSkillIds.includes(id)),
      truncated: body.length > EXPERT_LIMITS.roleChars
    }
  }
}
