/**
 * 界面偏好、对话页模型展示偏好、快捷发送短语、快捷命令与扩展自动更新开关的读写入口：
 * 把同一配置存储的独立字段转换为页面契约，不写 Pi 配置。
 * 界面偏好含侧栏折叠状态、主题、侧栏展开的项目路径列表与右侧面板的开合状态、宽度和当前页签，作为一份载荷整体保存与读取。
 *
 * 不直接访问文件，也不管理窗口状态；窗口尺寸与位置由 window-state.ts 独占。读写失败只回传
 * 错误：界面偏好已在页面本地生效，不阻断其他操作；模型展示偏好、快捷发送短语、快捷命令与扩展自动更新开关则在保存成功后提交。
 * 五类偏好共用错误码。
 * IPC 契约与响应校验在 shared/preferences-api.ts，请求参数与调用者校验在 main/index.ts。
 */
import type { AutoUpdatePreference, AutoUpdateResult, ModelDisplayPreference, ModelDisplayResult, PreferencesError, PreferencesResult, QuickSendPreference, QuickSendResult, UiPreferences } from '../shared/preferences-api'
import type { QuickCommandsPreference, QuickCommandsResult } from '../shared/quick-commands-api'
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

  /** 读取对话页模型展示偏好；空列表表示全部显示。 */
  async getModelDisplay(): Promise<ModelDisplayResult> {
    try {
      return { ok: true, data: await this.options.store.readModelDisplay() }
    } catch (error) {
      return this.failure(error, '读取对话页模型展示偏好时发生未预期的内部错误。')
    }
  }

  /** 保存对话页模型展示偏好；只影响输入坞模型选择器，不修改 Pi 配置。 */
  async setModelDisplay(preference: ModelDisplayPreference): Promise<ModelDisplayResult> {
    try {
      return { ok: true, data: await this.options.store.saveModelDisplay(preference) }
    } catch (error) {
      return this.failure(error, '保存对话页模型展示偏好时发生未预期的内部错误。')
    }
  }

  /** 读取快捷发送短语；缺失或非法时为默认列表。 */
  async getQuickSend(): Promise<QuickSendResult> {
    try {
      return { ok: true, data: await this.options.store.readQuickSend() }
    } catch (error) {
      return this.failure(error, '读取快捷发送短语时发生未预期的内部错误。')
    }
  }

  /** 保存快捷发送短语；返回存储层规范化后的列表，只影响输入坞的下拉候选。 */
  async setQuickSend(preference: QuickSendPreference): Promise<QuickSendResult> {
    try {
      return { ok: true, data: await this.options.store.saveQuickSend(preference) }
    } catch (error) {
      return this.failure(error, '保存快捷发送短语时发生未预期的内部错误。')
    }
  }

  /**
   * 读取快捷命令清单；缺失或非法条目已在存储层过滤。
   * 全局与项目范围用同一个清单表达，页面自己按当前项目筛选，因此这里只有一次读取。
   */
  async getQuickCommands(): Promise<QuickCommandsResult> {
    try {
      return { ok: true, data: await this.options.store.readQuickCommands() }
    } catch (error) {
      return this.failure(error, '读取快捷命令时发生未预期的内部错误。')
    }
  }

  /** 保存快捷命令清单；返回存储层规范化后的清单，只影响菜单与设置页。 */
  async setQuickCommands(preference: QuickCommandsPreference): Promise<QuickCommandsResult> {
    try {
      return { ok: true, data: await this.options.store.saveQuickCommands(preference) }
    } catch (error) {
      return this.failure(error, '保存快捷命令时发生未预期的内部错误。')
    }
  }

  /**
   * 读取扩展自动更新开关；缺失或非法时为关闭。
   * 主进程启动检查完成后按它决定要不要自动执行一次扩展更新，因此这里同时给页面与启动流程用。
   */
  async getExtensionAutoUpdate(): Promise<AutoUpdateResult> {
    try {
      return { ok: true, data: await this.options.store.readExtensionAutoUpdate() }
    } catch (error) {
      return this.failure(error, '读取扩展自动更新开关时发生未预期的内部错误。')
    }
  }

  /** 保存扩展自动更新开关；只改本应用启动时的行为，不写 Pi 配置。 */
  async setExtensionAutoUpdate(preference: AutoUpdatePreference): Promise<AutoUpdateResult> {
    try {
      return { ok: true, data: await this.options.store.saveExtensionAutoUpdate(preference) }
    } catch (error) {
      return this.failure(error, '保存扩展自动更新开关时发生未预期的内部错误。')
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
