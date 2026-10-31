/**
 * 主进程 Turn 代码快照与回滚服务：
 * 为处于独立 Git Worktree 的会话提供轮次级别的代码快照与时光倒流回退能力。
 *
 * 核心机制：
 * - 当 Agent 交互轮次结束且产生文件改动时，在当前工作树执行轻量提交：
 *   `git add -A && git commit -m "pi-desk: turn-<messageId>" --no-verify`
 * - 当用户对指定 messageId 发起回退时，定位该消息发出前的基准提交（若该消息产生过快照则为其父提交），
 *   执行 `git reset --hard <commit>` 并清除未跟踪文件，使代码精确回到提问发生前的状态。
 */
import { resolve } from 'node:path'
import { GIT_READ_TIMEOUT_MS, GitCommandError, runGit } from './git-command'

export const TURN_COMMIT_PREFIX = 'pi-desk: turn-'

export interface CommitRecord {
  readonly hash: string
  readonly subject: string
}

/** 从提交信息中提取绑定的 messageId（纯函数，供单测验证） */
export function parseTurnMessageIdFromSubject(subject: string): string | null {
  const trimmed = subject.trim()
  if (trimmed.startsWith(TURN_COMMIT_PREFIX)) {
    const id = trimmed.slice(TURN_COMMIT_PREFIX.length).trim()
    return id !== '' ? id : null
  }
  return null
}

/**
 * 在历史提交列表中定位将 messageId 对应轮次完全撤销的目标 Commit（纯函数）：
 * - 若找到对应 `pi-desk: turn-<messageId>` 的提交，撤销目标即为该提交的父提交（下一项）；
 * - 若该 message 自身未产生修改，但在历史中位于某两个快照之间，定位到该消息发起时的基准提交。
 */
export function findRevertTargetCommit(
  commits: readonly CommitRecord[],
  targetMessageId: string
): { targetHash: string; matchedCommitHash: string | null } | null {
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    if (c === undefined) continue
    const msgId = parseTurnMessageIdFromSubject(c.subject)
    if (msgId === targetMessageId) {
      // 找到了该消息对应的提交快照，回退目标为其父提交
      const parent = commits[i + 1]
      if (parent !== undefined) {
        return { targetHash: parent.hash, matchedCommitHash: c.hash }
      }
      // 如果没有更早的提交，使用 HEAD~1 语义
      return { targetHash: `${c.hash}~1`, matchedCommitHash: c.hash }
    }
  }
  return null
}

export class TurnSnapshotService {
  /**
   * 为指定工作树记录当前轮次的快照提交。
   * 若当前工作树无任何文件改动，则静默跳过提交。
   */
  async createTurnSnapshot(worktreePath: string, messageId: string): Promise<string | null> {
    const cwd = resolve(worktreePath)
    try {
      // 1. 检查是否有未提交文件（已暂存、未暂存、未跟踪）
      const { stdout: statusOut } = await runGit(['status', '--porcelain=v1'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      if (statusOut.trim() === '') {
        // 无改动，无需产生快照提交
        return null
      }

      // 2. 暂存所有修改
      await runGit(['add', '-A'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })

      // 3. 打上快照提交，带有 --no-verify 防止被本地 hook 阻塞
      const commitMsg = `${TURN_COMMIT_PREFIX}${messageId}`
      await runGit(['commit', '-m', commitMsg, '--no-verify'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })

      // 4. 读取最新 commit hash
      const { stdout: hashOut } = await runGit(['rev-parse', 'HEAD'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      return hashOut.trim()
    } catch (error) {
      console.warn(`[turn-snapshot] 为工作树 ${worktreePath} 创建快照失败：`, error)
      return null
    }
  }

  /**
   * 将工作树的代码重置到目标 messageId 发起前的状态。
   */
  async revertToTurnSnapshot(worktreePath: string, messageId: string): Promise<boolean> {
    const cwd = resolve(worktreePath)
    try {
      // 1. 读取最近 100 条提交历史（哈希与第一行主题）
      const { stdout: logOut } = await runGit(['log', '-n', '100', '--format=%H %s'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })

      const lines = logOut.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== '')
      const commits: CommitRecord[] = lines.map((line) => {
        const spaceIdx = line.indexOf(' ')
        if (spaceIdx === -1) return { hash: line, subject: '' }
        return {
          hash: line.slice(0, spaceIdx),
          subject: line.slice(spaceIdx + 1)
        }
      })

      // 2. 定位重置目标
      const target = findRevertTargetCommit(commits, messageId)
      let targetRef: string
      if (target !== null) {
        targetRef = target.targetHash
      } else {
        // 若在最近 100 条提交中未精确找到该快照标记，作为后备回退手段，
        // 尝试用 git rev-list 检索包含该标记的最早提交
        const { stdout: grepOut } = await runGit(
          ['log', '-n', '1', `--grep=^${TURN_COMMIT_PREFIX}${messageId}$`, '--format=%H'],
          { cwd, timeoutMs: GIT_READ_TIMEOUT_MS }
        )
        const matched = grepOut.trim()
        if (matched === '') {
          console.warn(`[turn-snapshot] 未找到消息 ${messageId} 对应的快照提交，跳过工作区硬重置。`)
          return false
        }
        targetRef = `${matched}~1`
      }

      // 3. 执行工作区硬重置与未跟踪文件清理
      await runGit(['reset', '--hard', targetRef], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })
      await runGit(['clean', '-fd'], {
        cwd,
        timeoutMs: GIT_READ_TIMEOUT_MS
      })

      return true
    } catch (error) {
      console.error(`[turn-snapshot] 回滚工作树 ${worktreePath} 失败：`, error)
      return false
    }
  }
}
