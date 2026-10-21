/**
 * 定义项目文件检索、单层目录列举、目录监听、条目路径解析与文件内容读写的 IPC 契约及跨进程响应校验。
 * 目录操作以当前项目为根；文件内容和 Markdown 资源固定请求所属的已登记项目，绝对路径与越界路径由主进程拒绝；
 * 需要绝对路径时（复制、写入终端、在文件管理器中显示）一律由主进程解析后回传，页面不自行拼接。
 * 普通文件读返回文本、图片或「不支持」，保存只接受文本并带回磁盘基线；图片导入走独立受限通道，不暴露任意二进制写入。
 * 目录监听是本契约里唯一的推送通道：页面提交「已加载的目录集合」，主进程只回报这些层里发生的变化。
 */
import type { DesktopError } from './desktop-api'

export const PROJECT_FILE_SEARCH_CHANNEL = 'desktop:project-file-search'
export const PROJECT_DIRECTORY_LIST_CHANNEL = 'desktop:project-directory-list'
export const PROJECT_ENTRY_RESOLVE_CHANNEL = 'desktop:project-entry-resolve'
export const PROJECT_ENTRY_REVEAL_CHANNEL = 'desktop:project-entry-reveal'
export const PROJECT_FILE_READ_CHANNEL = 'desktop:project-file-read'
export const PROJECT_FILE_WRITE_CHANNEL = 'desktop:project-file-write'
export const PROJECT_FILE_STAT_CHANNEL = 'desktop:project-file-stat'
export const PROJECT_DIRECTORY_WATCH_CHANNEL = 'desktop:project-directory-watch'
export const PROJECT_DIRECTORY_CHANGED_EVENT = 'desktop:project-directory-changed'

/** 查询串长度上限；主进程与渲染端共用，超出长度的一段不作为 `@` 引用处理。 */
export const PROJECT_FILE_QUERY_MAX_CHARS = 128

/** 目录相对路径长度上限；只拒绝明显异常的值，真实范围校验在主进程。 */
export const PROJECT_DIRECTORY_PATH_MAX_CHARS = 4096

/** 单层目录一次最多返回的条目数；超出截断并标记，界面据此提示而不是假装列全。 */
export const PROJECT_DIRECTORY_ENTRY_LIMIT = 500

/** 同时监听的目录层数上限；只监听已加载的层，超出部分截断，界面仍可手动刷新。 */
export const PROJECT_DIRECTORY_WATCH_LIMIT = 256

/**
 * 可读取（预览）的文本字节上限；超出按「不支持」返回，不截断。
 * 比可编辑上限大，因为只读预览不需要把全文放进编辑器，代价低得多。
 */
export const PROJECT_FILE_TEXT_MAX_BYTES = 8 * 1024 * 1024

/**
 * 可编辑文本的字节上限；超过它只读：内容仍可查看，编辑与保存都不提供。
 * 编辑器要完整持有文本并参与撤销历史与逐次比对，2 MiB 是保持响应性的分界。
 */
export const PROJECT_FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024

/** 图片预览的字节上限；超出按「不支持」返回，避免一次 IPC 搬运过大内容。 */
export const PROJECT_FILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 文本编辑区里统一使用 `\n`；保存时按读取到的原始换行符还原。 */
export type ProjectFileEol = 'lf' | 'crlf'

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

/**
 * 目录监听请求：页面只提交「当前已加载的目录」相对路径集合，根路径由主进程决定。
 * 主进程按集合做增删（不递归），页面收起或切项目时提交新集合即可。
 */
export interface ProjectDirectoryWatchRequest {
  readonly directories: readonly string[]
}

/** 监听登记结果：成功时 `watching` 是实际生效的目录数（超过上限或不存在的不计）。 */
export interface ProjectDirectoryWatchData {
  readonly watching: number
}

export type ProjectDirectoryWatchResult =
  | { readonly ok: true; readonly data: ProjectDirectoryWatchData }
  | { readonly ok: false; readonly error: DesktopError }

/**
 * 目录变化事件：`changed` 时 `directories` 是被改动目录的相对路径（已落在页面登记过的层内）；
 * `overflow` 表示变化过多或监听不可用，此时 `directories` 为空，页面应整树重读。
 * `projectPath` 是发生变化的项目根，页面据此丢弃已切项目的迟到事件。
 */
export interface ProjectDirectoryChange {
  readonly kind: 'changed' | 'overflow'
  readonly projectPath: string
  readonly directories: readonly string[]
}

/** 单个条目的路径请求；同样只接受项目内相对路径，项目根由主进程决定。 */
export interface ProjectEntryPathRequest {
  readonly path: string
}

