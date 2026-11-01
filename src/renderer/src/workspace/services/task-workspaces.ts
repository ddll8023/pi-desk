/** 工作区桥接服务：仅传项目和托管身份，通信异常不触发自动重试或主目录降级。 */
import type { WorkspaceResolveResult } from '../../../../shared/workspace-api'
import type { CreateWorktreeResult } from '../../../../shared/worktree-api'

export async function resolveTaskWorkspace(projectPath: string, workspaceId?: string | null): Promise<WorkspaceResolveResult> {
  if (!window.desktop?.resolveWorkspace) return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面工作区接口不可用。' } }
  try { return await window.desktop.resolveWorkspace({ projectPath, ...(workspaceId == null ? {} : { workspaceId }) }) }
  catch (error) { return { ok: false, error: { code: 'BRIDGE_CALL_FAILED', message: error instanceof Error ? error.message : '解析工作区失败。' } } }
}
export async function createParallelWorkspace(projectPath: string): Promise<CreateWorktreeResult> {
  if (!window.desktop?.createWorktree) return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面工作区接口不可用。' } }
  try { return await window.desktop.createWorktree({ projectPath }) }
  catch (error) { return { ok: false, error: { code: 'BRIDGE_CALL_FAILED', message: `任务创建结果未知，未自动重试：${error instanceof Error ? error.message : String(error)}` } } }
}
