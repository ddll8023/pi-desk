/** 任务工作区的稳定身份与展示契约；目录由主进程授权，所有文件和执行请求固定工作区 ID。 */
import type { DesktopError } from './desktop-api'

export const WORKSPACE_RESOLVE_CHANNEL = 'desktop:workspace-resolve'
export interface WorkspaceTarget { readonly projectPath: string; readonly workspaceId: string }
export interface WorkspaceResolveRequest { readonly projectPath: string; readonly workspaceId?: string | null }
export type WorkspaceResolveResult = { readonly ok: true; readonly workspace: WorkspaceContext }
  | { readonly ok: false; readonly error: DesktopError }
export interface WorkspaceApi {
  readonly resolveWorkspace: (request: WorkspaceResolveRequest) => Promise<WorkspaceResolveResult>
}
export function workspaceTarget(context: WorkspaceContext): WorkspaceTarget {
  return { projectPath: context.projectPath, workspaceId: context.id }
}
export function isWorkspaceTarget(value: unknown): value is WorkspaceTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.projectPath === 'string' && item.projectPath.trim() !== '' && item.projectPath.length <= 4096
    && isWorkspaceId(item.workspaceId)
}
export function isWorkspaceResolveRequest(value: unknown): value is WorkspaceResolveRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.projectPath === 'string' && item.projectPath.trim() !== '' && item.projectPath.length <= 4096
    && (item.workspaceId === undefined || item.workspaceId === null || isWorkspaceId(item.workspaceId))
    && Object.keys(item).every(key => ['projectPath', 'workspaceId'].includes(key))
}
export function isWorkspaceResolveResult(value: unknown): value is WorkspaceResolveResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.ok === true) return isWorkspaceContext(item.workspace)
  if (item.ok !== false || typeof item.error !== 'object' || item.error === null) return false
  return 'code' in item.error && typeof item.error.code === 'string' && 'message' in item.error && typeof item.error.message === 'string'
}

export type WorkspacePhase = 'creating' | 'ready' | 'merging' | 'removing' | 'merged' | 'removed' | 'failed'

export interface WorkspaceContext {
  readonly id: string
  /** 主进程持久版本；页面据此拒绝覆盖生命周期更新的迟到响应。 */
  readonly revision: number
  readonly projectPath: string
  /** 实际执行根；仓库子项目在独立工作树内仍保留相同的相对目录。 */
  readonly rootPath: string
  readonly repositoryPath: string | null
  readonly worktreePath: string | null
  readonly kind: 'project' | 'task'
  readonly branch: string | null
  readonly baseCommit: string | null
  /** 创建任务时固定的合入目标分支；切换目标分支后拒绝静默合入。 */
  readonly destinationBranch: string | null
  readonly phase: WorkspacePhase
  /** 合入已成功但清理失败时保留结果，不把任务伪装成已删除。 */
  readonly mergedCommit: string | null
  /** 合入时任务分支的确切 HEAD；清理前拒绝删除其后新增的提交。 */
  readonly mergedTaskCommit: string | null
  readonly problem: string | null
}

const PHASES: readonly string[] = ['creating', 'ready', 'merging', 'removing', 'merged', 'removed', 'failed']
export function isWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
}
export function isWorkspaceContext(value: unknown): value is WorkspaceContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const nullableText = (text: unknown): boolean => text === null || (typeof text === 'string' && text.length > 0)
  return isWorkspaceId(item.id) && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0
    && typeof item.projectPath === 'string' && item.projectPath.length > 0
    && typeof item.rootPath === 'string' && item.rootPath.length > 0
    && nullableText(item.repositoryPath) && nullableText(item.worktreePath)
    && (item.kind === 'project' || item.kind === 'task') && nullableText(item.branch)
    && nullableText(item.baseCommit) && nullableText(item.destinationBranch)
    && typeof item.phase === 'string' && PHASES.includes(item.phase)
    && nullableText(item.mergedCommit) && nullableText(item.mergedTaskCommit) && nullableText(item.problem)
    && (item.kind === 'task' ? item.worktreePath !== null && item.repositoryPath !== null && item.branch !== null
      : item.worktreePath === null && item.rootPath === item.projectPath)
    && Object.keys(item).every(key => ['id', 'revision', 'projectPath', 'rootPath', 'repositoryPath', 'worktreePath',
      'kind', 'branch', 'baseCommit', 'destinationBranch', 'phase', 'mergedCommit', 'mergedTaskCommit', 'problem'].includes(key))
}
