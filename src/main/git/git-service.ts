/**
 * 右侧面板「源代码管理」的主进程实现：读状态、算单文件差异、读提交历史与提交内差异、暂存/取消暂存/丢弃/提交。
 *
 * 设计要点（每一条都对应一类真实故障）：
 * - **仓库根优先**：所有 git 命令都以仓库根为 cwd，路径进出各折算一次（项目可能是仓库的子目录）。
 * - **状态读合并**：同一个项目的并发状态读共用一次 git 调用；焦点/可见性触发的刷新与用户点刷新不会互相排队跑两遍。
 * - **写后不复用旧结果**：每次写操作成功后递增代际，读取过程中发生过写就重读一次，避免把写之前的快照
 *   回给界面（表现为「暂存成功但列表没变」）。
 * - **写操作串行**：同一个仓库的写操作排队执行；git 自己的 index.lock 一旦被并发命令撞上就会失败。
 * - **丢弃未跟踪文件自己删**：不用 `git clean`（范围过大且会连带忽略规则），删前用 realpath 校验仍在项目内。
 * - **提交信息走 stdin**：`git commit -F -`，不拼接 shell，也不受引号、换行与长度影响。
 * - **远端操作不猜策略**：pull 直接沿用用户自己的 `pull.rebase` / `pull.ff`；push 有上游就推当前上游，
 *   没有上游时只在「恰好一个远端」的情况下自动 `--set-upstream`，多个远端一律交回用户决定。
 *   网络命令必须带超时，否则 ssh 口令提示或断网会让命令永久挂着。
 */
import { lstat, readFile, unlink } from 'node:fs/promises'
import type { DesktopError, DesktopErrorCode } from '../../shared/desktop-api'
import {
  GIT_COMMIT_FILES_LIMIT,
  GIT_DIFF_MAX_BYTES,
  GIT_HISTORY_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  GIT_STATUS_LIMIT
} from '../../shared/git-api'
import type {
  GitChangeEntry,
  GitCommitDetail,
  GitCommitDetailRequest,
  GitCommitDetailResult,
  GitCommitDiffRequest,
  GitCommitDiffResult,
  GitCommitFile,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitHistory,
  GitHistoryRequest,
  GitHistoryResult,
  GitOperationResult,
  GitPathRequest,
  GitStatus,
  GitStatusResult,
  GitTextDiff
} from '../../shared/git-api'
import { GIT_NETWORK_TIMEOUT_MS, GIT_READ_TIMEOUT_MS, GitCommandError, runGit, runGitBuffer, streamGit } from './git-command'
import {
  canonicalProjectRoot,
  detectConflictOperation,
  projectPathToRepoPath,
  repoPathToProjectPath,
  repositoryPathspec,
  resolveGitRepository
} from './git-repository'
import type { GitRepository } from './git-repository'
import { parseDiffTreeFiles, parseGitLog } from './git-history-parser'
import { createGitStatusParser } from './git-status-parser'
import { normalizeRelativeDirectory, resolveProjectEntryAbsolute } from '../projects/project-entry-path'

/** 判定二进制前最多看多少字节；git 自己也是这么判的。 */
const BINARY_PROBE_BYTES = 8000

/** 只用于读命令的公共前缀：让路径不被转义成八进制（含引号等特殊字符时仍会转义，由解析器还原）。 */
const QUOTE_PATH_ARGS = ['-c', 'core.quotePath=false'] as const

/**
 * 历史用的 log 格式：字段之间用 0x1f、记录之间用 NUL（`-z`）。
 * 标题放在最后一个字段，解析时把剩余部分整体拼回来，因此标题里出现任何字符都不会切错。
 */
const LOG_ARGS = [
  'log',
  '--no-show-signature',
  '--no-color',
  '-z',
  '--topo-order',
  '--decorate=short',
  '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s'
] as const

export interface GitServiceOptions {
  /** 当前项目路径的内存快照；未选择项目时为 null，不触发磁盘访问。 */
  readonly currentProjectPath: () => string | null
}

/** 项目根的两个视角：`reported` 是登记时的写法（回给页面复核），`canonical` 是解析后的真实路径（参与路径运算）。 */
interface ProjectRoots {
  readonly reported: string
  readonly canonical: string
}

