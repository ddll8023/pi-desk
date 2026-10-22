/** 界面偏好、快捷输入与快捷命令：preload 的 preferences 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { PREFERENCES_GET_CHANNEL, PREFERENCES_SET_UI_CHANNEL, PREFERENCES_GET_MODEL_DISPLAY_CHANNEL, PREFERENCES_SET_MODEL_DISPLAY_CHANNEL, PREFERENCES_GET_QUICK_SEND_CHANNEL, PREFERENCES_SET_QUICK_SEND_CHANNEL, PREFERENCES_GET_AUTO_UPDATE_CHANNEL, PREFERENCES_SET_AUTO_UPDATE_CHANNEL, PREFERENCES_GET_GENUI_CHANNEL, PREFERENCES_SET_GENUI_CHANNEL, isPreferencesResult, isModelDisplayResult, isQuickSendResult, isAutoUpdateResult, isGenuiResult } from '../shared/preferences-api'
import { QUICK_COMMANDS_GET_CHANNEL, QUICK_COMMANDS_SET_CHANNEL, isQuickCommandsResult } from '../shared/quick-commands-api'
import type { AutoUpdatePreference, AutoUpdateResult, GenuiPreference, GenuiResult, ModelDisplayPreference, ModelDisplayResult, PreferencesResult, QuickSendPreference, QuickSendResult, UiPreferences } from '../shared/preferences-api'
import type { QuickCommand, QuickCommandsPreference, QuickCommandsResult } from '../shared/quick-commands-api'
import type { PreferencesApi } from '../shared/preferences-api'
import type { QuickCommandsApi } from '../shared/quick-commands-api'

const INVALID_PREFERENCES_RESPONSE = '桌面接口返回了无法识别的界面偏好。'
const INVALID_MODEL_DISPLAY_RESPONSE = '桌面接口返回了无法识别的对话页模型展示偏好。'
const INVALID_QUICK_SEND_RESPONSE = '桌面接口返回了无法识别的快捷发送短语。'
const INVALID_QUICK_COMMANDS_RESPONSE = '桌面接口返回了无法识别的快捷命令清单。'
const INVALID_AUTO_UPDATE_RESPONSE = '桌面接口返回了无法识别的扩展自动更新开关。'
const INVALID_GENUI_RESPONSE = '桌面接口返回了无法识别的生成式 UI 开关。'

function invalidPreferencesResponse(): PreferencesResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PREFERENCES_RESPONSE } }
}

function invalidModelDisplayResponse(): ModelDisplayResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_MODEL_DISPLAY_RESPONSE } }
}

function invalidQuickSendResponse(): QuickSendResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_QUICK_SEND_RESPONSE } }
}

function invalidAutoUpdateResponse(): AutoUpdateResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_AUTO_UPDATE_RESPONSE } }
}

function invalidGenuiResponse(): GenuiResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_GENUI_RESPONSE } }
}

function invalidQuickCommandsResponse(): QuickCommandsResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_QUICK_COMMANDS_RESPONSE } }
}

export const preferencesApi = {
  async getPreferences() {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_CHANNEL)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  },

  async getModelDisplay(): Promise<ModelDisplayResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_MODEL_DISPLAY_CHANNEL)
    return isModelDisplayResult(response) ? response : invalidModelDisplayResponse()
  },

  async setModelDisplay(preference: ModelDisplayPreference): Promise<ModelDisplayResult> {
    // 只搬运已声明的字段，并重建普通对象与数组，避免响应式代理跨 contextBridge。
    const payload: ModelDisplayPreference = {
      hiddenModels: preference.hiddenModels.map((model) => ({ provider: model.provider, modelId: model.modelId }))
    }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_MODEL_DISPLAY_CHANNEL, payload)
    return isModelDisplayResult(response) ? response : invalidModelDisplayResponse()
  },

  async getQuickSend(): Promise<QuickSendResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_QUICK_SEND_CHANNEL)
    return isQuickSendResult(response) ? response : invalidQuickSendResponse()
  },

  async setQuickSend(preference: QuickSendPreference): Promise<QuickSendResult> {
    // 只搬运已声明的字段，并重建普通数组，避免响应式代理跨 contextBridge。
    const payload: QuickSendPreference = { messages: [...preference.messages] }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_QUICK_SEND_CHANNEL, payload)
    return isQuickSendResult(response) ? response : invalidQuickSendResponse()
  },

  async getAutoUpdate(): Promise<AutoUpdateResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_AUTO_UPDATE_CHANNEL)
    return isAutoUpdateResult(response) ? response : invalidAutoUpdateResponse()
  },

  async getQuickCommands(): Promise<QuickCommandsResult> {
    const response: unknown = await ipcRenderer.invoke(QUICK_COMMANDS_GET_CHANNEL)
    return isQuickCommandsResult(response) ? response : invalidQuickCommandsResponse()
  },

  async setQuickCommands(preference: QuickCommandsPreference): Promise<QuickCommandsResult> {
    // 只搬运已声明的字段，并逐条重建普通对象，避免响应式代理跨 contextBridge。
    const payload: QuickCommandsPreference = {
      commands: preference.commands.map((command): QuickCommand => ({
        id: command.id,
        label: command.label,
        command: command.command,
        appendEnter: command.appendEnter === true,
        scope: command.scope,
        projectPath: command.projectPath
      }))
    }
    const response: unknown = await ipcRenderer.invoke(QUICK_COMMANDS_SET_CHANNEL, payload)
    return isQuickCommandsResult(response) ? response : invalidQuickCommandsResponse()
  },

  async setAutoUpdate(preference: AutoUpdatePreference): Promise<AutoUpdateResult> {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const payload: AutoUpdatePreference = { enabled: preference.enabled === true }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_AUTO_UPDATE_CHANNEL, payload)
    return isAutoUpdateResult(response) ? response : invalidAutoUpdateResponse()
  },

  async getGenui(): Promise<GenuiResult> {
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_GET_GENUI_CHANNEL)
    return isGenuiResult(response) ? response : invalidGenuiResponse()
  },

  async setGenui(preference: GenuiPreference): Promise<GenuiResult> {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const payload: GenuiPreference = { enabled: preference.enabled === true }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_GENUI_CHANNEL, payload)
    return isGenuiResult(response) ? response : invalidGenuiResponse()
  },

  async setUiPreferences(ui: UiPreferences) {
    // 只搬运已声明的字段，不把页面传入的整个对象转交给主进程。
    const request: UiPreferences = {
      sidebarCollapsed: ui.sidebarCollapsed,
      theme: ui.theme,
      expandedProjects: [...ui.expandedProjects],
      rightPanelOpen: ui.rightPanelOpen,
      rightPanelWidth: ui.rightPanelWidth,
      rightPanelTab: ui.rightPanelTab,
      markdownDefaultView: ui.markdownDefaultView
    }
    const response: unknown = await ipcRenderer.invoke(PREFERENCES_SET_UI_CHANNEL, request)
    return isPreferencesResult(response) ? response : invalidPreferencesResponse()
  }
} satisfies PreferencesApi & QuickCommandsApi
