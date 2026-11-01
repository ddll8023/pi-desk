/** 主进程任务工作区所有者：持久身份、会话绑定、托管路径授权及生命周期；不从前台项目或临时标签推断执行目录。 */
import { randomUUID } from 'node:crypto'
import { relative, isAbsolute } from 'node:path'
import type { DesktopError } from '../../shared/desktop-api'
import { isWorkspaceTarget } from '../../shared/workspace-api'
import type { WorkspaceContext, WorkspacePhase, WorkspaceResolveRequest, WorkspaceTarget } from '../../shared/workspace-api'
import type { CreateWorktreeRequest, CreateWorktreeResult, MergeWorktreeRequest, MergeWorktreeResult,
  RemoveWorktreeRequest, RemoveWorktreeResult, WorktreeListRequest, WorktreeListResult,
  WorktreeStatusRequest, WorktreeStatusResult } from '../../shared/worktree-api'
import { GitCommandError } from '../git/git-command'
import { WorktreeOperationError } from '../git/worktree-service'
import type { WorktreeService } from '../git/worktree-service'
import type { ProjectManager } from '../projects/project-manager'
import type { TrustManager } from '../trust/trust-manager'
import { normalizeProjectPath } from '../shared/project-path'
import { WorkspaceStorageError } from './workspace-store'
import type { WorkspaceStore } from './workspace-store'

interface WorkspaceManagerOptions {
  readonly store: WorkspaceStore
  readonly worktrees: WorktreeService
  readonly projects: ProjectManager
  readonly trust: TrustManager
  /** 只收敛空闲实例；打开中、未确认或执行中的实例必须拒绝，不自动中断。 */
  readonly closeWorkspaceRuns: (workspaceIds: readonly string[]) => Promise<void>
  readonly countTerminals: (workspaceId: string) => Promise<number>
  readonly settleTerminals: (workspaceId: string, consent: boolean) => Promise<void>
  readonly releaseViews: (workspaceId: string) => void
}
export function workspaceError(error: unknown): DesktopError {
  if (error instanceof WorktreeOperationError) return { code: error.code, message: error.message }
  if (error instanceof GitCommandError) return { code: error.kind === 'unavailable' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED', message: error.message }
  return { code: 'INTERNAL_ERROR', message: error instanceof WorkspaceStorageError || error instanceof Error
    ? error.message : '工作区操作失败，未选择替代执行目录。' }
}
function under(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part))
}

