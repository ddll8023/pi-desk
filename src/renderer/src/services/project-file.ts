/** 作为渲染端项目文件检索、目录列举与条目路径解析的入口，收敛桥接缺失与通信异常。 */
import type { DesktopError } from '../../../shared/desktop-api'
import type {
  ProjectDirectoryListResult,
  ProjectEntryPathResult,
  ProjectEntryRevealResult,
  ProjectFileSearchResult
} from '../../../shared/project-file-api'

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
