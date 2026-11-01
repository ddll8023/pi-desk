/**
 * Git 模块清理与维护服务：盘点仓库存储占用、托管任务工作树与临时任务分支，并执行修剪、移除、删分支与垃圾回收。
 *
 * 设计要点：
 * - **只清理应用自己建立的东西**：只有落在 `<仓库根>/.pi/worktrees/` 下的工作树才可获得删除权限，
 *   其它工作树只展示状态，避免误删用户自己的多工作树布局。
 * - **状态先看清再动手**：工作树是否干净、是否仍被会话登记、分支是否已合入当前分支都由主进程判断，
 *   页面只提交「要清理哪些」，不提交任意 git 参数。
 * - **孤立与已合入分开**：孤立工作树指磁盘上还在但不属于任何登记会话；已合入但未清理的工作树是合入后残留。
 *   两者可以一键清理，但强制丢弃未提交改动必须由调用方显式标记。
 * - **GC 是重活**：`git gc` 会重写打包文件，单独给足超时，失败只回传原因，不影响其它清理动作。
 */
import { readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  GitCleanupSummaryResult,
  GitGcResultData,
  GitPruneWorktreesResult,
  GitRemoveBranchesRequest,
  GitRemoveBranchesResult,
  GitRemoveWorktreesRequest,
  GitRemoveWorktreesResult,
  GitRunGcResult,
  GitStorageSummary,
  TaskBranchCleanItem,
  TaskWorktreeCleanItem
} from '../../shared/git-cleanup-api'
import type { WorkspaceContext } from '../../shared/workspace-api'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import { GIT_READ_TIMEOUT_MS, GitCommandError, runGit } from './git-command'
import { canonicalProjectRoot, resolveGitRepository } from './git-repository'
import type { WorktreeService } from './worktree-service'

/** `git gc` 需要重写打包文件，单独给长超时；仍给上限，避免异常仓库让命令永久挂着。 */
const GIT_GC_TIMEOUT_MS = 10 * 60_000

/** 托管工作树目录：与 WorktreeService 使用同一路径口径。 */
const MANAGED_WORKTREE_SEGMENTS = ['.pi', 'worktrees'] as const

/** 临时任务分支前缀：只有这个前缀的分支出现在清理列表里。 */
const TASK_BRANCH_PREFIX = 'pi/task-'

/** 目录体积估算的条目上限；超出即停止累加，只用于展示规模，不当作精确占用。 */
const MAX_SIZE_ENTRIES = 200_000

export class GitCleanupError extends Error {
  constructor(readonly code: DesktopErrorCode, message: string) {
    super(message)
    this.name = 'GitCleanupError'
  }
}

export interface GitCleanupServiceOptions {
  /** 工作树列举复用既有实现，保证与任务工作区使用同一套 porcelain 解析。 */
  readonly worktrees: WorktreeService
  /** 已登记工作区目录的唯一读取者；只在判断孤立与关联状态时读取。 */
  readonly readWorkspaces: () => Promise<readonly WorkspaceContext[]>
  /**
   * 清理已登记工作树必须走工作区管理器：它会同步工作区相位并释放终端与视图，
   * 直接用 git 删除目录会让登记记录停在 ready，下次盘点仍把它当成可继续使用的工作树。
   */
  readonly removeRegisteredWorkspace: (request: {
    readonly projectPath: string
    readonly workspaceId: string
    readonly force: boolean
    readonly deleteBranch: boolean
  }) => Promise<void>
}

/** 一次盘点所需的仓库上下文。 */
interface CleanupContext {
  readonly repositoryRoot: string
  /** 公共对象库目录；统计体积与 GC 前后对比都以它为准。 */
  readonly objectDir: string
  readonly projectRoot: string
  readonly workspaces: readonly WorkspaceContext[]
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 判断 path 是否位于 root 之内（不含 root 本身）。 */
function inside(root: string, path: string): boolean {
  const base = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  const normalizedPath = path.replace(/\\/gu, '/')
  const normalizedRoot = base.replace(/\\/gu, '/')
  return process.platform === 'win32'
    ? normalizedPath.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
    : normalizedPath.startsWith(`${normalizedRoot}/`)
}

/** 递归累加目录体积；只用于展示，读不了的条目直接跳过。 */
async function directorySize(path: string): Promise<number> {
  let total = 0
  let visited = 0
  const walk = async (current: string): Promise<void> => {
    if (visited >= MAX_SIZE_ENTRIES) return
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' }) as Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= MAX_SIZE_ENTRIES) return
      visited += 1
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      try {
        total += (await stat(child)).size
      } catch {
        // 读不到具体文件不影响整体估算。
      }
    }
  }
  await walk(path)
  return total
}

