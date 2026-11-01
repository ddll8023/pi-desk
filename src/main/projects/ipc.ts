/** 项目登记与项目文件的 IPC：目录选择、列表、添加、移除、切换当前项目，以及文件检索、目录列举与监听、条目路径解析、显示与删除（移入废纸篓）、文件内容读写、HTML 隔离预览、Markdown 文档与图片导入。所有入口先校验调用者，再逐字段校验载荷。 */

import { BrowserWindow } from 'electron'
import { ProjectMarkdownAssets } from './project-markdown-assets'
import {
  PROJECT_MARKDOWN_DOCUMENTS_CHANNEL,
  PROJECT_MARKDOWN_IMAGE_CHANNEL,
  isProjectMarkdownImageRequest
} from '../../shared/project-file-api'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopError, DesktopErrorCode } from '../../shared/desktop-api'
import { isWorkspaceTarget, workspaceTarget } from '../../shared/workspace-api'
import type { WorkspaceContext, WorkspaceTarget } from '../../shared/workspace-api'
import { workspaceError } from '../workspaces/workspace-manager'
import {
  PROJECT_ADD_CHANNEL,
  PROJECT_CHOOSE_DIRECTORY_CHANNEL,
  PROJECT_LIST_CHANNEL,
  PROJECT_REMOVE_CHANNEL,
  PROJECT_SET_CURRENT_CHANNEL
} from '../../shared/project-api'
import type {
  ProjectAddRequest,
  ProjectErrorCode,
  ProjectListResult,
  ProjectPathResult,
  ProjectRemoveRequest
} from '../../shared/project-api'
import {
  PROJECT_DIRECTORY_LIST_CHANNEL,
  PROJECT_DIRECTORY_WATCH_CHANNEL,
  PROJECT_ENTRY_RESOLVE_CHANNEL,
  PROJECT_ENTRY_REVEAL_CHANNEL,
  PROJECT_ENTRY_DELETE_CHANNEL,
  PROJECT_FILE_READ_CHANNEL,
  PROJECT_FILE_SEARCH_CHANNEL,
  PROJECT_FILE_STAT_CHANNEL,
  PROJECT_FILE_WRITE_CHANNEL,
  PROJECT_HTML_PREVIEW_PREPARE_CHANNEL,
  PROJECT_HTML_PREVIEW_RELEASE_CHANNEL,
  isProjectHtmlPreviewRequest,
  isProjectHtmlPreviewReleaseRequest,
  isProjectDirectoryWatchRequest,
  isProjectDirectoryListRequest,
  isProjectFileSearchRequest,
  isProjectEntryPathRequest,
  isProjectFileReadRequest,
  isProjectFileWriteRequest
} from '../../shared/project-file-api'
import type {
  ProjectDirectoryListResult,
  ProjectDirectoryWatchResult,
  ProjectEntryPathResult,
  ProjectEntryRevealResult,
  ProjectEntryDeleteResult,
  ProjectFileReadResult,
  ProjectFileSearchResult,
  ProjectFileStatResult,
  ProjectFileWriteResult
} from '../../shared/project-file-api'
import { isTrustDecision, isTrustStatus } from '../../shared/trust-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import {
  projectManager, terminals, projectFileIndex, projectDirectory, projectDirectoryWatcher,
  projectFileContent, projectHtmlPreview, workspaceManager, registeredProjectPathById
} from '../services'

export function projectPathFailure(code: ProjectErrorCode, message: string): ProjectPathResult {
  return { ok: false, error: { code, message } }
}

export function projectListFailure(code: ProjectErrorCode, message: string): ProjectListResult {
  return { ok: false, error: { code, message } }
}

export function projectFileFailure(code: DesktopErrorCode, message: string): ProjectFileSearchResult {
  return { ok: false, error: { code, message } }
}

export function projectDirectoryFailure(code: DesktopErrorCode, message: string): ProjectDirectoryListResult {
  return { ok: false, error: { code, message } }
}

export function projectDirectoryWatchFailure(code: DesktopErrorCode, message: string): ProjectDirectoryWatchResult {
  return { ok: false, error: { code, message } }
}

export function projectEntryPathFailure(code: DesktopErrorCode, message: string): ProjectEntryPathResult {
  return { ok: false, error: { code, message } }
}

export function projectEntryRevealFailure(code: DesktopErrorCode, message: string): ProjectEntryRevealResult {
  return { ok: false, error: { code, message } }
}

export function projectEntryDeleteFailure(code: DesktopErrorCode, message: string): ProjectEntryDeleteResult {
  return { ok: false, error: { code, message } }
}

export function projectFileReadFailure(code: DesktopErrorCode, message: string): ProjectFileReadResult {
  return { ok: false, error: { code, message } }
}

export function projectFileWriteFailure(code: DesktopErrorCode, message: string): ProjectFileWriteResult {
  return { ok: false, error: { code, message } }
}