/** 条目路径解析结果：`path` 是规范化后的相对路径，`absolutePath` 是主进程按平台拼出的绝对路径。 */
export interface ProjectEntryPath {
  readonly path: string
  readonly absolutePath: string
}

export type ProjectEntryPathResult =
  | { readonly ok: true; readonly data: ProjectEntryPath }
  | { readonly ok: false; readonly error: DesktopError }

/** 在系统文件管理器中显示条目；成功不回传数据，失败带可展示的原因。 */
export type ProjectEntryRevealResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DesktopError }

/** 文件读写固定所属项目；路径仍必须是该已登记项目内的相对路径。 */
export interface ProjectFileReadRequest {
  readonly projectPath: string
  readonly path: string
}

/** 可编辑文本内容；`text` 已统一为 `\n` 换行，`eol` 与 `bom` 用于保存时还原原始格式。 */
export interface ProjectFileTextContent {
  readonly kind: 'text'
  readonly path: string
  readonly text: string
  readonly eol: ProjectFileEol
  readonly bom: boolean
  readonly size: number
  readonly mtimeMs: number
}

/** 图片内容；`base64` 由页面转成 `data:` URL 展示，不经过任何远程地址。 */
export interface ProjectFileImageContent {
  readonly kind: 'image'
  readonly path: string
  readonly mimeType: string
  readonly base64: string
  readonly size: number
  readonly mtimeMs: number
}

/** 不支持预览与编辑的内容：二进制或超出大小上限；只回原因，不搬运内容。 */
export interface ProjectFileUnsupportedContent {
  readonly kind: 'unsupported'
  readonly path: string
  readonly reason: 'binary' | 'too-large'
  readonly size: number
  readonly mtimeMs: number
}

export type ProjectFileContent =
  | ProjectFileTextContent
  | ProjectFileImageContent
  | ProjectFileUnsupportedContent

export type ProjectFileReadResult =
  | { readonly ok: true; readonly data: ProjectFileContent }
  | { readonly ok: false; readonly error: DesktopError }

/** 写入文件请求；`expected` 为 null 表示用户已确认覆盖，跳过磁盘基线比对。 */
export interface ProjectFileWriteRequest {
  readonly projectPath: string
  readonly path: string
  readonly text: string
  readonly eol: ProjectFileEol
  readonly bom: boolean
  readonly expected: { readonly size: number; readonly mtimeMs: number } | null
}

/** 写入成功后的新磁盘基线；页面据此更新脏状态与后续冲突判定。 */
export interface ProjectFileWriteData {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
}

export type ProjectFileWriteResult =
  | { readonly ok: true; readonly data: ProjectFileWriteData }
  | { readonly ok: false; readonly error: DesktopError }

/** 磁盘基线查询请求；用于标签重新激活或窗口重新聚焦时判断外部改动。 */
export interface ProjectFileStatRequest extends ProjectFileReadRequest {}

/** 磁盘基线；条目已不存在时 `exists` 为 false，size 与 mtimeMs 为 0。 */
export interface ProjectFileStatData {
  readonly path: string
  readonly exists: boolean
  readonly size: number
  readonly mtimeMs: number
}

export type ProjectFileStatResult =
  | { readonly ok: true; readonly data: ProjectFileStatData }
  | { readonly ok: false; readonly error: DesktopError }

export const PROJECT_MARKDOWN_DOCUMENTS_CHANNEL = 'desktop:project-markdown-documents'
export const PROJECT_MARKDOWN_IMAGE_CHANNEL = 'desktop:project-markdown-image'

export type ProjectMarkdownImageRequest = ProjectFileReadRequest & (
  | { readonly source: 'pick' }
  | { readonly source: 'clipboard'; readonly bytes: Uint8Array }
)
export type ProjectMarkdownImageResult =
  | { readonly ok: true; readonly data: { readonly projectPath: string; readonly path: string | null; readonly reference: string | null } }
  | { readonly ok: false; readonly error: DesktopError }
export type ProjectMarkdownDocumentsResult =
  | { readonly ok: true; readonly data: { readonly projectPath: string; readonly entries: readonly string[]; readonly truncated: boolean } }
  | { readonly ok: false; readonly error: DesktopError }

