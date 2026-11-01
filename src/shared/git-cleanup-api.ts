/**
 * Git 模块清理与维护共享 API 契约：
 * 定义仓库存储概览、托管任务工作树盘点、临时分支盘点、失效引用修剪与垃圾回收（GC）的 IPC 通道及类型校验。
 */
import type { DesktopError } from './desktop-api'

export const GIT_CLEANUP_SUMMARY_CHANNEL = 'desktop:git-cleanup-summary'
export const GIT_CLEANUP_PRUNE_WORKTREES_CHANNEL = 'desktop:git-cleanup-prune-worktrees'
export const GIT_CLEANUP_REMOVE_WORKTREES_CHANNEL = 'desktop:git-cleanup-remove-worktrees'
export const GIT_CLEANUP_REMOVE_BRANCHES_CHANNEL = 'desktop:git-cleanup-remove-branches'
export const GIT_CLEANUP_RUN_GC_CHANNEL = 'desktop:git-cleanup-run-gc'

/** 仓库存储与工作树/分支统计摘要 */
export interface GitStorageSummary {
  readonly repositoryRoot: string
  readonly currentBranch: string | null
  readonly gitDirBytes: number
  readonly totalWorktrees: number
  readonly prunableWorktrees: number
  readonly orphanWorktrees: number
  readonly totalTaskBranches: number
  readonly mergedTaskBranches: number
}

/** 任务工作树在清理视角下的详细状态条目 */
export interface TaskWorktreeCleanItem {
  readonly id: string
  readonly path: string
  readonly branch: string | null
  readonly headCommit: string
  readonly isMain: boolean
  readonly isLocked: boolean
  readonly lockReason?: string
  readonly isPrunable: boolean
  /** 是否为孤立工作树（在磁盘上存在或在 git 中记录，但未登记在 active workspace catalog 中） */
  readonly isOrphan: boolean
  /** 关联会话状态：ready / merged / removed / failed / null */
  readonly phase: string | null
  /** 工作树文件变动状态：为 null 表示 prunable 或无法读取 */
  readonly status: {
    readonly isClean: boolean
    readonly changedFileCount: number
    readonly untrackedFileCount: number
  } | null
}

/** 临时任务分支（pi/task-*）在清理视角下的详细条目 */
export interface TaskBranchCleanItem {
  readonly name: string
  readonly headCommit: string
  readonly commitSubject: string
  readonly commitTime: number
  /** 是否已被合入默认分支（HEAD/main/master 等） */
  readonly isMerged: boolean
  /** 是否仍有工作树正在使用该分支 */
  readonly isUsedByWorktree: boolean
}

/** 盘点请求与响应 */
export interface GitCleanupSummaryRequest {
  readonly projectPath: string
}

export type GitCleanupSummaryResult =
  | { readonly ok: false; readonly error: DesktopError }
  | {
    readonly ok: true
    readonly isRepository: boolean
    readonly summary: GitStorageSummary | null
    readonly worktrees: readonly TaskWorktreeCleanItem[]
    readonly taskBranches: readonly TaskBranchCleanItem[]
  }

/** 修剪失效工作树请求与响应 */
export interface GitPruneWorktreesRequest {
  readonly projectPath: string
}

export type GitPruneWorktreesResult =
  | { readonly ok: false; readonly error: DesktopError }
  | { readonly ok: true; readonly prunedCount: number }

/** 批量移除工作树请求与响应 */
export interface GitRemoveWorktreesRequest {
  readonly projectPath: string
  readonly worktreePaths: readonly string[]
  readonly force?: boolean
  readonly deleteBranch?: boolean
}

export type GitRemoveWorktreesResult =
  | { readonly ok: false; readonly error: DesktopError }
  | {
    readonly ok: true
    readonly removedCount: number
    readonly failedCount: number
    readonly errors: readonly string[]
  }

/** 批量删除临时任务分支请求与响应 */
export interface GitRemoveBranchesRequest {
  readonly projectPath: string
  readonly branchNames: readonly string[]
  readonly force?: boolean
}

export type GitRemoveBranchesResult =
  | { readonly ok: false; readonly error: DesktopError }
  | {
    readonly ok: true
    readonly removedCount: number
    readonly failedCount: number
    readonly errors: readonly string[]
  }

/** 执行 Git GC 垃圾回收请求与响应 */
export interface GitRunGcRequest {
  readonly projectPath: string
}

export interface GitGcResultData {
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly freedBytes: number
}

export type GitRunGcResult =
  | { readonly ok: false; readonly error: DesktopError }
  | { readonly ok: true; readonly data: GitGcResultData }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFailure(value: Record<string, unknown>): boolean {
  return value.ok === false && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
}

function isValidProjectPath(projectPath: unknown): projectPath is string {
  return typeof projectPath === 'string' && projectPath.trim() !== '' && projectPath.length <= 4096
}

export function isGitCleanupSummaryRequest(value: unknown): value is GitCleanupSummaryRequest {
  return isRecord(value) && isValidProjectPath(value.projectPath)
}

