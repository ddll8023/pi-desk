/** 作为渲染端项目选择、列表、添加、移除与切换入口，收敛桥接缺失和通信异常。 */
import type {
  ProjectError,
  ProjectListResult,
  ProjectPathResult
} from '../../../shared/project-api'
import type { TrustDecision, TrustStatus } from '../../../shared/trust-api'

function unavailable(): { ok: false; error: ProjectError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/**
 * 桥接调用异常：保留原始错误文本。调用被拒的真实原因（处理器未注册、参数无法克隆等）
 * 只存在于这个异常里，用固定文案盖掉就只能靠猜。
 */
function callFailed(error: unknown): { ok: false; error: ProjectError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 打开系统目录选择器；用户取消时成功结果的 `data` 为 `null`。 */
export async function chooseProjectDirectory(): Promise<ProjectPathResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.chooseProjectDirectory !== 'function') return unavailable()
  try {
    return await bridge.chooseProjectDirectory()
  } catch (error) {
    return callFailed(error)
  }
}

export async function listProjects(): Promise<ProjectListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.listProjects !== 'function') return unavailable()
  try {
    return await bridge.listProjects()
  } catch (error) {
    return callFailed(error)
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
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * 把信任状态重建为普通对象再传过桥。
 *
 * contextBridge 无法克隆 Vue 的响应式代理：直接从 `ref` 里取出对象传参，会在渲染层就抛出
 * "An object could not be cloned."，主进程根本收不到请求，而调用方只能看到一句通用的调用失败。
 * 在服务层重建载荷，使任何调用方都不会再踩这一点。
 */
function toPlainTrustStatus(status: TrustStatus): TrustStatus {
  return {
    projectPath: status.projectPath,
    decision: status.decision,
    resources: status.resources.map((resource) => ({ path: resource.path, kind: resource.kind }))
  }
}

/** 完成候选项目添加与切换；信任决定随项目状态一起由主进程保存。 */
export async function addProject(
  path: string,
  trustStatus: TrustStatus,
  trustDecision: TrustDecision | null,
  allowInterrupt: boolean
): Promise<ProjectListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.addProject !== 'function') return unavailable()
  try {
    return await bridge.addProject(path, toPlainTrustStatus(trustStatus), trustDecision, allowInterrupt)
  } catch (error) {
    return callFailed(error)
  }
}

/** 从 Pi Desktop 项目列表移除项目，不删除磁盘目录。 */
export async function removeProject(
  projectId: string,
  allowInterrupt: boolean
): Promise<ProjectListResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.removeProject !== 'function') return unavailable()
  try {
    return await bridge.removeProject(projectId, allowInterrupt)
  } catch (error) {
    return callFailed(error)
  }
}
