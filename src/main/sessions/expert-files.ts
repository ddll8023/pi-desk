/**
 * 专家定义的写操作：派生内置专家副本、读取与保存专家定义（含覆盖内置的写盘）、删除自定义专家与覆盖定义。
 *
 * 写入面只到 `<agentDir>/experts/<id>/expert.md`：标识先过格式校验（不含分隔符，拼接无法逃逸），
 * 目标再复核必须落在 experts 根下的一级目录。内置专家在随包目录里只读，这里既不覆盖也不删除；
 * 要让内置专家生效改动，只能以同标识写一份自定义定义去覆盖它——读取时以随包定义为底回填，
 * 保存时以内置的声明段起稿，只补本模块认识的字段，随包文件全程不动。
 * 派生只复制正文并补 `derivedFrom`，此后副本自行演进，不跟随内置升级；
 * 保存保留声明段里本模块不认识的字段，避免把用户手写的说明洗掉。
 * 能力范围字段只在非默认值时写入：继承模式与空加减项不落行，文件保持可读，也不把当时清单固化成白名单。
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
  parseExpertCapabilityMode,
  parseExpertDocument,
  parseExpertServerNames,
  parseExpertSkillIds,
  parseExpertToolNames,
  parseExpertWriteScope
} from '../../shared-process/expert-definitions'
import { PROTECTED_EXPERT_TOOLS, isProtectedExpertTool } from '../../shared/expert-capability'
import { isExpertWriteScopeEntry } from '../../shared/experts-api'
import type { ExpertCapabilityFields } from '../../shared/expert-capability'
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

/**
 * 内置专家定义路径：清单缺失或条目不存在时返回 null，由调用方按「没有这份内置」处理。
 * 覆盖编辑的第一步就是找它——没有内置定义可继承时，同标识的自定义目录不构成覆盖。
 */
function builtinDefinitionPath(resourcesDirectory: string, expertId: string): string | null {
  try {
    const bundle = readAgentResourceBundle(resourcesDirectory)
    return builtinExperts(bundle).find(item => item.id === expertId)?.filePath ?? null
  } catch {
    return null
  }
}

/** 挑一个没被占用的副本标识：已有自定义目录都算占用，否则派生会覆盖掉别人的定义（同标识即覆盖）。 */
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
 * 读取一份专家的声明与正文，供设置页编辑。
 * 自定义目录里没有时回落到同标识的内置定义：设置页打开内置专家时看到的就是随包版本，
 * 保存后再按覆盖处理，用户不必先派生一份副本才知道要改什么。
 * 读不到按不存在处理；正文为空仍返回，让用户能在界面里补上而不是只能手工改文件。
 */
