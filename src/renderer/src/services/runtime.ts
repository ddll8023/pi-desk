/** 作为渲染端 Runtime 启停、可用模型读取、Prompt 提交、中止与投影同步的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  CapabilitiesResult,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  RuntimeError,
  RuntimeResult,
  RuntimeStatus
} from '../../../shared/runtime-api'

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

/** 请求中止当前 Agent 操作；结果只表示 Pi 是否确认取消，运行状态仍看事件流。 */
export async function abortRuntime(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.abortRuntime !== 'function') return unavailable()
  try {
    return await bridge.abortRuntime()
  } catch {
    return callFailed()
  }
}

/** 提交 Prompt；返回只表达请求接受或拒绝，不代表 Agent 执行结束。图片附件经主进程校验后转发。 */
export async function sendPrompt(
  message: string,
  images: readonly PromptImageInput[] = []
): Promise<PromptResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.sendPrompt !== 'function') return unavailable()
  try {
    return await bridge.sendPrompt(message, images)
  } catch {
    return callFailed()
  }
}

/** 取得投影快照；这是渲染端重新同步的唯一基准。 */
export async function getRuntimeProjection(): Promise<ProjectionResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeProjection !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeProjection()
  } catch {
    return callFailed()
  }
}

/** 读取当前代际的可用模型；失败原因由结果表达。 */
export async function getRuntimeCapabilities(): Promise<CapabilitiesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeCapabilities !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeCapabilities()
  } catch {
    return callFailed()
  }
}

/** 确认已应用到的最高序号；确认失败只影响通知窗口，不打断展示。 */
export function ackRuntimeProjection(runtimeId: number, seq: number): void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.ackRuntimeProjection !== 'function') return
  try {
    bridge.ackRuntimeProjection(runtimeId, seq)
  } catch {
    // 应用确认失败由主进程的未确认窗口收敛。
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

/** 订阅投影批次；桥接缺失或订阅失败时返回无操作的释放函数。 */
export function subscribeRuntimeProjection(listener: (batch: ProjectionBatch) => void): () => void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.onRuntimeProjectionChanged !== 'function') return () => {}
  try {
    return bridge.onRuntimeProjectionChanged(listener)
  } catch {
    return () => {}
  }
}
