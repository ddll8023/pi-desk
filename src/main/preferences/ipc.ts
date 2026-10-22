/** 界面偏好与快捷命令的 IPC：界面主题与面板偏好、对话页模型展示偏好、快捷发送短语、全局与项目范围快捷命令、扩展自动更新与生成式界面开关。未知字段与非法取值一律拒绝。 */

import type { IpcMainInvokeEvent } from 'electron'
import {
  PREFERENCES_GET_CHANNEL,
  PREFERENCES_SET_UI_CHANNEL,
  PREFERENCES_GET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_SET_MODEL_DISPLAY_CHANNEL,
  PREFERENCES_GET_QUICK_SEND_CHANNEL,
  PREFERENCES_SET_QUICK_SEND_CHANNEL,
  PREFERENCES_GET_AUTO_UPDATE_CHANNEL,
  PREFERENCES_SET_AUTO_UPDATE_CHANNEL,
  PREFERENCES_GET_GENUI_CHANNEL,
  PREFERENCES_SET_GENUI_CHANNEL
} from '../../shared/preferences-api'
import type {
  AutoUpdateResult,
  GenuiResult,
  ModelDisplayResult,
  PreferencesErrorCode,
  PreferencesResult,
  QuickSendResult
} from '../../shared/preferences-api'
import {
  isAutoUpdatePreference,
  isGenuiPreference,
  isUiPreferences,
  isModelDisplayPreference,
  isQuickSendPreference
} from '../../shared/preferences-api'
import {
  QUICK_COMMANDS_GET_CHANNEL,
  QUICK_COMMANDS_SET_CHANNEL,
  isQuickCommandsPreference
} from '../../shared/quick-commands-api'
import type { QuickCommandsResult } from '../../shared/quick-commands-api'
import { handle } from '../ipc/dispatch'
import { isTrustedCaller } from '../ipc/dispatch'
import { preferencesManager } from '../services'
import { applyNativeTheme } from '../window'

export function preferencesFailure(code: PreferencesErrorCode, message: string): PreferencesResult {
  return { ok: false, error: { code, message } }
}

/** 界面偏好、对话页模型展示偏好、快捷发送短语、快捷命令与扩展自动更新开关分开读写；未知字段、任意启动参数一律拒绝。 */
export function registerPreferencesHandlers(pageUrl: string): void {
  handle(
    PREFERENCES_GET_QUICK_SEND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickSendResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '快捷发送短语读取接口不接受参数。' } }
      }
      return preferencesManager.getQuickSend()
    }
  )
  handle(
    PREFERENCES_SET_QUICK_SEND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickSendResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isQuickSendPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '快捷发送短语必须是不超过上限的文本列表。' } }
      }
      return preferencesManager.setQuickSend(args[0])
    }
  )
  handle(
    QUICK_COMMANDS_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickCommandsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '快捷命令读取接口不接受参数。' } }
      }
      return preferencesManager.getQuickCommands()
    }
  )
  handle(
    QUICK_COMMANDS_SET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<QuickCommandsResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isQuickCommandsPreference(args[0])) {
        return {
          ok: false,
          error: {
            code: 'INVALID_REQUEST',
            message: '快捷命令必须是不超过上限的清单，每条含标签、命令文本与合法的范围。'
          }
        }
      }
      return preferencesManager.setQuickCommands(args[0])
    }
  )
  handle(
    PREFERENCES_GET_AUTO_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AutoUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展自动更新开关读取接口不接受参数。' } }
      }
      return preferencesManager.getExtensionAutoUpdate()
    }
  )
  handle(
    PREFERENCES_SET_AUTO_UPDATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<AutoUpdateResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isAutoUpdatePreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '扩展自动更新开关只接受一个布尔值。' } }
      }
      return preferencesManager.setExtensionAutoUpdate(args[0])
    }
  )
  handle(
    PREFERENCES_GET_GENUI_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GenuiResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '生成式 UI 开关读取接口不接受参数。' } }
      }
      return preferencesManager.getGenui()
    }
  )
  handle(
    PREFERENCES_SET_GENUI_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<GenuiResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isGenuiPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '生成式 UI 开关只接受一个布尔值。' } }
      }
      return preferencesManager.setGenui(args[0])
    }
  )
  handle(
    PREFERENCES_GET_MODEL_DISPLAY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelDisplayResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 0) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '对话页模型展示偏好读取接口不接受参数。' } }
      }
      return preferencesManager.getModelDisplay()
    }
  )
  handle(
    PREFERENCES_SET_MODEL_DISPLAY_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ModelDisplayResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return { ok: false, error: { code: 'FORBIDDEN', message: '不允许此页面调用桌面接口。' } }
      }
      if (args.length !== 1 || !isModelDisplayPreference(args[0])) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: '对话页模型展示偏好必须是隐藏模型的列表。' } }
      }
      return preferencesManager.setModelDisplay(args[0])
    }
  )
  handle(
    PREFERENCES_GET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PreferencesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return preferencesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 0) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好读取接口不接受参数。')
      }
      return preferencesManager.get()
    }
  )

  handle(
    PREFERENCES_SET_UI_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<PreferencesResult> => {
      if (!isTrustedCaller(event, pageUrl)) {
        return preferencesFailure('FORBIDDEN', '不允许此页面调用桌面接口。')
      }
      if (args.length !== 1) {
        return preferencesFailure('INVALID_REQUEST', '保存界面偏好接口只接受一个请求对象。')
      }
      const request = args[0]
      if (!isUiPreferences(request)) {
        return preferencesFailure('INVALID_REQUEST', '界面偏好必须包含折叠状态、合法主题、展开的项目路径列表、右侧面板状态与 Markdown 默认视图。')
      }
      const { sidebarCollapsed, theme, expandedProjects, rightPanelOpen, rightPanelWidth, rightPanelTab, markdownDefaultView } = request
      // 主题在参数合法后立即生效：只读降级时同样切换本次运行的主题，与页面本地生效保持一致。
      applyNativeTheme(theme)
      return preferencesManager.setUi({ sidebarCollapsed, theme, expandedProjects, rightPanelOpen, rightPanelWidth, rightPanelTab, markdownDefaultView })
    }
  )
}
