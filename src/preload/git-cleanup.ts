/**
 * Git 清理与维护：preload 的 git-cleanup 域，只经固定 channel 与主进程通信，载荷与响应在此校验。
 */
import { ipcRenderer } from 'electron'
import {
  GIT_CLEANUP_PRUNE_WORKTREES_CHANNEL,
  GIT_CLEANUP_REMOVE_BRANCHES_CHANNEL,
  GIT_CLEANUP_REMOVE_WORKTREES_CHANNEL,
  GIT_CLEANUP_RUN_GC_CHANNEL,
  GIT_CLEANUP_SUMMARY_CHANNEL,
  isGitCleanupSummaryResult,
  isGitPruneWorktreesResult,
  isGitRemoveBranchesResult,
  isGitRemoveWorktreesResult,
  isGitRunGcResult
} from '../shared/git-cleanup-api'
import type {
  GitCleanupApi,
  GitCleanupSummaryRequest,
  GitCleanupSummaryResult,
  GitPruneWorktreesRequest,
  GitPruneWorktreesResult,
  GitRemoveBranchesRequest,
  GitRemoveBranchesResult,
  GitRemoveWorktreesRequest,
  GitRemoveWorktreesResult,
  GitRunGcRequest,
  GitRunGcResult
} from '../shared/git-cleanup-api'

const INVALID_CLEANUP_RESPONSE = '桌面接口返回了无法识别的 Git 清理结果。'

function invalidResponse<T>(): T {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_CLEANUP_RESPONSE } } as T
}

export const gitCleanupApi: GitCleanupApi = {
  async getGitCleanupSummary(request: GitCleanupSummaryRequest): Promise<GitCleanupSummaryResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_CLEANUP_SUMMARY_CHANNEL, { projectPath: request.projectPath })
    return isGitCleanupSummaryResult(response) ? response : invalidResponse<GitCleanupSummaryResult>()
  },

  async pruneWorktrees(request: GitPruneWorktreesRequest): Promise<GitPruneWorktreesResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_CLEANUP_PRUNE_WORKTREES_CHANNEL, { projectPath: request.projectPath })
    return isGitPruneWorktreesResult(response) ? response : invalidResponse<GitPruneWorktreesResult>()
  },

  async removeWorktrees(request: GitRemoveWorktreesRequest): Promise<GitRemoveWorktreesResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_CLEANUP_REMOVE_WORKTREES_CHANNEL, {
      projectPath: request.projectPath,
      worktreePaths: [...request.worktreePaths],
      ...(request.force === undefined ? {} : { force: request.force }),
      ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch })
    })
    return isGitRemoveWorktreesResult(response) ? response : invalidResponse<GitRemoveWorktreesResult>()
  },

  async removeTaskBranches(request: GitRemoveBranchesRequest): Promise<GitRemoveBranchesResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_CLEANUP_REMOVE_BRANCHES_CHANNEL, {
      projectPath: request.projectPath,
      branchNames: [...request.branchNames],
      ...(request.force === undefined ? {} : { force: request.force })
    })
    return isGitRemoveBranchesResult(response) ? response : invalidResponse<GitRemoveBranchesResult>()
  },

  async runGitGc(request: GitRunGcRequest): Promise<GitRunGcResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_CLEANUP_RUN_GC_CHANNEL, { projectPath: request.projectPath })
    return isGitRunGcResult(response) ? response : invalidResponse<GitRunGcResult>()
  }
}
