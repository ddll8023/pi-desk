/**
 * 主进程 Git Worktree 隔离与生命周期管理服务：
 * 负责列举多工作树、在 `.pi/worktrees/` 下创建带分支的隔离工作树、
 * 自动配置 `.gitignore` 保护、共享依赖目录软链接编排、以及安全的移除与分支清理。
 *
 * 关键安全边界：
 * - 严禁删除主工作树（`isMain: true`）；
 * - 工作树目录严格限定在当前仓库根的 `.pi/worktrees/` 内，杜绝路径逃逸；
 * - 依赖软链接创建失败（如 Windows 非开发者模式）优雅降级，不中断工作树创建；
 * - 写操作支持并发串行化锁，防止 git worktree 内部锁定冲突。
 */
import { access, appendFile, lstat, readFile, symlink } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { DesktopError, DesktopErrorCode } from '../../shared/desktop-api'
import {
  WORKTREE_BRANCH_NAME_MAX_CHARS,
  WORKTREE_BRANCH_NAME_REGEX
} from '../../shared/worktree-api'
import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  MergeWorktreeRequest,
  MergeWorktreeResult,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  WorktreeEntry,
  WorktreeListResult,
  WorktreeStatus,
  WorktreeStatusRequest,
  WorktreeStatusResult
} from '../../shared/worktree-api'
import { GIT_READ_TIMEOUT_MS, GitCommandError, runGit } from './git-command'
import { canonicalProjectRoot, resolveGitRepository } from './git-repository'
import type { GitRepository } from './git-repository'

export interface WorktreeServiceOptions {
  /** 当前活动项目路径获取器。 */
  readonly currentProjectPath: () => string | null
}

function errorResult<T extends { ok: false; error: DesktopError }>(code: DesktopErrorCode, message: string): T {
  return { ok: false, error: { code, message } } as T
}

/** 规范化路径并统一平台大小写折叠比较 */
function normalizePath(p: string): string {
  const resolved = resolve(p)
  if (process.platform === 'win32') {
    return resolved.toLowerCase()
  }
  return resolved
}

/** 检查文件或目录是否存在 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 解析 `git worktree list --porcelain` 输出为结构化的 WorktreeEntry 数组。
 * 纯函数，独立导出以供单元测试。
 */
export function parseWorktreeListPorcelain(stdout: string, mainRepoRoot: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  const blocks = stdout.split(/\r?\n\r?\n/u).map((b) => b.trim()).filter((b) => b !== '')
  const normMainRoot = normalizePath(mainRepoRoot)

  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== '')
    let worktreePath = ''
    let headCommit = ''
    let branch: string | null = null
    let isLocked = false
    let lockReason: string | undefined
    let isPrunable = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = resolve(line.slice('worktree '.length).trim())
      } else if (line.startsWith('HEAD ')) {
        headCommit = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ')) {
        const fullRef = line.slice('branch '.length).trim()
        branch = fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : fullRef
      } else if (line === 'detached') {
        branch = null
      } else if (line.startsWith('locked')) {
        isLocked = true
        const reason = line.slice('locked'.length).trim()
        if (reason !== '') lockReason = reason
      } else if (line.startsWith('prunable')) {
        isPrunable = true
      }
    }

    if (worktreePath !== '' && headCommit !== '') {
      const isMain = entries.length === 0 || normalizePath(worktreePath) === normMainRoot
      entries.push({
        path: worktreePath,
        branch,
        headCommit,
        isMain,
        isLocked,
        ...(lockReason === undefined ? {} : { lockReason }),
        ...(isPrunable ? { isPrunable: true } : {})
      })
    }
  }

  return entries
}

export class WorktreeService {
  private readonly currentProjectPath: () => string | null
  /** 同一仓库的写操作串行队列 */
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(options: WorktreeServiceOptions) {
    this.currentProjectPath = options.currentProjectPath
  }

  /** 获取当前仓库上下文 */
  private async getActiveRepository(): Promise<{ repository: GitRepository; canonicalRoot: string } | null> {
    const current = this.currentProjectPath()
    if (current === null) return null
    const canonicalRoot = await canonicalProjectRoot(current)
    const repository = await resolveGitRepository(canonicalRoot)
    if (repository === null) return null
    return { repository, canonicalRoot }
  }