/**
 * 公共对象库目录：链接工作树里 `--absolute-git-dir` 指向 `<repo>/.git/worktrees/<id>`，
 * 那里只有该工作树自己的一小部分记录；对象与打包文件都在公共目录下，
 * 统计体积必须用公共目录，否则在任务工作树里跑 GC 会始终显示「释放 0 B」。
 */
async function commonGitDir(repositoryRoot: string, fallback: string): Promise<string> {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-common-dir'],
      { cwd: repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
    const value = stdout.trim()
    return value === '' ? fallback : resolve(repositoryRoot, value)
  } catch {
    return fallback
  }
}

/** 临时任务分支的一行 `for-each-ref` 输出；主题放在最后一段，避免主题里出现分隔符时切错。 */
function parseTaskBranchLine(line: string): { headCommit: string; name: string; commitTime: number; subject: string } | null {
  const parts = line.split('\x1f')
  if (parts.length < 4) return null
  const [headCommit = '', name = '', timeText = ''] = parts
  const subject = parts.slice(3).join('\x1f')
  const commitTime = Number(timeText)
  if (headCommit === '' || name === '' || !Number.isFinite(commitTime)) return null
  return { headCommit, name, commitTime, subject }
}

export class GitCleanupService {
  constructor(private readonly options: GitCleanupServiceOptions) {}

  /** 盘点仓库存储与可清理资源；非仓库返回空结果而不是失败。 */
  async summary(projectPath: string): Promise<GitCleanupSummaryResult> {
    try {
      const context = await this.context(projectPath)
      if (context === null) {
        return { ok: true, isRepository: false, summary: null, worktrees: [], taskBranches: [] }
      }
      const listed = await this.options.worktrees.listWorktrees(context.projectRoot)
      const inventory = listed.worktrees
      const branches = await this.taskBranches(context, inventory)
      const worktrees = await this.taskWorktrees(context, inventory)
      const gitDirBytes = await directorySize(context.objectDir)
      // 工作树列表只包含托管目录下的条目，统计也必须基于同一批，否则数字与下方清单对不上。
      const summary: GitStorageSummary = {
        repositoryRoot: context.repositoryRoot,
        currentBranch: await this.currentBranch(context.repositoryRoot),
        gitDirBytes,
        totalWorktrees: worktrees.length,
        prunableWorktrees: worktrees.filter((entry) => entry.isPrunable).length,
        orphanWorktrees: worktrees.filter((entry) => entry.isOrphan).length,
        totalTaskBranches: branches.length,
        mergedTaskBranches: branches.filter((entry) => entry.isMerged).length
      }
      return { ok: true, isRepository: true, summary, worktrees, taskBranches: branches }
    } catch (error) {
      return { ok: false, error: this.failure(error, '读取 Git 清理概览时发生未预期的内部错误。') }
    }
  }