export function projectFileStatFailure(code: DesktopErrorCode, message: string): ProjectFileStatResult {
  return { ok: false, error: { code, message } }
}

/** 只接受受限的项目选择/添加/移除请求与显式中断确认；不接受任意 channel 或 RPC 内容。 */
export function registerProjectHandlers(pageUrl: string): void {
  handle(
    PROJECT_CHOOSE_DIRECTORY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectPathResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectPathFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return projectPathFailure('INVALID_REQUEST', '目录选择接口不接受参数。')
      }
      return projectManager.chooseDirectory()
    }
  )

  handle(
    PROJECT_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return projectListFailure('INVALID_REQUEST', '项目列表接口不接受参数。')
      }
      return projectManager.list()
    }
  )

  handle(
    PROJECT_ADD_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '添加项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '添加项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => !['path', 'trustStatus', 'trustDecision', 'allowInterrupt'].includes(key))) {
        return projectListFailure('INVALID_REQUEST', '添加项目参数包含未支持的字段。')
      }
      const { path, trustStatus, trustDecision, allowInterrupt } = fields
      if (typeof path !== 'string' || !isTrustStatus(trustStatus) || trustStatus.projectPath !== path) {
        return projectListFailure('INVALID_REQUEST', '候选项目路径或信任状态无效。')
      }
      if (trustDecision !== null && !isTrustDecision(trustDecision)) {
        return projectListFailure('INVALID_REQUEST', '信任决定必须是 trusted、untrusted 或 null。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '添加项目必须显式给出 allowInterrupt 布尔值。')
      }
      return projectManager.add(request as ProjectAddRequest)
    }
  )

  handle(
    PROJECT_REMOVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '移除项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '移除项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'projectId' && key !== 'allowInterrupt')) {
        return projectListFailure('INVALID_REQUEST', '移除项目参数包含未支持的字段。')
      }
      const { projectId, allowInterrupt } = fields
      if (typeof projectId !== 'string' || projectId.trim() === '') {
        return projectListFailure('INVALID_REQUEST', '项目 id 无效。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '移除项目必须显式说明是否允许中断当前操作。')
      }
      // 项目移除后它的终端不再有意义：先取规范路径，移除成功后一并收敛该项目终端。
      const terminalProjectPath = await registeredProjectPathById(projectId)
      const result = await projectManager.remove(request as ProjectRemoveRequest)
      if (result.ok && terminalProjectPath !== null) {
        void terminals.closeProject(terminalProjectPath)
        projectHtmlPreview.releaseProject(terminalProjectPath)
      }
      return result
    }
  )

  handle(
    PROJECT_SET_CURRENT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectListFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return projectListFailure('INVALID_REQUEST', '切换项目接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return projectListFailure('INVALID_REQUEST', '切换项目参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'path' && key !== 'allowInterrupt')) {
        return projectListFailure('INVALID_REQUEST', '切换项目参数包含未支持的字段。')
      }
      const { path, allowInterrupt } = fields
      if (typeof path !== 'string') {
        return projectListFailure('INVALID_PROJECT_PATH', '项目目录必须是非空的绝对路径。')
      }
      if (typeof allowInterrupt !== 'boolean') {
        return projectListFailure('INVALID_REQUEST', '切换项目必须显式给出 allowInterrupt 布尔值。')
      }
      return projectManager.setCurrent({ path, allowInterrupt })
    }
  )
}

/**
 * 文件检索、目录、条目、Markdown 与预览全部固定请求工作区，页面不能指定外部执行路径。
 * 文件内容读写同样只接受项目内相对路径：读返回文本/图片/不支持三类结果，写只接受文本并比对磁盘基线；
 * 解析与「在文件管理器中显示」共用同一个条目解析：越界、绝对路径与非法段一律拒绝。
 */
async function scopedFile<T>(target: WorkspaceTarget, mode: 'read' | 'write', operation: (context: WorkspaceContext) => Promise<T>): Promise<T | { ok: false; error: DesktopError }> {
  try { return await workspaceManager.use(target, mode, operation) }
  catch (error) { return { ok: false, error: workspaceError(error) } }
}

