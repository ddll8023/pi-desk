/**
 * Git Worktree：preload 的 worktree 域，只经固定 channel 与主进程通信，载荷与响应在此校验。
 */
import { ipcRenderer } from 'electron'
import { WORKSPACE_RESOLVE_CHANNEL, isWorkspaceResolveResult } from '../shared/workspace-api'
import type { WorkspaceResolveRequest, WorkspaceResolveResult } from '../shared/workspace-api'
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
  WorktreeListRequest,
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
  async resolveWorkspace(request: WorkspaceResolveRequest): Promise<WorkspaceResolveResult> {
    const response: unknown = await ipcRenderer.invoke(WORKSPACE_RESOLVE_CHANNEL, {
      projectPath: request.projectPath, ...(request.workspaceId == null ? {} : { workspaceId: request.workspaceId })
    })
    return isWorkspaceResolveResult(response) ? response : { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_WORKTREE_RESPONSE } }
  },
  async listWorktrees(request: WorktreeListRequest): Promise<WorktreeListResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_LIST_CHANNEL, { projectPath: request.projectPath })
    return isWorktreeListResult(response) ? response : invalidWorktreeListResponse()
  },

  async createWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_CREATE_CHANNEL, {
      projectPath: request.projectPath,
      ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch })
    })
    return isCreateWorktreeResult(response) ? response : invalidCreateWorktreeResponse()
  },

  async removeWorktree(request: RemoveWorktreeRequest): Promise<RemoveWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_REMOVE_CHANNEL, {
      projectPath: request.projectPath, workspaceId: request.workspaceId,
      ...(request.deleteBranch === undefined ? {} : { deleteBranch: request.deleteBranch }),
      ...(request.force === undefined ? {} : { force: request.force }),
      closeTerminals: request.closeTerminals === true
    })
    return isRemoveWorktreeResult(response) ? response : invalidRemoveWorktreeResponse()
  },

  async getWorktreeStatus(request: WorktreeStatusRequest): Promise<WorktreeStatusResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_STATUS_CHANNEL, {
      projectPath: request.projectPath, workspaceId: request.workspaceId
    })
    return isWorktreeStatusResult(response) ? response : invalidWorktreeStatusResponse()
  },

  async mergeWorktree(request: MergeWorktreeRequest): Promise<MergeWorktreeResult> {
    const response: unknown = await ipcRenderer.invoke(WORKTREE_MERGE_CHANNEL, {
      projectPath: request.projectPath, workspaceId: request.workspaceId,
      ...(request.squash === undefined ? {} : { squash: request.squash }),
      ...(request.deleteAfterMerge === undefined ? {} : { deleteAfterMerge: request.deleteAfterMerge }),
      closeTerminals: request.closeTerminals === true
    })
    return isMergeWorktreeResult(response) ? response : invalidMergeWorktreeResponse()
  }
}
