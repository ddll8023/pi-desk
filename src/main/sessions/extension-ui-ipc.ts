/** SDK 扩展交互的 IPC：读取当前运行实例的扩展对话、通知与 widget 快照，并提交用户的互斥应答。一次只展示队首，应答后由宿主推进队列。 */

import { dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  EXTENSION_UI_RESPOND_CHANNEL,
  EXTENSION_UI_STATE_CHANNEL,
  isExtensionDialogResponseInput,
  isExtensionDialogTarget
} from '../../shared/extension-ui-api'
import type {
  ExtensionDialogResponseInput,
  ExtensionUiErrorCode,
  ExtensionUiResult,
  ExtensionUiSnapshot
} from '../../shared/extension-ui-api'
import { handle, isBoundedIdentifier } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { sdkRuntime } from '../services'

export function extensionUiFailure(code: ExtensionUiErrorCode, message: string): ExtensionUiResult {
  return { ok: false, error: { code, message } }
}

/** Extension UI 状态查询与 dialog 响应提交；只接受受控的运行身份、id 与互斥响应形态。
 * 运行实例不存在时状态接口返回空交互；id 不在队列或形态不符按 EXTENSION_DIALOG_NOT_FOUND /
 * INVALID_REQUEST 拒绝，不猜造。
 */
export function registerExtensionUiHandlers(pageUrl: string): void {
  handle(
    EXTENSION_UI_STATE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): ExtensionUiResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return extensionUiFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension UI 状态接口只接受一个运行实例身份。')
      }
      const runId = args[0]
      if (typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension UI 状态接口只接受正整数运行实例身份。')
      }
      return { ok: true, data: sdkRuntime.getExtensionUiSnapshot(runId) }
    }
  )

  handle(
    EXTENSION_UI_RESPOND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ExtensionUiResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return extensionUiFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'target' && key !== 'dialogId' && key !== 'response')) {
        return extensionUiFailure('INVALID_REQUEST', 'Extension 对话响应参数包含未支持的字段。')
      }
      const target = fields.target
      const { dialogId, response } = fields
      if (!isExtensionDialogTarget(target)) {
        return extensionUiFailure('INVALID_REQUEST', '对话响应必须给出运行实例与绑定代际。')
      }
      if (!isBoundedIdentifier(dialogId, 256)) {
        return extensionUiFailure('INVALID_REQUEST', '对话 id 必须是非空且长度受控的字符串。')
      }
      if (!isExtensionDialogResponseInput(response)) {
        return extensionUiFailure('INVALID_REQUEST', '对话响应形态不符合约定。')
      }
      let snapshot: ExtensionUiSnapshot | null = null
      try {
        snapshot = await sdkRuntime.respondExtensionDialog(
          target,
          dialogId,
          response as ExtensionDialogResponseInput
        )
      } catch {
        return extensionUiFailure('INTERNAL_ERROR', '提交 Extension 对话响应时发生未预期的内部错误。')
      }
      if (snapshot === null) {
        return extensionUiFailure('EXTENSION_DIALOG_NOT_FOUND', '该 Extension 对话已结束或不存在。')
      }
      return { ok: true, data: snapshot }
    }
  )
}
