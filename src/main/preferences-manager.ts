/**
 * 界面偏好（侧栏折叠、主题与 Thinking 默认状态）的读写入口：把配置文件存储的读写转换为页面契约。
 *
 * 不直接访问文件，也不管理窗口状态；窗口尺寸与位置由 window-state.ts 独占。读取失败与写入
 * 失败都只回传错误，界面偏好的改动已在页面本地生效，不阻断其他操作，也不新增错误码。
 * IPC 契约与响应校验在 shared/preferences-api.ts，请求参数与调用者校验在 main/index.ts。
 */
import type { PreferencesError, PreferencesResult, UiPreferences } from '../shared/preferences-api'
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

  /** 存储故障与内部错误使用同一错误码，只保留可展示的原因文本。 */
  private failure(error: unknown, fallback: string): { ok: false; error: PreferencesError } {
    if (error instanceof DesktopConfigStorageError) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: error.message } }
    }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }
  }
}
