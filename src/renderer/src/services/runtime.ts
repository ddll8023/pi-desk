/** 作为渲染端 Runtime 调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { RuntimeResult } from '../../../shared/runtime-api'

function unavailable(): RuntimeResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): RuntimeResult {
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: '桌面桥接调用失败，可以重试。' }
  }
}

export async function startRuntime(projectPath: string): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.startRuntime !== 'function') return unavailable()
  try {
    return await bridge.startRuntime(projectPath)
  } catch {
    return callFailed()
  }
}

export async function getRuntimeStatus(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeStatus !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeStatus()
  } catch {
    return callFailed()
  }
}
