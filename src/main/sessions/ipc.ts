/** 会话与运行实例的 IPC：会话列表、打开、重载、删除，以及应用级运行清单查询、释放与结束。删除会话前先按登记占用收敛实例；关闭标签与删除会话是不同动作。 */

import type { IpcMainInvokeEvent } from 'electron'
import {
  SESSION_DELETE_CHANNEL,
  SESSION_LIST_CHANNEL,
  SESSION_OPEN_CHANNEL,
  SESSION_RELOAD_CHANNEL,
  isSessionDeleteRequest,
  isSessionListRequest,
  isSessionOpenRequest,
  isSessionListWindow
} from '../../shared/session-api'
import type {
  SessionDeleteResult,
  SessionErrorCode,
  SessionListResult,
  SessionOpenResult
} from '../../shared/session-api'
import {
  SESSION_RUNS_STATE_CHANNEL,
  SESSION_RUN_RELEASE_CHANNEL,
  SESSION_RUN_CLOSE_CHANNEL,
  isSessionRunReleaseRequest
} from '../../shared/session-run-api'
import type { SessionRunReleaseResult, SessionRunsResult } from '../../shared/session-run-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { sessionManager, trustManager, sdkRuntime, resolveRegisteredProjectPath } from '../services'

export function sessionFailure(code: SessionErrorCode, message: string): Extract<SessionListResult, { ok: false }> {
  return { ok: false, error: { code, message } }
}

/** 运行状态查询失败只回到通用分类：不把实例内部结构暴露给页面。 */
export function sessionRunsFailure(code: 'FORBIDDEN' | 'INVALID_REQUEST' | 'INTERNAL_ERROR', message: string): SessionRunsResult {
  return { ok: false, error: { code, message } }
}

/** 会话列表、打开、重载与删除通道：参数白名单校验后转调会话编排层；新会话的默认模型由 Pi 自己的 settings.json 决定，会话归属与文件解析由主进程完成。 */
export function registerSessionHandlers(pageUrl: string): void {
  handle(
    SESSION_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionListResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      // 侧栏按项目树展示会话：列表必须显式给出项目路径与窗口大小，主进程只接受已添加项目。
      if (args.length !== 1) {
        return sessionFailure('INVALID_REQUEST', '会话列表接口只接受一个项目路径与窗口大小请求对象。')
      }
      const request = args[0]
      if (!isSessionListRequest(request)) {
        return sessionFailure('INVALID_REQUEST', '会话列表接口只接受一个项目路径与窗口大小请求对象。')
      }
      return sessionManager.list(request.projectPath, request.limit)
    }
  )

  handle(
    SESSION_OPEN_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionOpenResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isSessionOpenRequest(args[0])) {
        return sessionFailure('INVALID_REQUEST', '打开会话必须给出项目、会话身份、中断确认和列表窗口。')
      }
      const request = args[0]
      const projectPath = await resolveRegisteredProjectPath(request.projectPath)
      if (projectPath === null) return sessionFailure('INVALID_PROJECT_PATH', '会话所属项目未登记或已被移除。')
      const trust = await trustManager.resolveLaunchDecision(projectPath)
      if (trust.requiresPrompt) {
        return sessionFailure('TRUST_REQUIRED', '该项目包含需要信任决定的资源。')
      }
      return sessionManager.open({ ...request, projectPath })
    }
  )

  /** 重新加载 Pi 资源：在目标会话所属实例内重建该会话的 services，并尽量恢复当前会话；
   * 只接受显式中断确认；打开方式仍按前台项目拦截信任，重载按被重载会话的归属项目在编排层复核。 */
  handle(
    SESSION_RELOAD_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionOpenResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'allowInterrupt' && key !== 'listLimit')) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源参数包含未支持的字段。')
      }
      if (typeof fields.allowInterrupt !== 'boolean') {
        return sessionFailure('INVALID_REQUEST', '重新加载资源必须显式说明是否允许中断当前操作。')
      }
      if (!isSessionListWindow(fields.listLimit)) {
        return sessionFailure('INVALID_REQUEST', '重新加载资源必须显式给出合法的列表窗口大小。')
      }
      return sessionManager.reload(fields.allowInterrupt, fields.listLimit)
    }
  )

  /** 删除会话：只接受显式项目路径、会话 id 与中断确认；归属与占用收敛都在编排层完成。 */
  handle(
    SESSION_DELETE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionDeleteResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isSessionDeleteRequest(args[0])) {
        return sessionFailure('INVALID_REQUEST', '删除会话接口只接受一个包含项目路径、会话 id、中断确认与列表窗口的请求对象。')
      }
      return sessionManager.delete(args[0])
    }
  )
}

/** 运行实例状态查询、释放与结束：都只操作注册表登记与宿主生命周期，不删除任何会话历史。 */
export function registerSessionRunHandlers(pageUrl: string): void {
  handle(
    SESSION_RUNS_STATE_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): SessionRunsResult => {
      if (!isTrustedCaller(event, pageUrl)) {
        return sessionRunsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return sessionRunsFailure('INVALID_REQUEST', '运行状态接口不接受参数。')
      }
      return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
    }
  )

  handle(
    SESSION_RUN_RELEASE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionRunReleaseResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isSessionRunReleaseRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '释放运行实例只接受一个运行实例身份。' } }
      }
      try {
        // 不中断在途工作：释放只在确实可释放时生效，未确认时占用保留并由错误如实报告。
        const result = await sdkRuntime.releaseRun(args[0].runId, false)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '释放运行实例时发生未预期的内部错误。' } }
      }
    }
  )

  handle(
    SESSION_RUN_CLOSE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<SessionRunReleaseResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isSessionRunReleaseRequest(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '结束运行实例只接受一个运行实例身份。' } }
      }
      try {
        // 结束包含中断：页面已在关闭标签时表达了结束意图，未确认时占用保留并由错误如实报告。
        const result = await sdkRuntime.closeRun(args[0].runId)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { runs: sdkRuntime.listRunStates() } }
      } catch {
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: '结束运行实例时发生未预期的内部错误。' } }
      }
    }
  )
}
