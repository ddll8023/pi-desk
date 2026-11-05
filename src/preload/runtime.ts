/** Runtime、模型能力、资源与 MCP：preload 的 runtime 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { cloneImageAnnotations } from '../shared/image-annotation'
import type { IpcRendererEvent } from 'electron'
import { RUNTIME_ABORT_CHANNEL, RUNTIME_CAPABILITIES_CHANNEL, RUNTIME_COMPACT_CHANNEL, RUNTIME_SET_MODEL_CHANNEL, RUNTIME_DIAGNOSTICS_CHANNEL, RUNTIME_MCP_COMMAND_CHANNEL, RUNTIME_MCP_CONFIG_CHANNEL, RUNTIME_MCP_INSPECT_ABORT_CHANNEL, RUNTIME_MCP_INSPECT_CHANNEL, RUNTIME_MCP_STATUS_CHANNEL, RUNTIME_PROMPT_CHANNEL, RUNTIME_REWIND_CHANNEL, RUNTIME_PROJECTION_ACK_CHANNEL, RUNTIME_PROJECTION_CHANNEL, RUNTIME_PROJECTION_EVENT, RUNTIME_RESOURCES_CHANNEL, RUNTIME_RESOURCE_PREVIEW_CHANNEL, RUNTIME_STATUS_CHANNEL, RUNTIME_STATUS_EVENT, isCapabilitiesResult, isMcpCommandResult, isMcpConfigResult, isMcpInspectionResult, isMcpInspectAbortResult, isMcpStatusResult, isProjectionBatch, isProjectionResult, isPromptResult, isResourcesResult, isResourcePreviewResult, isRuntimeDiagnosticsResult, isRuntimeResult, isRuntimeRewindResult, isRuntimeStatus } from '../shared/runtime-api'
import type { CapabilitiesResult, McpCommandAction, McpCommandResult, McpConfigResult, McpInspectionResult, McpInspectAbortResult, McpStatusResult, ProjectionBatch, ProjectionResult, PromptImageInput, PromptResult, ResourcesResult, ResourcePreviewResult, RuntimeCompactRequest, RuntimeDiagnosticsResult, RuntimeResult, RuntimeSetModelRequest, RuntimeRewindRequest, RuntimeStatus, RuntimeTarget } from '../shared/runtime-api'
import type { RuntimeApi } from '../shared/runtime-api'

const INVALID_RUNTIME_RESPONSE = '桌面接口返回了无法识别的 Runtime 结果。'
const INVALID_PROMPT_RESPONSE = '桌面接口返回了无法识别的 Prompt 结果。'
const INVALID_PROJECTION_RESPONSE = '桌面接口返回了无法识别的投影快照。'
const INVALID_CAPABILITIES_RESPONSE = '桌面接口返回了无法识别的模型列表结果。'
const INVALID_RESOURCES_RESPONSE = '桌面接口返回了无法识别的资源清单。'
const INVALID_RESOURCE_PREVIEW_RESPONSE = '桌面接口返回了无法识别的资源预读结果。'
const INVALID_DIAGNOSTICS_RESPONSE = '桌面接口返回了无法识别的诊断结果。'
const INVALID_MCP_STATUS_RESPONSE = '桌面接口返回了无法识别的 MCP 状态结果。'
const INVALID_MCP_INSPECTION_RESPONSE = '桌面接口返回了无法识别的 MCP 探测结果。'
const INVALID_MCP_CONFIG_RESPONSE = '桌面接口返回了无法识别的 MCP 配置列举结果。'
const INVALID_MCP_INSPECT_ABORT_RESPONSE = '桌面接口返回了无法识别的中止探测结果。'

function invalidRuntimeResponse(): RuntimeResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RUNTIME_RESPONSE } }
}

function invalidPromptResponse(): PromptResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROMPT_RESPONSE } }
}

function invalidProjectionResponse(): ProjectionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PROJECTION_RESPONSE } }
}

function invalidCapabilitiesResponse(): CapabilitiesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_CAPABILITIES_RESPONSE } }
}

function invalidResourcesResponse(): ResourcesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RESOURCES_RESPONSE } }
}

function invalidResourcePreviewResponse(): ResourcePreviewResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_RESOURCE_PREVIEW_RESPONSE } }
}

function invalidDiagnosticsResponse(): RuntimeDiagnosticsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_DIAGNOSTICS_RESPONSE } }
}

function invalidMcpStatusResponse(): McpStatusResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_STATUS_RESPONSE } }
}

function invalidMcpInspectionResponse(): McpInspectionResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_INSPECTION_RESPONSE } }
}

function invalidMcpConfigResponse(): McpConfigResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_CONFIG_RESPONSE } }
}

function invalidMcpInspectAbortResponse(): McpInspectAbortResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MCP_INSPECT_ABORT_RESPONSE } }
}

export const runtimeApi = {
  async getRuntimeStatus() {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_STATUS_CHANNEL)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async abortRuntime(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_ABORT_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async sendPrompt(target: RuntimeTarget, message: string, images?: readonly PromptImageInput[]) {
    // 只搬运已声明的字段：目标逐字段重建，图片附件逐条重建，不带页面传入的其他内容。
    const payloadImages = (images ?? []).map((image) => ({
      name: image.name,
      mimeType: image.mimeType,
      data: image.data,
      ...(image.annotations === undefined ? {} : { annotations: cloneImageAnnotations(image.annotations) })
    }))
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROMPT_CHANNEL, {
      target: { runId: target.runId, runtimeId: target.runtimeId },
      message,
      ...(payloadImages.length > 0 ? { images: payloadImages } : {})
    })
    return isPromptResult(response) ? response : invalidPromptResponse()
  },

  async rewindRuntime(request: RuntimeRewindRequest) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_REWIND_CHANNEL, {
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      messageId: request.messageId
    })
    return isRuntimeRewindResult(response)
      ? response
      : { ok: false as const, error: { code: 'INVALID_RESPONSE' as const, message: '桌面接口返回了无法识别的回退结果。' }, blocked: true }
  },

  async getRuntimeProjection(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_PROJECTION_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isProjectionResult(response) ? response : invalidProjectionResponse()
  },

  async getRuntimeCapabilities(target: RuntimeTarget) {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_CAPABILITIES_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isCapabilitiesResult(response) ? response : invalidCapabilitiesResponse()
  },

  async setRuntimeModel(request: RuntimeSetModelRequest): Promise<RuntimeResult> {
    const payload: RuntimeSetModelRequest = {
      runId: request.runId,
      runtimeId: request.runtimeId,
      provider: request.provider,
      modelId: request.modelId
    }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_SET_MODEL_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async compactRuntime(request: RuntimeCompactRequest): Promise<RuntimeResult> {
    const payload: RuntimeCompactRequest = {
      runId: request.runId,
      runtimeId: request.runtimeId,
      sessionId: request.sessionId,
      instructions: request.instructions
    }
    const response: unknown = await ipcRenderer.invoke(RUNTIME_COMPACT_CHANNEL, payload)
    return isRuntimeResult(response) ? response : invalidRuntimeResponse()
  },

  async getRuntimeResources(target: RuntimeTarget): Promise<ResourcesResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCES_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isResourcesResult(response) ? response : invalidResourcesResponse()
  },

  async getResourcePreview(force: boolean): Promise<ResourcePreviewResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_RESOURCE_PREVIEW_CHANNEL, { force })
    return isResourcePreviewResult(response) ? response : invalidResourcePreviewResponse()
  },

  async getRuntimeDiagnostics(target: RuntimeTarget): Promise<RuntimeDiagnosticsResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_DIAGNOSTICS_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isRuntimeDiagnosticsResult(response) ? response : invalidDiagnosticsResponse()
  },

  async readRuntimeMcpStatus(target: RuntimeTarget): Promise<McpStatusResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_STATUS_CHANNEL, {
      runId: target.runId,
      runtimeId: target.runtimeId
    })
    return isMcpStatusResult(response) ? response : invalidMcpStatusResponse()
  },

  async runRuntimeMcpCommand(
    target: RuntimeTarget,
    action: McpCommandAction,
    serverName: string
  ): Promise<McpCommandResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_COMMAND_CHANNEL, {
      target: { runId: target.runId, runtimeId: target.runtimeId },
      action,
      serverName
    })
    return isMcpCommandResult(response) ? response : invalidMcpStatusResponse()
  },

  async getRuntimeMcpConfig(): Promise<McpConfigResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_CONFIG_CHANNEL)
    return isMcpConfigResult(response) ? response : invalidMcpConfigResponse()
  },

  async inspectRuntimeMcpServers(): Promise<McpInspectionResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_INSPECT_CHANNEL)
    return isMcpInspectionResult(response) ? response : invalidMcpInspectionResponse()
  },

  async abortRuntimeMcpInspection(): Promise<McpInspectAbortResult> {
    const response: unknown = await ipcRenderer.invoke(RUNTIME_MCP_INSPECT_ABORT_CHANNEL)
    return isMcpInspectAbortResult(response) ? response : invalidMcpInspectAbortResponse()
  },

  ackRuntimeProjection(target: RuntimeTarget, seq: number) {
    // 应用确认失败只影响通知窗口，不应产生未处理的拒绝。
    void ipcRenderer
      .invoke(RUNTIME_PROJECTION_ACK_CHANNEL, {
        target: { runId: target.runId, runtimeId: target.runtimeId },
        seq
      })
      .catch(() => undefined)
  },

  onRuntimeStatusChanged(listener: (status: RuntimeStatus) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 事件载荷同样不可信：不符合契约时直接丢弃。
      if (!isRuntimeStatus(payload)) return
      listener(payload)
    }
    ipcRenderer.on(RUNTIME_STATUS_EVENT, handler)
    return () => {
      ipcRenderer.off(RUNTIME_STATUS_EVENT, handler)
    }
  },

  onRuntimeProjectionChanged(listener: (batch: ProjectionBatch) => void) {
    const handler = (_event: IpcRendererEvent, payload: unknown): void => {
      // 批次同样不可信：契约不符时丢弃，序号缺口由快照重同步收敛。
      if (!isProjectionBatch(payload)) return
      listener(payload)
    }
    ipcRenderer.on(RUNTIME_PROJECTION_EVENT, handler)
    return () => {
      ipcRenderer.off(RUNTIME_PROJECTION_EVENT, handler)
    }
  }
} satisfies RuntimeApi
