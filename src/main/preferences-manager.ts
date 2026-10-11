/**
 * 界面偏好、桌面新会话默认模型与对话页模型展示偏好的读写入口：把同一配置存储的独立字段转换为页面契约，不写 Pi 配置。
 *
 * 不直接访问文件，也不管理窗口状态；窗口尺寸与位置由 window-state.ts 独占。读写失败只回传
 * 错误：界面偏好已在页面本地生效，不阻断其他操作；模型选择则在保存成功后提交，调用方在
 * 模型偏好失败时阻止新会话启动。两类偏好共用错误码。
 * IPC 契约与响应校验在 shared/preferences-api.ts，请求参数与调用者校验在 main/index.ts。
 */
import type { ModelDisplayPreference, ModelDisplayResult, ModelPreferenceResult, PreferencesError, PreferencesResult, UiPreferences } from '../shared/preferences-api'
import type { ModelIdentity } from '../shared/runtime-api'
import type { DesktopConfigStore } from './desktop-config-store'
import { DesktopConfigStorageError } from './desktop-config-store'

export interface PreferencesManagerOptions {
  /** 配置文件的唯一读写者；界面偏好与项目、窗口状态共用同一份文件。 */
  readonly store: DesktopConfigStore
}

export class PreferencesManager {
  constructor(private readonly options: PreferencesManagerOptions) {}

  /** 读取界面偏好；失败时页面按默认值展示，不把读取失败当作阻断。 */
  async get(): Promise<PreferencesResult> {
    try {
      return { ok: true, data: await this.options.store.readUiPreferences() }
    } catch (error) {
      return this.failure(error, '读取界面偏好时发生未预期的内部错误。')
    }
  }

  /** 保存界面偏好；返回值是主进程确认后的状态。 */
  async setUi(ui: UiPreferences): Promise<PreferencesResult> {
    try {
      return { ok: true, data: await this.options.store.saveUiPreferences(ui) }
    } catch (error) {
      return this.failure(error, '保存界面偏好时发生未预期的内部错误。')
    }
  }

  /** 读取桌面新会话模型偏好；null 表示跟随 Pi 默认。 */
  async getNewSessionModel(): Promise<ModelPreferenceResult> {
    try {
      return { ok: true, data: await this.options.store.readNewSessionModel() }
    } catch (error) {
      return this.failure(error, '读取新会话默认模型时发生未预期的内部错误。')
    }
  }

  /** 保存只影响桌面新会话，已有会话与 Pi 全局默认均不改变。 */
  async setNewSessionModel(model: ModelIdentity | null): Promise<ModelPreferenceResult> {
    try {
      return { ok: true, data: await this.options.store.saveNewSessionModel(model) }
    } catch (error) {
      return this.failure(error, '保存新会话默认模型时发生未预期的内部错误。')
    }
  }

  /** 读取对话页模型展示偏好；空列表表示全部显示。 */
  async getModelDisplay(): Promise<ModelDisplayResult> {
    try {
      return { ok: true, data: await this.options.store.readModelDisplay() }
    } catch (error) {
      return this.failure(error, '读取对话页模型展示偏好时发生未预期的内部错误。')
    }
  }

  /** 保存对话页模型展示偏好；只影响顶栏切换器，不修改 Pi 配置。 */
  async setModelDisplay(preference: ModelDisplayPreference): Promise<ModelDisplayResult> {
    try {
      return { ok: true, data: await this.options.store.saveModelDisplay(preference) }
    } catch (error) {
      return this.failure(error, '保存对话页模型展示偏好时发生未预期的内部错误。')
    }
  }

  /** 存储故障与内部错误使用同一错误码，只保留可展示的原因文本。 */
  private failure(error: unknown, fallback: string): { ok: false; error: PreferencesError } {
    if (error instanceof DesktopConfigStorageError) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } }
    }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }
  }
}
