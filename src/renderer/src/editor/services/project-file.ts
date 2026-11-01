/** 文件服务只接收固定工作区目标；不在异步调用后重新读取前台目录，也不将失效任务降级为主目录。 */
import type { DesktopError } from '../../../../shared/desktop-api'
import type { WorkspaceTarget } from '../../../../shared/workspace-api'
import type {
  ProjectDirectoryChange, ProjectDirectoryListResult, ProjectDirectoryWatchResult,
  ProjectEntryDeleteResult, ProjectEntryPathResult, ProjectEntryRevealResult,
  ProjectFileReadResult, ProjectFileSearchResult, ProjectFileStatResult, ProjectFileWriteResult,
  ProjectHtmlPreviewResult, ProjectHtmlPreviewReleaseResult, ProjectMarkdownDocumentsResult, ProjectMarkdownImageResult
} from '../../../../shared/project-file-api'

type Failure = { ok: false; error: DesktopError }
function unavailable(): Failure { return { ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面文件桥接不可用。' } } }
async function call<T>(operation: () => Promise<T>): Promise<T | Failure> {
  try { return await operation() }
  catch (error) { return { ok: false, error: { code: 'BRIDGE_CALL_FAILED', message: `桌面文件调用失败：${error instanceof Error ? error.message : String(error)}` } } }
}
export async function prepareProjectHtmlPreview(projectPath: string, path: string, text: string, previewId: string | null, workspaceId: string): Promise<ProjectHtmlPreviewResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.prepareProjectHtmlPreview({ projectPath, workspaceId, path, text, previewId })) : unavailable()
}
export async function releaseProjectHtmlPreview(previewId: string): Promise<ProjectHtmlPreviewReleaseResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.releaseProjectHtmlPreview({ previewId })) : unavailable()
}
export async function listMarkdownDocuments(projectPath: string, path: string, workspaceId: string): Promise<ProjectMarkdownDocumentsResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.listMarkdownDocuments({ projectPath, workspaceId, path })) : unavailable()
}
export async function importMarkdownImage(projectPath: string, path: string, bytes: Uint8Array | undefined, workspaceId: string): Promise<ProjectMarkdownImageResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.importMarkdownImage(bytes
    ? { projectPath, workspaceId, path, source: 'clipboard', bytes: new Uint8Array(bytes) }
    : { projectPath, workspaceId, path, source: 'pick' })) : unavailable()
}
export async function searchProjectFiles(query: string, target: WorkspaceTarget): Promise<ProjectFileSearchResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.searchProjectFiles({ projectPath: target.projectPath, workspaceId: target.workspaceId, query })) : unavailable()
}
export async function listProjectDirectory(directory: string, target: WorkspaceTarget): Promise<ProjectDirectoryListResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.listProjectDirectory({ projectPath: target.projectPath, workspaceId: target.workspaceId, directory })) : unavailable()
}
export async function watchProjectDirectories(directories: readonly string[], target: WorkspaceTarget | null): Promise<ProjectDirectoryWatchResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.watchProjectDirectories({ projectPath: target?.projectPath ?? null, workspaceId: target?.workspaceId ?? null, directories: [...directories] })) : unavailable()
}
export function onProjectDirectoryChanged(listener: (change: ProjectDirectoryChange) => void): () => void {
  const bridge = window.desktop
  return bridge ? bridge.onProjectDirectoryChanged(listener) : () => {}
}
export async function resolveProjectEntryPath(path: string, target: WorkspaceTarget): Promise<ProjectEntryPathResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.resolveProjectEntryPath({ projectPath: target.projectPath, workspaceId: target.workspaceId, path })) : unavailable()
}
export async function revealProjectEntry(path: string, target: WorkspaceTarget): Promise<ProjectEntryRevealResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.revealProjectEntry({ projectPath: target.projectPath, workspaceId: target.workspaceId, path })) : unavailable()
}
export async function deleteProjectEntry(path: string, target: WorkspaceTarget): Promise<ProjectEntryDeleteResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.deleteProjectEntry({ projectPath: target.projectPath, workspaceId: target.workspaceId, path })) : unavailable()
}
export async function readProjectFile(projectPath: string, path: string, workspaceId: string): Promise<ProjectFileReadResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.readProjectFile({ projectPath, workspaceId, path })) : unavailable()
}
export async function writeProjectFile(projectPath: string, path: string, text: string, eol: 'lf' | 'crlf', bom: boolean,
  expected: { readonly size: number; readonly mtimeMs: number } | null, workspaceId: string): Promise<ProjectFileWriteResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.writeProjectFile({ projectPath, workspaceId, path, text, eol, bom, expected })) : unavailable()
}
export async function statProjectFile(projectPath: string, path: string, workspaceId: string): Promise<ProjectFileStatResult> {
  const bridge = window.desktop
  return bridge ? call(() => bridge.statProjectFile({ projectPath, workspaceId, path })) : unavailable()
}