/** 图片来源只认系统选择器或粘贴事件字节，不接受页面提供的外部路径。 */
export function isProjectMarkdownImageRequest(value: unknown): value is ProjectMarkdownImageRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some(key => !['projectPath', 'path', 'source', 'bytes'].includes(key))) return false
  if (!isProjectFileReadRequest({ projectPath: value.projectPath, path: value.path })) return false
  return value.source === 'pick' ? !('bytes' in value)
    : value.source === 'clipboard' && value.bytes instanceof Uint8Array && value.bytes.byteLength > 0 && value.bytes.byteLength <= PROJECT_FILE_IMAGE_MAX_BYTES
}
export function isProjectMarkdownImageResult(value: unknown): value is ProjectMarkdownImageResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isProjectFileSearchResult(value)
  if (value.ok !== true || !isRecord(value.data)) return false
  const data = value.data
  return typeof data.projectPath === 'string' && ((data.path === null && data.reference === null)
    || (typeof data.path === 'string' && typeof data.reference === 'string'))
}
export function isProjectMarkdownDocumentsResult(value: unknown): value is ProjectMarkdownDocumentsResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return isProjectFileSearchResult(value)
  return value.ok === true && isRecord(value.data) && typeof value.data.projectPath === 'string'
    && typeof value.data.truncated === 'boolean' && Array.isArray(value.data.entries)
    && value.data.entries.length <= 20000 && value.data.entries.every(entry => typeof entry === 'string' && entry.length <= PROJECT_DIRECTORY_PATH_MAX_CHARS)
}

export interface ProjectFileApi {
  readonly listMarkdownDocuments: (request: ProjectFileReadRequest) => Promise<ProjectMarkdownDocumentsResult>
  readonly importMarkdownImage: (request: ProjectMarkdownImageRequest) => Promise<ProjectMarkdownImageResult>
  /** 在当前项目内按查询串检索文件路径；不接受目录参数，根路径由主进程决定。 */
  readonly searchProjectFiles: (query: string) => Promise<ProjectFileSearchResult>
  /** 列举当前项目内某一层的目录条目；不接受绝对路径，根路径由主进程决定。 */
  readonly listProjectDirectory: (request: ProjectDirectoryListRequest) => Promise<ProjectDirectoryListResult>
  /** 提交当前项目里需要监听的目录集合；主进程按集合增删监听，不递归。 */
  readonly watchProjectDirectories: (request: ProjectDirectoryWatchRequest) => Promise<ProjectDirectoryWatchResult>
  /** 订阅目录变化；回调只在主进程登记的层内触发，返回取消订阅函数。 */
  readonly onProjectDirectoryChanged: (listener: (change: ProjectDirectoryChange) => void) => () => void
  /** 把项目内相对条目路径解析为绝对路径；绝对路径、越界路径与非法段由主进程拒绝。 */
  readonly resolveProjectEntryPath: (request: ProjectEntryPathRequest) => Promise<ProjectEntryPathResult>
  /** 在系统文件管理器中显示一个项目内条目；条目已不存在时回可展示的原因。 */
  readonly revealProjectEntry: (request: ProjectEntryPathRequest) => Promise<ProjectEntryRevealResult>
  /** 读取项目内文件内容；文本、图片与不支持三类结果由主进程判定。 */
  readonly readProjectFile: (request: ProjectFileReadRequest) => Promise<ProjectFileReadResult>
  /** 写入项目内文本文件；磁盘基线不一致时回 CONFLICT，由界面提示用户继续编辑或覆盖保存。 */
  readonly writeProjectFile: (request: ProjectFileWriteRequest) => Promise<ProjectFileWriteResult>
  /** 查询项目内文件的磁盘基线；只回元数据，不读内容。 */
  readonly statProjectFile: (request: ProjectFileStatRequest) => Promise<ProjectFileStatResult>
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

/**
 * 监听请求校验：只接受 `directories` 一个字段，且必须是字符串数组；
 * 逐项范围校验（越界、绝对路径、超长）在主进程完成，这里只挡住结构异常。
 */
export function isProjectDirectoryWatchRequest(value: unknown): value is ProjectDirectoryWatchRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'directories')) return false
  return Array.isArray(value.directories)
    && value.directories.every((entry) => (
      typeof entry === 'string' && entry.length <= PROJECT_DIRECTORY_PATH_MAX_CHARS
    ))
}

/** 监听登记结果：成功只回生效目录数，失败沿用同一份错误结构。 */
export function isProjectDirectoryWatchResult(value: unknown): value is ProjectDirectoryWatchResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data) && typeof data.watching === 'number' && Number.isFinite(data.watching) && data.watching >= 0
  }
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

