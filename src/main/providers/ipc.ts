/** 供应商与认证的 IPC：认证状态、云端模型目录刷新与登录流程（开始、应答、取消、打开授权地址、退出）、自定义供应商配置读写、Pi 默认模型读写。密钥只经登录应答单向提交，之后不保留任何副本。 */

import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import {
  AUTH_LOGIN_CANCEL_CHANNEL,
  AUTH_LOGIN_RESPOND_CHANNEL,
  AUTH_LOGIN_START_CHANNEL,
  AUTH_LOGOUT_CHANNEL,
  AUTH_MAX_FLOW_ID_CHARS,
  AUTH_MAX_PROVIDER_ID_CHARS,
  AUTH_MAX_SECRET_CHARS,
  AUTH_OPEN_URL_CHANNEL,
  AUTH_REFRESH_MODELS_CHANNEL,
  AUTH_STATUS_CHANNEL,
  isAuthLoginRespondRequest,
  isAuthLoginStartRequest,
  isAuthRefreshModelsRequest
} from '../../shared/auth-api'
import type {
  AuthErrorCode,
  AuthFlowResult,
  AuthLogoutResult,
  AuthRefreshModelsRequest,
  AuthRefreshModelsResult,
  AuthStatusResult
} from '../../shared/auth-api'
import {
  MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
  MODELS_CONFIG_GET_CHANNEL,
  MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
  isModelsConfigDeleteRequest,
  isModelsConfigSaveRequest
} from '../../shared/models-config-api'
import type { ModelsConfigErrorCode, ModelsConfigResult } from '../../shared/models-config-api'
import {
  PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL,
  PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL,
  isPiDefaultModelSetRequest
} from '../../shared/pi-settings-api'
import type { PiDefaultModelResult } from '../../shared/pi-settings-api'
import { ModelsConfigError } from './models-config-manager'
import { PiSettingsError } from './pi-settings-manager'
import { handle, isBoundedIdentifier } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { AuthManagerError } from './auth-manager'
import { authManager, modelsConfigManager, piSettingsManager } from '../services'

export function modelsConfigFailure(code: ModelsConfigErrorCode, message: string): ModelsConfigResult {
  return { ok: false, error: { code, message } }
}

/** 读写失败统一映射：已知错误保留自己的错误码与结论文本，其余按内部错误处理。 */
export function modelsConfigFailureOf(error: unknown, fallback: string): ModelsConfigResult {
  if (error instanceof ModelsConfigError) return modelsConfigFailure(error.code, error.message)
  return modelsConfigFailure('INTERNAL_ERROR', fallback)
}

export function piDefaultModelFailure(code: DesktopErrorCode, message: string): PiDefaultModelResult {
  return { ok: false, error: { code, message } }
}

/** 读写失败统一映射：已知错误保留自己的错误码与结论文本，其余按内部错误处理。 */
export function piDefaultModelFailureOf(error: unknown, fallback: string): PiDefaultModelResult {
  if (error instanceof PiSettingsError) return piDefaultModelFailure(error.code, error.message)
  return piDefaultModelFailure('INTERNAL_ERROR', fallback)
}

/** 认证操作失败统一映射为共享契约的错误码；未知异常不向外暴露内部细节。 */
export function authErrorOf(error: unknown): { readonly code: AuthErrorCode; readonly message: string; readonly detail: string | null } {
  if (error instanceof AuthManagerError) {
    return { code: error.code, message: error.message, detail: error.detail }
  }
  return { code: 'INTERNAL_ERROR', message: '认证操作失败，请重试。', detail: null }
}

export function authStatusFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthStatusResult {
  return { ok: false, error: { code, message, detail } }
}

export function authFlowFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthFlowResult {
  return { ok: false, error: { code, message, detail } }
}

export function authLogoutFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthLogoutResult {
  return { ok: false, error: { code, message, detail } }
}

export function authRefreshModelsFailure(code: AuthErrorCode, message: string, detail: string | null = null): AuthRefreshModelsResult {
  return { ok: false, error: { code, message, detail } }
}

/** Pi 默认模型（settings.json）的读写；零参读取，写入只接受一个合法模型身份。 */
export function registerPiSettingsHandlers(pageUrl: string): void {
  handle(
    PI_SETTINGS_GET_DEFAULT_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PiDefaultModelResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return piDefaultModelFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return piDefaultModelFailure('INVALID_REQUEST', 'Pi 默认模型读取接口不接受参数。')
      }
      try {
        return { ok: true, data: await piSettingsManager.getDefaultModel() }
      } catch (error) {
        return piDefaultModelFailureOf(error, '读取 Pi 默认模型时发生未预期的内部错误。')
      }
    }
  )
  handle(
    PI_SETTINGS_SET_DEFAULT_MODEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PiDefaultModelResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return piDefaultModelFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1 || !isPiDefaultModelSetRequest(args[0])) {
        return piDefaultModelFailure('INVALID_REQUEST', 'Pi 默认模型必须是包含供应商与模型 ID 的合法身份。')
      }
      const model = args[0]
      try {
        return { ok: true, data: await piSettingsManager.setDefaultModel(model) }
      } catch (error) {
        return piDefaultModelFailureOf(error, '保存 Pi 默认模型时发生未预期的内部错误。')
      }
    }
  )
}

/**
 * 第三方自定义供应商（Pi 的 models.json）：读取快照、按单个条目新增或替换、删除条目。
 * 页面只能提交一个供应商条目的 JSON 文本，不能指定文件路径、不能整体替换文件；
 * 真实密钥不回传，页面看到的是哨兵文本，保存时由主进程按位置还原。
 */
