/**
 * 定义 Git Worktree 隔离与生命周期管理的跨进程 IPC 契约：
 * 包含多工作树列举、创建独立隔离工作树、移除工作树与临时分支，以及工作树干净状态检测。
 *
 * 安全与设计原则：
 * - 页面不能传入任意外部路径，创建的工作树统一由主进程分配并规范在 `.pi/worktrees/<branchName>` 下；
 * - 页面写操作（创建、删除）必须通过可信页面校验与项目信任门禁；
 * - 移除工作树时主工作树（`isMain: true`）被主进程强制阻断，防止误删主仓库根。
 */
import type { DesktopError } from './desktop-api'

export const WORKTREE_LIST_CHANNEL = 'desktop:worktree-list'
export const WORKTREE_CREATE_CHANNEL = 'desktop:worktree-create'
export const WORKTREE_REMOVE_CHANNEL = 'desktop:worktree-remove'
export const WORKTREE_STATUS_CHANNEL = 'desktop:worktree-status'
export const WORKTREE_MERGE_CHANNEL = 'desktop:worktree-merge'

/** 分支名称格式校验规则：符合常见 Git 分支命名规范，禁止包含路径遍历字符。 */
export const WORKTREE_BRANCH_NAME_REGEX = /^(?!\/)(?!.*(?:[/.]\.|\/\/|@\{|\\))[^ ~^:?*[\x00-\x1f\x7f]+(?<!\.|\/)$/u

/** 分支名称最大字符数。 */
export const WORKTREE_BRANCH_NAME_MAX_CHARS = 100

/** 单个工作树条目描述。 */
export interface WorktreeEntry {
  /** 工作树在宿主系统中的绝对路径（已做规范化）。 */
  readonly path: string
  /** 关联的 Git 分支名称（例如 "feature/abc" 或 "pi/task-123"）；detached HEAD 时为 null。 */
  readonly branch: string | null
  /** 当前 HEAD 指向的完整的 Commit Hash。 */
  readonly headCommit: string
  /** 是否为当前 Git 仓库的主工作树（仓库初始根目录）。 */
  readonly isMain: boolean
  /** 是否被 Git 锁定（例如因网络文件系统挂载或防止被 prune）。 */
  readonly isLocked: boolean
  /** 锁定原因说明。 */
  readonly lockReason?: string
  /** 是否处于 prunable 状态（如磁盘目录已被外部删除）。 */
  readonly isPrunable?: boolean
}

/** 工作树的未提交改动检测状态。 */
export interface WorktreeStatus {
  /** 工作树绝对路径。 */
  readonly path: string
  /** 是否为干净状态（无未提交的已暂存/未暂存改动）。 */
  readonly isClean: boolean
  /** 改动（修改/新增/删除）文件数量统计。 */
  readonly changedFileCount: number
  /** 未跟踪文件数量统计。 */
  readonly untrackedFileCount: number
}

// ======================== 请求与响应类型 ========================

export type WorktreeListResult =
  | {
    readonly ok: true
    /** 当前项目是否为有效的 Git 仓库。不是仓库时为 false 且 worktrees 为空列表。 */
    readonly isRepository: boolean
    /** 工作树条目列表；第一个通常为主工作树。 */
    readonly worktrees: readonly WorktreeEntry[]
  }
  | {
    readonly ok: false
    readonly error: DesktopError
  }

export interface CreateWorktreeRequest {
  /** 新工作树绑定的分支名（必须符合 Git 分支规范）。 */
  readonly branchName: string
  /** 可选的基准分支或提交；未提供时默认基于当前仓库 HEAD 创建。 */
  readonly baseBranch?: string
}

export type CreateWorktreeResult =
  | {
    readonly ok: true
    readonly worktree: WorktreeEntry
  }
  | {
    readonly ok: false
    readonly error: DesktopError
  }

export interface RemoveWorktreeRequest {
  /** 待移除的工作树绝对路径。 */
  readonly worktreePath: string
  /** 是否一并删除关联的 Git 本地临时分支。默认 true。 */
  readonly deleteBranch?: boolean
  /** 是否强制移除（有未提交改动时）。默认 false。 */
  readonly force?: boolean
}

export type RemoveWorktreeResult =
  | {
    readonly ok: true
  }
  | {
    readonly ok: false
    readonly error: DesktopError
  }

export interface WorktreeStatusRequest {
  /** 待检测的工作树绝对路径。 */
  readonly worktreePath: string
}

export type WorktreeStatusResult =
  | {
    readonly ok: true
    readonly status: WorktreeStatus
  }
  | {
    readonly ok: false
    readonly error: DesktopError
  }

export interface MergeWorktreeRequest {
  /** 待合入主分支的工作树绝对路径。 */
  readonly worktreePath: string
  /** 是否以 Squash 方式合入主分支。默认 false。 */
  readonly squash?: boolean
  /** 合并成功后是否自动清理该工作树目录及分支。默认 true。 */
  readonly deleteAfterMerge?: boolean
}

export type MergeWorktreeResult =
  | {
    readonly ok: true
    readonly mergedCommit: string
  }
  | {
    readonly ok: false
    readonly error: DesktopError
  }

// ======================== 类型守护（Type Guards） ========================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDesktopError(value: unknown): value is DesktopError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
}

export function isWorktreeEntry(value: unknown): value is WorktreeEntry {
  if (!isRecord(value)) return false
  return (
    typeof value.path === 'string' &&
    (value.branch === null || typeof value.branch === 'string') &&
    typeof value.headCommit === 'string' &&
    typeof value.isMain === 'boolean' &&
    typeof value.isLocked === 'boolean' &&
    (value.lockReason === undefined || typeof value.lockReason === 'string') &&
    (value.isPrunable === undefined || typeof value.isPrunable === 'boolean')
  )
}

export function isWorktreeListResult(value: unknown): value is WorktreeListResult {
  if (!isRecord(value)) return false
  if (value.ok === true) {
    return typeof value.isRepository === 'boolean' && Array.isArray(value.worktrees) && value.worktrees.every(isWorktreeEntry)
  }
  if (value.ok === false) {
    return isDesktopError(value.error)
  }
  return false
}

export function isCreateWorktreeRequest(value: unknown): value is CreateWorktreeRequest {
  if (!isRecord(value)) return false
  return (
    typeof value.branchName === 'string' &&
    value.branchName.trim() !== '' &&
    value.branchName.length <= WORKTREE_BRANCH_NAME_MAX_CHARS &&
    WORKTREE_BRANCH_NAME_REGEX.test(value.branchName) &&
    (value.baseBranch === undefined || (typeof value.baseBranch === 'string' && value.baseBranch.trim() !== ''))
  )
}

export function isCreateWorktreeResult(value: unknown): value is CreateWorktreeResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isWorktreeEntry(value.worktree)
  if (value.ok === false) return isDesktopError(value.error)
  return false
}

