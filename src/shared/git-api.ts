/**
 * 定义右侧面板「源代码管理」的 IPC 契约：状态读取、单文件差异、提交历史与提交内差异，以及
 * 暂存/取消暂存/丢弃/提交四类写操作与拉取/推送两条远端操作。
 *
 * 与项目文件契约同一口径：页面只给项目内相对路径，项目根与仓库根由主进程解析，页面不能指定仓库、
 * 不能传入任何 git 参数。暂存/取消暂存/丢弃支持单个相对路径或批量相对路径（`GitWritePathRequest`）。
 * 状态读取不带参数，历史按条数/偏移与可选过滤路径读取；写操作成功后直接回传新的状态，避免「写完再拉一次」的竞态。
 * 远端操作同样不接受参数：远端、分支与推送策略全部由主进程从仓库现状与用户自己的 git 配置得出。
 * 写操作会执行仓库里的 filter 与 hook，因此项目尚无信任决定或被标记为未信任时返回 `TRUST_REQUIRED`；
 * 读操作（状态、差异、历史）不执行仓库代码，不做信任拦截。
 * 「不是 Git 仓库」是正常结果（`isRepository: false`）而不是错误，界面据此显示空态。
 * 状态条目与提交内文件都有硬上限（`GIT_STATUS_LIMIT` / `GIT_COMMIT_FILES_LIMIT`）：超过时截断并如实标记，
 * 界面提示而不是假装列全。
 */
import type { DesktopError } from './desktop-api'

export const GIT_STATUS_CHANNEL = 'desktop:git-status'
export const GIT_DIFF_CHANNEL = 'desktop:git-diff'
export const GIT_STAGE_CHANNEL = 'desktop:git-stage'
export const GIT_UNSTAGE_CHANNEL = 'desktop:git-unstage'
export const GIT_DISCARD_CHANNEL = 'desktop:git-discard'
export const GIT_COMMIT_CHANNEL = 'desktop:git-commit'
export const GIT_PULL_CHANNEL = 'desktop:git-pull'
export const GIT_PUSH_CHANNEL = 'desktop:git-push'
export const GIT_HISTORY_CHANNEL = 'desktop:git-history'
export const GIT_COMMIT_DETAIL_CHANNEL = 'desktop:git-commit-detail'
export const GIT_COMMIT_DIFF_CHANNEL = 'desktop:git-commit-diff'

/**
 * 改动条目上限：与 Orca 同口径取 1000。仓库里有一个没被忽略的大目录时，porcelain 能列出几十万条，
 * 渲染端与主进程都会因此变慢；到上限就停掉 git 子进程并只显示前 N 条。
 */
export const GIT_STATUS_LIMIT = 1000

/** 单文件 diff 的文本上限；超出按「过大」返回，不截断也不提供编辑。 */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024

/** 提交信息长度上限；主进程与页面共用同一份判定。 */
export const GIT_COMMIT_MESSAGE_MAX_CHARS = 5000

/** 一次历史读取返回的提交数；翻页按 skip 递增。 */
export const GIT_HISTORY_LIMIT = 50

/** 历史读取的单次上限：页面可以要求更少，但不能要求更多。 */
export const GIT_HISTORY_MAX_LIMIT = 200

/** 单个提交最多列出多少个改动文件；超出截断并如实标记。 */
export const GIT_COMMIT_FILES_LIMIT = 500

/** 改动所处区域：已暂存、未暂存（工作区）或未跟踪。 */
export type GitArea = 'staged' | 'unstaged' | 'untracked'

/** 改动类型；重命名与复制只出现在已暂存区域。 */
export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked'

/** porcelain v2 的 7 种未合并（冲突）类型，与 Git 的 XY 组合一一对应。 */
export type GitConflictKind =
  | 'both_modified'
  | 'both_added'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'
  | 'deleted_by_us'
  | 'deleted_by_them'

/** 当前仓库正处于哪种未完成操作；用于显示「中止合并/中止变基」入口。 */
export type GitConflictOperation = 'merge' | 'rebase' | 'cherry-pick'

/** 一个改动条目；`path` 是项目内 POSIX 相对路径，与项目文件契约一致。 */
export interface GitChangeEntry {
  readonly path: string
  readonly area: GitArea
  readonly status: GitChangeStatus
  /** 重命名/复制的原路径；仅已暂存区域可能出现。 */
  readonly oldPath?: string
  readonly conflictKind?: GitConflictKind
}

