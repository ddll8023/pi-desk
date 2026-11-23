/** 能力插件清单：preload 的 plugins 域，只经固定 channel 与主进程通信，载荷与响应在此重建与校验。 */

import { ipcRenderer } from 'electron'
import { PLUGIN_LIST_CHANNEL, PLUGIN_TOGGLE_CHANNEL, isPluginListResult } from '../shared/plugin-api'
import type { PluginApi, PluginListResult } from '../shared/plugin-api'

const INVALID_PLUGIN_RESPONSE = '桌面接口返回了无法识别的插件清单。'

function invalidPluginResponse(): PluginListResult {
  return { ok: false, error: { code: 'INVALID_RESPONSE', message: INVALID_PLUGIN_RESPONSE } }
}

export const pluginsApi = {
  async listPlugins() {
    const response: unknown = await ipcRenderer.invoke(PLUGIN_LIST_CHANNEL)
    return isPluginListResult(response) ? response : invalidPluginResponse()
  },

  async setPluginEnabled(id: string, enabled: boolean) {
    // 只搬运已声明的两个字段，不把页面传入的整个对象转交给主进程。
    const response: unknown = await ipcRenderer.invoke(PLUGIN_TOGGLE_CHANNEL, { id, enabled })
    return isPluginListResult(response) ? response : invalidPluginResponse()
  }
} satisfies PluginApi
