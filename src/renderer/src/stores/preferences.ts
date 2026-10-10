/** 保存侧栏、主题与 Thinking 默认状态的界面偏好；窗口状态由主进程独占，不保存 Runtime 数据或单个消息块的临时开合状态。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PreferencesError, UiTheme } from '../../../shared/preferences-api'
import { getPreferences, setUiPreferences } from '../services/preferences'

export const usePreferencesStore = defineStore('preferences', () => {
  const sidebarCollapsed = ref(false)
  const theme = ref<UiTheme>('system')
  const thinkingDefaultExpanded = ref(false)
  /** 首次读取是否已结束；用于侧栏挂载与设置控件启用，读取失败也结束等待。 */
  const ready = ref(false)
  const actionError = ref<PreferencesError | null>(null)
  /** 并发切换的请求序号；只让最后一次请求的结果覆盖状态。 */
  let requestSeed = 0

  async function initialize(): Promise<void> {
    if (ready.value) return

    const result = await getPreferences()
    if (result.ok) {
      sidebarCollapsed.value = result.data.sidebarCollapsed
      theme.value = result.data.theme
      thinkingDefaultExpanded.value = result.data.thinkingDefaultExpanded
    } else actionError.value = result.error
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
    const result = await setUiPreferences({
      sidebarCollapsed: next,
      theme: theme.value,
      thinkingDefaultExpanded: thinkingDefaultExpanded.value
    })
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

  /** 切换 Thinking 默认状态；本地先生效，保存失败只提示，不回滚或改写单个块的手动状态。 */
  async function setThinkingDefaultExpanded(next: boolean): Promise<void> {
    if (thinkingDefaultExpanded.value === next) return

    thinkingDefaultExpanded.value = next
    actionError.value = null
    requestSeed += 1
    const token = requestSeed
    const result = await setUiPreferences({
      sidebarCollapsed: sidebarCollapsed.value,
      theme: theme.value,
      thinkingDefaultExpanded: next
    })
    if (token !== requestSeed) return
    if (!result.ok) {
      actionError.value = result.error
      return
    }
    thinkingDefaultExpanded.value = result.data.thinkingDefaultExpanded
  }

  /** 主题循环顺序：跟随系统 → 浅色 → 深色。 */
  const THEME_CYCLE: readonly UiTheme[] = ['system', 'light', 'dark']

  /** 切换主题；本地先切换，主进程应用 `themeSource`，保存失败只提示，不回滚用户操作。 */
  async function setTheme(next: UiTheme): Promise<void> {
    if (theme.value === next) return

    theme.value = next
    actionError.value = null
    requestSeed += 1
    const token = requestSeed
    const result = await setUiPreferences({
      sidebarCollapsed: sidebarCollapsed.value,
      theme: next,
      thinkingDefaultExpanded: thinkingDefaultExpanded.value
    })
    if (token !== requestSeed) return
    if (!result.ok) {
      actionError.value = result.error
      return
    }
    theme.value = result.data.theme
  }

  /** 顶栏循环切换入口：按固定顺序取下一档；未知取值（不可能出现）时回到跟随系统。 */
  function cycleTheme(): void {
    const index = THEME_CYCLE.indexOf(theme.value)
    const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? 'system'
    void setTheme(next)
  }

  return {
    sidebarCollapsed,
    theme,
    thinkingDefaultExpanded,
    ready,
    actionError,
    initialize,
    setSidebarCollapsed,
    toggleSidebar,
    setTheme,
    setThinkingDefaultExpanded,
    cycleTheme
  }
})
