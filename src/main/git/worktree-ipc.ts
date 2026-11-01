/** 工作树 IPC 仅接受显式项目与托管工作区身份；项目授权、信任和资源生命周期统一交给工作区管理器。 */
import type { DesktopError } from '../../shared/desktop-api'
import {
  WORKTREE_CREATE_CHANNEL, WORKTREE_LIST_CHANNEL, WORKTREE_MERGE_CHANNEL,
  WORKTREE_REMOVE_CHANNEL, WORKTREE_STATUS_CHANNEL, isCreateWorktreeRequest,
  isMergeWorktreeRequest, isRemoveWorktreeRequest, isWorktreeListRequest, isWorktreeStatusRequest
} from '../../shared/worktree-api'
import { WORKSPACE_RESOLVE_CHANNEL, isWorkspaceResolveRequest } from '../../shared/workspace-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { workspaceManager } from '../services'
import { workspaceError } from '../workspaces/workspace-manager'

type Failure = { readonly ok: false; readonly error: DesktopError }
function forbidden(): Failure { return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } } }
function invalid(): Failure { return { ok: false, error: { code: 'INVALID_REQUEST', message: '工作区请求必须固定所属项目及托管身份。' } } }
async function attempt<T>(operation: () => Promise<T>): Promise<T | Failure> {
  try { return await operation() } catch (error) { return { ok: false, error: workspaceError(error) } }
}
export function registerWorktreeHandlers(pageUrl: string): void {
  handle(WORKSPACE_RESOLVE_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isWorkspaceResolveRequest(request)) return invalid()
    return attempt(async () => ({ ok: true as const, workspace: await workspaceManager.resolveWorkspace(request) }))
  })
  handle(WORKTREE_LIST_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isWorktreeListRequest(request)) return invalid()
    return attempt(() => workspaceManager.listWorktrees(request))
  })
  handle(WORKTREE_CREATE_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isCreateWorktreeRequest(request)) return invalid()
    return attempt(() => workspaceManager.createWorktree(request))
  })
  handle(WORKTREE_STATUS_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isWorktreeStatusRequest(request)) return invalid()
    return attempt(() => workspaceManager.checkWorktreeStatus(request))
  })
  handle(WORKTREE_REMOVE_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isRemoveWorktreeRequest(request)) return invalid()
    return attempt(() => workspaceManager.removeWorktree(request))
  })
  handle(WORKTREE_MERGE_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return forbidden()
    const request = args[0]
    if (args.length !== 1 || !isMergeWorktreeRequest(request)) return invalid()
    return attempt(() => workspaceManager.mergeWorktree(request))
  })
}
