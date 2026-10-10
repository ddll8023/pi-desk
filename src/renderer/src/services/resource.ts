/** 作为渲染端 Pi 资源清单与未启动时的资源预读、启动诊断、MCP 状态、MCP 服务器探测与 MCP 登录/退出/重连、安全模式启动的调用入口，把桥接缺失与通信异常转换为安全的展示结果。 */
import type {
  McpCommandAction,
  McpCommandResult,
  McpInspectionResult,
  McpInspectAbortResult,
  McpStatusResult,
  ResourcesResult,
  ResourcePreviewResult,
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

/** 桥接调用异常：保留原始错误文本，避免真实原因被固定文案盖掉。 */
function callFailed(error: unknown): { ok: false; error: RuntimeError } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'BRIDGE_CALL_FAILED', message: `桌面桥接调用失败，可以重试：${detail}` }
  }
}

/** 读取当前代际已加载的 Pi 资源清单；清单来源是 Pi 自己的 `get_commands`。 */
export async function getResources(): Promise<ResourcesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeResources !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeResources()
  } catch (error) {
    return callFailed(error)
  }
}

/** Runtime 未启动时的资源预读；零参数，项目与信任决定由主进程决定。 */
export async function getResourcePreview(): Promise<ResourcePreviewResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getResourcePreview !== 'function') return unavailable()
  try {
    return await bridge.getResourcePreview()
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取当前代际的启动诊断尾部与 Extension 运行时错误；无活动 Runtime 时两项都为空。 */
export async function getDiagnostics(): Promise<RuntimeDiagnosticsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeDiagnostics !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeDiagnostics()
  } catch (error) {
    return callFailed(error)
  }
}

/** 请求固定的 `/mcp` 状态；命令文本由主进程决定，页面不传入任何命令。 */
export async function readMcpStatus(): Promise<McpStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.readRuntimeMcpStatus !== 'function') return unavailable()
  try {
    return await bridge.readRuntimeMcpStatus()
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * MCP 服务器 OAuth 登录、退出或重连：服务器名由页面给出但由主进程校验，
 * 命令文本由主进程拼出；页面不能传入任意命令。
 */
export async function runMcpCommand(
  action: McpCommandAction,
  serverName: string
): Promise<McpCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.runRuntimeMcpCommand !== 'function') return unavailable()
  try {
    return await bridge.runRuntimeMcpCommand(action, serverName)
  } catch (error) {
    return callFailed(error)
  }
}

/** MCP 服务器探测：零参数；命令、工作目录与信任决定都由主进程决定。 */
export async function inspectMcpServers(): Promise<McpInspectionResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.inspectRuntimeMcpServers !== 'function') return unavailable()
  try {
    return await bridge.inspectRuntimeMcpServers()
  } catch (error) {
    return callFailed(error)
  }
}

/** 中止进行中的 MCP 探测；零参数，只终止主进程自己启动的探测进程。 */
export async function abortMcpInspection(): Promise<McpInspectAbortResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.abortRuntimeMcpInspection !== 'function') return unavailable()
  try {
    return await bridge.abortRuntimeMcpInspection()
  } catch (error) {
    return callFailed(error)
  }
}

/** 安全模式启动：不加载 Extension，仅本次生效；目标由主进程用最近一次启动意图决定。 */
export async function startRuntimeSafely(): Promise<RuntimeResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.startRuntimeSafely !== 'function') return unavailable()
  try {
    return await bridge.startRuntimeSafely()
  } catch (error) {
    return callFailed(error)
  }
}