export function isRemoveWorktreeRequest(value: unknown): value is RemoveWorktreeRequest {
  if (!isRecord(value)) return false
  return (
    typeof value.worktreePath === 'string' &&
    value.worktreePath.trim() !== '' &&
    (value.deleteBranch === undefined || typeof value.deleteBranch === 'boolean') &&
    (value.force === undefined || typeof value.force === 'boolean')
  )
}

export function isRemoveWorktreeResult(value: unknown): value is RemoveWorktreeResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return true
  if (value.ok === false) return isDesktopError(value.error)
  return false
}

export function isWorktreeStatusRequest(value: unknown): value is WorktreeStatusRequest {
  if (!isRecord(value)) return false
  return typeof value.worktreePath === 'string' && value.worktreePath.trim() !== ''
}

export function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  if (!isRecord(value)) return false
  return (
    typeof value.path === 'string' &&
    typeof value.isClean === 'boolean' &&
    typeof value.changedFileCount === 'number' &&
    typeof value.untrackedFileCount === 'number'
  )
}

export function isWorktreeStatusResult(value: unknown): value is WorktreeStatusResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return isWorktreeStatus(value.status)
  if (value.ok === false) return isDesktopError(value.error)
  return false
}

export function isMergeWorktreeRequest(value: unknown): value is MergeWorktreeRequest {
  if (!isRecord(value)) return false
  return (
    typeof value.worktreePath === 'string' &&
    value.worktreePath.trim() !== '' &&
    (value.squash === undefined || typeof value.squash === 'boolean') &&
    (value.deleteAfterMerge === undefined || typeof value.deleteAfterMerge === 'boolean')
  )
}

export function isMergeWorktreeResult(value: unknown): value is MergeWorktreeResult {
  if (!isRecord(value)) return false
  if (value.ok === true) return typeof value.mergedCommit === 'string'
  if (value.ok === false) return isDesktopError(value.error)
  return false
}

/** 供 preload 暴露给前端页面的 Worktree 桥接接口。 */
export interface WorktreeApi {
  listWorktrees(): Promise<WorktreeListResult>
  createWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult>
  removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult>
  getWorktreeStatus(request: WorktreeStatusRequest): Promise<WorktreeStatusResult>
  mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult>
}
