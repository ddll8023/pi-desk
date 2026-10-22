/** Pi 资源与 MCP 的 IPC：只读资源清单、共享预读（资源、可用模型与默认模型）、启动诊断、MCP 状态、登录/退出/重连、配置列举、服务器探测与中止。命令文本由主进程按固定调用点给出。 */

import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  RUNTIME_DIAGNOSTICS_CHANNEL,
  RUNTIME_MCP_COMMAND_CHANNEL,
  RUNTIME_MCP_CONFIG_CHANNEL,
  RUNTIME_MCP_INSPECT_ABORT_CHANNEL,
  RUNTIME_MCP_INSPECT_CHANNEL,
  RUNTIME_MCP_STATUS_CHANNEL,
  RUNTIME_RESOURCES_CHANNEL,
  RUNTIME_RESOURCE_PREVIEW_CHANNEL,
  isResourcePreviewRequest,
  isRuntimeTarget
} from '../../shared/runtime-api'
import type {
  McpCommandResult,
  McpConfigResult,
  McpInspectionResult,
  McpInspectAbortResult,
  McpStatusResult,
  ResourcesResult,
  ResourcePreviewResult,
  RuntimeDiagnosticsResult,
  RuntimeErrorCode
} from '../../shared/runtime-api'
import { readMcpConfigListing } from './mcp-config-reader'
import { ResourcePreviewError, previewGlobalModels, previewProjectResources } from './resource-preview'
import { handle, isMcpServerName } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { sdkRuntime, projectManager, trustManager, mcpInspection } from '../services'
import { resolveTrustForCurrentProject } from '../trust/guards'

export function resourcesFailure(code: RuntimeErrorCode, message: string): ResourcesResult {
  return { ok: false, error: { code, message } }
}

export function resourcePreviewFailure(code: RuntimeErrorCode, message: string): ResourcePreviewResult {
  return { ok: false, error: { code, message } }
}

export function diagnosticsFailure(code: RuntimeErrorCode, message: string): RuntimeDiagnosticsResult {
  return { ok: false, error: { code, message } }
}

export function mcpStatusFailure(code: RuntimeErrorCode, message: string): McpStatusResult {
  return { ok: false, error: { code, message } }
}

export function mcpInspectionFailure(code: RuntimeErrorCode, message: string): McpInspectionResult {
  return { ok: false, error: { code, message } }
}

export function mcpInspectionAbortFailure(code: RuntimeErrorCode, message: string): McpInspectAbortResult {
  return { ok: false, error: { code, message } }
}

export function mcpConfigFailure(code: RuntimeErrorCode, message: string): McpConfigResult {
  return { ok: false, error: { code, message } }
}

