/** 作为渲染端 Runtime 启停与 Prompt 提交的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type { PromptResult, RuntimeError, RuntimeResult, RuntimeStatus } from '../../../shared/runtime-api'

function unavailable(): { ok: false; error: RuntimeError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

function callFailed(): { ok: false; error: RuntimeError } {
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

export async function stopRuntime(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.stopRuntime !== 'function') return unavailable()
  try {
    return await bridge.stopRuntime()
  } catch {
    return callFailed()
  }
}

/** 提交 Prompt；返回只表达请求接受或拒绝，不代表 Agent 执行结束。 */
export async function sendPrompt(message: string): Promise<PromptResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.sendPrompt !== 'function') return unavailable()
  try {
    return await bridge.sendPrompt(message)
  } catch {
    return callFailed()
  }
}

/** 订阅状态事件；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeRuntimeStatus(listener: (status: RuntimeStatus) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onRuntimeStatusChanged !== 'function') return () => {}
  try {
    return bridge.onRuntimeStatusChanged(listener)
  } catch {
    return () => {}
  }
}