/** 上游分支的相对位置；没有上游时为 null。 */
export interface GitUpstream {
  readonly name: string
  readonly ahead: number
  readonly behind: number
}

/**
 * 一次状态快照。
 * `projectPath` 是本次读取的项目根：页面据此丢弃切换项目后的迟到结果（与文件检索同一手法）。
 * `repositoryRoot` 与项目根不同说明项目是仓库的子目录，条目路径已折算成项目内相对路径。
 */
export interface GitStatus {
  readonly projectPath: string
  readonly isRepository: boolean
  readonly repositoryRoot: string | null
  /** 当前提交 oid；空仓库为 null。 */
  readonly head: string | null
  /** 短分支名；分离 HEAD 或空仓库时为 null。 */
  readonly branch: string | null
  readonly detached: boolean
  readonly upstream: GitUpstream | null
  /** 已配置的远端名；空数组表示没有远端，界面据此区分「不能推送」与「需要发布分支」。 */
  readonly remotes: readonly string[]
  readonly conflictOperation: GitConflictOperation | null
  readonly entries: readonly GitChangeEntry[]
  /** 条目数超过上限被截断；界面提示而不是假装列全。 */
  readonly truncated: boolean
  /** 实际看到的改动条目总数（含被截断的部分）。 */
  readonly totalCount: number
  readonly generatedAt: number
}

export type GitStatusResult =
  | { readonly ok: true; readonly data: GitStatus }
  | { readonly ok: false; readonly error: DesktopError }

/** 写操作成功后直接回传新状态，页面不需要再拉一次。 */
export type GitOperationResult = GitStatusResult

/** diff 请求：路径 + 区域。区域决定两侧内容的来源（索引 / HEAD / 工作区）。 */
export interface GitDiffRequest {
  readonly path: string
  readonly area: GitArea
}

/**
 * 两侧内容的公共形状：工作区差异与提交内差异共用，界面只需要渲染一种结构。
 * `originalText` 为 null 表示该侧不存在（新增文件没有原内容，删除文件没有新内容）；
 * `kind` 为 `binary` / `too-large` 时两侧都是 null，界面只给提示。
 */
export interface GitTextDiff {
  readonly kind: 'text' | 'binary' | 'too-large'
  readonly originalText: string | null
  readonly modifiedText: string | null
  /** 统一成 `\n` 之前观察到的原始换行符；页面渲染不依赖它，仅用于说明。 */
  readonly eol: 'lf' | 'crlf'
  readonly truncated: boolean
}

/** 工作区里的单文件差异：索引/HEAD 与工作区相比。 */
export interface GitDiff extends GitTextDiff {
  readonly path: string
  readonly area: GitArea
}

export type GitDiffResult =
  | { readonly ok: true; readonly data: GitDiff }
  | { readonly ok: false; readonly error: DesktopError }

/**
 * 历史里的一个提交摘要。
 * `pushed` 只在仓库有上游时才可能为 true：没有上游意味着这些提交确实还没推到任何地方。
 */
export interface GitCommitSummary {
  readonly oid: string
  readonly shortOid: string
  readonly subject: string
  readonly authorName: string
  readonly authorEmail: string
  /** 作者时间（毫秒）。 */
  readonly authoredAt: number
  readonly parents: readonly string[]
  /** `%D` 里的引用名，已按逗号拆开（例如 `HEAD -> main`、`origin/main`、`tag: v1.0`）。 */
  readonly refs: readonly string[]
  readonly pushed: boolean
}

export interface GitHistory {
  readonly projectPath: string
  readonly isRepository: boolean
  /** 上游分支名；没有上游时为 null。 */
  readonly upstreamName: string | null
  /** 本地领先上游的提交数；没有上游时为 0。 */
  readonly aheadCount: number
  readonly commits: readonly GitCommitSummary[]
  /** 还有更早的提交可翻页。 */
  readonly hasMore: boolean
  readonly limit: number
  /** 本次历史是否按路径过滤；null 表示整仓库。 */
  readonly path: string | null
}

export type GitHistoryResult =
  | { readonly ok: true; readonly data: GitHistory }
  | { readonly ok: false; readonly error: DesktopError }

/** 历史读取请求：limit/skip 分页，path 可选地只看某个文件的历史。 */
export interface GitHistoryRequest {
  readonly limit?: number
  readonly skip?: number
  readonly path?: string
}