/** 一次「项目 + 仓库 + 路径」的解析结果：写操作都要先过这一步。 */
type PreparedPath =
  | {
    readonly ok: true
    readonly repository: GitRepository
    readonly projectRoot: string
    readonly reportedProjectRoot: string
    readonly relativePath: string
    readonly absolutePath: string
    readonly repoPath: string
  }
  | { readonly ok: false; readonly error: DesktopError }

export class GitService {
  /** 每个仓库一条写操作队列；值为队尾。 */
  private readonly lanes = new Map<string, Promise<void>>()
  /** 同一项目的在途状态读；共享给并发调用方。 */
  private readonly statusInFlight = new Map<string, Promise<GitStatusResult>>()
  /** 写操作代际：读取过程中代际变化说明结果可能已过期。 */
  private mutationSeq = 0

  constructor(private readonly options: GitServiceOptions) {}

  /** 读取当前项目的状态；未选择项目时回错误，不是仓库时回 `isRepository: false`。 */
  async status(): Promise<GitStatusResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots

    const key = roots.roots.reported
    const inFlight = this.statusInFlight.get(key)
    if (inFlight !== undefined) return inFlight

    const pending = this.readStatusSettled(roots.roots)
    this.statusInFlight.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.statusInFlight.get(key) === pending) this.statusInFlight.delete(key)
    }
  }

  /** 单文件差异；两侧内容由主进程给出，页面只负责渲染。 */
  async diff(request: GitDiffRequest): Promise<GitDiffResult> {
    const prepared = await this.prepare(request.path)
    if (!prepared.ok) return prepared

    try {
      const original = await this.readBlob(prepared.repository, originalSpec(prepared.repoPath, request.area))
      const modified = request.area === 'staged'
        ? await this.readBlob(prepared.repository, `:${prepared.repoPath}`)
        : await this.readWorktreeFile(prepared.absolutePath)

      return {
        ok: true,
        data: {
          path: prepared.relativePath,
          area: request.area,
          ...this.toTextDiff(original, modified)
        }
      }
    } catch (error) {
      return { ok: false, error: gitError(error, '读取文件差异失败。') }
    }
  }

  /** 两侧内容 → 契约里的差异结构：过大与二进制只给提示，文本统一成 `\n`。 */
  private toTextDiff(original: Buffer | null, modified: Buffer | null): GitTextDiff {
    if (original !== null && original.length > GIT_DIFF_MAX_BYTES) return tooLargeDiff()
    if (modified !== null && modified.length > GIT_DIFF_MAX_BYTES) return tooLargeDiff()
    if (isBinary(original) || isBinary(modified)) return binaryDiff()
    return {
      kind: 'text',
      originalText: original === null ? null : decodeText(original),
      modifiedText: modified === null ? null : decodeText(modified),
      eol: usesCrlf(original) || usesCrlf(modified) ? 'crlf' : 'lf',
      truncated: false
    }
  }

  /** 暂存一个路径（含删除）；成功后回传最新状态。 */
  async stage(request: GitPathRequest): Promise<GitOperationResult> {
    const prepared = await this.prepare(request.path)
    if (!prepared.ok) return prepared
    return this.mutate(prepared, async () => {
      await runGit(['add', '-A', '--', prepared.repoPath], { cwd: prepared.repository.root })
    }, '暂存失败。')
  }

  /** 取消暂存一个路径；老版本 git 没有 `restore` 时退回 `reset`。 */
  async unstage(request: GitPathRequest): Promise<GitOperationResult> {
    const prepared = await this.prepare(request.path)
    if (!prepared.ok) return prepared
    return this.mutate(prepared, async () => {
      try {
        await runGit(['restore', '--staged', '--', prepared.repoPath], { cwd: prepared.repository.root })
      } catch (error) {
        if (!isMissingRestore(error)) throw error
        await runGit(['reset', '-q', 'HEAD', '--', prepared.repoPath], { cwd: prepared.repository.root })
      }
    }, '取消暂存失败。')
  }

  /**
   * 丢弃改动：已跟踪文件恢复工作区内容，未跟踪文件直接删除。
   * 尚未提交过的文件（只在索引里）不做处理：此时「丢弃」既不是恢复也不是删除，交给用户先取消暂存。
   */
  async discard(request: GitPathRequest): Promise<GitOperationResult> {
    const prepared = await this.prepare(request.path)
    if (!prepared.ok) return prepared

    return this.mutate(prepared, async () => {
      if (await this.isTracked(prepared)) {
        if (!(await this.existsInHead(prepared))) {
          throw new GitCommandError('failed', '该文件尚未提交过，请先取消暂存，再删除它。', { subcommand: 'discard' })
        }
        try {
          await runGit(['restore', '--worktree', '--', prepared.repoPath], { cwd: prepared.repository.root })
        } catch (error) {
          if (!isMissingRestore(error)) throw error
          await runGit(['checkout', '--', prepared.repoPath], { cwd: prepared.repository.root })
        }
        return
      }

      // 未跟踪：删除文件本身（不跟随符号链接），路径已由 realpath 校验在项目内。
      const info = await lstat(prepared.absolutePath).catch(() => null)
      if (info === null) return
      if (info.isDirectory()) {
        throw new GitCommandError('failed', '目录不提供整体删除，请先展开到具体文件。', { subcommand: 'discard' })
      }
      await unlink(prepared.absolutePath)
    }, '丢弃改动失败。')
  }

  /** 提交已暂存的改动；提交信息走 stdin，作者与签名沿用用户自己的 git 配置。 */
  async commit(request: GitCommitRequest): Promise<GitOperationResult> {
    const message = request.message.trim() === '' ? '' : request.message
    if (message === '') return failure('INVALID_REQUEST', '提交信息不能为空。')

    const roots = await this.resolveRoots()
    if (!roots.ok) return roots
    const prepared = await this.prepareRoot(roots.roots)
    if (!prepared.ok) return prepared

    return this.mutate(prepared, async () => {
      try {
        await runGit(['commit', '-F', '-'], {
          cwd: prepared.repository.root,
          stdin: message.endsWith('\n') ? message : `${message}\n`
        })
      } catch (error) {
        // 常见的提交失败换成能直接照做的中文原因；其余保留 git 自己的最后一句话。
        if (error instanceof GitCommandError && error.kind === 'failed') {
          if (/nothing to commit|no changes added to commit/u.test(error.stderr)) {
            throw new GitCommandError('failed', '没有已暂存的改动，先暂存再提交。', { subcommand: 'commit' })
          }
          if (/unresolved conflict/u.test(error.stderr)) {
            throw new GitCommandError('failed', '还有未解决的冲突，先解决并暂存再提交。', { subcommand: 'commit' })
          }
          if (/Please tell me who you are|unable to auto-detect email address/u.test(error.stderr)) {
            throw new GitCommandError('failed', '还没有配置 git 用户信息，请先设置 user.name 与 user.email。', { subcommand: 'commit' })
          }
          if (/hook/iu.test(error.stderr) && /failed|abort/iu.test(error.stderr)) {
            throw new GitCommandError('failed', '提交被仓库钩子拦下，按钩子输出修正后重试。', { subcommand: 'commit' })
          }
        }
        throw error
      }
    }, '提交失败。')
  }

  /**
   * 拉取当前分支的上游。策略沿用用户自己的 git 配置（`pull.rebase` / `pull.ff`），不替用户选合并还是变基；
   * 分叉且未配置策略时 git 会拒绝并给出可读原因，由界面展示。
   */
  async pull(): Promise<GitOperationResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots
    const prepared = await this.prepareRoot(roots.roots)
    if (!prepared.ok) return prepared

    return this.mutate(prepared, async () => {
      try {
        await runGit(['pull'], {
          cwd: prepared.repository.root,
          timeoutMs: GIT_NETWORK_TIMEOUT_MS
        })
      } catch (error) {
        throw remoteFailure(error, 'pull')
      }
    }, '拉取失败。')
  }

  /**
   * 推送当前分支：有上游就直接推；没有上游且仓库只有一个远端时自动 `--set-upstream` 发布分支。
   * 多个远端、分离 HEAD、没有远端都直接拒绝，不替用户猜该推到哪。
   */
  async push(): Promise<GitOperationResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots
    const prepared = await this.prepareRoot(roots.roots)
    if (!prepared.ok) return prepared

    return this.mutate(prepared, async () => {
      const branch = await this.currentBranch(prepared.repository)
      if (branch === null) {
        throw new GitCommandError('failed', '当前处于分离 HEAD 状态，没有可推送的分支。', { subcommand: 'push' })
      }

      const upstream = await this.upstreamNameOf(prepared.repository)
      let args: string[]
      if (upstream === null) {
        const remotes = await this.remoteNames(prepared.repository)
        const [only] = remotes
        if (remotes.length === 0) {
          throw new GitCommandError('failed', '这个仓库还没有配置远端，先添加远端再推送。', { subcommand: 'push' })
        }
        if (only === undefined || remotes.length > 1) {
          throw new GitCommandError(
            'failed',
            `仓库有多个远端（${remotes.join('、')}），先在终端执行 git push -u <远端> ${branch} 设置上游。`,
            { subcommand: 'push' }
          )
        }
        args = ['push', '--set-upstream', only, branch]
      } else {
        args = ['push']
      }

      try {
        await runGit(args, {
          cwd: prepared.repository.root,
          timeoutMs: GIT_NETWORK_TIMEOUT_MS
        })
      } catch (error) {
        throw remoteFailure(error, 'push')
      }
    }, '推送失败。')
  }

  /**
   * 读取提交历史（可选只看某个路径）。
   * `pushed` 依据上游的 `@{u}..HEAD` 判定：没有上游时这些提交确实还没推到任何地方，因此一律标为未推送。
   */
  async history(request: GitHistoryRequest): Promise<GitHistoryResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots

    // null 表示「不过滤」；只有页面确实给了路径却不合法时才拒绝。
    const filterPath = request.path === undefined ? null : normalizeRelativeDirectory(request.path)
    if (request.path !== undefined && (filterPath === null || filterPath === '')) {
      return failure('INVALID_REQUEST', '历史过滤路径必须是项目内的相对路径。')
    }

    try {
      const repository = await resolveGitRepository(roots.roots.canonical)
      if (repository === null) return { ok: true, data: emptyHistory(roots.roots.reported, filterPath) }

      const limit = Math.min(request.limit ?? GIT_HISTORY_LIMIT, GIT_HISTORY_MAX_LIMIT)
      const skip = request.skip ?? 0
      const repoFilter = filterPath === null
        ? null
        : projectPathToRepoPath(repository, roots.roots.canonical, filterPath)

      // 多取一条用来判断还有没有更早的提交，比再跑一次 count 便宜。
      const { stdout } = await runGit(
        [
          ...LOG_ARGS,
          `--skip=${skip}`,
          `-n${limit + 1}`,
          ...(repoFilter === null ? [] : ['--', repoFilter])
        ],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )
      const parsed = parseGitLog(stdout)
      const hasMore = parsed.length > limit
      const upstream = await this.upstreamOf(repository)
      // 没有上游 = 这些提交确实还没推到任何地方；有上游但查不出未推送集合时才按「不知道」处理（不误报）。
      const unpushed = upstream === null ? null : await this.unpushedOids(repository, limit)

      return {
        ok: true,
        data: {
          projectPath: roots.roots.reported,
          isRepository: true,
          upstreamName: upstream?.name ?? null,
          aheadCount: upstream?.ahead ?? 0,
          commits: parsed.slice(0, limit).map((commit) => ({
            ...commit,
            pushed: upstream === null ? false : unpushed === null ? true : !unpushed.has(commit.oid)
          })),
          hasMore,
          limit,
          path: filterPath
        }
      }
    } catch (error) {
      return { ok: false, error: gitError(error, '读取提交历史失败。') }
    }
  }

  /** 读取一个提交的元信息与改动文件清单；文件带该次提交的行数增减。 */
  async commitDetail(request: GitCommitDetailRequest): Promise<GitCommitDetailResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots

    try {
      const repository = await resolveGitRepository(roots.roots.canonical)
      if (repository === null) return failure('NOT_A_REPOSITORY', '当前项目不是 Git 仓库。')

      const oid = await this.verifyCommit(repository, request.oid)
      if (oid === null) return failure('INVALID_REQUEST', '找不到该提交，可能已被删除或改写。')

      const meta = parseGitLog(
        (await runGit([...LOG_ARGS, '-n1', oid], { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS })).stdout
      )[0]
      if (meta === undefined) return failure('INVALID_REQUEST', '找不到该提交的元信息。')

      const rawMessage = (await runGit(
        ['show', '-s', '--no-color', '--format=%B', '-z', oid],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )).stdout
      const filesRaw = (await runGit(
        ['diff-tree', '--root', '--no-commit-id', '-r', '--raw', '--numstat', '-z', '-M', '-C', oid],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )).stdout

      const files: GitCommitFile[] = []
      for (const file of parseDiffTreeFiles(filesRaw)) {
        const path = repoPathToProjectPath(repository, roots.roots.canonical, file.path)
        if (path === null) continue
        const oldPath = file.oldPath === undefined
          ? undefined
          : repoPathToProjectPath(repository, roots.roots.canonical, file.oldPath) ?? undefined
        files.push({ ...file, path, ...(oldPath === undefined ? {} : { oldPath }) })
        if (files.length >= GIT_COMMIT_FILES_LIMIT) break
      }

      const detail: GitCommitDetail = {
        oid: meta.oid,
        shortOid: meta.shortOid,
        subject: meta.subject,
        body: bodyOf(rawMessage),
        authorName: meta.authorName,
        authorEmail: meta.authorEmail,
        authoredAt: meta.authoredAt,
        parents: meta.parents,
        refs: meta.refs,
        files,
        truncated: files.length >= GIT_COMMIT_FILES_LIMIT
      }
      return { ok: true, data: detail }
    } catch (error) {
      return { ok: false, error: gitError(error, '读取提交详情失败。') }
    }
  }

  /** 读取一个提交内某个文件的差异：原内容取父提交，新内容取该提交。 */
  async commitDiff(request: GitCommitDiffRequest): Promise<GitCommitDiffResult> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots

    const relativePath = normalizeRelativeDirectory(request.path)
    if (relativePath === null || relativePath === '') {
      return failure('INVALID_REQUEST', '差异路径必须是项目内的相对路径。')
    }

    try {
      const repository = await resolveGitRepository(roots.roots.canonical)
      if (repository === null) return failure('NOT_A_REPOSITORY', '当前项目不是 Git 仓库。')

      const oid = await this.verifyCommit(repository, request.oid)
      if (oid === null) return failure('INVALID_REQUEST', '找不到该提交，可能已被删除或改写。')

      const repoPath = projectPathToRepoPath(repository, roots.roots.canonical, relativePath)
      // 重命名条目要用原路径去父提交取内容，否则会被当成「新文件」。
      const originalPath = request.oldPath === undefined
        ? repoPath
        : projectPathToRepoPath(repository, roots.roots.canonical, normalizeRelativeDirectory(request.oldPath) ?? relativePath)

      const original = await this.readBlob(repository, `${oid}^:${originalPath}`)
      const modified = await this.readBlob(repository, `${oid}:${repoPath}`)
      return {
        ok: true,
        data: { oid, path: relativePath, ...this.toTextDiff(original, modified) }
      }
    } catch (error) {
      return { ok: false, error: gitError(error, '读取提交差异失败。') }
    }
  }

  /** 上游分支名；没有配置上游时返回 null（`@{u}` 会以退出码 128 失败，这是正常状态）。 */
  private async upstreamNameOf(repository: GitRepository): Promise<string | null> {
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )
      const name = stdout.trim()
      return name === '' ? null : name
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed') return null
      throw error
    }
  }

  /** 当前分支名；分离 HEAD 时返回 null。 */
  private async currentBranch(repository: GitRepository): Promise<string | null> {
    const { stdout } = await runGit(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
    )
    const name = stdout.trim()
    return name === '' || name === 'HEAD' ? null : name
  }

  /** 已配置的远端名；读取失败时按「没有远端」处理，不把整个状态读取打成错误。 */
  private async remoteNames(repository: GitRepository): Promise<string[]> {
    try {
      const { stdout } = await runGit(['remote'], { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS })
      return stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
    } catch {
      return []
    }
  }

  /** 上游分支名与领先数；没有上游时返回 null（不是错误）。 */
  private async upstreamOf(repository: GitRepository): Promise<{ name: string; ahead: number } | null> {
    const name = await this.upstreamNameOf(repository)
    if (name === null) return null
    const count = await runGit(
      ['rev-list', '--count', '@{u}..HEAD'],
      { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
    )
    return { name, ahead: Number.parseInt(count.stdout.trim(), 10) || 0 }
  }

  /** 还没推到上游的提交 oid（最多取 limit 个）；失败时返回 null，界面按「不知道」处理。 */
  private async unpushedOids(repository: GitRepository, limit: number): Promise<Set<string> | null> {
    try {
      const { stdout } = await runGit(
        ['rev-list', `--max-count=${limit}`, '@{u}..HEAD'],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )
      return new Set(stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== ''))
    } catch {
      return null
    }
  }

  /** 把用户给的引用解析成完整提交 oid；不是提交时返回 null。 */
  private async verifyCommit(repository: GitRepository, ref: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS }
      )
      const oid = stdout.trim()
      return oid === '' ? null : oid
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed') return null
      throw error
    }
  }

  /** 读取状态并保证不抛异常：所有失败都换成契约里的错误结构。 */
  private async readStatusSettled(roots: ProjectRoots): Promise<GitStatusResult> {
    let seq = this.mutationSeq
    let result = await this.loadStatus(roots)
    // 读取期间发生过写操作：结果可能已过期，重读；只重试两轮，避免持续写入时死循环。
    for (let attempt = 0; attempt < 2 && seq !== this.mutationSeq; attempt += 1) {
      seq = this.mutationSeq
      result = await this.loadStatus(roots)
    }
    return result
  }

  private async loadStatus(roots: ProjectRoots): Promise<GitStatusResult> {
    try {
      const repository = await resolveGitRepository(roots.canonical)
      if (repository === null) return { ok: true, data: emptyStatus(roots.reported) }

      const parser = createGitStatusParser(GIT_STATUS_LIMIT)
      // 远端名与状态读取并行：它很便宜，但没必要再串一次子进程。
      const remotes = this.remoteNames(repository)
      await streamGit(
        [
          ...QUOTE_PATH_ARGS,
          'status',
          '--porcelain=v2',
          '--branch',
          '--untracked-files=all',
          '--',
          repositoryPathspec(repository, roots.canonical)
        ],
        { cwd: repository.root, timeoutMs: GIT_READ_TIMEOUT_MS },
        (chunk) => parser.update(chunk)
      )

      const snapshot = parser.finish()
      const conflictOperation = await detectConflictOperation(repository.gitDir)
      return {
        ok: true,
        data: {
          projectPath: roots.reported,
          isRepository: true,
          repositoryRoot: repository.root,
          head: snapshot.head,
          branch: snapshot.branch,
          detached: snapshot.detached,
          upstream: snapshot.upstream,
          remotes: await remotes,
          conflictOperation,
          entries: mapEntries(snapshot.entries, repository, roots.canonical),
          truncated: snapshot.truncated,
          totalCount: snapshot.totalCount,
          generatedAt: Date.now()
        }
      }
    } catch (error) {
      return { ok: false, error: gitError(error, '读取 Git 状态失败。') }
    }
  }

  /** 写操作：同仓库串行执行，成功后递增代际并回传最新状态。 */
  private async mutate(
    prepared: Extract<PreparedPath, { ok: true }>,
    run: () => Promise<void>,
    fallbackMessage: string
  ): Promise<GitOperationResult> {
    try {
      await this.withLock(prepared.repository.root, run)
    } catch (error) {
      return { ok: false, error: gitError(error, fallbackMessage) }
    }
    this.mutationSeq += 1
    // 写之前的在途读不能再回给界面：丢掉它，重新读一次。
    this.statusInFlight.delete(prepared.reportedProjectRoot)
    return this.loadStatus({
      reported: prepared.reportedProjectRoot,
      canonical: prepared.projectRoot
    })
  }

  /** 仓库级串行队列：队尾表示「最后一个等待者完成」。 */
  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(key) ?? Promise.resolve()
    const result = previous.then(run, run)
    const settled = result.then(() => undefined, () => undefined)
    this.lanes.set(key, settled)
    void settled.then(() => {
      if (this.lanes.get(key) === settled) this.lanes.delete(key)
    })
    return result
  }

  private async prepare(path: string): Promise<PreparedPath> {
    const roots = await this.resolveRoots()
    if (!roots.ok) return roots
    const prepared = await this.prepareRoot(roots.roots)
    if (!prepared.ok) return prepared

    const resolved = await resolveProjectEntryAbsolute(roots.roots.canonical, path)
    if (!resolved.ok) return resolved

    return {
      ok: true,
      repository: prepared.repository,
      projectRoot: roots.roots.canonical,
      reportedProjectRoot: roots.roots.reported,
      relativePath: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      repoPath: projectPathToRepoPath(prepared.repository, roots.roots.canonical, resolved.relativePath)
    }
  }

  private async prepareRoot(roots: ProjectRoots): Promise<PreparedPath> {
    try {
      const repository = await resolveGitRepository(roots.canonical)
      if (repository === null) return failure('NOT_A_REPOSITORY', '当前项目不是 Git 仓库。')
      return {
        ok: true,
        repository,
        projectRoot: roots.canonical,
        reportedProjectRoot: roots.reported,
        relativePath: '',
        absolutePath: roots.canonical,
        repoPath: ''
      }
    } catch (error) {
      return { ok: false, error: gitError(error, '无法访问 Git 仓库。') }
    }
  }

  /** 当前项目的两个路径视角；未选择项目时回错误。 */
  private async resolveRoots(): Promise<{ ok: true; roots: ProjectRoots } | { ok: false; error: DesktopError }> {
    const reported = this.options.currentProjectPath()
    if (reported === null) return failure('INVALID_REQUEST', '尚未选择项目，无法操作 Git。')
    return { ok: true, roots: { reported, canonical: await canonicalProjectRoot(reported) } }
  }

  /** 该路径是否已纳入索引（`--error-unmatch` 用退出码回答）。 */
  private async isTracked(prepared: Extract<PreparedPath, { ok: true }>): Promise<boolean> {
    try {
      await runGit(['ls-files', '--error-unmatch', '--', prepared.repoPath], {
        cwd: prepared.repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      return true
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed') return false
      throw error
    }
  }

  /** HEAD 里是否存在该路径；空仓库（没有 HEAD）一律视为不存在。 */
  private async existsInHead(prepared: Extract<PreparedPath, { ok: true }>): Promise<boolean> {
    try {
      await runGit(['cat-file', '-e', `HEAD:${prepared.repoPath}`], {
        cwd: prepared.repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      return true
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed') return false
      throw error
    }
  }

  /** 读索引或 HEAD 里的内容；不存在（新增/未纳入索引）返回 null。 */
  private async readBlob(repository: GitRepository, spec: string): Promise<Buffer | null> {
    try {
      const { stdout } = await runGitBuffer(['show', spec], {
        cwd: repository.root,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      return stdout
    } catch (error) {
      if (error instanceof GitCommandError && error.kind === 'failed') return null
      throw error
    }
  }

  /** 读工作区文件；已被删除返回 null（删除类改动就是这种情形）。 */
  private async readWorktreeFile(absolutePath: string): Promise<Buffer | null> {
    try {
      return await readFile(absolutePath)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
      throw error
    }
  }
}

/** 原内容来自哪里：已暂存比 HEAD 与索引，未暂存与未跟踪比索引与工作区。 */
function originalSpec(repoPath: string, area: GitDiffRequest['area']): string {
  return area === 'staged' ? `HEAD:${repoPath}` : `:${repoPath}`
}

/** 条目路径折算成项目内相对路径；落在项目外的条目（仓库子目录场景）直接丢弃。 */
function mapEntries(
  entries: readonly GitChangeEntry[],
  repository: GitRepository,
  projectRoot: string
): GitChangeEntry[] {
  const mapped: GitChangeEntry[] = []
  for (const entry of entries) {
    const path = repoPathToProjectPath(repository, projectRoot, entry.path)
    if (path === null) continue
    const { oldPath: rawOldPath, ...rest } = entry
    if (rawOldPath === undefined) {
      mapped.push({ ...rest, path })
      continue
    }
    const oldPath = repoPathToProjectPath(repository, projectRoot, rawOldPath)
    mapped.push(oldPath === null ? { ...rest, path } : { ...rest, path, oldPath })
  }
  return mapped
}

/** 非仓库时的状态：空列表 + `isRepository: false`，界面显示空态而不是报错。 */
function emptyStatus(projectPath: string): GitStatus {
  return {
    projectPath,
    isRepository: false,
    repositoryRoot: null,
    head: null,
    branch: null,
    detached: false,
    upstream: null,
    remotes: [],
    conflictOperation: null,
    entries: [],
    truncated: false,
    totalCount: 0,
    generatedAt: Date.now()
  }
}

function failure(code: DesktopErrorCode, message: string): { ok: false; error: DesktopError } {
  return { ok: false, error: { code, message } }
}

/** git 失败到契约错误码的映射：只有「没装 git」与「不是仓库」需要区分，其余都是可展示的失败原因。 */
function gitError(error: unknown, fallbackMessage: string): DesktopError {
  if (error instanceof GitCommandError) {
    if (error.kind === 'unavailable') return { code: 'GIT_UNAVAILABLE', message: error.message }
    if (error.kind === 'aborted') return { code: 'GIT_FAILED', message: '操作已取消。' }
    if (error.kind === 'timeout') return { code: 'GIT_FAILED', message: error.message }
    return { code: 'GIT_FAILED', message: error.message === '' ? fallbackMessage : error.message }
  }
  return { code: 'INTERNAL_ERROR', message: fallbackMessage }
}

/** 老版本 git 没有 `restore` 子命令：两种情况都退回 `reset`/`checkout`。 */
function isMissingRestore(error: unknown): boolean {
  if (!(error instanceof GitCommandError) || error.kind !== 'failed') return false
  return /unknown option|unknown switch|is not a git command/u.test(error.stderr)
}

/**
 * 远端操作失败：把最常见的几种 stderr 换成能直接照做的中文原因，其余保留 git 自己的最后一句话。
 * 只改写「git 报错」这一类，`unavailable` / `timeout` / `aborted` 保持原样，错误码映射才不会被掩盖。
 */
function remoteFailure(error: unknown, operation: 'pull' | 'push'): unknown {
  if (!(error instanceof GitCommandError) || error.kind !== 'failed') return error
  const message = remoteFailureMessage(error.stderr, operation)
  if (message === null) return error
  return new GitCommandError('failed', message, {
    stderr: error.stderr,
    exitCode: error.exitCode,
    subcommand: error.subcommand
  })
}

function remoteFailureMessage(stderr: string, operation: 'pull' | 'push'): string | null {
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/iu.test(stderr)) {
    return `远端拒绝了凭据：先在终端里完成一次 git ${operation} 让 git 记住账号，或配置好 SSH 密钥后重试。`
  }
  if (/Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable/iu.test(stderr)) {
    return '连不上远端：检查网络、代理与远端地址后重试。'
  }
  if (/Need to specify how to reconcile divergent branches|not possible to fast-forward/iu.test(stderr)) {
    return '本地与远端已经分叉，git 不知道该合并还是变基：在终端执行一次 git pull 选择策略，或先配置 pull.rebase。'
  }
  if (/would be overwritten by (merge|checkout|pull)|Please commit your changes or stash them|Please move or remove them/iu.test(stderr)) {
    return '有未提交的改动会被覆盖，先提交或暂存后再拉取。'
  }
  if (/\[rejected\]|non-fast-forward|fetch first/iu.test(stderr)) {
    return '远端有本地没有的提交，先拉取再推送。'
  }
  if (/has no upstream branch|no upstream configured/iu.test(stderr)) {
    return '当前分支还没有上游分支，先配置远端后再推送。'
  }
  if (/does not appear to be a git repository|No such remote|Could not read from remote repository/iu.test(stderr)) {
    return '无法访问远端仓库：检查远端地址与访问权限。'
  }
  return null
}

function isBinary(buffer: Buffer | null): boolean {
  if (buffer === null) return false
  const probe = buffer.subarray(0, Math.min(buffer.length, BINARY_PROBE_BYTES))
  return probe.includes(0)
}

function usesCrlf(buffer: Buffer | null): boolean {
  if (buffer === null) return false
  return buffer.includes(Buffer.from('\r\n', 'utf8'))
}

/** 两侧内容统一成 `\n`：差异按行比较，换行符本身不作为改动展示。 */
function decodeText(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/\r\n/gu, '\n')
}

function binaryDiff(): GitTextDiff {
  return { kind: 'binary', originalText: null, modifiedText: null, eol: 'lf', truncated: false }
}

function tooLargeDiff(): GitTextDiff {
  return { kind: 'too-large', originalText: null, modifiedText: null, eol: 'lf', truncated: true }
}

/** 非仓库时的历史：空列表 + `isRepository: false`，与状态读取保持同一口径。 */
function emptyHistory(projectPath: string, path: string | null): GitHistory {
  return {
    projectPath,
    isRepository: false,
    upstreamName: null,
    aheadCount: 0,
    commits: [],
    hasMore: false,
    limit: GIT_HISTORY_LIMIT,
    path
  }
}

/** 提交信息正文：`%B` 的第一行是标题，其余是正文。 */
function bodyOf(rawMessage: string): string {
  const message = rawMessage.replace(/\0+$/u, '').replace(/\r\n/gu, '\n')
  const newline = message.indexOf('\n')
  if (newline === -1) return ''
  return message.slice(newline + 1).trim()
}
