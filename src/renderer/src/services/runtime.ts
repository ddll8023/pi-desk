/** 渲染端 Runtime 状态、模型选择、Prompt、回退、手动压缩与投影同步的受限桥接入口；通信异常转换为安全的展示结果。 */
import type {
  CapabilitiesResult,
  ProjectionBatch,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  RuntimeCompactRequest,
  RuntimeError,
  RuntimeResult,
  RuntimeRewindRequest,
  RuntimeRewindResult,
  RuntimeSetModelRequest,
  RuntimeStatus,
  RuntimeTarget
} from '../../../shared/runtime-api'

function unavailable(): { ok: false; error: RuntimeError } {
  return {
    ok: false,
    error: { code: 'BRIDGE_UNAVAILABLE', message: '桌面桥接不可用，请通过 Electron 打开此页面。' }
  }
}

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: RuntimeError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

export async function getRuntimeStatus(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeStatus !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeStatus()
  } catch (error) {
    return callFailed(error)
  }
}

/** 请求中止目标运行实例的当前操作；结果只表示 Pi 是否确认取消，运行状态仍看事件流。 */
export async function abortRuntime(target: RuntimeTarget): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.abortRuntime !== 'function') return unavailable()
  try {
    return await bridge.abortRuntime({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/** 提交 Prompt 到目标实例的当前绑定；返回只表达请求接受或拒绝，不代表 Agent 执行结束。 */
export async function sendPrompt(
  target: RuntimeTarget,
  message: string,
  images: readonly PromptImageInput[] = []
): Promise<PromptResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.sendPrompt !== 'function') return unavailable()
  try {
    return await bridge.sendPrompt(
      { runId: target.runId, runtimeId: target.runtimeId },
      message,
      images.map((image) => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
    )
  } catch (error) {
    return callFailed(error)
  }
}

/** 回退属于非幂等操作；普通对象跨桥接，通信中断时不自动重发。 */
export async function rewindRuntime(request: RuntimeRewindRequest): Promise<RuntimeRewindResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.rewindRuntime !== 'function') return unavailable()
  try {
    return await bridge.rewindRuntime({
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      messageId: request.messageId
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `回退桥接调用失败：${detail}；结果未知，请重新打开会话，不会自动重发。` },
      blocked: true
    }
  }
}

/** 取得目标实例的投影快照；这是渲染端重新同步的唯一基准。 */
export async function getRuntimeProjection(target: RuntimeTarget): Promise<ProjectionResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeProjection !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeProjection({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取目标实例当前绑定的可用模型；失败原因由结果表达。 */
export async function getRuntimeCapabilities(target: RuntimeTarget): Promise<CapabilitiesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeCapabilities !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeCapabilities({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/** 切换目标实例的当前会话模型；只传原始值，通信失败保留异常文本便于定位。 */
export async function setRuntimeModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.setRuntimeModel !== 'function') return unavailable()
  try {
    return await bridge.setRuntimeModel({
      runId: request.runId,
      runtimeId: request.runtimeId,
      provider: request.provider,
      modelId: request.modelId
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `模型切换桥接调用失败：${detail}` }
    }
  }
}

/**
 * 手动压缩目标实例的当前会话上下文；说明可选。
 * 调用会等到整段压缩结束才返回，过程与结果由投影中的压缩记录表达。
 */
export async function compactRuntime(request: RuntimeCompactRequest): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.compactRuntime !== 'function') return unavailable()
  try {
    return await bridge.compactRuntime({
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      instructions: request.instructions
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: { code: 'BRIDGE_CALL_FAILED', message: `压缩桥接调用失败：${detail}` }
    }
  }
}

/** 确认目标实例已应用到的最高序号；确认失败只影响通知窗口，不打断展示。 */
export function ackRuntimeProjection(target: RuntimeTarget, seq: number): void {
  const bridge = window.desktop
  if (!bridge || typeof bridge.ackRuntimeProjection !== 'function') return
  try {
    bridge.ackRuntimeProjection({ runId: target.runId, runtimeId: target.runtimeId }, seq)
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