export function readUserExpertDefinition(input: {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly expertId: string
}): ExpertReadResult {
  if (!isExpertDefinitionId(input.expertId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
  const userPath = join(userExpertDirectory(input.agentDir, input.expertId), EXPERT_DEFINITION_FILE)
  let text: string | null = null
  try {
    const info = statSync(userPath)
    if (info.isFile()) {
      // 存在但超限是被写坏的文件，不能静默退回内置：那会让用户以为改动生效了。
      if (info.size > EXPERT_LIMITS.definitionBytes) {
        return failure('INVALID_DEFINITION', '定义文件超出体积上限，请先手工精简再回来编辑。')
      }
      text = readFileSync(userPath, 'utf8')
    }
  } catch {
    text = null
  }
  // 自定义定义不存在（或不可读）时才看内置：覆盖定义始终优先，与清单合并同一优先级。
  if (text === null) {
    const builtinPath = builtinDefinitionPath(input.resourcesDirectory, input.expertId)
    if (builtinPath === null) return failure('NOT_FOUND', '没有找到这份专家定义；内置与自定义目录里都没有它。')
    try {
      const info = statSync(builtinPath)
      if (!info.isFile() || info.size > EXPERT_LIMITS.definitionBytes) {
        return failure('INVALID_DEFINITION', '内置定义文件超出体积上限，请先精简随包定义。')
      }
      text = readFileSync(builtinPath, 'utf8')
    } catch {
      return failure('NOT_FOUND', '内置定义读取失败，检查随包资源是否完整。')
    }
  }
  const document = parseExpertDocument(text)
  if (document === null) {
    return failure('INVALID_DEFINITION', '定义文件缺少首尾分隔行，先在编辑器里补上再回来编辑。')
  }
  const skillIds = parseExpertSkillIds(document.fields.skills)
  if (skillIds === null) {
    return failure('INVALID_DEFINITION', '声明段的 skills 写法不合法，先手工修正再回来编辑。')
  }
  const capabilities = parseCapabilityFields(document.fields)
  if (capabilities === null) {
    return failure('INVALID_DEFINITION', '声明段的能力字段（模式、技能、服务器或工具列表）写法不合法，先手工修正再回来编辑。')
  }
  // 与清单解析同一口径：写法不合法的写入范围项被忽略，界面里看不见它们，而不是把范围悄悄放大。
  const writeScope = parseExpertWriteScope(document.fields.writeScope).scope
  const derivedFrom = document.fields.derivedFrom
  return {
    ok: true,
    data: {
      id: input.expertId,
      displayName: document.fields.displayName ?? '',
      summary: document.fields.summary ?? '',
      skillIds,
      ...capabilities,
      writeScope,
      body: document.body,
      derivedFrom: derivedFrom !== undefined && isExpertDefinitionId(derivedFrom) ? derivedFrom : null
    }
  }
}

/** 读取时把能力字段解析成界面直接可编辑的形状；任一项写法不合法就整份拒绝，不拿半份数据填表。 */
function parseCapabilityFields(fields: Readonly<Record<string, string>>): ExpertCapabilityFields | null {
  const skillsMode = parseExpertCapabilityMode(fields.skillsMode)
  const skillAddIds = parseExpertSkillIds(fields.skillsAdd)
  const skillRemoveIds = parseExpertSkillIds(fields.skillsRemove)
  const mcpMode = parseExpertCapabilityMode(fields.mcpMode)
  const mcpServerIds = parseExpertServerNames(fields.mcpServers)
  const mcpAddIds = parseExpertServerNames(fields.mcpAdd)
  const mcpRemoveIds = parseExpertServerNames(fields.mcpRemove)
  const toolsMode = parseExpertCapabilityMode(fields.toolsMode)
  const toolIds = parseExpertToolNames(fields.tools)
  const toolAddIds = parseExpertToolNames(fields.toolsAdd)
  const toolRemoveIds = parseExpertToolNames(fields.toolsRemove)
  if (skillsMode === null || skillAddIds === null || skillRemoveIds === null
    || mcpMode === null || mcpServerIds === null || mcpAddIds === null || mcpRemoveIds === null
    || toolsMode === null || toolIds === null || toolAddIds === null || toolRemoveIds === null) {
    return null
  }
  return {
    skillsMode, skillAddIds, skillRemoveIds,
    mcpMode, mcpServerIds, mcpAddIds, mcpRemoveIds,
    toolsMode, toolIds, toolAddIds, toolRemoveIds
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
 * 重写声明段：只动本设计认识的字段，其余行（`derivedFrom` 与用户自加的说明）原样保留。
 * 字段顺序固定，避免每次保存都产生无意义的 diff；能力字段只在偏离默认值时写法入文件。
 */
function rebuildHeader(input: ExpertCapabilityFields & {
  readonly headerLines: readonly string[]
  readonly id: string
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly writeScope: readonly string[] | null
}): string[] {
  const managed = /^(name|displayName|summary|skills|skillsMode|skillsAdd|skillsRemove|mcpMode|mcpServers|mcpAdd|mcpRemove|tools|toolsMode|toolsAdd|toolsRemove|writeScope)\s*:/
  const kept = input.headerLines.filter(line => !managed.test(line))
  const lines = [
    `name: ${input.id}`,
    `displayName: ${input.displayName}`,
    `summary: ${input.summary}`,
    `skills: ${formatList(input.skillIds)}`
  ]
  // 继承模式是默认值：不写行，避免每份定义都带一条与基线等价却不再随基线变化的声明。
  if (input.skillsMode === 'only') lines.push('skillsMode: only')
  if (input.skillAddIds.length > 0) lines.push(`skillsAdd: ${formatList(input.skillAddIds)}`)
  if (input.skillRemoveIds.length > 0) lines.push(`skillsRemove: ${formatList(input.skillRemoveIds)}`)
  if (input.mcpMode === 'only') lines.push('mcpMode: only')
  if (input.mcpServerIds.length > 0) lines.push(`mcpServers: ${formatList(input.mcpServerIds)}`)
  if (input.mcpAddIds.length > 0) lines.push(`mcpAdd: ${formatList(input.mcpAddIds)}`)
  if (input.mcpRemoveIds.length > 0) lines.push(`mcpRemove: ${formatList(input.mcpRemoveIds)}`)
  if (input.toolsMode === 'only') lines.push('toolsMode: only')
  if (input.toolIds.length > 0) lines.push(`tools: ${formatList(input.toolIds)}`)
  if (input.toolAddIds.length > 0) lines.push(`toolsAdd: ${formatList(input.toolAddIds)}`)
  if (input.toolRemoveIds.length > 0) lines.push(`toolsRemove: ${formatList(input.toolRemoveIds)}`)
  // 写入范围不写行是「不限制」、写 `[]` 是「只读」：两者必须分开写，不能把空列表省成不写行。
  if (input.writeScope !== null) lines.push(`writeScope: ${formatList(input.writeScope)}`)
  return [...lines, ...kept]
}

/** 列表统一写成 `[]` 或 `[a, b]`，读取端两种都认。 */
function formatList(ids: readonly string[]): string {
  return ids.length === 0 ? '[]' : `[${ids.join(', ')}]`
}

/** 去重并保留首次出现的顺序；同一标识重复写没有额外含义。 */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

/**
 * 新建或保存一份自定义专家：新建由主进程分配标识，保存只改声明字段与正文。
 * 保存内置专家标识时不报错：同标识没有自定义定义时以随包定义为底创建覆盖项，
 * 随包文件仍是只读的，界面上这一项从「内置」变成「覆盖内置」。
 * 拒绝落盘的条件都是写入前就能判定的（字段为空、写法不合法、引用子代理专用技能、超出体积、
 * 技能白名单为空）；引用了当前不可见的技能与服务器、正文超长只回报，不拦——
 * 用户可能先写引用、后补技能，拦下来会让编辑无法保存。
 */
export function saveUserExpertDefinition(input: ExpertCapabilityFields & {
  readonly resourcesDirectory: string
  readonly agentDir: string
  readonly expertId: string | null
  readonly displayName: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly writeScope: readonly string[] | null
  readonly body: string
  readonly availableSkillIds: readonly string[]
  readonly subAgentOnlySkillIds: readonly string[]
  readonly availableMcpServers: readonly string[]
}): ExpertSaveResult {
  const { agentDir } = input
  if (input.expertId !== null && !isExpertDefinitionId(input.expertId)) {
    return failure('INVALID_REQUEST', '专家标识写法不合法。')
  }
  const skillIds = dedupe(input.skillIds)
  const skillAddIds = dedupe(input.skillAddIds)
  const skillRemoveIds = dedupe(input.skillRemoveIds)
  const mcpServerIds = dedupe(input.mcpServerIds)
  const mcpAddIds = dedupe(input.mcpAddIds)
  const mcpRemoveIds = dedupe(input.mcpRemoveIds)
  const toolIds = dedupe(input.toolIds)
  const toolAddIds = dedupe(input.toolAddIds)
  const toolRemoveIds = dedupe(input.toolRemoveIds)
  // 写入范围是路径而不是标识：按路径规则二次校验，不把一条写错的项落盘成「限到别处」。
  const writeScope = input.writeScope === null ? null : dedupe(input.writeScope)
  if (writeScope !== null && !writeScope.every(isExpertWriteScopeEntry)) {
    return failure('INVALID_DEFINITION', '写入范围里有写法不合法的路径：只接受项目内相对路径，目录以 / 结尾。')
  }
  const allSkillIds = [...skillIds, ...skillAddIds, ...skillRemoveIds]
  if (!allSkillIds.every(isSkillReferenceId)) {
    return failure('INVALID_DEFINITION', '技能引用里有写法不合法的标识。')
  }
  if (![...mcpServerIds, ...mcpAddIds, ...mcpRemoveIds].every(isSkillReferenceId)) {
    return failure('INVALID_DEFINITION', 'MCP 服务器名里有写法不合法的名称。')
  }
  if (![...toolIds, ...toolAddIds, ...toolRemoveIds].every(isSkillReferenceId)) {
    return failure('INVALID_DEFINITION', '工具名里有写法不合法的名称。')
  }
  // 受保护工具由技能门禁、执行模式与记忆组共同依赖，排除会让会话在功能上断裂而不是少一个能力。
  const blockedTools = [...toolRemoveIds, ...(input.toolsMode === 'only'
    ? PROTECTED_EXPERT_TOOLS.filter(name => !toolIds.includes(name))
    : [])].filter(isProtectedExpertTool)
  if (blockedTools.length > 0) {
    return failure('INVALID_DEFINITION',
      `这些工具不能从专家范围里排除：${[...new Set(blockedTools)].join('、')}。`)
  }
  const blocked = allSkillIds.filter(id => input.subAgentOnlySkillIds.includes(id))
  if (blocked.length > 0) {
    return failure('INVALID_DEFINITION', `不能引用只对子代理可见的技能：${[...new Set(blocked)].join('、')}。`)
  }
  // 技能白名单为空等于禁用全部技能，专家会退化成只会说话的角色，按无效定义拦下。
  if (input.skillsMode === 'only' && skillIds.length === 0) {
    return failure('INVALID_DEFINITION', '技能选择「仅用选中」时至少要保留一个技能；要继承默认则切回继承模式。')
  }
  if (input.body.trim() === '') {
    return failure('INVALID_DEFINITION', '正文不能为空；只有能力清单的专家会退化成一个开关。')
  }

  const expertId = input.expertId ?? nextAutoExpertId(agentDir)
  const directory = userExpertDirectory(agentDir, expertId)
  const filePath = join(directory, EXPERT_DEFINITION_FILE)
  let headerLines: readonly string[] = []
  if (input.expertId !== null) {
    let existingText: string | null = null
    try {
      // 与删除同一口径：符号链接与非常规目录不当作自定义专家，避免写盘顺着链接逸出 experts 根。
      const info = statSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        return failure('NOT_USER_EXPERT', '目标不是自定义专家目录。')
      }
      existingText = readFileSync(filePath, 'utf8')
    } catch {
      existingText = null
    }
    if (existingText === null) {
      // 同标识还没有自定义定义：以内置定义为底写一份覆盖项，随包文件不动。
      const builtinPath = builtinDefinitionPath(input.resourcesDirectory, expertId)
      if (builtinPath === null) {
        return failure('NOT_FOUND', '没有找到这份专家定义；内置与自定义目录里都没有它。')
      }
      try {
        existingText = readFileSync(builtinPath, 'utf8')
      } catch {
        return failure('INTERNAL_ERROR', '内置定义读取失败，无法以它为底创建覆盖定义。')
      }
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
    skillIds,
    writeScope,
    skillsMode: input.skillsMode,
    skillAddIds,
    skillRemoveIds,
    mcpMode: input.mcpMode,
    mcpServerIds,
    mcpAddIds,
    mcpRemoveIds,
    toolsMode: input.toolsMode,
    toolIds,
    toolAddIds,
    toolRemoveIds
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
      unavailableSkillIds: allSkillIds.filter(id => !input.availableSkillIds.includes(id)),
      unavailableMcpServers: [...mcpServerIds, ...mcpAddIds, ...mcpRemoveIds]
        .filter(name => !input.availableMcpServers.includes(name)),
      truncated: body.length > EXPERT_LIMITS.roleChars
    }
  }
}
