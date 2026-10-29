/**
 * 仓库定位与路径换算：把「项目目录」翻译成「仓库根 + 仓库内路径」，再折算回项目内相对路径。
 *
 * 为什么需要这一层：porcelain 的路径永远相对**仓库根**，而页面与项目文件契约只认**项目内相对路径**。
 * 项目常常就是仓库根，但项目也可能是仓库的子目录（例如单仓多包），两者混用会让暂存与 diff 全部错位。
 * 因此所有 git 命令都以仓库根为 cwd 运行，进出各换算一次；落在项目外的条目直接丢弃，界面只看到项目内的改动。
 * Windows 平台下驱动器盘符做统一大写归一化，并在换算前做大小写折叠判定，避免大小写不一致导致路径被误判为在项目外而丢弃。
 *
 * 冲突操作的探测读的是 `--absolute-git-dir`：链接工作树（git worktree）里 `MERGE_HEAD`、`rebase-merge`
 * 都在各自的 git 目录下而不是公共目录，用公共目录会漏判。
 */
import { access, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GitConflictOperation } from '../../shared/git-api'
import { GIT_READ_TIMEOUT_MS, GitCommandError, runGit } from './git-command'

export interface GitRepository {
  /** 仓库根（工作区顶层）。 */
  readonly root: string
  /** 本次操作的 git 目录；链接工作树时与仓库根下的 `.git` 不同。 */
  readonly gitDir: string
}

export interface GitRepositoryOptions {
  readonly signal?: AbortSignal
}

/**
 * 规范化项目根：macOS 上 `/var` 是 `/private/var` 的符号链接，用户也可能用符号链接目录作为项目。
 * git 报告的是**已解析**的顶层目录，不先把项目根解析掉，两边相减就会得到一串 `..`，
 * pathspec 会被 git 判成「在仓库之外」。解析失败时保留原值，让后续步骤给出更准确的错误。
 */
export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot)
  } catch {
    return projectRoot
  }
}

/**
 * 定位仓库；不是仓库时返回 null（正常结果，界面显示空态）。
 * 没装 git、超时或中止会抛 `GitCommandError`，由调用方换成对应错误码。
 */
export async function resolveGitRepository(
  projectRoot: string,
  options: GitRepositoryOptions = {}
): Promise<GitRepository | null> {
  try {
    const { stdout } = await runGit(
      ['rev-parse', '--show-toplevel', '--absolute-git-dir'],
      { cwd: projectRoot, timeoutMs: GIT_READ_TIMEOUT_MS, ...(options.signal === undefined ? {} : { signal: options.signal }) }
    )
    const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
    const top = lines[0]
    const gitDir = lines[1]
    if (top === undefined || gitDir === undefined) return null
    return { root: normalizeDriveLetter(resolve(top)), gitDir: normalizeDriveLetter(resolve(gitDir)) }
  } catch (error) {
    // 退出码 128 是「不在工作区内」的标准回答；其余失败（没装 git、超时、中止）必须向上报。
    if (error instanceof GitCommandError && error.kind === 'failed' && error.exitCode === 128) return null
    throw error
  }
}

/** 探测未完成的操作；四类标记文件都不存在时返回 null。 */
export async function detectConflictOperation(gitDir: string): Promise<GitConflictOperation | null> {
  const [merge, cherryPick, rebaseMerge, rebaseApply] = await Promise.all([
    exists(join(gitDir, 'MERGE_HEAD')),
    exists(join(gitDir, 'CHERRY_PICK_HEAD')),
    exists(join(gitDir, 'rebase-merge')),
    exists(join(gitDir, 'rebase-apply'))
  ])
  if (merge) return 'merge'
  if (rebaseMerge || rebaseApply) return 'rebase'
  if (cherryPick) return 'cherry-pick'
  return null
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 规范化驱动器盘符：Windows 下将盘符首字母统一转为大写。 */
function normalizeDriveLetter(pathValue: string): string {
  if (process.platform === 'win32' && pathValue.length >= 2 && pathValue[1] === ':') {
    const drive = pathValue[0]
    if (drive !== undefined && drive >= 'a' && drive <= 'z') {
      return drive.toUpperCase() + pathValue.slice(1)
    }
  }
  return pathValue
}

/** 路径相等比较（Windows 折叠大小写）。 */
function isSameDirectory(left: string, right: string): boolean {
  const normLeft = normalizeDriveLetter(resolve(left))
  const normRight = normalizeDriveLetter(resolve(right))
  return process.platform === 'win32' ? normLeft.toLowerCase() === normRight.toLowerCase() : normLeft === normRight
}

/** 状态命令的 pathspec：项目根相对仓库根的前缀；项目即仓库根时为 `.`。 */
export function repositoryPathspec(repository: GitRepository, projectRoot: string): string {
  if (isSameDirectory(repository.root, projectRoot)) return '.'
  const repoRoot = normalizeDriveLetter(repository.root)
  const normProjectRoot = normalizeDriveLetter(projectRoot)
  const prefix = toPosix(relative(repoRoot, normProjectRoot))
  return prefix === '' ? '.' : prefix
}

/** 仓库内相对路径 → 项目内相对路径；落在项目外返回 null（该条目不属于本项目）。 */
export function repoPathToProjectPath(repository: GitRepository, projectRoot: string, repoRelative: string): string | null {
  if (isSameDirectory(repository.root, projectRoot)) {
    return repoRelative === '' ? null : repoRelative
  }
  const repoRoot = normalizeDriveLetter(repository.root)
  const normProjectRoot = normalizeDriveLetter(projectRoot)
  const absolute = join(repoRoot, ...repoRelative.split('/'))
  const projectRelative = toPosix(relative(normProjectRoot, absolute))
  if (projectRelative === '') return null
  if (projectRelative === '..' || projectRelative.startsWith('../')) return null
  if (isAbsolute(projectRelative)) return null
  return projectRelative
}

/** 项目内相对路径 → 仓库内相对路径；调用方已保证路径在项目内，这里只做换算。 */
export function projectPathToRepoPath(repository: GitRepository, projectRoot: string, projectRelative: string): string {
  if (isSameDirectory(repository.root, projectRoot)) {
    return projectRelative
  }
  const repoRoot = normalizeDriveLetter(repository.root)
  const normProjectRoot = normalizeDriveLetter(projectRoot)
  const absolute = join(normProjectRoot, ...projectRelative.split('/'))
  return toPosix(relative(repoRoot, absolute))
}

function toPosix(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}
