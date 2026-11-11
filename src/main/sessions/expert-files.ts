/**
 * 专家定义的写操作：把内置专家复制成本地可编辑的派生副本，以及删除自定义专家。
 *
 * 写入面只到 `<agentDir>/experts/<id>/expert.md`：标识先过格式校验（不含分隔符，拼接无法逃逸），
 * 目标再复核必须落在 experts 根下的一级目录。内置专家在随包目录里只读，这里既不覆盖也不删除。
 * 派生只复制正文并补 `derivedFrom`，此后副本自行演进，不跟随内置升级。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAgentResourceBundle } from '../../shared-process/agent-resources'
import { builtinExperts } from '../../shared-process/expert-definitions'
import type { ExpertDeriveResult, ExpertDeleteResult } from '../../shared/experts-api'

/** 专家标识；与解析层同一形状，写盘前再校一次，避免调用方绕过契约直接传值。 */
const EXPERT_ID = /^[a-z][a-z0-9-]*$/
/** 每个自定义专家目录里的唯一定义文件名。 */
const DEFINITION_FILE = 'expert.md'
/** 派生副本的标识后缀；被占用时顺延编号。 */
const DERIVE_SUFFIX = '-copy'

type DocumentParts = {
  readonly headerLines: readonly string[]
  readonly body: string
}

function failure(code: 'BUILTIN_NOT_FOUND' | 'INVALID_REQUEST' | 'NOT_USER_EXPERT' | 'INTERNAL_ERROR', message: string) {
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
  if (!EXPERT_ID.test(input.builtinId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
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
    writeFileSync(join(directory, DEFINITION_FILE), text, 'utf8')
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
  if (!EXPERT_ID.test(input.expertId)) return failure('INVALID_REQUEST', '专家标识写法不合法。')
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
  if (entries.some(entry => entry !== DEFINITION_FILE)) {
    return failure('NOT_USER_EXPERT', '这个专家目录里还有其他文件，先手工整理再删除。')
  }
  try {
    rmSync(join(directory, DEFINITION_FILE), { force: true })
    // 目录只剩定义文件时一并收掉；上面的检查已保证这里不会碰到别的素材。
    rmdirSync(directory)
  } catch {
    return failure('INTERNAL_ERROR', '删除专家定义失败，检查应用数据目录是否可写。')
  }
  return { ok: true, data: { expertId: input.expertId } }
}
