/** Git IPC 固定请求工作区，在整个命令及信任检查期间占用该工作区；不从前台项目推断执行根。 */
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import {
  GIT_COMMIT_CHANNEL, GIT_COMMIT_DETAIL_CHANNEL, GIT_COMMIT_DIFF_CHANNEL, GIT_DIFF_CHANNEL,
  GIT_DISCARD_CHANNEL, GIT_HISTORY_CHANNEL, GIT_PULL_CHANNEL, GIT_PUSH_CHANNEL, GIT_STAGE_CHANNEL,
  GIT_STATUS_CHANNEL, GIT_UNSTAGE_CHANNEL, isGitCommitDetailRequest, isGitCommitDiffRequest,
  isGitCommitRequest, isGitDiffRequest, isGitHistoryRequest, isGitWritePathRequest, isGitWorkspaceRequest
} from '../../shared/git-api'
import type { GitCommitDetailResult, GitCommitDiffResult, GitDiffResult, GitHistoryResult, GitStatusResult } from '../../shared/git-api'
import type { WorkspaceTarget } from '../../shared/workspace-api'
import { handle, isTrustedCaller } from '../ipc/dispatch'
import { gitService, workspaceManager } from '../services'
import { workspaceError } from '../workspaces/workspace-manager'
import { requireGitWriteTrust } from '../trust/guards'

export function gitStatusFailure(code: DesktopErrorCode, message: string): GitStatusResult { return { ok: false, error: { code, message } } }
export function gitDiffFailure(code: DesktopErrorCode, message: string): GitDiffResult { return { ok: false, error: { code, message } } }
export function gitHistoryFailure(code: DesktopErrorCode, message: string): GitHistoryResult { return { ok: false, error: { code, message } } }
export function gitCommitDetailFailure(code: DesktopErrorCode, message: string): GitCommitDetailResult { return { ok: false, error: { code, message } } }
export function gitCommitDiffFailure(code: DesktopErrorCode, message: string): GitCommitDiffResult { return { ok: false, error: { code, message } } }

export function registerGitHandlers(pageUrl: string): void {
  function register<T extends WorkspaceTarget>(channel: string, guard: (value: unknown) => value is T,
    mode: 'read' | 'write', operation: (request: T) => Promise<unknown>): void {
    handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
      if (!isTrustedCaller(event, pageUrl)) return gitStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      const request = args[0]
      if (args.length !== 1 || !guard(request)) return gitStatusFailure('INVALID_REQUEST', 'Git 请求必须包含固定工作区和受支持参数。')
      try {
        return await workspaceManager.use(request, mode, async context => {
          if (mode === 'write') {
            const blocked = await requireGitWriteTrust(context.projectPath)
            if (blocked) return { ok: false, error: blocked }
          }
          return operation(request)
        })
      } catch (error) { return { ok: false, error: workspaceError(error) } }
    })
  }
  register(GIT_STATUS_CHANNEL, isGitWorkspaceRequest, 'read', request => gitService.status(request))
  register(GIT_DIFF_CHANNEL, isGitDiffRequest, 'read', request => gitService.diff(request))
  register(GIT_HISTORY_CHANNEL, isGitHistoryRequest, 'read', request => gitService.history(request))
  register(GIT_COMMIT_DETAIL_CHANNEL, isGitCommitDetailRequest, 'read', request => gitService.commitDetail(request))
  register(GIT_COMMIT_DIFF_CHANNEL, isGitCommitDiffRequest, 'read', request => gitService.commitDiff(request))
  register(GIT_STAGE_CHANNEL, isGitWritePathRequest, 'write', request => gitService.stage(request))
  register(GIT_UNSTAGE_CHANNEL, isGitWritePathRequest, 'write', request => gitService.unstage(request))
  register(GIT_DISCARD_CHANNEL, isGitWritePathRequest, 'write', request => gitService.discard(request))
  register(GIT_COMMIT_CHANNEL, isGitCommitRequest, 'write', request => gitService.commit(request))
  register(GIT_PULL_CHANNEL, isGitWorkspaceRequest, 'write', request => gitService.pull(request))
  register(GIT_PUSH_CHANNEL, isGitWorkspaceRequest, 'write', request => gitService.push(request))
}
