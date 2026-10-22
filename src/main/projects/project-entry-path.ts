/**
 * 项目内条目路径的唯一解析入口：目录列举、条目路径解析与文件内容读写都经这里把相对路径还原为绝对路径。
 *
 * 只接受项目内相对路径，项目根由调用方注入，页面无法指定绝对路径；`..` 段、盘符开头、超长输入一律拒绝。
 * 解析只对父目录做 `realpath` 与包含性校验，最后一段按原名拼回：因此父目录是符号链接且指向项目外时被拒绝，
 * 而条目本身是符号链接时解析为链接自身，是否跟随由调用方决定（文件内容读写一律拒绝符号链接）。
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { DesktopError } from '../../shared/desktop-api'
import { PROJECT_DIRECTORY_PATH_MAX_CHARS } from '../../shared/project-file-api'

/** 条目路径解析结果：成功同时给出规范化相对路径与绝对路径，失败带可展示原因。 */
export type ProjectEntryResolution =
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly error: DesktopError }

/** 解析失败：只描述可展示的原因，不携带底层文件错误。 */
export function entryFailure(code: 'INVALID_REQUEST' | 'INTERNAL_ERROR', message: string): ProjectEntryResolution {
  return { ok: false, error: { code, message } }
}

/**
 * 相对目录路径规范化：统一分隔符、丢弃空段与 `.`，返回 POSIX 风格相对路径（根目录为 ''）。
 * 绝对路径、盘符开头、`..` 段与超长输入一律拒绝；不做 trim，避免改写真实存在的目录名。
 */
export function normalizeRelativeDirectory(input: string): string | null {
  if (typeof input !== 'string' || input.length > PROJECT_DIRECTORY_PATH_MAX_CHARS) return null
  const unified = input.replace(/\\/gu, '/')
  if (unified === '' || unified === '/' || unified === '.') return ''
  if (isAbsolute(unified) || /^[A-Za-z]:/u.test(unified)) return null

  const segments: string[] = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.join('/')
}

/** 目标目录必须落在项目根内：realpath 结果与根相同，或以「根 + 分隔符」开头。 */
export function isInsideRoot(root: string, resolved: string): boolean {
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix)
}

/**
 * 把项目内相对条目路径解析为绝对路径。
 * 只对父目录做 realpath 与包含性校验，最后一段按原名拼回，因此不跟随条目自身的符号链接。
 */
export async function resolveProjectEntryAbsolute(root: string, input: string): Promise<ProjectEntryResolution> {
  const relativePath = normalizeRelativeDirectory(input)
  if (relativePath === null || relativePath === '') {
    return entryFailure('INVALID_REQUEST', '条目路径必须是项目内的相对路径。')
  }

  const slash = relativePath.lastIndexOf('/')
  const parentRelative = slash < 0 ? '' : relativePath.slice(0, slash)
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1)
  const parentAbsolute = parentRelative === '' ? root : join(root, ...parentRelative.split('/'))

  let resolvedParent: string
  try {
    resolvedParent = await realpath(parentAbsolute)
  } catch (error) {
    return entryFailure('INTERNAL_ERROR', readFailureMessage(error, parentRelative))
  }
  if (!isInsideRoot(root, resolvedParent)) {
    return entryFailure('INVALID_REQUEST', '条目路径超出当前项目范围。')
  }
  return { ok: true, relativePath, absolutePath: join(resolvedParent, name) }
}

/** 读取失败的可展示原因：区分不存在、不是目录与没有权限，其余归为通用失败。 */
export function readFailureMessage(error: unknown, relative: string): string {
  const target = relative === '' ? '项目根目录' : relative
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
  if (code === 'ENOENT') return `目录不存在：${target}`
  if (code === 'ENOTDIR') return `路径不是目录：${target}`
  if (code === 'EACCES' || code === 'EPERM') return `没有权限读取目录：${target}`
  return `读取目录失败：${target}`
}
