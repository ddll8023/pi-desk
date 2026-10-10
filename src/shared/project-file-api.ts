/** 定义项目文件检索的 IPC 契约与跨进程响应校验；只暴露项目相对路径，不传文件内容。 */
import type { DesktopError } from './desktop-api'

export const PROJECT_FILE_SEARCH_CHANNEL = 'desktop:project-file-search'

/** 查询串长度上限；主进程与渲染端共用，超出长度的一段不作为 `@` 引用处理。 */
export const PROJECT_FILE_QUERY_MAX_CHARS = 128

/**
 * 检索结果；`entries` 是相对当前项目根的 POSIX 风格路径，最多 50 条。
 * 未选择项目、目录不可读与没有匹配一样返回空数组，不区分成错误。
 */
export interface ProjectFileSearch {
  readonly entries: readonly string[]
}

export type ProjectFileSearchResult =
  | { readonly ok: true; readonly data: ProjectFileSearch }
  | { readonly ok: false; readonly error: DesktopError }

export interface ProjectFileApi {
  /** 在当前项目内按查询串检索文件路径；不接受目录参数，根路径由主进程决定。 */
  readonly searchProjectFiles: (query: string) => Promise<ProjectFileSearchResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProjectFileSearch(value: unknown): value is ProjectFileSearch {
  if (!isRecord(value)) return false
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
