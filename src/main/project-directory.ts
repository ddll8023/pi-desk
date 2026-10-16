/**
 * 项目目录单层读取与条目路径解析：为右侧面板的文件树提供「一层目录的条目」，并把相对条目路径还原为绝对路径。
 *
 * 只接受项目内相对路径，项目根由调用方注入，页面无法指定绝对路径；读取与解析前都用 `realpath` 复核
 * 目标仍在项目内，且符号链接不跟随，因此链接不会把访问带出项目。列举只回传条目名与类型：不读文件内容、
 * 不递归、不做 git 过滤（只跳过 `.git`），单层条目超过上限时截断并如实标记。
 * 解析只对父目录做 realpath：最后一段按原名拼回，因此符号链接条目解析为链接本身而不是它指向的目标；
 * 复制路径不需要条目仍存在，在文件管理器中显示则先 `lstat` 确认存在，否则回可展示的原因。
 * 目录不存在、不可读、越界与条目已删除都回可展示的原因，由界面就近提示。
 */
import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { shell } from 'electron'
import type { DesktopError } from '../shared/desktop-api'
import { PROJECT_DIRECTORY_ENTRY_LIMIT, PROJECT_DIRECTORY_PATH_MAX_CHARS } from '../shared/project-file-api'
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryEntryKind,
  ProjectDirectoryListResult,
  ProjectEntryPathResult,
  ProjectEntryRevealResult
} from '../shared/project-file-api'

/** 只跳过版本库目录：其余条目（含 dotfiles）都如实展示，gitignore 过滤留到后续按开关处理。 */
const SKIPPED_DIRECTORIES = new Set(['.git'])

export interface ProjectDirectoryReaderOptions {
  /** 当前项目路径的内存快照；未选择项目时为 null，不触发磁盘访问。 */
  readonly currentProjectPath: () => string | null
}

export class ProjectDirectoryReader {
  constructor(private readonly options: ProjectDirectoryReaderOptions) {}

  /**
   * 把项目内相对条目路径解析为绝对路径；未选择项目、路径非法与越界都回可展示的原因。
   * 不检查条目是否仍存在：复制路径不应该因为文件刚被删掉就失败。
   */
  async resolveEntry(path: string): Promise<ProjectEntryPathResult> {
    const root = this.options.currentProjectPath()
    if (root === null) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '尚未选择项目，无法解析文件路径。' } }
    }
    const resolved = await this.resolveAbsolute(root, path)
    if (!resolved.ok) return resolved
    return { ok: true, data: { path: resolved.relativePath, absolutePath: resolved.absolutePath } }
  }

  /**
   * 在系统文件管理器中显示一个条目：解析通过且条目仍存在时交给 Electron 的 `showItemInFolder`，
   * 它只定位并选中条目，不打开文件。
   */
  async revealEntry(path: string): Promise<ProjectEntryRevealResult> {
    const root = this.options.currentProjectPath()
    if (root === null) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '尚未选择项目，无法显示文件位置。' } }
    }
    const resolved = await this.resolveAbsolute(root, path)
    if (!resolved.ok) return resolved
    try {
      // lstat 不跟随链接：指向已删除目标的符号链接本身仍然可以被定位。
      await lstat(resolved.absolutePath)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'ENOENT') {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: `文件不存在，可能已被移动或删除：${resolved.relativePath}` } }
      }
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: `无法读取文件信息：${resolved.relativePath}` } }
    }
    try {
      shell.showItemInFolder(resolved.absolutePath)
    } catch {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: `无法在文件管理器中显示：${resolved.relativePath}` } }
    }
    return { ok: true }
  }

  /**
   * 相对路径到绝对路径的公共解析：只对父目录做 realpath 与包含性校验，最后一段按原名拼回。
   * 因此父目录是符号链接且指向项目外时被拒绝，而条目本身是符号链接时解析为链接自身。
   */
  private async resolveAbsolute(root: string, input: string): Promise<EntryResolution> {
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

  /** 列举一层目录；未选择项目时返回空结果，与检索接口保持同一口径。 */
  async list(directory: string): Promise<ProjectDirectoryListResult> {
    const root = this.options.currentProjectPath()
    if (root === null) {
      return { ok: true, data: { projectPath: null, directory: '', entries: [], truncated: false } }
    }

    const relative = normalizeRelativeDirectory(directory)
    if (relative === null) {
      return failure('INVALID_REQUEST', '目录路径必须是项目内的相对路径。')
    }

    const target = relative === '' ? root : join(root, ...relative.split('/'))
    let resolved: string
    try {
      // 符号链接在 realpath 里被解析：链接指向项目外时下面的一致性检查会拒绝。
      resolved = await realpath(target)
    } catch (error) {
      return failure('INTERNAL_ERROR', readFailureMessage(error, relative))
    }
    if (!isInsideRoot(root, resolved)) {
      return failure('INVALID_REQUEST', '目录路径超出当前项目范围。')
    }

    let dirents: readonly Dirent[]
    try {
      dirents = await readdir(resolved, { withFileTypes: true })
    } catch (error) {
      return failure('INTERNAL_ERROR', readFailureMessage(error, relative))
    }

    const entries = toEntries(dirents, relative)
    const truncated = entries.length > PROJECT_DIRECTORY_ENTRY_LIMIT
    return {
      ok: true,
      data: {
        projectPath: root,
        directory: relative,
        entries: truncated ? entries.slice(0, PROJECT_DIRECTORY_ENTRY_LIMIT) : entries,
        truncated
      }
    }
  }
}

