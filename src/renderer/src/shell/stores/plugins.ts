/**
 * 本次启动的插件装配结论：给会话页等消费点判断某一项插件是否被停用。
 *
 * 与设置页的清单读取分工不同：设置页要的是配置状态（含「已改配置、重启后生效」），所以自己读整份清单；
 * 这里只保留启动快照的结论——本次运行到底提供了哪几项，取自清单里的 `active`。
 * 读不到清单时按全部可用处理：拿不到结论不应连带把常用消息或执行模式藏起来。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isPluginListResult } from '../../../../shared/plugin-api'

export const usePluginsStore = defineStore('plugins', () => {
  /** 本次启动未装配的插件标识；空集表示全部可用。 */
  const disabledAtStartup = ref<ReadonlySet<string>>(new Set())
  /** 首次读取是否已结束；失败也结束等待，消费点据此按全部可用展示。 */
  const ready = ref(false)

  /** 页面挂载后读取一次；已有结果时不重复请求。 */
  async function initialize(): Promise<void> {
    if (ready.value) return
    ready.value = true
    const bridge = window.desktop
    if (!bridge || typeof bridge.listPlugins !== 'function') return
    try {
      const response: unknown = await bridge.listPlugins()
      if (!isPluginListResult(response) || !response.ok) return
      disabledAtStartup.value = new Set(
        response.data.plugins.filter(plugin => !plugin.active).map(plugin => plugin.id)
      )
    } catch {
      // 桥接异常按全部可用处理：这里的读取只是展示门控，真实原因由设置页的清单失败提示承担。
    }
  }

  /** 该插件在本次启动是否被停用；清单未读到或读取失败时一律按可用。 */
  function isDisabled(id: string): boolean {
    return disabledAtStartup.value.has(id)
  }

  return { ready, disabledAtStartup, initialize, isDisabled }
})