/** 提交里的一个文件；`added`/`removed` 是这次提交对该文件的行数增减。 */
export interface GitCommitFile {
  readonly path: string
  readonly status: GitChangeStatus
  readonly oldPath?: string
  readonly added?: number
  readonly removed?: number
}

export interface GitCommitDetail {
  readonly oid: string
  readonly shortOid: string
  readonly subject: string
  /** 提交信息正文（不含标题行）；没有正文时为空串。 */
  readonly body: string
  readonly authorName: string
  readonly authorEmail: string
  readonly authoredAt: number
  readonly parents: readonly string[]
  readonly refs: readonly string[]
  readonly files: readonly GitCommitFile[]
  /** 文件数超过上限被截断。 */
  readonly truncated: boolean
}

export type GitCommitDetailResult =
  | { readonly ok: true; readonly data: GitCommitDetail }
  | { readonly ok: false; readonly error: DesktopError }

export interface GitCommitDetailRequest {
  readonly oid: string
}

/** 提交内单文件差异：父提交（根提交为空）与该提交相比。 */
export interface GitCommitDiff extends GitTextDiff {
  readonly oid: string
  readonly path: string
}

export type GitCommitDiffResult =
  | { readonly ok: true; readonly data: GitCommitDiff }
  | { readonly ok: false; readonly error: DesktopError }

export interface GitCommitDiffRequest {
  readonly oid: string
  readonly path: string
  /** 重命名/复制条目的原路径：原内容要从父提交的这个路径取，否则会显示成「新文件」。 */
  readonly oldPath?: string
}

/** 单文件写操作请求：只接受项目内相对路径。 */
export interface GitPathRequest {
  readonly path: string
}

/** 多文件写操作请求：支持批量传递项目内相对路径。 */
export interface GitPathsRequest {
  readonly paths: readonly string[]
}

/** 写操作请求：支持单个相对路径或批量相对路径。 */
export type GitWritePathRequest = GitPathRequest | GitPathsRequest

/** 提交请求：只接受提交信息，选项与作者一律沿用用户自己的 git 配置。 */
export interface GitCommitRequest {
  readonly message: string
}

export interface GitApi {
  readonly getGitStatus: () => Promise<GitStatusResult>
  readonly getGitDiff: (request: GitDiffRequest) => Promise<GitDiffResult>
  readonly stageGitPaths: (request: GitWritePathRequest) => Promise<GitOperationResult>
  readonly unstageGitPaths: (request: GitWritePathRequest) => Promise<GitOperationResult>
  readonly discardGitPath: (request: GitWritePathRequest) => Promise<GitOperationResult>
  readonly commitGitStaged: (request: GitCommitRequest) => Promise<GitOperationResult>
  readonly pullGit: () => Promise<GitOperationResult>
  readonly pushGit: () => Promise<GitOperationResult>
  readonly getGitHistory: (request: GitHistoryRequest) => Promise<GitHistoryResult>
  readonly getGitCommitDetail: (request: GitCommitDetailRequest) => Promise<GitCommitDetailResult>
  readonly getGitCommitDiff: (request: GitCommitDiffRequest) => Promise<GitCommitDiffResult>
}

const AREAS: readonly string[] = ['staged', 'unstaged', 'untracked']
const CHANGE_STATUSES: readonly string[] = ['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked']
const CONFLICT_KINDS: readonly string[] = [
  'both_modified',
  'both_added',
  'both_deleted',
  'added_by_us',
  'added_by_them',
  'deleted_by_us',
  'deleted_by_them'
]
const CONFLICT_OPERATIONS: readonly string[] = ['merge', 'rebase', 'cherry-pick']

/** 相对路径长度上限：只拒绝明显异常的值，真实范围校验在主进程。 */
const MAX_PATH_CHARS = 4096

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isArea(value: unknown): value is GitArea {
  return typeof value === 'string' && AREAS.includes(value)
}

function isChangeEntry(value: unknown): value is GitChangeEntry {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string' || value.path === '' || value.path.length > MAX_PATH_CHARS) return false
  if (!isArea(value.area)) return false
  if (typeof value.status !== 'string' || !CHANGE_STATUSES.includes(value.status)) return false
  if (value.oldPath !== undefined && (typeof value.oldPath !== 'string' || value.oldPath === '')) return false
  if (value.conflictKind !== undefined) {
    if (typeof value.conflictKind !== 'string' || !CONFLICT_KINDS.includes(value.conflictKind)) return false
  }
  return true
}

