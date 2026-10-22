/** 生成式界面参数的 IPC：读取、保存与清除本机旁路记录。它与会话正文分开存，可再生产，不作为会话历史的一部分。 */

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopError, DesktopErrorCode } from '../../shared/desktop-api'
import {
  GENUI_PARAMS_CLEAR_CHANNEL,
  GENUI_PARAMS_GET_CHANNEL,
  GENUI_PARAMS_SAVE_CHANNEL,
  isGenuiParamSaveRequest
} from '../../shared/genui-params-api'
import type {
  GenuiParamsClearResult,
  GenuiParamsGetResult,
  GenuiParamsSaveResult
} from '../../shared/genui-params-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { genuiParamStore } from '../services'

/** 界面参数存储失败：码取自共享错误码族，消息可直接展示。 */
export function genuiParamsFailure(
  code: DesktopErrorCode,
  message: string
): { readonly ok: false; readonly error: DesktopError } {
  return { ok: false, error: { code, message } }
}

/**
 * 生成式界面参数取值：读取全量、保存单条、清除全部。
 * 这三项只动本机旁路文件 `genui-params.json`，不读写 Desktop 配置，也不修改 Pi 配置。
 * 失败一律回传错误而不静默吞掉：参数可再生产，但用户需要知道本次调节没存下来。
 */
export function registerGenuiParamHandlers(pageUrl: string): void {
  handle(
    GENUI_PARAMS_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GenuiParamsGetResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return genuiParamsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return genuiParamsFailure('INVALID_REQUEST', '界面参数读取接口不接受参数。')
      }
      try {
        return { ok: true, data: await genuiParamStore.read() }
      } catch (error) {
        return genuiParamsFailure('INTERNAL_ERROR', error instanceof Error ? error.message : '读取界面参数时发生未知错误。')
      }
    }
  )

  handle(
    GENUI_PARAMS_SAVE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GenuiParamsSaveResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return genuiParamsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return genuiParamsFailure('INVALID_REQUEST', '保存界面参数接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isGenuiParamSaveRequest(request)) {
        return genuiParamsFailure('INVALID_REQUEST', '界面参数请求必须包含合法的界面标识，record 为 null 或合法记录对象。')
      }
      try {
        return { ok: true, data: await genuiParamStore.save(request.documentId, request.record) }
      } catch (error) {
        return genuiParamsFailure('INTERNAL_ERROR', error instanceof Error ? error.message : '保存界面参数时发生未知错误。')
      }
    }
  )

  handle(
    GENUI_PARAMS_CLEAR_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GenuiParamsClearResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return genuiParamsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return genuiParamsFailure('INVALID_REQUEST', '清除界面参数接口不接受参数。')
      }
      try {
        return { ok: true, data: { removed: await genuiParamStore.clear() } }
      } catch (error) {
        return genuiParamsFailure('INTERNAL_ERROR', error instanceof Error ? error.message : '清除界面参数时发生未知错误。')
      }
    }
  )
}