  /** 修剪已失效的工作树登记（目录已被手工删除等），不删除任何现存目录。 */
  async pruneWorktrees(projectPath: string): Promise<GitPruneWorktreesResult> {
    try {
      const context = await this.requireRepository(projectPath)
      // 修剪只清掉登记里的失效条目（目录已被手工删除），不删任何现存的目录。
      const before = await this.listWorktreePaths(context.repositoryRoot)
      await runGit(['worktree', 'prune'], { cwd: context.repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
      const after = await this.listWorktreePaths(context.repositoryRoot)
      const prunedCount = before.filter((path) => !after.some((kept) => samePath(kept, path))).length
      return { ok: true, prunedCount }
    } catch (error) {
      return { ok: false, error: this.failure(error, '修剪失效工作树时发生未预期的内部错误。') }
    }
  }

  /** 批量移除工作树；已登记的走工作区管理器，孤立的才直接删目录。 */
  async removeWorktrees(request: GitRemoveWorktreesRequest): Promise<GitRemoveWorktreesResult> {
    try {
      const context = await this.requireRepository(request.projectPath)
      const managedRoot = join(context.repositoryRoot, ...MANAGED_WORKTREE_SEGMENTS)
      const listed = await this.options.worktrees.listWorktrees(context.projectRoot)
      const errors: string[] = []
      let removedCount = 0
      for (const rawPath of request.worktreePaths) {
        const path = resolve(rawPath)
        const entry = listed.worktrees.find((item) => samePath(item.path, path))
        if (entry === undefined) {
          errors.push(`${rawPath}：未在仓库工作树登记中找到，未删除。`)
          continue
        }
        if (!inside(managedRoot, path)) {
          errors.push(`${rawPath}：不在应用托管的工作树目录内，未删除。`)
          continue
        }
        const workspace = context.workspaces.find((item) => item.worktreePath !== null && samePath(item.worktreePath, path))
        if (workspace !== undefined) {
          try {
            await this.options.removeRegisteredWorkspace({
              projectPath: workspace.projectPath,
              workspaceId: workspace.id,
              force: request.force === true,
              deleteBranch: request.deleteBranch !== false
            })
            removedCount += 1
          } catch (error) {
            errors.push(`${rawPath}：${this.messageOf(error)}`)
          }
          continue
        }
        // 孤立工作树没有任何登记记录，只能在这里按路径删除。
        try {
          await runGit(['worktree', 'remove', ...(request.force === true ? ['--force'] : []), entry.path],
            { cwd: context.repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
          removedCount += 1
          if (request.deleteBranch === true && entry.branch !== null && entry.branch.startsWith(TASK_BRANCH_PREFIX)) {
            try {
              await runGit(['branch', request.force === true ? '-D' : '-d', '--', entry.branch],
                { cwd: context.repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
            } catch (error) {
              errors.push(`${entry.branch}：工作树已移除，分支保留（${this.messageOf(error)}）。`)
            }
          }
        } catch (error) {
          errors.push(`${rawPath}：${this.messageOf(error)}`)
        }
      }
      return { ok: true, removedCount, failedCount: errors.length, errors }
    } catch (error) {
      return { ok: false, error: this.failure(error, '移除工作树时发生未预期的内部错误。') }
    }
  }

  /** 批量删除临时任务分支；只处理 `pi/task-` 前缀。 */
  async removeTaskBranches(request: GitRemoveBranchesRequest): Promise<GitRemoveBranchesResult> {
    try {
      const context = await this.requireRepository(request.projectPath)
      const errors: string[] = []
      let removedCount = 0
      for (const name of request.branchNames) {
        if (!name.startsWith(TASK_BRANCH_PREFIX)) {
          errors.push(`${name}：不是应用创建的任务分支，未删除。`)
          continue
        }
        try {
          await runGit(['branch', request.force === true ? '-D' : '-d', '--', name],
            { cwd: context.repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
          removedCount += 1
        } catch (error) {
          errors.push(`${name}：${this.messageOf(error)}`)
        }
      }
      return { ok: true, removedCount, failedCount: errors.length, errors }
    } catch (error) {
      return { ok: false, error: this.failure(error, '删除临时分支时发生未预期的内部错误。') }
    }
  }

  /** 执行垃圾回收并回报释放的体积；体积为估算值，不代表精确磁盘回收量。 */
  async runGc(projectPath: string): Promise<GitRunGcResult> {
    try {
      const context = await this.requireRepository(projectPath)
      const beforeBytes = await directorySize(context.objectDir)
      await runGit(['gc', '--prune=now', '--quiet'], { cwd: context.repositoryRoot, timeoutMs: GIT_GC_TIMEOUT_MS })
      const afterBytes = await directorySize(context.objectDir)
      const data: GitGcResultData = { beforeBytes, afterBytes, freedBytes: Math.max(0, beforeBytes - afterBytes) }
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: this.failure(error, '执行 Git 垃圾回收时发生未预期的内部错误。') }
    }
  }

  /** 解析仓库上下文；不是仓库时返回 null。 */
  private async context(projectPath: string): Promise<CleanupContext | null> {
    const projectRoot = await canonicalProjectRoot(projectPath)
    const repository = await resolveGitRepository(projectRoot)
    if (repository === null) return null
    return {
      repositoryRoot: repository.root,
      objectDir: await commonGitDir(repository.root, repository.gitDir),
      projectRoot,
      workspaces: await this.options.readWorkspaces()
    }
  }

  private async requireRepository(projectPath: string): Promise<CleanupContext> {
    const context = await this.context(projectPath)
    if (context === null) throw new GitCleanupError('NOT_A_REPOSITORY', '该项目不是有效的 Git 仓库。')
    return context
  }

  private async currentBranch(repositoryRoot: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'],
        { cwd: repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
      return stdout.trim() === '' ? null : stdout.trim()
    } catch {
      return null
    }
  }

  private async listWorktreePaths(repositoryRoot: string): Promise<readonly string[]> {
    const { stdout } = await runGit(['worktree', 'list', '--porcelain'],
      { cwd: repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
    return stdout.split(/\r?\n/u)
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
  }

  /** 该提交是否已是当前 HEAD 的祖先；用于判断分支是否已合入。 */
  private async isMergedIntoHead(repositoryRoot: string, commit: string): Promise<boolean> {
    try {
      await runGit(['merge-base', '--is-ancestor', commit, 'HEAD'],
        { cwd: repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
      return true
    } catch (error) {
      // 退出码 1 表示不是祖先（未合入）；其它失败按未合入处理，避免误报可删除。
      if (error instanceof GitCommandError && error.kind === 'failed' && error.exitCode === 1) return false
      return false
    }
  }

  /** 工作树的文件变动状态；读不到时返回 null，不把未知当成干净。 */
  private async worktreeStatus(path: string): Promise<TaskWorktreeCleanItem['status']> {
    try {
      const { stdout } = await runGit(['status', '--porcelain=v1', '-z'],
        { cwd: path, timeoutMs: GIT_READ_TIMEOUT_MS })
      let changedFileCount = 0
      let untrackedFileCount = 0
      const entries = stdout.split('\0')
      for (let index = 0; index < entries.length; index += 1) {
        const line = entries[index]
        if (line === undefined || line === '') continue
        if (line.startsWith('??')) {
          untrackedFileCount += 1
          continue
        }
        changedFileCount += 1
        // 重命名与复制会额外占一个条目（原路径），跳过它才不会再数一次。
        if (line.slice(0, 2).includes('R') || line.slice(0, 2).includes('C')) index += 1
      }
      return { isClean: changedFileCount === 0 && untrackedFileCount === 0, changedFileCount, untrackedFileCount }
    } catch {
      return null
    }
  }

  /** 托管任务工作树清单：只列登记在应用托管目录下的工作树。 */
  private async taskWorktrees(
    context: CleanupContext,
    inventory: readonly { path: string; branch: string | null; headCommit: string; isMain: boolean; isLocked: boolean; lockReason?: string; isPrunable?: boolean }[]
  ): Promise<readonly TaskWorktreeCleanItem[]> {
    const managedRoot = join(context.repositoryRoot, ...MANAGED_WORKTREE_SEGMENTS)
    const items: TaskWorktreeCleanItem[] = []
    for (const entry of inventory) {
      const path = resolve(entry.path)
      if (entry.isMain || !inside(managedRoot, path)) continue
      const workspace = context.workspaces.find((item) => item.worktreePath !== null && samePath(item.worktreePath, path))
        ?? context.workspaces.find((item) => item.kind === 'task' && item.branch !== null && item.branch === entry.branch)
      const isPrunable = entry.isPrunable === true
      items.push({
        id: workspace?.id ?? path,
        path,
        branch: entry.branch,
        headCommit: entry.headCommit,
        isMain: entry.isMain,
        isLocked: entry.isLocked,
        ...(entry.lockReason === undefined ? {} : { lockReason: entry.lockReason }),
        isPrunable,
        isOrphan: workspace === undefined,
        phase: workspace?.phase ?? null,
        status: isPrunable ? null : await this.worktreeStatus(path)
      })
    }
    return items
  }

  /** 临时任务分支清单；合入判定以当前工作区 HEAD 为基准。 */
  private async taskBranches(
    context: CleanupContext,
    inventory: readonly { branch: string | null }[]
  ): Promise<readonly TaskBranchCleanItem[]> {
    const { stdout } = await runGit(
      ['for-each-ref', '--format=%H%x1f%(refname:short)%x1f%(committerdate:unix)%x1f%(subject)', `refs/heads/${TASK_BRANCH_PREFIX}`],
      { cwd: context.repositoryRoot, timeoutMs: GIT_READ_TIMEOUT_MS }
    )
    const usedBranches = new Set(inventory.map((entry) => entry.branch).filter((name): name is string => name !== null))
    const items: TaskBranchCleanItem[] = []
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      const parsed = parseTaskBranchLine(line)
      if (parsed === null) continue
      items.push({
        name: parsed.name,
        headCommit: parsed.headCommit,
        commitSubject: parsed.subject,
        commitTime: parsed.commitTime,
        isMerged: await this.isMergedIntoHead(context.repositoryRoot, parsed.headCommit),
        isUsedByWorktree: usedBranches.has(parsed.name)
      })
    }
    return items.sort((left, right) => right.commitTime - left.commitTime)
  }

  private messageOf(error: unknown): string {
    if (error instanceof GitCommandError) return error.message
    return error instanceof Error ? error.message : String(error)
  }

  /** 把命令失败映射回共享错误码：没装 git 与「不是仓库」要能分开，界面才能给不同提示。 */
  private failure(error: unknown, fallbackMessage: string): { readonly code: DesktopErrorCode; readonly message: string } {
    if (error instanceof GitCleanupError) return { code: error.code, message: error.message }
    if (error instanceof GitCommandError) {
      if (error.kind === 'unavailable') return { code: 'GIT_UNAVAILABLE', message: error.message }
      if (error.kind === 'timeout' || error.kind === 'aborted') return { code: 'GIT_FAILED', message: error.message }
      return { code: 'GIT_FAILED', message: error.message }
    }
    return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : fallbackMessage }
  }
}
