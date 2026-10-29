/** 项目、项目文件与目录监听：preload 的 projects 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { PROJECT_MARKDOWN_DOCUMENTS_CHANNEL, PROJECT_MARKDOWN_IMAGE_CHANNEL, isProjectMarkdownDocumentsResult, isProjectMarkdownImageResult } from '../shared/project-file-api'
import { PROJECT_ADD_CHANNEL, PROJECT_CHOOSE_DIRECTORY_CHANNEL, PROJECT_LIST_CHANNEL, PROJECT_REMOVE_CHANNEL, PROJECT_SET_CURRENT_CHANNEL, isProjectListResult, isProjectPathResult } from '../shared/project-api'
import { PROJECT_DIRECTORY_CHANGED_EVENT, PROJECT_DIRECTORY_LIST_CHANNEL, PROJECT_DIRECTORY_WATCH_CHANNEL, PROJECT_ENTRY_DELETE_CHANNEL, PROJECT_ENTRY_RESOLVE_CHANNEL, PROJECT_ENTRY_REVEAL_CHANNEL, PROJECT_FILE_READ_CHANNEL, PROJECT_FILE_SEARCH_CHANNEL, PROJECT_FILE_STAT_CHANNEL, PROJECT_FILE_WRITE_CHANNEL, isProjectDirectoryChange, isProjectDirectoryListResult, isProjectDirectoryWatchResult, isProjectEntryDeleteResult, isProjectEntryPathResult, isProjectEntryRevealResult, isProjectFileReadResult, isProjectFileSearchResult, isProjectFileStatResult, isProjectFileWriteResult } from '../shared/project-file-api'
import type { ProjectMarkdownImageRequest, ProjectFileReadRequest as MarkdownOwnerRequest } from '../shared/project-file-api'
import type { ProjectAddRequest, ProjectListResult, ProjectPathResult, ProjectRemoveRequest, ProjectSetCurrentRequest } from '../shared/project-api'
import type { ProjectDirectoryChange, ProjectDirectoryListRequest, ProjectDirectoryListResult, ProjectDirectoryWatchRequest, ProjectDirectoryWatchResult, ProjectEntryDeleteResult, ProjectEntryPathRequest, ProjectEntryPathResult, ProjectEntryRevealResult, ProjectFileReadRequest, ProjectFileReadResult, ProjectFileSearchResult, ProjectFileStatRequest, ProjectFileStatResult, ProjectFileWriteRequest, ProjectFileWriteResult } from '../shared/project-file-api'
import type { ProjectApi } from '../shared/project-api'
import type { ProjectFileApi } from '../shared/project-file-api'
import {
  PROJECT_HTML_PREVIEW_PREPARE_CHANNEL, PROJECT_HTML_PREVIEW_RELEASE_CHANNEL,
  isProjectHtmlPreviewResult, isProjectHtmlPreviewReleaseResult
} from '../shared/project-file-api'
import type { ProjectHtmlPreviewRequest, ProjectHtmlPreviewReleaseRequest } from '../shared/project-file-api'

const INVALID_PROJECT_PATH_RESPONSE = '桌面接口返回了无法识别的目录选择结果。'
const INVALID_PROJECT_LIST_RESPONSE = '桌面接口返回了无法识别的项目列表。'
const INVALID_PROJECT_FILE_RESPONSE = '桌面接口返回了无法识别的文件检索结果。'
const INVALID_PROJECT_DIRECTORY_RESPONSE = '桌面接口返回了无法识别的目录列举结果。'
const INVALID_PROJECT_DIRECTORY_WATCH_RESPONSE = '桌面接口返回了无法识别的目录监听登记结果。'
const INVALID_PROJECT_ENTRY_PATH_RESPONSE = '桌面接口返回了无法识别的条目路径解析结果。'
const INVALID_PROJECT_ENTRY_REVEAL_RESPONSE = '桌面接口返回了无法识别的显示文件位置结果。'
const INVALID_PROJECT_ENTRY_DELETE_RESPONSE = '桌面接口返回了无法识别的删除文件结果。'
const INVALID_PROJECT_FILE_READ_RESPONSE = '桌面接口返回了无法识别的文件读取结果。'
const INVALID_PROJECT_FILE_WRITE_RESPONSE = '桌面接口返回了无法识别的文件保存结果。'
const INVALID_PROJECT_FILE_STAT_RESPONSE = '桌面接口返回了无法识别的文件状态结果。'

function invalidProjectPathResponse(): ProjectPathResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_PATH_RESPONSE } }
}

function invalidProjectListResponse(): ProjectListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_LIST_RESPONSE } }
}

function invalidProjectFileResponse(): ProjectFileSearchResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_RESPONSE } }
}

function invalidProjectDirectoryResponse(): ProjectDirectoryListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_DIRECTORY_RESPONSE } }
}

function invalidProjectDirectoryWatchResponse(): ProjectDirectoryWatchResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_DIRECTORY_WATCH_RESPONSE } }
}

function invalidProjectEntryPathResponse(): ProjectEntryPathResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_ENTRY_PATH_RESPONSE } }
}

function invalidProjectEntryRevealResponse(): ProjectEntryRevealResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_ENTRY_REVEAL_RESPONSE } }
}

function invalidProjectEntryDeleteResponse(): ProjectEntryDeleteResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_ENTRY_DELETE_RESPONSE } }
}

function invalidProjectFileReadResponse(): ProjectFileReadResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_READ_RESPONSE } }
}

function invalidProjectFileWriteResponse(): ProjectFileWriteResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_WRITE_RESPONSE } }
}

function invalidProjectFileStatResponse(): ProjectFileStatResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECT_FILE_STAT_RESPONSE } }
}

export const projectsApi = {
  async prepareProjectHtmlPreview(request: ProjectHtmlPreviewRequest) {
    const payload: ProjectHtmlPreviewRequest = {
      projectPath: request.projectPath, path: request.path, text: request.text, previewId: request.previewId
    }
    const response: unknown = await ipcRenderer.invoke(PROJECT_HTML_PREVIEW_PREPARE_CHANNEL, payload)
    return isProjectHtmlPreviewResult(response) ? response : {
      ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '桌面接口返回了无法识别的 HTML 预览结果。' }
    }
  },

  async releaseProjectHtmlPreview(request: ProjectHtmlPreviewReleaseRequest) {
    const response: unknown = await ipcRenderer.invoke(PROJECT_HTML_PREVIEW_RELEASE_CHANNEL, { previewId: request.previewId })
    return isProjectHtmlPreviewReleaseResult(response) ? response : {
      ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '桌面接口返回了无法识别的预览释放结果。' }
    }
  },

  async chooseProjectDirectory() {
    const response: unknown = await ipcRenderer.invoke(PROJECT_CHOOSE_DIRECTORY_CHANNEL)
    return isProjectPathResult(response) ? response : invalidProjectPathResponse()
  },

  async listProjects() {
    const response: unknown = await ipcRenderer.invoke(PROJECT_LIST_CHANNEL)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async setCurrentProject(path: string, allowInterrupt: boolean) {
    const request: ProjectSetCurrentRequest = { path, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_SET_CURRENT_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async addProject(path, trustStatus, trustDecision, allowInterrupt) {
    const request: ProjectAddRequest = { path, trustStatus, trustDecision, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ADD_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async removeProject(projectId, allowInterrupt) {
    const request: ProjectRemoveRequest = { projectId, allowInterrupt }
    const response: unknown = await ipcRenderer.invoke(PROJECT_REMOVE_CHANNEL, request)
    return isProjectListResult(response) ? response : invalidProjectListResponse()
  },

  async searchProjectFiles(query: string) {
    const request = { query }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_SEARCH_CHANNEL, request)
    return isProjectFileSearchResult(response) ? response : invalidProjectFileResponse()
  },

  async listProjectDirectory(request: ProjectDirectoryListRequest) {
    const payload: ProjectDirectoryListRequest = { directory: request.directory }
    const response: unknown = await ipcRenderer.invoke(PROJECT_DIRECTORY_LIST_CHANNEL, payload)
    return isProjectDirectoryListResult(response) ? response : invalidProjectDirectoryResponse()
  },

  async watchProjectDirectories(request: ProjectDirectoryWatchRequest) {
    const payload: ProjectDirectoryWatchRequest = { directories: request.directories }
    const response: unknown = await ipcRenderer.invoke(PROJECT_DIRECTORY_WATCH_CHANNEL, payload)
    return isProjectDirectoryWatchResult(response) ? response : invalidProjectDirectoryWatchResponse()
  },

  onProjectDirectoryChanged(listener: (change: ProjectDirectoryChange) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!isProjectDirectoryChange(payload)) return
      listener(payload)
    }
    ipcRenderer.on(PROJECT_DIRECTORY_CHANGED_EVENT, handler)
    return () => {
      ipcRenderer.off(PROJECT_DIRECTORY_CHANGED_EVENT, handler)
    }
  },

  async resolveProjectEntryPath(request: ProjectEntryPathRequest) {
    const payload: ProjectEntryPathRequest = { path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ENTRY_RESOLVE_CHANNEL, payload)
    return isProjectEntryPathResult(response) ? response : invalidProjectEntryPathResponse()
  },

  async revealProjectEntry(request: ProjectEntryPathRequest) {
    const payload: ProjectEntryPathRequest = { path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ENTRY_REVEAL_CHANNEL, payload)
    return isProjectEntryRevealResult(response) ? response : invalidProjectEntryRevealResponse()
  },

  async deleteProjectEntry(request: ProjectEntryPathRequest) {
    const payload: ProjectEntryPathRequest = { path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_ENTRY_DELETE_CHANNEL, payload)
    return isProjectEntryDeleteResult(response) ? response : invalidProjectEntryDeleteResponse()
  },

  async readProjectFile(request: ProjectFileReadRequest) {
    const payload: ProjectFileReadRequest = { projectPath: request.projectPath, path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_READ_CHANNEL, payload)
    return isProjectFileReadResult(response) ? response : invalidProjectFileReadResponse()
  },

  async writeProjectFile(request: ProjectFileWriteRequest) {
    const payload: ProjectFileWriteRequest = {
      projectPath: request.projectPath,
      path: request.path,
      text: request.text,
      eol: request.eol,
      bom: request.bom,
      expected: request.expected === null
        ? null
        : { size: request.expected.size, mtimeMs: request.expected.mtimeMs }
    }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_WRITE_CHANNEL, payload)
    return isProjectFileWriteResult(response) ? response : invalidProjectFileWriteResponse()
  },

  async listMarkdownDocuments(request: MarkdownOwnerRequest) {
    const response: unknown = await ipcRenderer.invoke(PROJECT_MARKDOWN_DOCUMENTS_CHANNEL, { projectPath: request.projectPath, path: request.path })
    return isProjectMarkdownDocumentsResult(response) ? response : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '文档索引响应无效。' } }
  },

  async importMarkdownImage(request: ProjectMarkdownImageRequest) {
    const payload: ProjectMarkdownImageRequest = request.source === 'pick'
      ? { projectPath: request.projectPath, path: request.path, source: 'pick' }
      : { projectPath: request.projectPath, path: request.path, source: 'clipboard', bytes: new Uint8Array(request.bytes) }
    const response: unknown = await ipcRenderer.invoke(PROJECT_MARKDOWN_IMAGE_CHANNEL, payload)
    return isProjectMarkdownImageResult(response) ? response : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '图片导入响应无效。' } }
  },

  async statProjectFile(request: ProjectFileStatRequest) {
    const payload: ProjectFileStatRequest = { projectPath: request.projectPath, path: request.path }
    const response: unknown = await ipcRenderer.invoke(PROJECT_FILE_STAT_CHANNEL, payload)
    return isProjectFileStatResult(response) ? response : invalidProjectFileStatResponse()
  }
} satisfies ProjectApi & ProjectFileApi