export function registerResourceHandlers(pageUrl: string): void {
  /** 资源清单只读目标实例的绑定代际已加载的扩展命令、提示词与技能。 */
  handle(
    RUNTIME_RESOURCES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ResourcesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return resourcesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return resourcesFailure('INVALID_REQUEST', '资源清单只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readResources(args[0])
    }
  )

  /**
   * 共享预读只接受一个请求对象：返回资源、可用模型与默认模型及分项错误，单项失败不遮蔽其他结果。
   * 未选项目时改用中立目录做全局预读，只回模型与默认身份，`projectPath` 为 null，供首页设置默认模型。
   * 项目与信任由主进程决定，页面只能要求绕过缓存；无决定时按未信任探测，不触发信任提示或写记录。
   */
  handle(
    RUNTIME_RESOURCE_PREVIEW_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ResourcePreviewResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return resourcePreviewFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isResourcePreviewRequest(args[0])) {
        return resourcePreviewFailure('INVALID_REQUEST', '资源预读请求必须显式给出 force 布尔值。')
      }
      const { force } = args[0]
      const projectPath = projectManager.currentProjectPath()
      try {
        if (projectPath === null) {
          // userData 属于桌面应用自己，没有 .pi 项目配置，适合作为无关项目的探测目录。
          const preview = await previewGlobalModels(app.getPath('userData'), force)
          return { ok: true, data: { projectPath: null, ...preview } }
        }
        const outcome = await trustManager.resolveLaunchDecision(projectPath)
        const trustDecision = outcome.requiresPrompt ? 'untrusted' : outcome.decision
        const preview = await previewProjectResources(projectPath, trustDecision, force)
        return { ok: true, data: { projectPath, ...preview } }
      } catch (error) {
        if (error instanceof ResourcePreviewError) {
          return resourcePreviewFailure(error.code, error.message)
        }
        return resourcePreviewFailure(
          'INTERNAL_ERROR',
          `资源预读失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )

  /** 诊断只暴露目标实例绑定代际已持有的 SDK 创建期诊断与 Extension 运行时错误。 */
  handle(
    RUNTIME_DIAGNOSTICS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeDiagnosticsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return diagnosticsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return diagnosticsFailure('INVALID_REQUEST', '诊断接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readDiagnostics(args[0])
    }
  )

  /** MCP 状态使用目标实例绑定内固定的 `/mcp` 命令，不接受页面传入任何命令文本。 */
  handle(
    RUNTIME_MCP_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 状态接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readMcpStatus(args[0])
    }
  )

  /** MCP 登录、退出或重连：只接受动作与服务器名；命令文本与等待期限都由主进程决定。 */
  handle(
    RUNTIME_MCP_COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpCommandResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'action' && key !== 'serverName')) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 登录/退出参数包含未支持的字段。')
      }
      const target = fields.target
      if (!isRuntimeTarget(target)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 操作必须给出运行实例与绑定代际。')
      }
      if (fields.action !== 'login' && fields.action !== 'logout' && fields.action !== 'reconnect') {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 动作只能是 login、logout 或 reconnect。')
      }
      // 服务器名会被拼进固定命令文本，因此只允许字母、数字、点、下划线与连字符。
      if (!isMcpServerName(fields.serverName)) {
        return mcpStatusFailure('INVALID_REQUEST', 'MCP 服务器名只能包含字母、数字、点、下划线与连字符。')
      }
      return sdkRuntime.runMcpCommand(target, fields.action, fields.serverName)
    }
  )

  /**
   * MCP 服务器探测：零参数，主进程用当前项目跑一次固定的 `pi mcp list --json`。
   * 探测会另起一个 Pi 进程并重新连接所有已启用服务器，不写任何配置文件。
   * 官方 CLI 不接受信任 flag，探测以未信任项目身份运行，因此这里不做信任拦截。
   */
  handle(
    RUNTIME_MCP_INSPECT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpInspectionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpInspectionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpInspectionFailure('INVALID_REQUEST', 'MCP 探测接口不接受参数。')
      }
      const projectPath = projectManager.currentProjectPath()
      if (projectPath === null) {
        return mcpInspectionFailure('INVALID_PROJECT_PATH', '请先选择一个项目，再探测 MCP 服务器。')
      }
      const result = await mcpInspection.inspect(projectPath)
      // 探测期间项目可能已切换：此时结果属于旧项目，不能当作当前项目的状态交给页面。
      if (result.ok && projectManager.currentProjectPath() !== projectPath) {
        return mcpInspectionFailure('INVALID_PROJECT_PATH', '项目已切换，本次探测结果已丢弃。')
      }
      return result
    }
  )

  /** 中止进行中的 MCP 探测：零参数，只终止主进程自己启动的探测进程。 */
  handle(
    RUNTIME_MCP_INSPECT_ABORT_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): McpInspectAbortResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpInspectionAbortFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpInspectionAbortFailure('INVALID_REQUEST', '中止探测接口不接受参数。')
      }
      return mcpInspection.abort()
    }
  )

  /**
   * MCP 配置列举：零参数，只读读取 Pi 的 mcp.json（全局与当前项目两处）。
   * 不连接服务器、不写配置文件；项目级配置是否生效取决于信任决定，因此决定结果一并回传，
   * 未信任与需要信任决定的项目都按「未生效」如实展示，不在这里触发信任拦截。
   */
  handle(
    RUNTIME_MCP_CONFIG_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<McpConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return mcpConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return mcpConfigFailure('INVALID_REQUEST', 'MCP 配置列举接口不接受参数。')
      }
      try {
        const trust = await resolveTrustForCurrentProject()
        return {
          ok: true,
          data: await readMcpConfigListing(
            projectManager.currentProjectPath(),
            !trust.requiresPrompt && trust.decision === 'trusted'
          )
        }
      } catch (error) {
        return mcpConfigFailure(
          'INTERNAL_ERROR',
          `读取 MCP 配置失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  )
}