export class WorkspaceManager {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly blocked = new Set<string>()
  private readonly uses = new Map<string, number>()
  constructor(private readonly options: WorkspaceManagerOptions) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation)
    this.tail = task.catch(() => {})
    return task
  }
  private async project(path: string): Promise<string> {
    const normalized = await normalizeProjectPath(path)
    if (!await this.options.projects.hasProject(normalized)) throw new WorktreeOperationError('FORBIDDEN', '工作区所属项目未登记。')
    return normalized
  }
  private async writeTrust(projectPath: string): Promise<void> {
    const trust = await this.options.trust.resolveLaunchDecision(projectPath)
    if (trust.requiresPrompt || trust.decision === 'untrusted') throw new WorktreeOperationError('TRUST_REQUIRED', '请先在所属项目完成信任决定，再执行工作区写操作。')
  }
  private async get(projectPath: string, workspaceId: string): Promise<WorkspaceContext> {
    const project = await this.project(projectPath)
    const catalog = await this.options.store.read()
    const workspace = catalog.workspaces.find(item => item.id === workspaceId && item.projectPath === project)
    if (!workspace) throw new WorktreeOperationError('FORBIDDEN', '找不到该项目托管的工作区，未使用页面提供的其他目录。')
    return workspace
  }
  private async put(workspace: WorkspaceContext): Promise<WorkspaceContext> {
    let saved = workspace
    await this.options.store.update(catalog => {
      const previous = catalog.workspaces.find(item => item.id === workspace.id)
      saved = { ...workspace, revision: (previous?.revision ?? 0) + 1 }
      return { ...catalog, workspaces: [...catalog.workspaces.filter(item => item.id !== workspace.id), saved] }
    })
    return saved
  }
  private async phase(workspace: WorkspaceContext, phase: WorkspacePhase, problem: string | null = null): Promise<WorkspaceContext> {
    return this.put({ ...workspace, phase, problem })
  }
  /** 新建时可指定已有工作区；已有会话的持久绑定不允许被另一次打开请求改写。 */
  resolveForSession(projectPath: string, sessionId: string | null, requestedId?: string | null): Promise<WorkspaceContext> {
    return this.serial(async () => {
      const project = await this.project(projectPath)
      const catalog = await this.options.store.read()
      const binding = sessionId === null ? undefined : catalog.bindings.find(item => item.projectPath === project && item.sessionId === sessionId)
      if (binding && requestedId && binding.workspaceId !== requestedId) throw new WorktreeOperationError('CONFLICT', '该会话已绑定其他工作区，不允许静默改绑。')
      const id = binding?.workspaceId ?? requestedId
      let workspace = id ? catalog.workspaces.find(item => item.id === id && item.projectPath === project)
        : catalog.workspaces.find(item => item.projectPath === project && item.kind === 'project')
      if (id && !workspace) throw new WorktreeOperationError('FORBIDDEN', '指定工作区不属于该项目。')
      if (!workspace) workspace = await this.put({ id: randomUUID(), revision: 1, projectPath: project, rootPath: project,
        repositoryPath: null, worktreePath: null, kind: 'project', branch: null, baseCommit: null,
        destinationBranch: null, phase: 'ready', mergedCommit: null, mergedTaskCommit: null, problem: null })
      return this.authorize(project, workspace.id)
    })
  }
  async resolveWorkspace(request: WorkspaceResolveRequest): Promise<WorkspaceContext> {
    return request.workspaceId ? this.get(request.projectPath, request.workspaceId)
      : this.resolveForSession(request.projectPath, null)
  }
  async contextForSession(projectPath: string, sessionId: string): Promise<WorkspaceContext> {
    const project = await this.project(projectPath)
    const catalog = await this.options.store.read()
    const binding = catalog.bindings.find(item => item.projectPath === project && item.sessionId === sessionId)
    return binding ? this.get(project, binding.workspaceId) : this.resolveForSession(project, null)
  }
  async contextFor(target: WorkspaceTarget, mode: 'read' | 'write' | 'run' = 'read'): Promise<WorkspaceContext> {
    const allowed = (workspace: WorkspaceContext): boolean => (workspace.phase === 'ready' || mode === 'read' && workspace.phase === 'merged')
      && !this.blocked.has(workspace.id)
    const workspace = await this.get(target.projectPath, target.workspaceId)
    if (!allowed(workspace)) throw new WorktreeOperationError('CONFLICT', workspace.problem ?? '工作区当前不可执行该操作，未切回主目录。')
    await this.options.worktrees.assertUsable(workspace)
    const latest = await this.get(target.projectPath, target.workspaceId)
    if (!allowed(latest)) throw new WorktreeOperationError('CONFLICT', '工作区生命周期已变化，未继续执行。')
    return latest
  }
  authorize(projectPath: string, workspaceId: string): Promise<WorkspaceContext> {
    return this.contextFor({ projectPath, workspaceId }, 'run')
  }
  /** 请求从进入授权到操作完成持有占用，清理不能跨过原生对话框或在途文件/Git/终端请求。 */
  async use<T>(target: WorkspaceTarget, mode: 'read' | 'write' | 'run', operation: (context: WorkspaceContext) => Promise<T>): Promise<T> {
    if (!isWorkspaceTarget(target) || this.blocked.has(target.workspaceId)) throw new WorktreeOperationError('CONFLICT', '工作区请求已失效或正在收敛。')
    const id = target.workspaceId
    this.uses.set(id, (this.uses.get(id) ?? 0) + 1)
    try { return await operation(await this.contextFor(target, mode)) }
    finally {
      const remaining = (this.uses.get(id) ?? 1) - 1
      if (remaining === 0) this.uses.delete(id)
      else this.uses.set(id, remaining)
    }
  }
  private block(ids: readonly string[]): void {
    if (ids.some(id => (this.uses.get(id) ?? 0) > 0)) throw new WorktreeOperationError('CONFLICT', '工作区仍有在途文件、Git 或终端操作，请待其完成后再处理任务。')
    for (const id of ids) this.blocked.add(id)
  }
  async bindSession(projectPath: string, sessionId: string | null, workspaceId: string): Promise<void> {
    if (sessionId === null) return
    const workspace = await this.authorize(projectPath, workspaceId)
    await this.options.store.update(catalog => {
      const current = catalog.workspaces.find(item => item.id === workspaceId)
      if (!current || current.phase !== 'ready' || this.blocked.has(workspaceId)) throw new WorktreeOperationError('CONFLICT', '工作区已停止接收会话绑定。')
      const old = catalog.bindings.find(item => item.projectPath === workspace.projectPath && item.sessionId === sessionId)
      if (old && old.workspaceId !== workspaceId) throw new WorktreeOperationError('CONFLICT', '会话已有不同工作区绑定，未覆盖。')
      if (old) return catalog
      return { ...catalog, bindings: [...catalog.bindings, { projectPath: workspace.projectPath, sessionId, workspaceId }] }
    })
  }
  async listWorktrees(request: WorktreeListRequest): Promise<Extract<WorktreeListResult, { ok: true }>> {
    const project = await this.project(request.projectPath)
    const inventory = await this.options.worktrees.listWorktrees(project)
    const catalog = await this.options.store.read()
    return { ok: true, isRepository: inventory.repository !== null, worktrees: inventory.worktrees,
      workspaces: catalog.workspaces.filter(item => item.projectPath === project) }
  }
  createWorktree(request: CreateWorktreeRequest): Promise<Extract<CreateWorktreeResult, { ok: true }>> {
    return this.serial(async () => {
      const project = await this.project(request.projectPath)
      await this.writeTrust(project)
      let workspace = await this.options.worktrees.planWorkspace(project, randomUUID(), request.baseBranch)
      workspace = await this.put(workspace)
      try {
        await this.options.worktrees.createWorktree(workspace)
        workspace = await this.phase(workspace, 'ready')
        return { ok: true, workspace }
      } catch (error) {
        // 创建失败可能已经产生部分 Git 资源，保留记录，不擅自删除或伪装成未创建。
        await this.phase(workspace, 'failed', workspaceError(error).message)
        throw error
      }
    })
  }
  async checkWorktreeStatus(request: WorktreeStatusRequest): Promise<Extract<WorktreeStatusResult, { ok: true }>> {
    const workspace = await this.get(request.projectPath, request.workspaceId)
    if (workspace.kind !== 'task' || !['ready', 'merged'].includes(workspace.phase)) throw new WorktreeOperationError('CONFLICT', '任务工作树当前不可读取状态。')
    const status = await this.options.worktrees.checkWorktreeStatus(workspace)
    const runningTerminals = await this.options.countTerminals(workspace.id)
    const counts = await Promise.all((await this.targets(workspace, true)).filter(id => id !== workspace.id).map(id => this.options.countTerminals(id)))
    return { ok: true, workspace, status, runningTerminals, destinationRunningTerminals: counts.reduce((sum, count) => sum + count, 0) }
  }
  private async targets(workspace: WorkspaceContext, includeDestination: boolean): Promise<readonly string[]> {
    const catalog = await this.options.store.read()
    return catalog.workspaces.filter(item => item.id === workspace.id || (includeDestination && workspace.repositoryPath
      && item.kind === 'project' && under(workspace.repositoryPath, item.rootPath))).map(item => item.id)
  }
  removeWorktree(request: RemoveWorktreeRequest): Promise<Extract<RemoveWorktreeResult, { ok: true }>> {
    return this.serial(async () => {
      let workspace = await this.get(request.projectPath, request.workspaceId)
      await this.writeTrust(workspace.projectPath)
      if (workspace.kind !== 'task' || !['ready', 'merged'].includes(workspace.phase)) throw new WorktreeOperationError('FORBIDDEN', '只能移除已完成创建的托管任务工作树。')
      const original = workspace
      let mutating = false
      let removed = false
      this.block([workspace.id])
      try {
        workspace = await this.phase(workspace, 'removing')
        await this.options.settleTerminals(workspace.id, request.closeTerminals === true)
        await this.options.closeWorkspaceRuns([workspace.id])
        this.options.releaseViews(workspace.id)
        mutating = true
        const result = await this.options.worktrees.removeWorktree(workspace,
          { force: request.force === true, deleteBranch: request.deleteBranch !== false })
        removed = true
        workspace = await this.phase(workspace, 'removed', result.cleanupError)
        return { ok: true, workspace }
      } catch (error) {
        if (!removed) await this.phase(original, !mutating || error instanceof WorktreeOperationError ? original.phase : 'failed', workspaceError(error).message)
        throw error
      } finally { this.blocked.delete(workspace.id) }
    })
  }
  mergeWorktree(request: MergeWorktreeRequest): Promise<Extract<MergeWorktreeResult, { ok: true }>> {
    return this.serial(async () => {
      let workspace = await this.get(request.projectPath, request.workspaceId)
      await this.writeTrust(workspace.projectPath)
      if (workspace.kind !== 'task' || workspace.phase !== 'ready') throw new WorktreeOperationError('CONFLICT', '该任务不可重复合入；已合入任务请直接重试清理。')
      const original = workspace
      const targets = await this.targets(workspace, true)
      this.block(targets)
      let mergedCommit: string | null = null
      let mutating = false
      try {
        workspace = await this.phase(workspace, 'merging')
        if (request.closeTerminals !== true && (await Promise.all(targets.map(id => this.options.countTerminals(id)))).some(count => count > 0)) throw new WorktreeOperationError('CONFLICT', '任务或合入目标仍有运行中的终端，须明确确认关闭后再合入。')
        for (const id of targets) await this.options.settleTerminals(id, request.closeTerminals === true)
        await this.options.closeWorkspaceRuns(targets)
        this.options.releaseViews(workspace.id)
        mutating = true
        const merged = await this.options.worktrees.mergeWorktree(workspace, request.squash === true)
        mergedCommit = merged.mergedCommit
        workspace = await this.put({ ...workspace, phase: 'merged', mergedCommit, mergedTaskCommit: merged.taskCommit, problem: null })
        if (request.deleteAfterMerge === false) {
          return { ok: true, workspace, mergedCommit, cleanedUp: false, cleanupError: null }
        }
        try {
          const cleanup = await this.options.worktrees.removeWorktree(workspace, { force: false, deleteBranch: true })
          workspace = await this.phase(workspace, 'removed', cleanup.cleanupError)
          return { ok: true, workspace, mergedCommit, cleanedUp: cleanup.cleanupError === null, cleanupError: cleanup.cleanupError }
        } catch (error) {
          const cleanupError = workspaceError(error).message
          workspace = await this.phase(workspace, 'merged', cleanupError)
          return { ok: true, workspace, mergedCommit, cleanedUp: false, cleanupError }
        }
      } catch (error) {
        // 合入后存储出错不能当作“尚未合入”重试；保留处理中记录，阻止重复写操作。
        if (mergedCommit === null) await this.phase(original, !mutating || error instanceof WorktreeOperationError ? 'ready' : 'failed', workspaceError(error).message)
        throw error
      } finally { for (const id of targets) this.blocked.delete(id) }
    })
  }
}
