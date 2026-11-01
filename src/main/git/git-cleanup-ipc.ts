/**
 * Git 清理与维护的 IPC 注册：只接受可信页面调用，参数与调用者逐一校验，业务动作全部交给 GitCleanupService。
 */
import type { DesktopError } from '../../shared/desktop-api'
import {
  GIT_CLEANUP_PRUNE_WORKTREES_CHANNEL,
  GIT_CLEANUP_REMOVE_BRANCHES_CHANNEL,
  GIT_CLEANUP_REMOVE_WORKTREES_CHANNEL,
  GIT_CLEANUP_RUN_GC_CHANNEL,
  GIT_CLEANUP_SUMMARY_CHANNEL,
  isGitCleanupSummaryRequest,
  isGitPruneWorktreesRequest,
  isGitRemoveBranchesRequest,
  isGitRemoveWorktreesRequest,
  isGitRunGcRequest
} from '../../shared/git-cleanup-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { gitCleanupService } from '../services'

type Failure = { readonly ok: false; readonly error: DesktopError }

function forbidden(): Failure {
  return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
}

function invalid(): Failure {
  return { ok: false, error: { code: 'INVALID_REQUEST', message: '清理请求缺少项目路径或参数不合法。' } }
}

export function registerGitCleanupHandlers(pageUrl: string): void {
  handle(GIT_CLEANUP_SUMMARY_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isGitCleanupSummaryRequest(request)) return invalid()
    return gitCleanupService.summary(request.projectPath)
  })
  handle(GIT_CLEANUP_PRUNE_WORKTREES_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isGitPruneWorktreesRequest(request)) return invalid()
    return gitCleanupService.pruneWorktrees(request.projectPath)
  })
  handle(GIT_CLEANUP_REMOVE_WORKTREES_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isGitRemoveWorktreesRequest(request)) return invalid()
    return gitCleanupService.removeWorktrees(request)
  })
  handle(GIT_CLEANUP_REMOVE_BRANCHES_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isGitRemoveBranchesRequest(request)) return invalid()
    return gitCleanupService.removeTaskBranches(request)
  })
  handle(GIT_CLEANUP_RUN_GC_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isGitRunGcRequest(request)) return invalid()
    return gitCleanupService.runGc(request.projectPath)
  })
}
