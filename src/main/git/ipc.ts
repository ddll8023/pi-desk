/** 源代码管理 IPC：状态、差异、暂存与取消暂存、丢弃改动、提交与提交详情、拉取与推送。仓库根与路径折算都在主进程，页面只给项目内相对路径；写操作先过项目信任门禁。 */

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import {
  GIT_COMMIT_CHANNEL,
  GIT_COMMIT_DETAIL_CHANNEL,
  GIT_COMMIT_DIFF_CHANNEL,
  GIT_DIFF_CHANNEL,
  GIT_DISCARD_CHANNEL,
  GIT_HISTORY_CHANNEL,
  GIT_PULL_CHANNEL,
  GIT_PUSH_CHANNEL,
  GIT_STAGE_CHANNEL,
  GIT_STATUS_CHANNEL,
  GIT_UNSTAGE_CHANNEL,
  isGitCommitDetailRequest,
  isGitCommitDiffRequest,
  isGitCommitRequest,
  isGitDiffRequest,
  isGitHistoryRequest,
  isGitWritePathRequest
} from '../../shared/git-api'
import type {
  GitCommitDetailResult,
  GitCommitDiffResult,
  GitDiffResult,
  GitHistoryResult,
  GitOperationResult,
  GitStatusResult
} from '../../shared/git-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { gitService } from '../services'
import { requireGitWriteTrust } from '../trust/guards'

export function gitStatusFailure(code: DesktopErrorCode, message: string): GitStatusResult {
  return { ok: false, error: { code, message } }
}

export function gitDiffFailure(code: DesktopErrorCode, message: string): GitDiffResult {
  return { ok: false, error: { code, message } }
}

export function gitHistoryFailure(code: DesktopErrorCode, message: string): GitHistoryResult {
  return { ok: false, error: { code, message } }
}

export function gitCommitDetailFailure(code: DesktopErrorCode, message: string): GitCommitDetailResult {
  return { ok: false, error: { code, message } }
}

export function gitCommitDiffFailure(code: DesktopErrorCode, message: string): GitCommitDiffResult {
  return { ok: false, error: { code, message } }
}

/**
 * 源代码管理通道：状态读取不带参数；diff 只接受「项目内相对路径 + 区域」；历史接受可选的条数、偏移与
 * 过滤路径；提交详情只接受提交标识；提交内差异接受提交标识与路径（重命名条目另带原路径）；写操作只接受
 * 单个或批量项目内相对路径，提交额外只接受提交信息；拉取与推送都不接受参数。页面不能指定仓库根，也不能传入任何 git
 * 参数：命令组装、仓库定位与路径折算都在主进程，写操作成功时直接回传新状态，避免「写完再拉一次」的竞态。
 *
 * 写操作需要项目信任：暂存、取消暂存与恢复会跑仓库配置的 clean/smudge filter，提交会跑 pre-commit hook，
 * 推送会跑 pre-push hook，拉取会跑 merge driver，它们都能执行仓库里的代码。读操作（状态、差异、历史）
 * 不执行仓库代码，因此不做拦截，面板打开与刷新不会被信任弹窗打断。
 */
export function registerGitHandlers(pageUrl: string): void {
  handle(
    GIT_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return gitStatusFailure('INVALID_REQUEST', 'Git 状态接口不接受参数。')
      }
      return gitService.status()
    }
  )

  handle(
    GIT_DIFF_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitDiffResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitDiffFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitDiffRequest(args[0])) {
        return gitDiffFailure('INVALID_REQUEST', '查看差异只接受一个项目内相对路径与区域请求。')
      }
      return gitService.diff(args[0])
    }
  )

  handle(
    GIT_STAGE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitWritePathRequest(args[0])) {
        return gitStatusFailure('INVALID_REQUEST', '暂存只接受项目内相对路径请求。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.stage(args[0])
    }
  )

  handle(
    GIT_UNSTAGE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitWritePathRequest(args[0])) {
        return gitStatusFailure('INVALID_REQUEST', '取消暂存只接受项目内相对路径请求。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.unstage(args[0])
    }
  )

  handle(
    GIT_DISCARD_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitWritePathRequest(args[0])) {
        return gitStatusFailure('INVALID_REQUEST', '丢弃改动只接受项目内相对路径请求。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.discard(args[0])
    }
  )

  handle(
    GIT_COMMIT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitCommitRequest(args[0])) {
        return gitStatusFailure('INVALID_REQUEST', '提交只接受一条非空的提交信息。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.commit(args[0])
    }
  )

  handle(
    GIT_PULL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return gitStatusFailure('INVALID_REQUEST', '拉取不接受参数：远端与策略沿用仓库配置。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.pull()
    }
  )

  handle(
    GIT_PUSH_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitOperationResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return gitStatusFailure('INVALID_REQUEST', '推送不接受参数：远端与分支由主进程根据仓库现状决定。')
      }
      const blocked = await requireGitWriteTrust()
      if (blocked !== null) return { ok: false, error: blocked }
      return gitService.push()
    }
  )

  handle(
    GIT_HISTORY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitHistoryResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitHistoryFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitHistoryRequest(args[0])) {
        return gitHistoryFailure('INVALID_REQUEST', '历史只接受一个可选的条数与过滤路径请求。')
      }
      return gitService.history(args[0])
    }
  )

  handle(
    GIT_COMMIT_DETAIL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitCommitDetailResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitCommitDetailFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitCommitDetailRequest(args[0])) {
        return gitCommitDetailFailure('INVALID_REQUEST', '提交详情只接受一个提交标识。')
      }
      return gitService.commitDetail(args[0])
    }
  )

  handle(
    GIT_COMMIT_DIFF_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GitCommitDiffResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return gitCommitDiffFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isGitCommitDiffRequest(args[0])) {
        return gitCommitDiffFailure('INVALID_REQUEST', '提交内差异只接受一个提交标识与项目内相对路径。')
      }
      return gitService.commitDiff(args[0])
    }
  )
}