export function isGitPruneWorktreesRequest(value: unknown): value is GitPruneWorktreesRequest {
  return isRecord(value) && isValidProjectPath(value.projectPath)
}

export function isGitRemoveWorktreesRequest(value: unknown): value is GitRemoveWorktreesRequest {
  return isRecord(value)
    && isValidProjectPath(value.projectPath)
    && Array.isArray(value.worktreePaths)
    && value.worktreePaths.every((p) => typeof p === 'string' && p.trim() !== '')
    && (value.force === undefined || typeof value.force === 'boolean')
    && (value.deleteBranch === undefined || typeof value.deleteBranch === 'boolean')
}

export function isGitRemoveBranchesRequest(value: unknown): value is GitRemoveBranchesRequest {
  return isRecord(value)
    && isValidProjectPath(value.projectPath)
    && Array.isArray(value.branchNames)
    && value.branchNames.every((b) => typeof b === 'string' && b.trim() !== '')
    && (value.force === undefined || typeof value.force === 'boolean')
}

export function isGitRunGcRequest(value: unknown): value is GitRunGcRequest {
  return isRecord(value) && isValidProjectPath(value.projectPath)
}

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
)

function isWorktreeCleanItem(value: unknown): value is TaskWorktreeCleanItem {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.path !== 'string' || typeof value.headCommit !== 'string') return false
  if (!(value.branch === null || typeof value.branch === 'string')) return false
  if (typeof value.isMain !== 'boolean' || typeof value.isLocked !== 'boolean') return false
  if (typeof value.isPrunable !== 'boolean' || typeof value.isOrphan !== 'boolean') return false
  if (!(value.phase === null || typeof value.phase === 'string')) return false
  if (value.status === null) return true
  if (!isRecord(value.status)) return false
  return typeof value.status.isClean === 'boolean'
    && isNonNegativeInteger(value.status.changedFileCount)
    && isNonNegativeInteger(value.status.untrackedFileCount)
}

function isTaskBranchCleanItem(value: unknown): value is TaskBranchCleanItem {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.headCommit === 'string'
    && typeof value.commitSubject === 'string'
    && typeof value.commitTime === 'number'
    && typeof value.isMerged === 'boolean'
    && typeof value.isUsedByWorktree === 'boolean'
}

function isStorageSummary(value: unknown): value is GitStorageSummary {
  return isRecord(value)
    && typeof value.repositoryRoot === 'string'
    && (value.currentBranch === null || typeof value.currentBranch === 'string')
    && isNonNegativeInteger(value.gitDirBytes)
    && isNonNegativeInteger(value.totalWorktrees)
    && isNonNegativeInteger(value.prunableWorktrees)
    && isNonNegativeInteger(value.orphanWorktrees)
    && isNonNegativeInteger(value.totalTaskBranches)
    && isNonNegativeInteger(value.mergedTaskBranches)
}

export function isGitCleanupSummaryResult(value: unknown): value is GitCleanupSummaryResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true
    && typeof value.isRepository === 'boolean'
    && (value.summary === null || isStorageSummary(value.summary))
    && Array.isArray(value.worktrees)
    && value.worktrees.every(isWorktreeCleanItem)
    && Array.isArray(value.taskBranches)
    && value.taskBranches.every(isTaskBranchCleanItem)
}

export function isGitPruneWorktreesResult(value: unknown): value is GitPruneWorktreesResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true && isNonNegativeInteger(value.prunedCount)
}

function isBatchOutcome(value: Record<string, unknown>): boolean {
  return isNonNegativeInteger(value.removedCount)
    && isNonNegativeInteger(value.failedCount)
    && Array.isArray(value.errors)
    && value.errors.every((item) => typeof item === 'string')
}

export function isGitRemoveWorktreesResult(value: unknown): value is GitRemoveWorktreesResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true && isBatchOutcome(value)
}

export function isGitRemoveBranchesResult(value: unknown): value is GitRemoveBranchesResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true && isBatchOutcome(value)
}

export function isGitRunGcResult(value: unknown): value is GitRunGcResult {
  if (!isRecord(value)) return false
  if (value.ok === false) return hasFailure(value)
  return value.ok === true && isRecord(value.data)
    && isNonNegativeInteger(value.data.beforeBytes)
    && isNonNegativeInteger(value.data.afterBytes)
    && isNonNegativeInteger(value.data.freedBytes)
}

export interface GitCleanupApi {
  getGitCleanupSummary(request: GitCleanupSummaryRequest): Promise<GitCleanupSummaryResult>
  pruneWorktrees(request: GitPruneWorktreesRequest): Promise<GitPruneWorktreesResult>
  removeWorktrees(request: GitRemoveWorktreesRequest): Promise<GitRemoveWorktreesResult>
  removeTaskBranches(request: GitRemoveBranchesRequest): Promise<GitRemoveBranchesResult>
  runGitGc(request: GitRunGcRequest): Promise<GitRunGcResult>
}