export function registerProjectFileHandlers(pageUrl: string): void {
  handle(PROJECT_HTML_PREVIEW_PREPARE_CHANNEL, async (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    if (args.length !== 1 || !isProjectHtmlPreviewRequest(args[0])) return projectFileFailure('INVALID_REQUEST', 'HTML 预览必须给出所属项目、文档与有界文本快照。')
    const request = args[0]
    return scopedFile(request, 'read', context => projectHtmlPreview.prepare(event.sender, request, context))
  })
  handle(PROJECT_HTML_PREVIEW_RELEASE_CHANNEL, (event, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    if (args.length !== 1 || !isProjectHtmlPreviewReleaseRequest(args[0])) return projectFileFailure('INVALID_REQUEST', '释放预览必须给出有效的预览身份。')
    return projectHtmlPreview.release(event.sender.id, args[0].previewId)
  })
  const assets = new ProjectMarkdownAssets(context => workspaceManager.contextFor(workspaceTarget(context), 'write'))
  handle(PROJECT_MARKDOWN_DOCUMENTS_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    if (args.length !== 1 || !isProjectFileReadRequest(args[0])) return projectFileFailure('INVALID_REQUEST', '文档补全必须固定所属项目和文档。')
    const request = args[0]
    return scopedFile(request, 'read', context => projectFileIndex.markdownDocuments(context))
  })
  handle(PROJECT_MARKDOWN_IMAGE_CHANNEL, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedCaller(event, pageUrl)) return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    if (args.length !== 1 || !isProjectMarkdownImageRequest(args[0])) return projectFileFailure('INVALID_REQUEST', '图片导入参数无效。')
    const request = args[0]
    const result = await scopedFile(request, 'write', context => assets.import(context, request, BrowserWindow.fromWebContents(event.sender)))
    if (result.ok && result.data.path) projectFileIndex.invalidate(result.data.workspaceId)
    return result
  })
  handle(
    PROJECT_FILE_SEARCH_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectFileSearchResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectFileFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const request = args[0]
      if (args.length !== 1 || !isProjectFileSearchRequest(request)) return projectFileFailure('INVALID_REQUEST', '文件检索必须固定工作区和有界查询。')
      return scopedFile(request, 'read', context => projectFileIndex.search(context, request.query))
    }
  )

  handle(
    PROJECT_DIRECTORY_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectDirectoryListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectDirectoryFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      const request = args[0]
      if (args.length !== 1 || !isProjectDirectoryListRequest(request)) return projectDirectoryFailure('INVALID_REQUEST', '目录列举必须固定工作区和相对目录。')
      return scopedFile(request, 'read', context => projectDirectory.list(context, request.directory))
    }
  )

  handle(
    PROJECT_DIRECTORY_WATCH_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectDirectoryWatchResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectDirectoryWatchFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectDirectoryWatchRequest(args[0])) {
        return projectDirectoryWatchFailure('INVALID_REQUEST', '目录监听只接受一个目录路径数组。')
      }
      const request = args[0]
      const ticket = projectDirectoryWatcher.beginRequest()
      return isWorkspaceTarget(request)
        ? scopedFile(request, 'read', context => projectDirectoryWatcher.sync(context, request.directories, ticket))
        : projectDirectoryWatcher.sync(null, [], ticket)
    }
  )

  handle(
    PROJECT_ENTRY_RESOLVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectEntryPathResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectEntryPathFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectEntryPathRequest(args[0])) {
        return projectEntryPathFailure('INVALID_REQUEST', '路径解析只接受一个项目内相对路径请求。')
      }
      const request = args[0]
      return scopedFile(request, 'read', context => projectDirectory.resolveEntry(context, request.path))
    }
  )

  handle(
    PROJECT_ENTRY_REVEAL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectEntryRevealResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectEntryRevealFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectEntryPathRequest(args[0])) {
        return projectEntryRevealFailure('INVALID_REQUEST', '显示文件位置只接受一个项目内相对路径请求。')
      }
      const request = args[0]
      return scopedFile(request, 'read', context => projectDirectory.revealEntry(context, request.path))
    }
  )

  handle(
    PROJECT_ENTRY_DELETE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectEntryDeleteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectEntryDeleteFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectEntryPathRequest(args[0])) {
        return projectEntryDeleteFailure('INVALID_REQUEST', '删除文件只接受一个项目内相对路径请求。')
      }
      const request = args[0]
      return scopedFile(request, 'write', context => projectDirectory.deleteEntry(context, request.path))
    }
  )

  handle(
    PROJECT_FILE_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectFileReadResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectFileReadFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectFileReadRequest(args[0])) {
        return projectFileReadFailure('INVALID_REQUEST', '读取文件必须给出所属项目和项目内相对路径。')
      }
      const request = args[0]
      return scopedFile(request, 'read', context => projectFileContent.read(context, request))
    }
  )

  handle(
    PROJECT_FILE_WRITE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectFileWriteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectFileWriteFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectFileWriteRequest(args[0])) {
        return projectFileWriteFailure('INVALID_REQUEST', '保存文件只接受一个项目内相对路径、文本与磁盘基线请求。')
      }
      const request = args[0]
      return scopedFile(request, 'write', context => projectFileContent.write(context, request))
    }
  )

  handle(
    PROJECT_FILE_STAT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectFileStatResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectFileStatFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isProjectFileReadRequest(args[0])) {
        return projectFileStatFailure('INVALID_REQUEST', '读取文件状态必须给出所属项目和项目内相对路径。')
      }
      const request = args[0]
      return scopedFile(request, 'read', context => projectFileContent.stat(context, request))
    }
  )
}
