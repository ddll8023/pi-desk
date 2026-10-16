/**
 * 定义项目文件检索与单层目录列举的 IPC 契约及跨进程响应校验；只暴露项目相对路径，不传文件内容。
 * 两者都以「当前项目」为根：页面只能给出项目内相对路径，绝对路径与越界路径由主进程拒绝。
 */
import type { DesktopError } from './desktop-api'

export const PROJECT_FILE_SEARCH_CHANNEL = 'desktop:project-file-search'
export const PROJECT_DIRECTORY_LIST_CHANNEL = 'desktop:project-directory-list'

/** 查询串长度上限；主进程与渲染端共用，超出长度的一段不作为 `@` 引用处理。 */
export const PROJECT_FILE_QUERY_MAX_CHARS = 128

/** 目录相对路径长度上限；只拒绝明显异常的值，真实范围校验在主进程。 */
export const PROJECT_DIRECTORY_PATH_MAX_CHARS = 4096

/** 单层目录一次最多返回的条目数；超出截断并标记，界面据此提示而不是假装列全。 */
export const PROJECT_DIRECTORY_ENTRY_LIMIT = 500

/**
 * 检索结果；`entries` 是相对当前项目根的 POSIX 风格路径，最多 50 条。
 * 未选择项目、目录不可读与没有匹配一样返回空数组，不区分成错误。
 * `projectPath` 是本次实际检索的项目根；未选择项目时为 null。页面据此丢弃已切换项目的迟到结果。
 */
export interface ProjectFileSearch {
  readonly entries: readonly string[]
  readonly projectPath: string | null
}

export type ProjectFileSearchResult =
  | { readonly ok: true; readonly data: ProjectFileSearch }
  | { readonly ok: false; readonly error: DesktopError }

/** 目录条目类型；符号链接不跟随，因此不会按它指向的目标归类。 */
export type ProjectDirectoryEntryKind = 'directory' | 'file' | 'other'

/** 单层目录里的一个条目；`path` 是相对项目根的 POSIX 路径，供后续按路径请求子层使用。 */
export interface ProjectDirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: ProjectDirectoryEntryKind
  /** 该项本身是符号链接；界面据此标注，且不提供展开。 */
  readonly symlink: boolean
}

/**
 * 单层目录列举结果；`directory` 是本次列举的目录相对路径，项目根为 ''。
 * `projectPath` 是本次实际列举的项目根；未选择项目时为 null，页面据此丢弃已切换项目的迟到结果。
 */
export interface ProjectDirectoryListing {
  readonly projectPath: string | null
  readonly directory: string
  readonly entries: readonly ProjectDirectoryEntry[]
  /** 该层条目超过上限被截断；界面提示而不是假装列全。 */
  readonly truncated: boolean
}

/** 列举失败只回错误：目录不存在、不可读与越界都带可展示的原因。 */
export type ProjectDirectoryListResult =
  | { readonly ok: true; readonly data: ProjectDirectoryListing }
  | { readonly ok: false; readonly error: DesktopError }

/** 列举请求；只接受项目内相对目录路径，根目录传空串。 */
export interface ProjectDirectoryListRequest {
  readonly directory: string
}

export interface ProjectFileApi {
  /** 在当前项目内按查询串检索文件路径；不接受目录参数，根路径由主进程决定。 */
  readonly searchProjectFiles: (query: string) => Promise<ProjectFileSearchResult>
  /** 列举当前项目内某一层的目录条目；不接受绝对路径，根路径由主进程决定。 */
  readonly listProjectDirectory: (request: ProjectDirectoryListRequest) => Promise<ProjectDirectoryListResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProjectFileSearch(value: unknown): value is ProjectFileSearch {
  if (!isRecord(value)) return false
  if (value.projectPath !== null && typeof value.projectPath !== 'string') return false
  return Array.isArray(value.entries)
    && value.entries.every((entry) => typeof entry === 'string' && entry !== '')
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isProjectFileSearchResult(value: unknown): value is ProjectFileSearchResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isProjectFileSearch(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

const DIRECTORY_ENTRY_KINDS: readonly string[] = ['directory', 'file', 'other']

function isProjectDirectoryEntry(value: unknown): value is ProjectDirectoryEntry {
  if (!isRecord(value)) return false
  if (typeof value.name !== 'string' || value.name === '') return false
  if (typeof value.path !== 'string' || value.path === '') return false
  if (typeof value.symlink !== 'boolean') return false
  return typeof value.kind === 'string' && DIRECTORY_ENTRY_KINDS.includes(value.kind)
}

function isProjectDirectoryListing(value: unknown): value is ProjectDirectoryListing {
  if (!isRecord(value)) return false
  if (value.projectPath !== null && typeof value.projectPath !== 'string') return false
  if (typeof value.directory !== 'string' || typeof value.truncated !== 'boolean') return false
  return Array.isArray(value.entries) && value.entries.every(isProjectDirectoryEntry)
}

export function isProjectDirectoryListResult(value: unknown): value is ProjectDirectoryListResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isProjectDirectoryListing(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}