function isUpstream(value: unknown): value is GitUpstream {
  if (!isRecord(value)) return false
  return typeof value.name === 'string' && value.name !== ''
    && isCount(value.ahead) && isCount(value.behind)
}

function isGitStatus(value: unknown): value is GitStatus {
  if (!isRecord(value)) return false
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return false
  if (typeof value.isRepository !== 'boolean') return false
  if (value.repositoryRoot !== null && typeof value.repositoryRoot !== 'string') return false
  if (value.head !== null && typeof value.head !== 'string') return false
  if (value.branch !== null && typeof value.branch !== 'string') return false
  if (typeof value.detached !== 'boolean') return false
  if (value.upstream !== null && !isUpstream(value.upstream)) return false
  if (!Array.isArray(value.remotes) || !value.remotes.every((entry) => typeof entry === 'string')) return false
  if (value.conflictOperation !== null) {
    if (typeof value.conflictOperation !== 'string' || !CONFLICT_OPERATIONS.includes(value.conflictOperation)) {
      return false
    }
  }
  if (typeof value.truncated !== 'boolean') return false
  if (!isCount(value.totalCount)) return false
  if (typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt)) return false
  return Array.isArray(value.entries) && value.entries.every(isChangeEntry)
}

function isGitTextDiff(value: Record<string, unknown>): boolean {
  if (value.kind !== 'text' && value.kind !== 'binary' && value.kind !== 'too-large') return false
  if (value.originalText !== null && typeof value.originalText !== 'string') return false
  if (value.modifiedText !== null && typeof value.modifiedText !== 'string') return false
  if (value.eol !== 'lf' && value.eol !== 'crlf') return false
  if (typeof value.truncated !== 'boolean') return false
  // 文本 diff 至少有一侧内容；两侧都为空只可能是二进制或过大。
  return value.kind === 'text' ? value.originalText !== null || value.modifiedText !== null : true
}

function isGitDiff(value: unknown): value is GitDiff {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string' || value.path === '') return false
  if (!isArea(value.area)) return false
  return isGitTextDiff(value)
}

function isGitCommitDiff(value: unknown): value is GitCommitDiff {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string' || value.path === '') return false
  if (!isOid(value.oid)) return false
  return isGitTextDiff(value)
}

/** 提交 oid：短哈希与完整哈希都接受，只允许十六进制。 */
function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/u.test(value)
}

function isCommitSummary(value: unknown): value is GitCommitSummary {
  if (!isRecord(value)) return false
  if (!isOid(value.oid) || !isOid(value.shortOid)) return false
  if (typeof value.subject !== 'string') return false
  if (typeof value.authorName !== 'string' || typeof value.authorEmail !== 'string') return false
  if (typeof value.authoredAt !== 'number' || !Number.isFinite(value.authoredAt)) return false
  if (typeof value.pushed !== 'boolean') return false
  if (!Array.isArray(value.parents) || !value.parents.every((entry) => typeof entry === 'string')) return false
  return Array.isArray(value.refs) && value.refs.every((entry) => typeof entry === 'string')
}

function isGitHistory(value: unknown): value is GitHistory {
  if (!isRecord(value)) return false
  if (typeof value.projectPath !== 'string' || value.projectPath === '') return false
  if (typeof value.isRepository !== 'boolean') return false
  if (value.upstreamName !== null && typeof value.upstreamName !== 'string') return false
  if (!isCount(value.aheadCount)) return false
  if (typeof value.hasMore !== 'boolean') return false
  if (!isCount(value.limit) || value.limit === 0) return false
  if (value.path !== null && typeof value.path !== 'string') return false
  return Array.isArray(value.commits) && value.commits.every(isCommitSummary)
}

function isCommitFile(value: unknown): value is GitCommitFile {
  if (!isRecord(value)) return false
  if (typeof value.path !== 'string' || value.path === '') return false
  if (typeof value.status !== 'string' || !CHANGE_STATUSES.includes(value.status)) return false
  if (value.oldPath !== undefined && (typeof value.oldPath !== 'string' || value.oldPath === '')) return false
  if (value.added !== undefined && !isCount(value.added)) return false
  if (value.removed !== undefined && !isCount(value.removed)) return false
  return true
}

