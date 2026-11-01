/** 工作树 IPC：创建固定所属项目，后续操作只引用已托管工作区，不接收页面提供的磁盘目录。 */
import type { DesktopError } from './desktop-api'
import { isWorkspaceContext, isWorkspaceId } from './workspace-api'
import type { WorkspaceApi, WorkspaceContext } from './workspace-api'

export const WORKTREE_LIST_CHANNEL = 'desktop:worktree-list'
export const WORKTREE_CREATE_CHANNEL = 'desktop:worktree-create'
export const WORKTREE_REMOVE_CHANNEL = 'desktop:worktree-remove'
export const WORKTREE_STATUS_CHANNEL = 'desktop:worktree-status'
export const WORKTREE_MERGE_CHANNEL = 'desktop:worktree-merge'
export const WORKTREE_BRANCH_NAME_REGEX = /^(?!\/)(?!.*(?:[/.]\.|\/\/|@\{|\\))[^ ~^:?*[\x00-\x1f\x7f]+(?<!\.|\/)$/u
export const WORKTREE_BRANCH_NAME_MAX_CHARS = 100

export interface WorktreeEntry {
  readonly path: string
  readonly branch: string | null
  readonly headCommit: string
  readonly isMain: boolean
  readonly isLocked: boolean
  readonly lockReason?: string
  readonly isPrunable?: boolean
}
export interface WorktreeStatus {
  readonly path: string
  readonly isClean: boolean
  readonly changedFileCount: number
  readonly untrackedFileCount: number
}
export interface WorktreeListRequest { readonly projectPath: string }
export interface CreateWorktreeRequest extends WorktreeListRequest { readonly baseBranch?: string }
export interface WorktreeStatusRequest extends WorktreeListRequest { readonly workspaceId: string }
export interface RemoveWorktreeRequest extends WorktreeStatusRequest {
  readonly deleteBranch?: boolean
  readonly force?: boolean
  readonly closeTerminals?: boolean
}
export interface MergeWorktreeRequest extends WorktreeStatusRequest {
  readonly squash?: boolean
  readonly deleteAfterMerge?: boolean
  readonly closeTerminals?: boolean
}
type Failure = { readonly ok: false; readonly error: DesktopError }
export type WorktreeListResult = Failure | {
  readonly ok: true
  readonly isRepository: boolean
  /** 非托管工作树只展示，不因此获得删除权限。 */
  readonly worktrees: readonly WorktreeEntry[]
  readonly workspaces: readonly WorkspaceContext[]
}
export type CreateWorktreeResult = Failure | { readonly ok: true; readonly workspace: WorkspaceContext }
export type RemoveWorktreeResult = Failure | { readonly ok: true; readonly workspace: WorkspaceContext }
export type WorktreeStatusResult = Failure | {
  readonly ok: true; readonly workspace: WorkspaceContext; readonly status: WorktreeStatus; readonly runningTerminals: number; readonly destinationRunningTerminals: number
}
export type MergeWorktreeResult = Failure | {
  readonly ok: true
  readonly workspace: WorkspaceContext
  readonly mergedCommit: string
  readonly cleanedUp: boolean
  readonly cleanupError: string | null
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}
function failure(value: Record<string, unknown>): boolean {
  return value.ok === false && record(value.error) && typeof value.error.code === 'string'
    && typeof value.error.message === 'string'
}
function project(value: Record<string, unknown>): boolean {
  return typeof value.projectPath === 'string' && value.projectPath.trim() !== '' && value.projectPath.length <= 4096
}
function scope(value: Record<string, unknown>): boolean { return project(value) && isWorkspaceId(value.workspaceId) }
export function isWorktreeListRequest(value: unknown): value is WorktreeListRequest {
  return record(value) && project(value) && keys(value, ['projectPath'])
}
export function isCreateWorktreeRequest(value: unknown): value is CreateWorktreeRequest {
  return record(value) && project(value) && keys(value, ['projectPath', 'baseBranch'])
    && (value.baseBranch === undefined || (typeof value.baseBranch === 'string'
      && value.baseBranch.trim() !== '' && value.baseBranch.length <= 255 && !value.baseBranch.startsWith('-')
      && !/[\x00-\x1f\x7f]/u.test(value.baseBranch)))
}
export function isWorktreeStatusRequest(value: unknown): value is WorktreeStatusRequest {
  return record(value) && scope(value) && keys(value, ['projectPath', 'workspaceId'])
}
export function isRemoveWorktreeRequest(value: unknown): value is RemoveWorktreeRequest {
  return record(value) && scope(value) && keys(value, ['projectPath', 'workspaceId', 'deleteBranch', 'force', 'closeTerminals'])
    && (value.deleteBranch === undefined || typeof value.deleteBranch === 'boolean')
    && (value.force === undefined || typeof value.force === 'boolean')
    && (value.closeTerminals === undefined || typeof value.closeTerminals === 'boolean')
}
export function isMergeWorktreeRequest(value: unknown): value is MergeWorktreeRequest {
  return record(value) && scope(value) && keys(value, ['projectPath', 'workspaceId', 'squash', 'deleteAfterMerge', 'closeTerminals'])
    && (value.squash === undefined || typeof value.squash === 'boolean')
    && (value.deleteAfterMerge === undefined || typeof value.deleteAfterMerge === 'boolean')
    && (value.closeTerminals === undefined || typeof value.closeTerminals === 'boolean')
}
export function isWorktreeEntry(value: unknown): value is WorktreeEntry {
  return record(value) && typeof value.path === 'string' && (value.branch === null || typeof value.branch === 'string')
    && typeof value.headCommit === 'string' && typeof value.isMain === 'boolean' && typeof value.isLocked === 'boolean'
    && (value.lockReason === undefined || typeof value.lockReason === 'string')
    && (value.isPrunable === undefined || typeof value.isPrunable === 'boolean')
}
export function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  return record(value) && typeof value.path === 'string' && typeof value.isClean === 'boolean'
    && typeof value.changedFileCount === 'number' && Number.isSafeInteger(value.changedFileCount) && value.changedFileCount >= 0
    && typeof value.untrackedFileCount === 'number' && Number.isSafeInteger(value.untrackedFileCount) && value.untrackedFileCount >= 0
}
export function isWorktreeListResult(value: unknown): value is WorktreeListResult {
  return record(value) && (failure(value) || (value.ok === true && typeof value.isRepository === 'boolean'
    && Array.isArray(value.worktrees) && value.worktrees.every(isWorktreeEntry)
    && Array.isArray(value.workspaces) && value.workspaces.every(isWorkspaceContext)))
}
export function isCreateWorktreeResult(value: unknown): value is CreateWorktreeResult {
  return record(value) && (failure(value) || (value.ok === true && isWorkspaceContext(value.workspace)))
}
export function isRemoveWorktreeResult(value: unknown): value is RemoveWorktreeResult { return isCreateWorktreeResult(value) }
export function isWorktreeStatusResult(value: unknown): value is WorktreeStatusResult {
  if (!record(value)) return false
  if (value.ok === false) return failure(value)
  return value.ok === true
    && isWorkspaceContext(value.workspace)
    && isWorktreeStatus(value.status)
    && typeof value.runningTerminals === 'number' && Number.isSafeInteger(value.runningTerminals) && value.runningTerminals >= 0
    && typeof value.destinationRunningTerminals === 'number' && Number.isSafeInteger(value.destinationRunningTerminals) && value.destinationRunningTerminals >= 0
}
export function isMergeWorktreeResult(value: unknown): value is MergeWorktreeResult {
  return record(value) && (failure(value) || (value.ok === true && isWorkspaceContext(value.workspace)
    && typeof value.mergedCommit === 'string' && value.mergedCommit !== '' && typeof value.cleanedUp === 'boolean'
    && (value.cleanupError === null || typeof value.cleanupError === 'string')
    && (value.cleanedUp === (value.workspace.phase === 'removed' && value.workspace.problem === null))))
}
export interface WorktreeApi extends WorkspaceApi {
  listWorktrees(request: WorktreeListRequest): Promise<WorktreeListResult>
  createWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult>
  removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult>
  getWorktreeStatus(request: WorktreeStatusRequest): Promise<WorktreeStatusResult>
  mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult>
}