/** 目录变化事件校验：`changed` 必须给出目录，`overflow` 必须是空列表，未知 kind 一律拒绝。 */
export function isProjectDirectoryChange(value: unknown): value is ProjectDirectoryChange {
  if (!isRecord(value)) return false
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return false
  if (!Array.isArray(value.directories) || !value.directories.every((entry) => typeof entry === 'string')) return false
  if (value.kind === 'changed') return value.directories.length > 0
  if (value.kind === 'overflow') return value.directories.length === 0
  return false
}

function isProjectEntryPath(value: unknown): value is ProjectEntryPath {
  if (!isRecord(value)) return false
  return typeof value.path === 'string'
    && value.path !== ''
    && value.path.length <= PROJECT_DIRECTORY_PATH_MAX_CHARS
    && typeof value.absolutePath === 'string'
    && value.absolutePath !== ''
}

/** 条目路径请求与目录列举同一口径：只接受非空且不超过长度上限的相对路径字符串。 */
export function isProjectEntryPathRequest(value: unknown): value is ProjectEntryPathRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'path')) return false
  return typeof value.path === 'string'
    && value.path !== ''
    && value.path.length <= PROJECT_DIRECTORY_PATH_MAX_CHARS
}

/** 项目归属只做有界结构校验；主进程继续核对项目登记及路径安全。 */
export function isProjectFileReadRequest(value: unknown): value is ProjectFileReadRequest {
  if (!isRecord(value)) return false
  return Object.keys(value).every(key => key === 'projectPath' || key === 'path')
    && isFileProjectPath(value.projectPath)
    && typeof value.path === 'string' && value.path !== ''
    && value.path.length <= PROJECT_DIRECTORY_PATH_MAX_CHARS
}

function isFileProjectPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 4096
}

export function isProjectEntryPathResult(value: unknown): value is ProjectEntryPathResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isProjectEntryPath(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

/** 显示结果只区分成功与失败：成功没有数据，失败沿用同一份错误结构。 */
export function isProjectEntryRevealResult(value: unknown): value is ProjectEntryRevealResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

/** 磁盘基线里的数值只接受有限非负数；NaN、Infinity 与负值一律拒绝。 */
function isFileMetric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 文本、图片与「不支持」三类内容各自校验字段，未知 kind 一律拒绝。 */
function isProjectFileContent(value: unknown): value is ProjectFileContent {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string' || value.path === '') return false
  if (!isFileMetric(value.size) || !isFileMetric(value.mtimeMs)) return false

  if (value.kind === 'text') {
    return typeof value.text === 'string'
      && (value.eol === 'lf' || value.eol === 'crlf')
      && typeof value.bom === 'boolean'
  }
  if (value.kind === 'image') {
    return typeof value.mimeType === 'string' && value.mimeType !== ''
      && typeof value.base64 === 'string'
  }
  if (value.kind === 'unsupported') {
    return value.reason === 'binary' || value.reason === 'too-large'
  }
  return false
}

export function isProjectFileReadResult(value: unknown): value is ProjectFileReadResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isProjectFileContent(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

/**
 * 写入请求校验：只接受契约里的字段，`text` 必须是字符串，`expected` 要么为 null、要么给出完整的磁盘基线。
 * 写入请求由页面构造，主进程不能假定字段齐全。
 */
export function isProjectFileWriteRequest(value: unknown): value is ProjectFileWriteRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => (
    key !== 'projectPath' && key !== 'path' && key !== 'text' && key !== 'eol' && key !== 'bom' && key !== 'expected'
  ))) return false
  if (typeof value.path !== 'string' || value.path === '' || value.path.length > PROJECT_DIRECTORY_PATH_MAX_CHARS) {
    return false
  }
  if (!isFileProjectPath(value.projectPath) || typeof value.text !== 'string') return false
  if (value.eol !== 'lf' && value.eol !== 'crlf') return false
  if (typeof value.bom !== 'boolean') return false
  if (value.expected === null) return true
  if (!isRecord(value.expected)) return false
  if (Object.keys(value.expected).some((key) => key !== 'size' && key !== 'mtimeMs')) return false
  return isFileMetric(value.expected.size) && isFileMetric(value.expected.mtimeMs)
}

export function isProjectFileWriteResult(value: unknown): value is ProjectFileWriteResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && typeof data.path === 'string' && data.path !== ''
      && isFileMetric(data.size) && isFileMetric(data.mtimeMs)
  }
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

export function isProjectFileStatResult(value: unknown): value is ProjectFileStatResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    const data = value.data
    return isRecord(data)
      && typeof data.path === 'string' && data.path !== ''
      && typeof data.exists === 'boolean'
      && isFileMetric(data.size) && isFileMetric(data.mtimeMs)
  }
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}