export function registerModelsConfigHandlers(pageUrl: string): void {
  handle(
    MODELS_CONFIG_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return modelsConfigFailure('INVALID_REQUEST', '自定义供应商读取接口不接受参数。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.getSnapshot() }
      } catch (error) {
        return modelsConfigFailureOf(error, '读取自定义供应商配置时发生未预期的内部错误。')
      }
    }
  )

  handle(
    MODELS_CONFIG_SAVE_PROVIDER_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return modelsConfigFailure('INVALID_REQUEST', '保存自定义供应商接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isModelsConfigSaveRequest(request)) {
        return modelsConfigFailure('INVALID_REQUEST', '保存自定义供应商需要且只需要 providerId 与 json 两个字段。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.saveProvider(request.providerId, request.json) }
      } catch (error) {
        return modelsConfigFailureOf(error, '保存自定义供应商时发生未预期的内部错误。')
      }
    }
  )

  handle(
    MODELS_CONFIG_DELETE_PROVIDER_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelsConfigResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return modelsConfigFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return modelsConfigFailure('INVALID_REQUEST', '删除自定义供应商接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isModelsConfigDeleteRequest(request)) {
        return modelsConfigFailure('INVALID_REQUEST', '删除自定义供应商需要且只需要 providerId 一个字段。')
      }
      try {
        return { ok: true, data: await modelsConfigManager.deleteProvider(request.providerId) }
      } catch (error) {
        return modelsConfigFailureOf(error, '删除自定义供应商时发生未预期的内部错误。')
      }
    }
  )
}

/**
 * 认证状态读取、Provider 登录流程（API Key 与 OAuth）、退出登录与外链打开。
 * 登录流程与密钥只经固定业务方法传递：页面不能指定辅助进程路径、命令文本或要打开的 URL。
 */
export function registerAuthHandlers(pageUrl: string): void {
  handle(
    AUTH_STATUS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthStatusResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authStatusFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return authStatusFailure('INVALID_REQUEST', '认证状态接口不接受参数。')
      }
      try {
        return { ok: true, data: await authManager.readStatus() }
      } catch (error) {
        const failure = authErrorOf(error)
        return authStatusFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_START_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '启动登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'providerId' && key !== 'method')) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数包含未支持的字段。')
      }
      if (!isAuthLoginStartRequest(request)) {
        return authFlowFailure('INVALID_REQUEST', '启动登录参数必须包含 providerId 与 method。')
      }
      if (!isBoundedIdentifier(request.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'Provider 名称必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.beginLogin(request.providerId, request.method) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_RESPOND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId' && key !== 'promptId' && key !== 'value')) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数包含未支持的字段。')
      }
      if (!isAuthLoginRespondRequest(request)) {
        return authFlowFailure('INVALID_REQUEST', '回应认证提示参数必须包含 flowId、promptId 与 value。')
      }
      // 密钥长度在这里先拦一次；取值合法性（如 select 候选）由主进程的认证管理再次校验。
      if (request.value.length > AUTH_MAX_SECRET_CHARS) {
        return authFlowFailure('INVALID_REQUEST', `输入超过 ${AUTH_MAX_SECRET_CHARS} 字符上限。`)
      }
      try {
        return {
          ok: true,
          data: await authManager.respondPrompt(request.flowId, request.promptId, request.value)
        }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGIN_CANCEL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '取消登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '取消登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId')) {
        return authFlowFailure('INVALID_REQUEST', '取消登录参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.flowId, AUTH_MAX_FLOW_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'flowId 必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.cancelLogin(fields.flowId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_OPEN_URL_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthFlowResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authFlowFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'flowId')) {
        return authFlowFailure('INVALID_REQUEST', '打开授权地址参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.flowId, AUTH_MAX_FLOW_ID_CHARS)) {
        return authFlowFailure('INVALID_REQUEST', 'flowId 必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.openFlowUrl(fields.flowId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authFlowFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_LOGOUT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthLogoutResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authLogoutFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录接口只接受一个请求对象。')
      }
      const request = args[0]
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录参数格式不正确。')
      }
      const fields = request as Record<string, unknown>
      if (Object.keys(fields).some((key) => key !== 'providerId')) {
        return authLogoutFailure('INVALID_REQUEST', '退出登录参数包含未支持的字段。')
      }
      if (!isBoundedIdentifier(fields.providerId, AUTH_MAX_PROVIDER_ID_CHARS)) {
        return authLogoutFailure('INVALID_REQUEST', 'Provider 名称必须是非空且长度受控的字符串。')
      }
      try {
        return { ok: true, data: await authManager.logout(fields.providerId) }
      } catch (error) {
        const failure = authErrorOf(error)
        return authLogoutFailure(failure.code, failure.message)
      }
    }
  )

  handle(
    AUTH_REFRESH_MODELS_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AuthRefreshModelsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return authRefreshModelsFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length > 1 || (args.length === 1 && !isAuthRefreshModelsRequest(args[0]))) {
        return authRefreshModelsFailure('INVALID_REQUEST', '刷新模型参数格式不正确。')
      }
      const request = (args[0] as AuthRefreshModelsRequest | undefined) ?? {}
      try {
        const data = await authManager.refreshModels(request.providerId)
        return { ok: true, data }
      } catch (error) {
        const failure = authErrorOf(error)
        return authRefreshModelsFailure(failure.code, failure.message, failure.detail)
      }
    }
  )
}
