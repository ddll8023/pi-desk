/** 源代码管理：preload 的 git 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { GIT_COMMIT_CHANNEL, GIT_COMMIT_DETAIL_CHANNEL, GIT_COMMIT_DIFF_CHANNEL, GIT_DIFF_CHANNEL, GIT_DISCARD_CHANNEL, GIT_HISTORY_CHANNEL, GIT_PULL_CHANNEL, GIT_PUSH_CHANNEL, GIT_STAGE_CHANNEL, GIT_STATUS_CHANNEL, GIT_UNSTAGE_CHANNEL, isGitCommitDetailResult, isGitCommitDiffResult, isGitDiffResult, isGitHistoryResult, isGitStatusResult } from '../shared/git-api'
import type { GitCommitDetailRequest, GitCommitDetailResult, GitCommitDiffRequest, GitCommitDiffResult, GitCommitRequest, GitDiffRequest, GitDiffResult, GitHistoryRequest, GitHistoryResult, GitOperationResult, GitStatusResult, GitWritePathRequest } from '../shared/git-api'
import type { GitApi } from '../shared/git-api'

const INVALID_GIT_RESPONSE = '桌面接口返回了无法识别的 Git 结果。'

function invalidGitStatusResponse(): GitStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitDiffResponse(): GitDiffResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitHistoryResponse(): GitHistoryResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitCommitDetailResponse(): GitCommitDetailResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

function invalidGitCommitDiffResponse(): GitCommitDiffResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GIT_RESPONSE } }
}

export const gitApi = {
  async getGitStatus(): Promise<GitStatusResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_STATUS_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_DIFF_CHANNEL, { path: request.path, area: request.area })
    return isGitDiffResult(response) ? response : invalidGitDiffResponse()
  },

  async stageGitPaths(request: GitWritePathRequest): Promise<GitOperationResult> {
    const payload = 'paths' in request ? { paths: request.paths } : { path: request.path }
    const response: unknown = await ipcRenderer.invoke(GIT_STAGE_CHANNEL, payload)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async unstageGitPaths(request: GitWritePathRequest): Promise<GitOperationResult> {
    const payload = 'paths' in request ? { paths: request.paths } : { path: request.path }
    const response: unknown = await ipcRenderer.invoke(GIT_UNSTAGE_CHANNEL, payload)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async discardGitPath(request: GitWritePathRequest): Promise<GitOperationResult> {
    const payload = 'paths' in request ? { paths: request.paths } : { path: request.path }
    const response: unknown = await ipcRenderer.invoke(GIT_DISCARD_CHANNEL, payload)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async commitGitStaged(request: GitCommitRequest): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_CHANNEL, { message: request.message })
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async pullGit(): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_PULL_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async pushGit(): Promise<GitOperationResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_PUSH_CHANNEL)
    return isGitStatusResult(response) ? response : invalidGitStatusResponse()
  },

  async getGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_HISTORY_CHANNEL, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.skip === undefined ? {} : { skip: request.skip }),
      ...(request.path === undefined ? {} : { path: request.path })
    })
    return isGitHistoryResult(response) ? response : invalidGitHistoryResponse()
  },

  async getGitCommitDetail(request: GitCommitDetailRequest): Promise<GitCommitDetailResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_DETAIL_CHANNEL, { oid: request.oid })
    return isGitCommitDetailResult(response) ? response : invalidGitCommitDetailResponse()
  },

  async getGitCommitDiff(request: GitCommitDiffRequest): Promise<GitCommitDiffResult> {
    const response: unknown = await ipcRenderer.invoke(GIT_COMMIT_DIFF_CHANNEL, {
      oid: request.oid,
      path: request.path,
      ...(request.oldPath === undefined ? {} : { oldPath: request.oldPath })
    })
    return isGitCommitDiffResult(response) ? response : invalidGitCommitDiffResponse()
  }
} satisfies GitApi