function failure(
  code: 'INVALID_REQUEST' | 'INTERNAL_ERROR',
  message: string
): ProjectDirectoryListResult {
  return { ok: false, error: { code, message } }
}

/** 条目路径解析的内部结果：成功同时给出规范化相对路径与绝对路径，失败带可展示原因。 */
type EntryResolution =
  | { readonly ok: true; readonly relativePath: string; readonly absolutePath: string }
  | { readonly ok: false; readonly error: DesktopError }

function entryFailure(code: 'INVALID_REQUEST' | 'INTERNAL_ERROR', message: string): EntryResolution {
  return { ok: false, error: { code, message } }
}

/**
 * 相对目录路径规范化：统一分隔符、丢弃空段与 `.`，返回 POSIX 风格相对路径（根目录为 ''）。
 * 绝对路径、盘符开头、`..` 段与超长输入一律拒绝；不做 trim，避免改写真实存在的目录名。
 */
function normalizeRelativeDirectory(input: string): string | null {
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
function isInsideRoot(root: string, resolved: string): boolean {
  if (resolved === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return resolved.startsWith(prefix)
}

/** 读取失败的可展示原因：区分不存在、不是目录与没有权限，其余归为通用失败。 */
function readFailureMessage(error: unknown, relative: string): string {
  const target = relative === '' ? '项目根目录' : relative
  const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
  if (code === 'ENOENT') return `目录不存在：${target}`
  if (code === 'ENOTDIR') return `路径不是目录：${target}`
  if (code === 'EACCES' || code === 'EPERM') return `没有权限读取目录：${target}`
  return `读取目录失败：${target}`
}

/** 目录优先、同类按名称排序；符号链接只按自身类型归类，因此不会排在目录里。 */
function toEntries(dirents: readonly Dirent[], directory: string): ProjectDirectoryEntry[] {
  const entries: ProjectDirectoryEntry[] = []
  for (const dirent of dirents) {
    if (dirent.isDirectory() && SKIPPED_DIRECTORIES.has(dirent.name)) continue
    entries.push({
      name: dirent.name,
      path: directory === '' ? dirent.name : `${directory}/${dirent.name}`,
      kind: entryKind(dirent),
      symlink: dirent.isSymbolicLink()
    })
  }
  return entries.sort(compareEntries)
}

function entryKind(dirent: Dirent): ProjectDirectoryEntryKind {
  if (dirent.isDirectory()) return 'directory'
  if (dirent.isFile()) return 'file'
  return 'other'
}

/** 中文与数字混合的文件名按本地序排列，`numeric` 让 `2` 排在 `10` 前面。 */
function compareEntries(left: ProjectDirectoryEntry, right: ProjectDirectoryEntry): number {
  const leftDirectory = left.kind === 'directory'
  const rightDirectory = right.kind === 'directory'
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}
