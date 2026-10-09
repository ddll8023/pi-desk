/** 作为渲染端 Pi 资源清单、启动诊断、MCP 状态与安全模式启动的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  McpStatusResult,
  ResourcesResult,
  RuntimeDiagnosticsResult,
  RuntimeError,
  RuntimeResult
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

/** 读取当前代际已加载的 Pi 资源清单；清单来源是 Pi 自己的 `get_commands`。 */
export async function getResources(): Promise<ResourcesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeResources !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeResources()
  } catch {
    return callFailed()
  }
}

/** 读取当前代际的启动诊断尾部与 Extension 运行时错误；无活动 Runtime 时两项都为空。 */
export async function getDiagnostics(): Promise<RuntimeDiagnosticsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeDiagnostics !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeDiagnostics()
  } catch {
    return callFailed()
  }
}

/** 请求固定的 `/mcp` 状态；命令文本由主进程决定，页面不传入任何命令。 */
export async function readMcpStatus(): Promise<McpStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.readRuntimeMcpStatus !== 'function') return unavailable()
  try {
    return await bridge.readRuntimeMcpStatus()
  } catch {
    return callFailed()
  }
}

/** 安全模式启动：不加载 Extension，仅本次生效；目标由主进程用最近一次启动意图决定。 */
export async function startRuntimeSafely(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.startRuntimeSafely !== 'function') return unavailable()
  try {
    return await bridge.startRuntimeSafely()
  } catch {
    return callFailed()
  }
}