function isGitCommitDetail(value: unknown): value is GitCommitDetail {
  if (!isRecord(value)) return false
  if (!isOid(value.oid) || !isOid(value.shortOid)) return false
  if (typeof value.subject !== 'string' || typeof value.body !== 'string') return false
  if (typeof value.authorName !== 'string' || typeof value.authorEmail !== 'string') return false
  if (typeof value.authoredAt !== 'number' || !Number.isFinite(value.authoredAt)) return false
  if (typeof value.truncated !== 'boolean') return false
  if (!Array.isArray(value.parents) || !value.parents.every((entry) => typeof entry === 'string')) return false
  if (!Array.isArray(value.refs) || !value.refs.every((entry) => typeof entry === 'string')) return false
  return Array.isArray(value.files) && value.files.every(isCommitFile)
}

// TypeScript 声明不能保证 invoke 的实际返回值；沙箱桥接只放行本契约。
export function isGitStatusResult(value: unknown): value is GitStatusResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGitStatus(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

export function isGitDiffResult(value: unknown): value is GitDiffResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGitDiff(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

export function isGitHistoryResult(value: unknown): value is GitHistoryResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGitHistory(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

export function isGitCommitDetailResult(value: unknown): value is GitCommitDetailResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGitCommitDetail(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

export function isGitCommitDiffResult(value: unknown): value is GitCommitDiffResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isGitCommitDiff(value.data)
  if (value.ok !== false || !isRecord(value.error)) return false

  const { code, message } = value.error
  return typeof code === 'string' && typeof message === 'string'
}

/** 单文件写操作请求校验：只接受一个项目内相对路径字段。 */
export function isGitPathRequest(value: unknown): value is GitPathRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'path')) return false
  return typeof value.path === 'string' && value.path !== '' && value.path.length <= MAX_PATH_CHARS
}

/** 批量写操作请求校验：接受非空相对路径数组。 */
export function isGitPathsRequest(value: unknown): value is GitPathsRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'paths')) return false
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > GIT_STATUS_LIMIT) return false
  return value.paths.every((p) => typeof p === 'string' && p !== '' && p.length <= MAX_PATH_CHARS)
}

/** 写操作请求校验：接受单个路径或非空相对路径数组。 */
export function isGitWritePathRequest(value: unknown): value is GitWritePathRequest {
  return isGitPathRequest(value) || isGitPathsRequest(value)
}

/** diff 请求校验：路径 + 区域，字段之外一律拒绝。 */
export function isGitDiffRequest(value: unknown): value is GitDiffRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'path' && key !== 'area')) return false
  if (typeof value.path !== 'string' || value.path === '' || value.path.length > MAX_PATH_CHARS) return false
  return isArea(value.area)
}

/** 历史请求校验：limit/skip 可选，path 可选且必须是项目内相对路径。 */
export function isGitHistoryRequest(value: unknown): value is GitHistoryRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'limit' && key !== 'skip' && key !== 'path')) return false
  if (value.limit !== undefined && (!isCount(value.limit) || value.limit === 0 || value.limit > GIT_HISTORY_MAX_LIMIT)) {
    return false
  }
  if (value.skip !== undefined && !isCount(value.skip)) return false
  if (value.path !== undefined) {
    if (typeof value.path !== 'string' || value.path === '' || value.path.length > MAX_PATH_CHARS) return false
  }
  return true
}

export function isGitCommitDetailRequest(value: unknown): value is GitCommitDetailRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'oid')) return false
  return isOid(value.oid)
}

export function isGitCommitDiffRequest(value: unknown): value is GitCommitDiffRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'oid' && key !== 'path' && key !== 'oldPath')) return false
  if (!isOid(value.oid)) return false
  if (value.oldPath !== undefined) {
    if (typeof value.oldPath !== 'string' || value.oldPath === '' || value.oldPath.length > MAX_PATH_CHARS) return false
  }
  return typeof value.path === 'string' && value.path !== '' && value.path.length <= MAX_PATH_CHARS
}

/** 提交请求校验：只接受非空、不超长的提交信息。 */
export function isGitCommitRequest(value: unknown): value is GitCommitRequest {
  if (!isRecord(value)) return false
  if (Object.keys(value).some((key) => key !== 'message')) return false
  if (typeof value.message !== 'string') return false
  if (value.message.trim() === '') return false
  return value.message.length <= GIT_COMMIT_MESSAGE_MAX_CHARS
}
