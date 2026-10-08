/** 作为渲染端项目选择、列表与切换的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  ProjectError,
  ProjectListResult,
  ProjectPathResult
} from '../../../shared/project-api'

function unavailable(): { ok: false; error: ProjectError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): { ok: false; error: ProjectError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试。' }
  }
}

/** 打开系统目录选择器；用户取消时成功结果的 `data` 为 `null`。 */
export async function chooseProjectDirectory(): Promise<ProjectPathResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.chooseProjectDirectory !== 'function') return unavailable()
  try {
    return await bridge.chooseProjectDirectory()
  } catch {
    return callFailed()
  }
}

export async function listProjects(): Promise<ProjectListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listProjects !== 'function') return unavailable()
  try {
    return await bridge.listProjects()
  } catch {
    return callFailed()
  }
}

/** 把目录设为当前项目；`allowInterrupt` 表示用户已确认可以停止运行中的操作。 */
export async function setCurrentProject(
  path: string,
  allowInterrupt: boolean
): Promise<ProjectListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setCurrentProject !== 'function') return unavailable()
  try {
    return await bridge.setCurrentProject(path, allowInterrupt)
  } catch {
    return callFailed()
  }
}
