/** 工作树物理适配：显式仓库上下文、本地排除配置与仓库级写队列；托管身份和会话生命周期由工作区管理器负责。 */
import { access, appendFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import type { WorktreeEntry, WorktreeStatus } from '../../shared/worktree-api'
import type { WorkspaceContext } from '../../shared/workspace-api'
import { GIT_READ_TIMEOUT_MS, GitCommandError, runGit } from './git-command'
import { canonicalProjectRoot, resolveGitRepository } from './git-repository'
import type { GitRepository } from './git-repository'

export class WorktreeOperationError extends Error {
  constructor(readonly code: DesktopErrorCode, message: string) { super(message) }
}
function samePath(left: string, right: string): boolean {
  const a = resolve(left), b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error }
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part)
}

/** 解析 Git porcelain；第一条为主工作树，其他条目不因当前项目处于链接工作树而成为主工作树。 */
export function parseWorktreeListPorcelain(stdout: string, _mainRepoRoot: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const block of stdout.split(/\r?\n\r?\n/u)) {
    let path = '', headCommit = '', branch: string | null = null
    let isLocked = false, isPrunable = false
    let lockReason: string | undefined
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith('worktree ')) path = resolve(line.slice(9))
      else if (line.startsWith('HEAD ')) headCommit = line.slice(5)
      else if (line.startsWith('branch ')) branch = line.slice(7).replace(/^refs\/heads\//u, '')
      else if (line === 'detached') branch = null
      else if (line === 'locked' || line.startsWith('locked ')) {
        isLocked = true
        lockReason = line.slice(6).trim() || undefined
      } else if (line === 'prunable' || line.startsWith('prunable ')) isPrunable = true
    }
    if (path && headCommit) entries.push({ path, headCommit, branch, isMain: entries.length === 0,
      isLocked, ...(lockReason === undefined ? {} : { lockReason }), ...(isPrunable ? { isPrunable: true } : {}) })
  }
  return entries
}

export class WorktreeService {
  private readonly queues = new Map<string, Promise<unknown>>()

