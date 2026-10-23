/** 封装 Pi 资源清单、启动前资源与模型共享预读、启动诊断、MCP 配置列举与探测及连接动作；把桥接缺失与通信异常转换为展示结果。 */
import type {
  McpCommandAction,
  McpCommandResult,
  McpConfigResult,
  McpInspectionResult,
  McpInspectAbortResult,
  McpStatusResult,
  ResourcesResult,
  ResourcePreviewResult,
  RuntimeDiagnosticsResult,
  RuntimeError,
  RuntimeTarget
} from '../../../../shared/runtime-api'

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

/** 读取目标实例绑定代际已加载的 Pi 资源清单；来源是它的会话已注册的扩展命令、提示词与技能。 */
export async function getResources(target: RuntimeTarget): Promise<ResourcesResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeResources !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeResources({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/** 预读资源、可用模型与默认模型及分项错误；项目与信任由主进程决定，`force` 用于手动刷新或认证更新后绕过缓存。 */
export async function getResourcePreview(force = false): Promise<ResourcePreviewResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getResourcePreview !== 'function') return unavailable()
  try {
    return await bridge.getResourcePreview(force)
  } catch (error) {
    return callFailed(error)
  }
}

/** 读取目标实例绑定代际的 SDK 会话创建期诊断与 Extension 运行时错误；未绑定时两项为空。 */
export async function getDiagnostics(target: RuntimeTarget): Promise<RuntimeDiagnosticsResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeDiagnostics !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeDiagnostics({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/** 请求目标实例内固定的 `/mcp` 状态；命令文本由主进程决定，页面不传入任何命令。 */
export async function readMcpStatus(target: RuntimeTarget): Promise<McpStatusResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.readRuntimeMcpStatus !== 'function') return unavailable()
  try {
    return await bridge.readRuntimeMcpStatus({ runId: target.runId, runtimeId: target.runtimeId })
  } catch (error) {
    return callFailed(error)
  }
}

/**
 * MCP 服务器 OAuth 登录、退出或重连：服务器名由页面给出但由主进程校验，
 * 命令文本由主进程拼出；页面不能传入任意命令，动作只作用于目标实例。
 */
export async function runMcpCommand(
  target: RuntimeTarget,
  action: McpCommandAction,
  serverName: string
): Promise<McpCommandResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.runRuntimeMcpCommand !== 'function') return unavailable()
  try {
    return await bridge.runRuntimeMcpCommand(
      { runId: target.runId, runtimeId: target.runtimeId },
      action,
      serverName
    )
  } catch (error) {
    return callFailed(error)
  }
}

/** MCP 配置列举：零参数，agent 目录与当前项目由主进程决定；只读，不连接服务器。 */
export async function getMcpConfig(): Promise<McpConfigResult> {
  const bridge = window.desktop
  if (!bridge || typeof bridge.getRuntimeMcpConfig !== 'function') return unavailable()
  try {
    return await bridge.getRuntimeMcpConfig()
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
