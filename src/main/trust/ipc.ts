/** Project Trust 的 IPC：查询当前或指定运行实例归属项目的信任状态，并保存用户的信任决定。 */

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import { TRUST_DECIDE_CHANNEL, TRUST_STATUS_CHANNEL, isTrustDecisionInput } from '../../shared/trust-api'
import type { TrustDecisionResult, TrustStatusResult } from '../../shared/trust-api'
import { TrustManagerError } from './trust-manager'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { trustManager } from '../services'
import { trustProjectOf } from './guards'

export function trustFailure(code: DesktopErrorCode, message: string): TrustStatusResult {
  return { ok: false, error: { code, message } }
}

/** 探测与决定的内部失败按可展示错误返回；不确定的异常收敛为内部错误。 */
export function trustFailureFromError(error: unknown): TrustStatusResult {
  if (error instanceof TrustManagerError) {
    return trustFailure('INVALID_REQUEST', error.message)
  }
  return trustFailure('INTERNAL_ERROR', '读取或保存信任决定时发生未预期的内部错误。')
}

/** Trust 查询与决定接口；目标项目按来源运行实例解析，未登记的身份不接受。 */
export function registerTrustHandlers(pageUrl: string): void {
  handle(
    TRUST_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TrustStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return trustFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      // 允许零参数（当前项目）或一个只含 runId 的请求对象（来源运行实例的归属项目）。
      let runId: unknown
      if (args.length === 1) {
        const request = args[0]
        if (typeof request !== 'object' || request === null || Array.isArray(request)) {
          return trustFailure('INVALID_REQUEST', '信任状态参数格式不正确。')
        }
        const fields = request as Record<string, unknown>
        if (Object.keys(fields).some((key) => key !== 'runId')) {
          return trustFailure('INVALID_REQUEST', '信任状态参数包含未支持的字段。')
        }
        runId = fields.runId
      } else if (args.length !== 0) {
        return trustFailure('INVALID_REQUEST', '信任状态接口只接受零参数或一个请求对象。')
      }
      try {
        return { ok: true, data: await trustManager.statusOf(trustProjectOf(runId)) }
      } catch (error) {
        return trustFailureFromError(error)
      }
    }
  )

  handle(
    TRUST_DECIDE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<TrustDecisionResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return trustFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return trustFailure('INVALID_REQUEST', '信任决定接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return trustFailure('INVALID_REQUEST', '信任决定参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'projectPath' && key !== 'decision' && key !== 'runId')) {
        return trustFailure('INVALID_REQUEST', '信任决定参数包含未支持的字段。')
      }
      const { projectPath, decision, runId } = fields
      if (typeof projectPath !== 'string') {
        return trustFailure('INVALID_REQUEST', '项目目录必须是非空的绝对路径。')
      }
      if (!isTrustDecisionInput(decision)) {
        return trustFailure('INVALID_REQUEST', '信任决定取值只能是 trusted、untrusted 或 unset。')
      }
      const allowedProjectPath = trustProjectOf(runId)
      if (allowedProjectPath === null) {
        return trustFailure('INVALID_REQUEST', '信任决定的目标不是当前项目，也不是已登记运行实例的归属项目。')
      }
      try {
        const normalizedDecision: 'trusted' | 'untrusted' | null = decision === 'unset' ? null : decision
        const status = await trustManager.decide(projectPath, normalizedDecision, allowedProjectPath)
        return { ok: true, data: status }
      } catch (error) {
        return trustFailureFromError(error)
      }
    }
  )
}
