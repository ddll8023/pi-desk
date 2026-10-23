/** 项目文件与 Markdown 资源的渲染端服务入口：重建普通请求载荷，收敛桥接缺失并保留通信错误。 */
import type { DesktopError } from '../../../../shared/desktop-api'
import type { ProjectMarkdownDocumentsResult, ProjectMarkdownImageResult } from '../../../../shared/project-file-api'

import type {
  ProjectDirectoryChange,
  ProjectDirectoryListResult,
  ProjectDirectoryWatchResult,
  ProjectEntryPathResult,
  ProjectEntryRevealResult,
  ProjectFileReadResult,
  ProjectFileSearchResult,
  ProjectFileStatResult,
  ProjectFileWriteResult
} from '../../../../shared/project-file-api'

function unavailable(): { ok: false; error: DesktopError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: DesktopError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 固定文档所属项目，不使用可变的当前项目信息解释迟到响应。 */
export async function listMarkdownDocuments(projectPath: string, path: string): Promise<ProjectMarkdownDocumentsResult> {
  if (!window.desktop?.listMarkdownDocuments) return unavailable()
  try { return await window.desktop.listMarkdownDocuments({ projectPath, path }) } catch (error) { return callFailed(error) }
}
/** 图片只接收选择器动作或已捕获的字节，不把响应式对象直接交给桥接。 */
export async function importMarkdownImage(projectPath: string, path: string, bytes?: Uint8Array): Promise<ProjectMarkdownImageResult> {
  if (!window.desktop?.importMarkdownImage) return unavailable()
  try {
    return await window.desktop.importMarkdownImage(bytes
      ? { projectPath, path, source: 'clipboard', bytes: new Uint8Array(bytes) }
      : { projectPath, path, source: 'pick' })
  } catch (error) { return callFailed(error) }
}

/** 在当前项目内检索文件候选；没有当前项目时主进程返回空列表，不是错误。 */
export async function searchProjectFiles(query: string): Promise<ProjectFileSearchResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.searchProjectFiles !== 'function') return unavailable()
  try {
    return await bridge.searchProjectFiles(query)
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 列举当前项目内一层目录；目录相对路径由页面给出，越界与绝对路径由主进程拒绝。
 * 未选择项目时主进程返回空结果，不是错误；目录不可读才回错误。
 */
export async function listProjectDirectory(directory: string): Promise<ProjectDirectoryListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listProjectDirectory !== 'function') return unavailable()
  try {
    return await bridge.listProjectDirectory({ directory })
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 提交当前项目里需要监听的目录集合；目录是项目内相对路径，越界与绝对路径由主进程丢弃。
 * 监听只服务于「自动刷新」，失败时按普通错误返回，调用方不必因此阻断列举。
 */
export async function watchProjectDirectories(
  directories: readonly string[]
): Promise<ProjectDirectoryWatchResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.watchProjectDirectories !== 'function') return unavailable()
  try {
    return await bridge.watchProjectDirectories({ directories })
  } catch (error) {
    return callFailed(error)
  }
}

/** 订阅目录变化；桥接缺失时返回空取消函数，调用方不必区分有没有监听。 */
export function onProjectDirectoryChanged(listener: (change: ProjectDirectoryChange) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onProjectDirectoryChanged !== 'function') return () => {}
  try {
    return bridge.onProjectDirectoryChanged(listener)
  } catch {
    return () => {}
  }
}

/**
 * 把项目内相对条目路径解析为绝对路径；页面不自行拼接路径，平台分隔符与越界判定都由主进程负责。
 * 未选择项目与路径非法都回错误，由调用方就近提示。
 */
export async function resolveProjectEntryPath(path: string): Promise<ProjectEntryPathResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.resolveProjectEntryPath !== 'function') return unavailable()
  try {
    return await bridge.resolveProjectEntryPath({ path })
  } catch (error) {
    return callFailed(error)
  }
}

/** 在系统文件管理器中显示一个项目内条目；条目已不存在时回可展示的原因。 */
export async function revealProjectEntry(path: string): Promise<ProjectEntryRevealResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.revealProjectEntry !== 'function') return unavailable()
  try {
    return await bridge.revealProjectEntry({ path })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取项目内文件内容；文本、图片与不支持三类结果都由主进程判定，页面不自行猜测类型。 */
export async function readProjectFile(projectPath: string, path: string): Promise<ProjectFileReadResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.readProjectFile !== 'function') return unavailable()
  try {
    return await bridge.readProjectFile({ projectPath, path })
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 保存项目内文本文件；`expected` 为读取时的磁盘基线，传 null 表示用户已确认覆盖。
 * 磁盘基线不一致时主进程回 CONFLICT，不写入任何内容。
 */
export async function writeProjectFile(
  projectPath: string,
  path: string,
  text: string,
  eol: 'lf' | 'crlf',
  bom: boolean,
  expected: { readonly size: number; readonly mtimeMs: number } | null
): Promise<ProjectFileWriteResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.writeProjectFile !== 'function') return unavailable()
  try {
    return await bridge.writeProjectFile({ projectPath, path, text, eol, bom, expected })
  } catch (error) {
    return callFailed(error)
  }
}

/** 查询文件磁盘基线；用于标签重新激活或窗口聚焦时判断外部改动。 */
export async function statProjectFile(projectPath: string, path: string): Promise<ProjectFileStatResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.statProjectFile !== 'function') return unavailable()
  try {
    return await bridge.statProjectFile({ projectPath, path })
  } catch (error) {
    return callFailed(error)
  }
}