  private enqueue<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? repositoryPath.toLowerCase() : repositoryPath
    const task = (this.queues.get(key) ?? Promise.resolve()).then(operation, operation)
    const tail = task.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return task
  }
  async listWorktrees(projectPath: string): Promise<{ repository: GitRepository | null; worktrees: readonly WorktreeEntry[] }> {
    const repository = await resolveGitRepository(await canonicalProjectRoot(projectPath))
    if (!repository) return { repository: null, worktrees: [] }
    const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS })
    return { repository, worktrees: parseWorktreeListPorcelain(stdout, repository.root) }
  }
  private async branchOf(path: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: path, timeoutMs: GIT_READ_TIMEOUT_MS })
      return stdout.trim() || null
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed' && error.exitCode === 1) return null
      throw error
    }
  }
  async planWorkspace(projectPath: string, id: string, baseBranch?: string): Promise<WorkspaceContext> {
    const repository = await resolveGitRepository(projectPath)
    if (!repository) throw new WorktreeOperationError('NOT_A_REPOSITORY', '该项目不是有效的 Git 仓库。')
    const projectRoot = await canonicalProjectRoot(projectPath)
    const prefix = relative(repository.root, projectRoot)
    if (prefix && !inside(repository.root, projectRoot)) throw new WorktreeOperationError('FORBIDDEN', '项目不在对应仓库内。')
    const { stdout } = await runGit(['rev-parse', '--verify', '--end-of-options', `${baseBranch ?? 'HEAD'}^{commit}`],
      { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS })
    const baseCommit = stdout.trim()
    if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) throw new WorktreeOperationError('GIT_FAILED', '无法固定任务起始提交。')
    const worktreePath = join(repository.root, '.pi', 'worktrees', id)
    return { id, revision: 1, projectPath, rootPath: join(worktreePath, prefix), repositoryPath: repository.root,
      worktreePath, kind: 'task', branch: `pi/task-${id}`, baseCommit,
      destinationBranch: await this.branchOf(repository.root), phase: 'creating', mergedCommit: null, mergedTaskCommit: null, problem: null }
  }
  private async managedPath(workspace: WorkspaceContext): Promise<{ repositoryPath: string; path: string }> {
    if (workspace.kind !== 'task' || !workspace.repositoryPath || !workspace.worktreePath || !workspace.branch) {
      throw new WorktreeOperationError('FORBIDDEN', '只能操作应用登记的任务工作树。')
    }
    const repositoryPath = await realpath(workspace.repositoryPath)
    if (!samePath(repositoryPath, workspace.repositoryPath)) throw new WorktreeOperationError('FORBIDDEN', '任务所属仓库的真实目录已变化。')
    const expected = join(repositoryPath, '.pi', 'worktrees', workspace.id)
    if (!samePath(workspace.worktreePath, expected) || !inside(expected, workspace.rootPath) && !samePath(expected, workspace.rootPath)) {
      throw new WorktreeOperationError('FORBIDDEN', '任务目录与托管身份不一致。')
    }
    // 不允许 .pi、worktrees 或任务目录经符号链接逃离仓库；不存在的末级目录留给创建操作建立。
    for (const path of [join(repositoryPath, '.pi'), join(repositoryPath, '.pi', 'worktrees'), expected]) {
      if (await exists(path) && !samePath(await realpath(path), path)) throw new WorktreeOperationError('FORBIDDEN', '托管目录包含重定向的符号链接。')
    }
    return { repositoryPath, path: expected }
  }
  async assertUsable(workspace: WorkspaceContext): Promise<void> {
    if (workspace.kind === 'project') {
      const stat = await lstat(workspace.rootPath)
      if (!stat.isDirectory()) throw new WorktreeOperationError('INVALID_REQUEST', '项目执行目录不可用。')
      return
    }
    await this.registeredEntry(workspace)
    const root = await realpath(workspace.rootPath)
    if (!samePath(root, workspace.rootPath)) throw new WorktreeOperationError('FORBIDDEN', '任务执行根被重定向。')
    const stat = await lstat(root)
    if (!stat.isDirectory()) throw new WorktreeOperationError('INVALID_REQUEST', '任务执行根不是目录。')
  }
  private async registeredEntry(workspace: WorkspaceContext): Promise<WorktreeEntry> {
    const { repositoryPath, path } = await this.managedPath(workspace)
    const inventory = await this.listWorktrees(repositoryPath)
    if (!inventory.repository || !samePath(inventory.repository.root, repositoryPath)) throw new WorktreeOperationError('FORBIDDEN', '任务所属仓库不一致。')
    const entry = inventory.worktrees.find(item => samePath(item.path, path))
    if (!entry || entry.isMain || entry.branch !== workspace.branch || entry.isPrunable || entry.isLocked) {
      throw new WorktreeOperationError('CONFLICT', '托管工作树已丢失、换分支或被锁定；未改用其他目录。')
    }
    return entry
  }
  private async ensureLocalExclude(repositoryPath: string): Promise<void> {
    const { stdout } = await runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
    const file = resolve(repositoryPath, stdout.trim())
    let content = ''
    try { content = await readFile(file, 'utf8') } catch (error) { if (!missing(error)) throw error }
    if (content.split(/\r?\n/u).some(line => ['.pi/worktrees/', '/.pi/worktrees/'].includes(line.trim()))) return
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${content && !content.endsWith('\n') ? '\n' : ''}# pi-desk task workspaces\n/.pi/worktrees/\n`, 'utf8')
  }
  private async linkDependencies(repositoryPath: string, path: string): Promise<void> {
    for (const name of ['node_modules', '.venv', 'vendor']) {
      const source = join(repositoryPath, name), destination = join(path, name)
      try {
        if (!await exists(source) || await exists(destination) || !(await lstat(source)).isDirectory()) continue
        // 只共享明确忽略的可再生目录，不能把仓库已跟踪内容替换成链接。
        await runGit(['check-ignore', '--quiet', '--', name], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
        await symlink(process.platform === 'win32' ? source : relative(path, source), destination,
          process.platform === 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (error instanceof GitCommandError && error.exitCode === 1) continue
        console.warn(`[worktree] 未共享依赖目录 ${name}：`, error)
      }
    }
  }
  async createWorktree(workspace: WorkspaceContext): Promise<void> {
    const { repositoryPath, path } = await this.managedPath(workspace)
    await this.enqueue(repositoryPath, async () => {
      if (await exists(path)) throw new WorktreeOperationError('CONFLICT', '任务目录已存在，未覆盖。')
      if (!workspace.branch || !workspace.baseCommit) throw new WorktreeOperationError('INVALID_REQUEST', '任务缺少固定分支或起始提交。')
      await this.ensureLocalExclude(repositoryPath)
      await runGit(['worktree', 'add', '-b', workspace.branch, path, workspace.baseCommit], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      await this.linkDependencies(repositoryPath, path)
      await this.assertUsable(workspace)
    })
  }
  async checkWorktreeStatus(workspace: WorkspaceContext): Promise<WorktreeStatus> {
    const entry = await this.registeredEntry(workspace)
    const { stdout } = await runGit(['status', '--porcelain=v1', '-z'], { cwd: entry.path, timeoutMs: GIT_READ_TIMEOUT_MS })
    let changedFileCount = 0, untrackedFileCount = 0
    const entries = stdout.split('\0')
    for (let index = 0; index < entries.length; index++) {
      const line = entries[index]
      if (!line) continue
      if (line.startsWith('??')) untrackedFileCount++
      else {
        changedFileCount++
        if (line.slice(0, 2).includes('R') || line.slice(0, 2).includes('C')) index++
      }
    }
    return { path: entry.path, isClean: changedFileCount === 0 && untrackedFileCount === 0, changedFileCount, untrackedFileCount }
  }
  async removeWorktree(workspace: WorkspaceContext, options: { readonly force: boolean; readonly deleteBranch: boolean }): Promise<{ cleanupError: string | null }> {
    const { repositoryPath } = await this.managedPath(workspace)
    return this.enqueue(repositoryPath, () => this.removeInQueue(workspace, options))
  }
  /** 只有公开入口入队；合入与移除不在队列内相互调用，避免等待自身尾部。 */
  private async removeInQueue(workspace: WorkspaceContext, options: { readonly force: boolean; readonly deleteBranch: boolean }): Promise<{ cleanupError: string | null }> {
    const { repositoryPath } = await this.managedPath(workspace)
    const entry = await this.registeredEntry(workspace)
    if (workspace.mergedTaskCommit !== null && entry.headCommit !== workspace.mergedTaskCommit) {
      throw new WorktreeOperationError('CONFLICT', '合入后任务分支又产生了提交，未删除这些新成果。')
    }
    await runGit(['worktree', 'remove', ...(options.force ? ['--force'] : []), entry.path], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
    if (options.deleteBranch && workspace.branch) {
      try {
        await runGit(['branch', options.force || workspace.mergedCommit ? '-D' : '-d', '--', workspace.branch],
          { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      } catch (error) { return { cleanupError: `工作树目录已移除，临时分支保留：${error instanceof Error ? error.message : String(error)}` } }
    }
    return { cleanupError: null }
  }
  async mergeWorktree(workspace: WorkspaceContext, squash: boolean): Promise<{ mergedCommit: string; taskCommit: string }> {
    const { repositoryPath } = await this.managedPath(workspace)
    return this.enqueue(repositoryPath, async () => {
      const entry = await this.registeredEntry(workspace)
      const destinationBranch = await this.branchOf(repositoryPath)
      if (!destinationBranch || destinationBranch !== workspace.destinationBranch) throw new WorktreeOperationError('CONFLICT', '合入目标分支已变化，未合入其他分支。')
      const { stdout: mainStatus } = await runGit(['status', '--porcelain=v1'], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      if (mainStatus.trim()) throw new WorktreeOperationError('CONFLICT', '目标工作区存在未提交修改；本阶段不自动处理这些修改。')
      const taskStatus = await this.checkWorktreeStatus(workspace)
      if (!taskStatus.isClean) {
        // 任务尚有未提交成果时先暂存并提交再合入；该交付提交不是独立轮次检查点。
        await runGit(['add', '-A'], { cwd: entry.path, timeoutMs: GIT_READ_TIMEOUT_MS })
        await runGit(['commit', '-m', 'pi-desk: finalize before merge', '--no-verify'], { cwd: entry.path, timeoutMs: GIT_READ_TIMEOUT_MS })
      }
      const { stdout: taskHead } = await runGit(['rev-parse', 'HEAD'], { cwd: entry.path, timeoutMs: GIT_READ_TIMEOUT_MS })
      const branch = workspace.branch
      if (!branch) throw new WorktreeOperationError('INVALID_REQUEST', '任务没有可合入分支。')
      await runGit(squash ? ['merge', '--squash', branch] : ['merge', '--no-ff', branch, '-m', `Merge task '${workspace.id}'`],
        { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      if (squash) await runGit(['commit', '-m', `Squash task '${workspace.id}'`], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repositoryPath, timeoutMs: GIT_READ_TIMEOUT_MS })
      return { mergedCommit: stdout.trim(), taskCommit: taskHead.trim() }
    })
  }
}
