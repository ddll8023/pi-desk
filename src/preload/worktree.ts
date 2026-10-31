/**
 * Git Worktree：preload 的 worktree 域，只经固定 channel 与主进程通信，载荷与响应在此校验。
 */
import { ipcRenderer } from 'electron'
import {
  WORKTREE_CREATE_CHANNEL,
  WORKTREE_LIST_CHANNEL,
  WORKTREE_MERGE_CHANNEL,
  WORKTREE_REMOVE_CHANNEL,
  WORKTREE_STATUS_CHANNEL,
  isCreateWorktreeResult,
  isMergeWorktreeResult,
  isRemoveWorktreeResult,
  isWorktreeListResult,
  isWorktreeStatusResult
} from '../shared/worktree-api'
import type {
  CreateWorktreeRequest,
  CreateWorktreeResult,
  MergeWorktreeRequest,
  MergeWorktreeResult,
  RemoveWorktreeRequest,
  RemoveWorktreeResult,
  WorktreeApi,
  WorktreeListResult,
  WorktreeStatusRequest,
  WorktreeStatusResult
} from '../shared/worktree-api'

const INVALID_WORKTREE_RESPONSE = '桌面接口返回了无法识别的工作树结果。'

function invalidWorktreeListResponse(): WorktreeListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
}

function invalidCreateWorktreeResponse(): CreateWorktreeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
}

function invalidRemoveWorktreeResponse(): RemoveWorktreeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
}

function invalidMergeWorktreeResponse(): MergeWorktreeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
}

function invalidWorktreeStatusResponse(): WorktreeStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
}

export const worktreeApi: WorktreeApi = {
  async listWorktrees(): Promise<WorktreeListResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_LIST_CHANNEL)
    return isWorktreeListResult(response) ? response : invalidWorktreeListResponse()
  },

  async createWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_CREATE_CHANNEL, {
      branchName: request.branchName,
      ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch })
    })
    return isCreateWorktreeResult(response) ? response : invalidCreateWorktreeResponse()
  },

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_REMOVE_CHANNEL, {
      worktreePath: request.worktreePath,
      ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch }),
      ...(request.force === undefined ? {} : { force: request.force })
    })
    return isRemoveWorktreeResult(response) ? response : invalidRemoveWorktreeResponse()
  },

  async getWorktreeStatus(request: WorktreeStatusRequest): Promise<WorktreeStatusResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_STATUS_CHANNEL, {
      worktreePath: request.worktreePath
    })
    return isWorktreeStatusResult(response) ? response : invalidWorktreeStatusResponse()
  },

  async mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_MERGE_CHANNEL, {
      worktreePath: request.worktreePath,
      ...(request.squash === undefined ? {} : { squash: request.squash }),
      ...(request.deleteAfterMerge === undefined ? {} : { deleteAfterMerge: request.deleteAfterMerge })
    })
    return isMergeWorktreeResult(response) ? response : invalidMergeWorktreeResponse()
  }
}
