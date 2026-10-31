/**
 * Git Worktree 跨进程 IPC：多工作树列举、隔离工作树创建、工作树及分支移除、干净状态检查。
 * 所有路径由主进程解析，写操作统一经过项目信任门禁与可信调用者核验。
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import {
  WORKTREE_CREATE_CHANNEL,
  WORKTREE_LIST_CHANNEL,
  WORKTREE_MERGE_CHANNEL,
  WORKTREE_REMOVE_CHANNEL,
  WORKTREE_STATUS_CHANNEL,
  isCreateWorktreeRequest,
  isMergeWorktreeRequest,
  isRemoveWorktreeRequest,
  isWorktreeStatusRequest
} from '../../shared/worktree-api'
import type {
  CreateWorktreeResult,
  MergeWorktreeResult,
  RemoveWorktreeResult,
  WorktreeListResult,
  WorktreeStatusResult
} from '../../shared/worktree-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { worktreeService } from '../services'
import { requireGitWriteTrust } from '../trust/guards'

function worktreeListFailure(code: DesktopErrorCode, message: string): WorktreeListResult {
  return { ok: false, error: { code, message } }
}

function createWorktreeFailure(code: DesktopErrorCode, message: string): CreateWorktreeResult {
  return { ok: false, error: { code, message } }
}

function removeWorktreeFailure(code: DesktopErrorCode, message: string): RemoveWorktreeResult {
  return { ok: false, error: { code, message } }
}

function mergeWorktreeFailure(code: DesktopErrorCode, message: string): MergeWorktreeResult {
  return { ok: false, error: { code, message } }
}

function worktreeStatusFailure(code: DesktopErrorCode, message: string): WorktreeStatusResult {
  return { ok: false, error: { code, message } }
}

export function registerWorktreeHandlers(pageUrl: string): void {
  // 1. 列举当前项目仓库的工作树
  handle(
    WORKTREE_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorktreeListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return worktreeListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return worktreeListFailure('INVALID_REQUEST', '工作树列表接口不接受参数。')
      }
      return worktreeService.listWorktrees()
    }
  )

  // 2. 检测指定工作树的未提交改动状态
  handle(
    WORKTREE_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<WorktreeStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return worktreeStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const request = args[0]
      if (!isWorktreeStatusRequest(request)) {
        return worktreeStatusFailure('INVALID_REQUEST', '工作树状态检测请求参数非法。')
      }
      return worktreeService.checkWorktreeStatus(request)
    }
  )

  // 3. 创建隔离工作树（写操作，受项目信任约束）
  handle(
    WORKTREE_CREATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<CreateWorktreeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return createWorktreeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const trustError = await requireGitWriteTrust()
      if (trustError !== null) {
        return createWorktreeFailure(trustError.code, trustError.message)
      }
      const request = args[0]
      if (!isCreateWorktreeRequest(request)) {
        return createWorktreeFailure('INVALID_REQUEST', '创建工作树请求参数非法。')
      }
      return worktreeService.createWorktree(request)
    }
  )

  // 4. 移除指定工作树（写操作，受项目信任约束）
  handle(
    WORKTREE_REMOVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RemoveWorktreeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return removeWorktreeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const trustError = await requireGitWriteTrust()
      if (trustError !== null) {
        return removeWorktreeFailure(trustError.code, trustError.message)
      }
      const request = args[0]
      if (!isRemoveWorktreeRequest(request)) {
        return removeWorktreeFailure('INVALID_REQUEST', '移除工作树请求参数非法。')
      }
      return worktreeService.removeWorktree(request)
    }
  )

  // 5. 合并工作树分支（写操作，受项目信任约束）
  handle(
    WORKTREE_MERGE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<MergeWorktreeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mergeWorktreeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const trustError = await requireGitWriteTrust()
      if (trustError !== null) {
        return mergeWorktreeFailure(trustError.code, trustError.message)
      }
      const request = args[0]
      if (!isMergeWorktreeRequest(request)) {
        return mergeWorktreeFailure('INVALID_REQUEST', '合并工作树请求参数非法。')
      }
      return worktreeService.mergeWorktree(request)
    }
  )
}