  /** 串行执行写操作 */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.catch(() => {})
    return run
  }

  /**
   * 列举当前项目仓库的所有工作树。
   */
  async listWorktrees(): Promise<WorktreeListResult> {
    const active = await this.getActiveRepository()
    if (active === null) {
      return { ok: true, isRepository: false, worktrees: [] }
    }

    try {
      const { stdout } = await runGit(['worktree', 'list', '--porcelain'], {
        cwd: active.repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      const worktrees = parseWorktreeListPorcelain(stdout, active.repository.root)
      return { ok: true, isRepository: true, worktrees }
    } catch (error) {
      if (error instanceof GitCommandError) {
        return errorResult('GIT_ERROR', `读取工作树列表失败：${error.message}`)
      }
      return errorResult('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 确保主仓库 `.gitignore` 中包含 `.pi/worktrees/` 忽略项。
   */
  private async ensureGitignore(repoRoot: string): Promise<void> {
    const gitignorePath = join(repoRoot, '.gitignore')
    try {
      let content = ''
      if (await pathExists(gitignorePath)) {
        content = await readFile(gitignorePath, 'utf-8')
      }
      const lines = content.split(/\r?\n/u)
      const hasIgnore = lines.some((line) => {
        const trimmed = line.trim()
        return trimmed === '.pi/worktrees' || trimmed === '.pi/worktrees/' || trimmed === '/.pi/worktrees/'
      })
      if (!hasIgnore) {
        const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
        await appendFile(gitignorePath, `${prefix}# pi-desk worktrees\n.pi/worktrees/\n`, 'utf-8')
      }
    } catch (error) {
      console.warn('[worktree] 自动更新 .gitignore 失败：', error)
    }
  }

  /**
   * 为新工作树建立主仓库依赖目录的符号链接（node_modules、.venv 等）。
   */
  private async linkDependencies(repoRoot: string, targetWorktreePath: string): Promise<void> {
    const candidates = ['node_modules', '.venv', 'vendor']
    for (const name of candidates) {
      const sourcePath = join(repoRoot, name)
      const destPath = join(targetWorktreePath, name)
      try {
        if ((await pathExists(sourcePath)) && !(await pathExists(destPath))) {
          // 在 Unix 上采用相对符号链接，在 Windows 上若权限允许使用目录符号链接
          const relSource = relative(targetWorktreePath, sourcePath)
          const symlinkType = process.platform === 'win32' ? 'junction' : 'dir'
          await symlink(relSource, destPath, symlinkType)
        }
      } catch (err) {
        // 软链接创建失败属非致命错误（例如 Windows 未开开发者权限）
        console.warn(`[worktree] 共享依赖 ${name} 软链接创建跳过：`, err)
      }
    }
  }

  /**
   * 创建新的隔离工作树。
   */
  async createWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
    const branchName = request.branchName.trim()
    if (
      branchName === '' ||
      branchName.length > WORKTREE_BRANCH_NAME_MAX_CHARS ||
      !WORKTREE_BRANCH_NAME_REGEX.test(branchName)
    ) {
      return errorResult('INVALID_REQUEST', '分支名称不合法，请使用标准 Git 分支名。')
    }

    return this.enqueueWrite(async () => {
      const active = await this.getActiveRepository()
      if (active === null) {
        return errorResult('NOT_FOUND', '当前项目不是有效的 Git 仓库。')
      }

      const repoRoot = active.repository.root
      const worktreeBaseDir = resolve(join(repoRoot, '.pi', 'worktrees'))
      const targetWorktreePath = resolve(join(worktreeBaseDir, branchName))

      // 安全路径边界校验：确保工作树严格位于 .pi/worktrees 内
      const rel = relative(worktreeBaseDir, targetWorktreePath)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return errorResult('FORBIDDEN', '目标工作树路径非法，不允许跳出 .pi/worktrees 目录。')
      }

      if (await pathExists(targetWorktreePath)) {
        return errorResult('CONFLICT', `目标工作树路径已存在：${branchName}`)
      }

      // 1. 确保主仓库已将 .pi/worktrees/ 纳入忽略
      await this.ensureGitignore(repoRoot)

      // 2. 执行 git worktree add
      const addArgs = ['worktree', 'add', '-b', branchName, targetWorktreePath]
      if (request.baseBranch !== undefined && request.baseBranch.trim() !== '') {
        addArgs.push(request.baseBranch.trim())
      }

      try {
        await runGit(addArgs, {
          cwd: repoRoot,
          timeoutMs: GIT_READ_TIMEOUT_MS
        })
      } catch (error) {
        if (error instanceof GitCommandError) {
          return errorResult('GIT_ERROR', `创建 Git 工作树失败：${error.stderr || error.message}`)
        }
        return errorResult('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      }

      // 3. 编排公共依赖目录的符号链接
      await this.linkDependencies(repoRoot, targetWorktreePath)

      // 4. 查询并返回新工作树的准确信息
      const listRes = await this.listWorktrees()
      if (!listRes.ok) {
        return errorResult(listRes.error.code, listRes.error.message)
      }

      const normTarget = normalizePath(targetWorktreePath)
      const found = listRes.worktrees.find((w) => normalizePath(w.path) === normTarget)
      if (found === undefined) {
        return errorResult('INTERNAL_ERROR', '工作树已创建，但无法从工作树列表中查询到该条目。')
      }

      return { ok: true, worktree: found }
    })
  }

  /**
   * 移除工作树，并可选删除关联分支。
   */
  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const rawPath = request.worktreePath.trim()
    if (rawPath === '') {
      return errorResult('INVALID_REQUEST', '必须指定要移除的工作树路径。')
    }

    return this.enqueueWrite(async () => {
      const active = await this.getActiveRepository()
      if (active === null) {
        return errorResult('NOT_FOUND', '当前项目不是有效的 Git 仓库。')
      }

      const listRes = await this.listWorktrees()
      if (!listRes.ok) {
        return errorResult(listRes.error.code, listRes.error.message)
      }

      const normTarget = normalizePath(rawPath)
      const targetWorktree = listRes.worktrees.find((w) => normalizePath(w.path) === normTarget)

      if (targetWorktree === undefined) {
        return errorResult('NOT_FOUND', '未找到指定的工作树条目。')
      }

      // 严禁移除主工作树
      if (targetWorktree.isMain) {
        return errorResult('FORBIDDEN', '严禁移除主仓库工作树！')
      }

      // 1. 执行 git worktree remove
      const removeArgs = ['worktree', 'remove', targetWorktree.path]
      if (request.force === true) {
        removeArgs.push('--force')
      }

      try {
        await runGit(removeArgs, {
          cwd: active.repository.root,
          timeoutMs: GIT_READ_TIMEOUT_MS
        })
      } catch (error) {
        if (error instanceof GitCommandError) {
          return errorResult('GIT_ERROR', `移除工作树失败：${error.stderr || error.message}`)
        }
        return errorResult('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      }

      // 2. 如果指定了删除分支，且该工作树有关联分支
      const shouldDeleteBranch = request.deleteBranch !== false
      if (shouldDeleteBranch && targetWorktree.branch !== null) {
        try {
          await runGit(['branch', '-D', targetWorktree.branch], {
            cwd: active.repository.root,
            timeoutMs: GIT_READ_TIMEOUT_MS
          })
        } catch (branchError) {
          console.warn(`[worktree] 移除关联分支 ${targetWorktree.branch} 失败：`, branchError)
        }
      }

      return { ok: true }
    })
  }

  /**
   * 检查指定工作树是否有未提交改动。
   */
  async checkWorktreeStatus(request: WorktreeStatusRequest): Promise<WorktreeStatusResult> {
    const targetPath = request.worktreePath.trim()
    if (targetPath === '') {
      return errorResult('INVALID_REQUEST', '必须指定要检测的工作树路径。')
    }

    if (!(await pathExists(targetPath))) {
      return errorResult('NOT_FOUND', '工作树目录不存在。')
    }

    try {
      const { stdout } = await runGit(['status', '--porcelain=v1'], {
        cwd: targetPath,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })

      const lines = stdout.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== '')
      let changedCount = 0
      let untrackedCount = 0

      for (const line of lines) {
        if (line.startsWith('??')) {
          untrackedCount++
        } else {
          changedCount++
        }
      }

      const status: WorktreeStatus = {
        path: targetPath,
        isClean: changedCount === 0 && untrackedCount === 0,
        changedFileCount: changedCount,
        untrackedFileCount: untrackedCount
      }

      return { ok: true, status }
    } catch (error) {
      if (error instanceof GitCommandError) {
        return errorResult('GIT_ERROR', `检查工作树状态失败：${error.message}`)
      }
      return errorResult('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 将工作树的分支合入当前主分支，并可选自动清理该工作树与分支。
   */
  async mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult> {
    const rawPath = request.worktreePath.trim()
    if (rawPath === '') {
      return errorResult('INVALID_REQUEST', '必须指定要合并的工作树路径。')
    }

    return this.enqueueWrite(async () => {
      const active = await this.getActiveRepository()
      if (active === null) {
        return errorResult('NOT_FOUND', '当前项目不是有效的 Git 仓库。')
      }

      const listRes = await this.listWorktrees()
      if (!listRes.ok) {
        return errorResult(listRes.error.code, listRes.error.message)
      }

      const normTarget = normalizePath(rawPath)
      const targetWorktree = listRes.worktrees.find((w) => normalizePath(w.path) === normTarget)
      if (targetWorktree === undefined) {
        return errorResult('NOT_FOUND', '未找到指定的工作树条目。')
      }

      if (targetWorktree.isMain) {
        return errorResult('FORBIDDEN', '主工作树无需合入自身。')
      }

      if (targetWorktree.branch === null) {
        return errorResult('INVALID_REQUEST', '该工作树处于游离（detached）状态，无分支可合并。')
      }

      // 1. 检查主工作树状态是否干净，防止未提交的改动导致 merge 失败或混淆
      const { stdout: mainStatusOut } = await runGit(['status', '--porcelain=v1'], {
        cwd: active.repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      if (mainStatusOut.trim() !== '') {
        return errorResult('CONFLICT', '主工作区存在未提交或未暂存的修改，请先提交或暂存后再合并。')
      }

      // 2. 检查工作树内是否有未提交的改动，若有自动打快照收录
      const { stdout: wtStatusOut } = await runGit(['status', '--porcelain=v1'], {
        cwd: targetWorktree.path,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      if (wtStatusOut.trim() !== '') {
        await runGit(['add', '-A'], { cwd: targetWorktree.path, timeoutMs: GIT_READ_TIMEOUT_MS })
        await runGit(['commit', '-m', 'pi-desk: finalize before merge', '--no-verify'], {
          cwd: targetWorktree.path,
          timeoutMs: GIT_READ_TIMEOUT_MS
        })
      }

      // 3. 在主仓库执行 git merge
      const isSquash = request.squash === true
      const mergeArgs = isSquash
        ? ['merge', '--squash', targetWorktree.branch]
        : ['merge', '--no-ff', targetWorktree.branch, '-m', `Merge worktree branch '${targetWorktree.branch}'`]

      try {
        await runGit(mergeArgs, {
          cwd: active.repository.root,
          timeoutMs: GIT_READ_TIMEOUT_MS
        })
        if (isSquash) {
          await runGit(['commit', '-m', `Squash merge branch '${targetWorktree.branch}'`], {
            cwd: active.repository.root,
            timeoutMs: GIT_READ_TIMEOUT_MS
          })
        }
      } catch (error) {
        if (error instanceof GitCommandError) {
          return errorResult('CONFLICT', `合并分支发生冲突或失败：${error.stderr || error.message}。工作树与临时分支已保留。`)
        }
        return errorResult('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      }

      // 4. 获取最新的合并 commit hash
      const { stdout: headOut } = await runGit(['rev-parse', 'HEAD'], {
        cwd: active.repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      const mergedCommit = headOut.trim()

      // 5. 若配置了 deleteAfterMerge（默认 true），自动清理工作树与分支
      if (request.deleteAfterMerge !== false) {
        await this.removeWorktree({
          worktreePath: targetWorktree.path,
          deleteBranch: true,
          force: true
        })
      }

      return { ok: true, mergedCommit }
    })
  }
}
