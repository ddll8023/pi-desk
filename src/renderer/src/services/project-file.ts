/** 作为渲染端项目文件检索入口，收敛桥接缺失与通信异常。 */
import type { DesktopError } from '../../../shared/desktop-api'
import type { ProjectFileSearchResult } from '../../../shared/project-file-api'

function unavailable(): { ok: false; error: DesktopError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): { ok: false; error: DesktopError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试。' }
  }
}

/** 在当前项目内检索文件候选；没有当前项目时主进程返回空列表，不是错误。 */
export async function searchProjectFiles(query: string): Promise<ProjectFileSearchResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.searchProjectFiles !== 'function') return unavailable()
  try {
    return await bridge.searchProjectFiles(query)
  } catch {
    return callFailed()
  }
}
