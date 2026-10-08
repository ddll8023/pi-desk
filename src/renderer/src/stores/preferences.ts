/** 保存界面偏好（Sidebar 折叠）的展示状态；窗口尺寸与位置由主进程独占，页面不参与，也不保存 Runtime 数据。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PreferencesError } from '../../../shared/preferences-api'
import { getPreferences, setUiPreferences } from '../services/preferences'

export const usePreferencesStore = defineStore('preferences', () => {
  const sidebarCollapsed = ref(false)
  /** 是否已完成首次读取；未完成时界面不按存储状态渲染，避免闪动。 */
  const ready = ref(false)
  const actionError = ref<PreferencesError | null>(null)
  /** 并发切换的请求序号；只让最后一次请求的结果覆盖状态。 */
  let requestSeed = 0

  async function initialize(): Promise<void> {
    if (ready.value) return

    const result = await getPreferences()
    if (result.ok) sidebarCollapsed.value = result.data.sidebarCollapsed
    else actionError.value = result.error
    // 读取失败也结束等待：界面继续使用默认布局，不把偏好读取变成启动阻塞。
    ready.value = true
  }

  /** 切换 Sidebar 折叠状态；本地先生效，保存失败只提示，不回滚用户操作。 */
  async function setSidebarCollapsed(next: boolean): Promise<void> {
    if (sidebarCollapsed.value === next) return

    sidebarCollapsed.value = next
    actionError.value = null
    requestSeed += 1
    const token = requestSeed
    const result = await setUiPreferences({ sidebarCollapsed: next })
    if (token !== requestSeed) return
    if (!result.ok) {
      actionError.value = result.error
      return
    }
    sidebarCollapsed.value = result.data.sidebarCollapsed
  }

  /** 折叠与展开共用的切换入口。 */
  function toggleSidebar(): void {
    void setSidebarCollapsed(!sidebarCollapsed.value)
  }

  return {
    sidebarCollapsed,
    ready,
    actionError,
    initialize,
    setSidebarCollapsed,
    toggleSidebar
  }
})
