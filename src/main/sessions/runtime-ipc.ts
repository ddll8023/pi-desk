/** 会话执行主链的 IPC：状态查询、中止、回退、可用模型与切换、手动压缩、Prompt 提交、投影快照与确认。目标身份、绑定代际与会话归属全部由主进程核对，页面不能指定任意会话文件或 Pi 条目；历史读取走会话通道。 */

import type { IpcMainInvokeEvent } from 'electron'
import {
  RUNTIME_ABORT_CHANNEL,
  RUNTIME_CAPABILITIES_CHANNEL,
  RUNTIME_COMPACT_CHANNEL,
  RUNTIME_SET_MODEL_CHANNEL,
  RUNTIME_PROMPT_CHANNEL,
  RUNTIME_REWIND_CHANNEL,
  RUNTIME_PROJECTION_ACK_CHANNEL,
  RUNTIME_PROJECTION_CHANNEL,
  RUNTIME_STATUS_CHANNEL,
  isRuntimeCompactRequest,
  isRuntimeSetModelRequest,
  isRuntimeRewindRequest,
  isRuntimeTarget
} from '../../shared/runtime-api'
import type {
  CapabilitiesResult,
  ProjectionResult,
  PromptImageInput,
  PromptResult,
  RuntimeErrorCode,
  RuntimeResult,
  RuntimeRewindResult
} from '../../shared/runtime-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { sdkRuntime } from '../services'

export function runtimeFailure(code: RuntimeErrorCode, message: string): RuntimeResult {
  return { ok: false, error: { code, message } }
}

export function promptFailure(code: RuntimeErrorCode, message: string): PromptResult {
  return { ok: false, error: { code, message } }
}

export function projectionFailure(code: RuntimeErrorCode, message: string): ProjectionResult {
  return { ok: false, error: { code, message } }
}

export function capabilitiesFailure(code: RuntimeErrorCode, message: string): CapabilitiesResult {
  return { ok: false, error: { code, message } }
}

export function registerRuntimeHandlers(pageUrl: string): void {
  handle(RUNTIME_STATUS_CHANNEL, (event: IpcMainInvokeEvent, ...args: unknown[]): RuntimeResult => {
    if (!isTrustedCaller(event, pageUrl)) {
      return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
    }
    if (args.length !== 0) {
      return runtimeFailure('INVALID_REQUEST', 'Runtime 状态接口不接受参数。')
    }
    return sdkRuntime.getStatus()
  })

  /** 中止目标运行实例的当前操作；只接受受校验的二维目标，运行状态仍以事件流为准。 */
  handle(
    RUNTIME_ABORT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '中止操作只接受运行实例与绑定代际。')
      }
      return sdkRuntime.abort(args[0])
    }
  )

  /** 回退目标只接受受校验的身份，不接受文件路径或任意 Pi 命令。 */
  handle(
    RUNTIME_REWIND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeRewindResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isRuntimeRewindRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '回退只接受运行实例、Runtime、会话与消息身份。' } }
      }
      return sdkRuntime.rewind(args[0])
    }
  )

  /** 可用模型读取只查询目标运行实例的当前绑定代际，不接受其他参数。 */
  handle(
    RUNTIME_CAPABILITIES_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<CapabilitiesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return capabilitiesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return capabilitiesFailure('INVALID_REQUEST', '能力读取只接受运行实例与绑定代际。')
      }
      return sdkRuntime.readCapabilities(args[0])
    }
  )

  /** 模型切换只接受明确运行实例、代际与模型身份；运行条件由 Runtime 所有者再次检查。 */
  handle(
    RUNTIME_SET_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeSetModelRequest(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '模型切换只接受运行实例、Runtime 代际、供应商和模型 ID。')
      }
      return sdkRuntime.setModel(args[0])
    }
  )

  /** 手动压缩只接受受校验的目标身份与有界说明文本；摘要内容不在请求里传递。 */
  handle(
    RUNTIME_COMPACT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<RuntimeResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return runtimeFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeCompactRequest(args[0])) {
        return runtimeFailure('INVALID_REQUEST', '压缩只接受运行实例、Runtime 代际、会话身份与可选说明文本。')
      }
      return sdkRuntime.compact(args[0])
    }
  )

  /** 只接受运行目标、Prompt 文本与图片附件；不接受可执行文件路径、启动参数或排队选项。 */
  handle(
    RUNTIME_PROMPT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PromptResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return promptFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 接口只接受一个消息对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'message' && key !== 'images')) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 参数包含未支持的字段。')
      }
      const target = fields.target
      if (!isRuntimeTarget(target)) {
        return promptFailure('INVALID_REQUEST', '提交 Prompt 必须给出运行实例与绑定代际。')
      }
      const message = fields.message
      if (typeof message !== 'string') {
        return promptFailure('INVALID_REQUEST', 'Prompt 内容必须是字符串。')
      }
      // 图片附件逐字段校验后重建：name 受控，mimeType 与 data 只接受字符串；其他字段丢弃。
      const images: PromptImageInput[] = []
      if (fields.images !== undefined) {
        if (!Array.isArray(fields.images) || fields.images.length > 4) {
          return promptFailure('INVALID_REQUEST', '图片附件必须是数量受控的数组。')
        }
        for (const entry of fields.images) {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            return promptFailure('INVALID_REQUEST', '图片附件格式不正确。')
          }
          const item = entry as Record<string, unknown>
          if (Object.keys(item).some((key) => key !== 'name' && key !== 'mimeType' && key !== 'data')) {
            return promptFailure('INVALID_REQUEST', '图片附件包含未支持的字段。')
          }
          if (typeof item.name !== 'string' || item.name === '' || item.name.length > 256) {
            return promptFailure('INVALID_REQUEST', '图片文件名必须是非空且长度受控的字符串。')
          }
          if (typeof item.mimeType !== 'string' || item.mimeType === '' || item.mimeType.length > 64) {
            return promptFailure('INVALID_REQUEST', '图片 MIME 类型必须是长度受控的字符串。')
          }
          if (typeof item.data !== 'string' || item.data === '') {
            return promptFailure('INVALID_REQUEST', '图片数据必须是非空字符串。')
          }
          images.push({ name: item.name, mimeType: item.mimeType, data: item.data })
        }
      }
      return sdkRuntime.prompt(target, message, images)
    }
  )

  /** 投影快照只读取目标实例绑定代际的投影；目标不成立或未绑定时由后端给出结果，不伪造空投影。 */
  handle(
    RUNTIME_PROJECTION_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ProjectionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return projectionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isRuntimeTarget(args[0])) {
        return projectionFailure('INVALID_REQUEST', '投影快照接口只接受运行实例与绑定代际。')
      }
      return sdkRuntime.getProjection(args[0])
    }
  )

  /** 应用确认只控制未确认通知窗口；参数不合法时忽略，不回传结果。 */
  handle(
    RUNTIME_PROJECTION_ACK_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): void => {
      if (!isTrustedCaller(event, pageUrl) || args.length !== 1) return
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'seq')) return
      const target = fields.target
      const { seq } = fields
      if (!isRuntimeTarget(target)) return
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return
      sdkRuntime.ackProjection(target, seq)
    }
  )
}
