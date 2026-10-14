/**
 * 保存侧栏与主题的界面偏好（含侧栏展开的项目路径）以及快捷发送短语；窗口状态由主进程独占，
 * 不保存 Runtime 数据或单个消息块的临时开合状态。
 *
 * 界面偏好是一份整体载荷：折叠状态、主题与展开的项目路径一起写入，任一变化都保存当前完整值，
 * 避免分字段保存互相覆盖；保存单飞，保存期间的新变化在收敛后补写一次。
 * 展开的项目路径只记录哪些项目展开过，顺序不参与展示。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DEFAULT_QUICK_SEND_MESSAGES } from '../../../shared/preferences-api'
import type { PreferencesError, UiPreferences, UiTheme } from '../../../shared/preferences-api'
import { getPreferences, getQuickSend, setQuickSend, setUiPreferences } from '../services/preferences'

/** 快捷发送短语的保存状态；失败保留原列表并把原因交给设置页展示。 */
type QuickSendView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'error'; readonly error: PreferencesError }

export const usePreferencesStore = defineStore('preferences', () => {
  const sidebarCollapsed = ref(false)
  const theme = ref<UiTheme>('system')
  /** 侧栏中保持展开的项目路径；顺序不参与展示，只用于判断某个项目是否展开。 */
  const expandedProjects = ref<readonly string[]>([])
  /** 快捷发送下拉的候选短语；顺序即展示顺序，读取失败或非法时为默认列表。 */
  const quickSendMessages = ref<string[]>([...DEFAULT_QUICK_SEND_MESSAGES])
  const quickSendView = ref<QuickSendView>({ phase: 'idle' })
  /** 首次读取是否已结束；用于侧栏挂载与设置控件启用，读取失败也结束等待。 */
  const ready = ref(false)
  const actionError = ref<PreferencesError | null>(null)
  /** 界面偏好保存单飞；同一时刻只有一个写请求，期间的新变化在收敛后补写一次。 */
  let saving: Promise<void> | null = null
  let saveQueued = false

  async function initialize(): Promise<void> {
    if (ready.value) return

    // 两份偏好互相独立：快捷发送读取失败不影响侧栏与主题，也不把启动变成阻塞。
    const [result, quickSend] = await Promise.all([getPreferences(), getQuickSend()])
    if (result.ok) {
      sidebarCollapsed.value = result.data.sidebarCollapsed
      theme.value = result.data.theme
      expandedProjects.value = [...result.data.expandedProjects]
    } else actionError.value = result.error
    if (quickSend.ok) quickSendMessages.value = [...quickSend.data.messages]
    // 读取失败也结束等待：界面继续使用默认布局，不把偏好读取变成启动阻塞。
    ready.value = true
  }

  /** 该项目的会话列表当前是否展开；未记录过的项目按折叠处理。 */
  function isProjectExpanded(projectPath: string): boolean {
    return expandedProjects.value.includes(projectPath)
  }

  /**
   * 记录或取消某个项目的展开状态：本地立即生效，保存失败只提示，不回滚用户操作。
   * 当前项目被自动展开也走这里，因此重启后仍保持展开。
   */
  function setProjectExpanded(projectPath: string, expanded: boolean): void {
    const current = expandedProjects.value
    if (current.includes(projectPath) === expanded) return
    expandedProjects.value = expanded
      ? [...current, projectPath]
      : current.filter((path) => path !== projectPath)
    void persistUi()
  }

  /**
   * 保存当前完整界面偏好；保存期间再次变化只排队一次补写。
   * 主进程返回的是规范化后的值，保存成功才用它覆盖本地状态。
   */
  async function persistUi(): Promise<void> {
    if (saving !== null) {
      saveQueued = true
      return
    }
    actionError.value = null
    const payload: UiPreferences = {
      sidebarCollapsed: sidebarCollapsed.value,
      theme: theme.value,
      expandedProjects: [...expandedProjects.value]
    }
    const pending = (async () => {
      const result = await setUiPreferences(payload)
      if (!result.ok) {
        actionError.value = result.error
        return
      }
      sidebarCollapsed.value = result.data.sidebarCollapsed
      theme.value = result.data.theme
      expandedProjects.value = [...result.data.expandedProjects]
    })()
    saving = pending
    await pending
    saving = null
    if (saveQueued) {
      saveQueued = false
      await persistUi()
    }
  }

  /** 切换 Sidebar 折叠状态；本地先生效，保存失败只提示，不回滚用户操作。 */
  async function setSidebarCollapsed(next: boolean): Promise<void> {
    if (sidebarCollapsed.value === next) return

    sidebarCollapsed.value = next
    await persistUi()
  }

  /** 折叠与展开共用的切换入口。 */
  function toggleSidebar(): void {
    void setSidebarCollapsed(!sidebarCollapsed.value)
  }

  /** 主题循环顺序：跟随系统 → 浅色 → 深色。 */
  const THEME_CYCLE: readonly UiTheme[] = ['system', 'light', 'dark']

  /** 切换主题；本地先切换，主进程应用 `themeSource`，保存失败只提示，不回滚用户操作。 */
  async function setTheme(next: UiTheme): Promise<void> {
    if (theme.value === next) return

    theme.value = next
    await persistUi()
  }

  /** 顶栏循环切换入口：按固定顺序取下一档；未知取值（不可能出现）时回到跟随系统。 */
  function cycleTheme(): void {
    const index = THEME_CYCLE.indexOf(theme.value)
    const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length] ?? 'system'
    void setTheme(next)
  }

  /**
   * 保存快捷发送短语：保存成功才用主进程规范化后的列表覆盖当前值，失败保留原值并暴露错误；
   * 返回是否成功，供设置页决定要不要丢弃本地草稿。
   */
  async function saveQuickSendMessages(messages: readonly string[]): Promise<boolean> {
    if (quickSendView.value.phase === 'saving') return false

    quickSendView.value = { phase: 'saving' }
    const result = await setQuickSend({ messages })
    if (!result.ok) {
      quickSendView.value = { phase: 'error', error: result.error }
      return false
    }
    quickSendMessages.value = [...result.data.messages]
    quickSendView.value = { phase: 'idle' }
    return true
  }

  return {
    sidebarCollapsed,
    theme,
    expandedProjects,
    quickSendMessages,
    quickSendView,
    ready,
    actionError,
    initialize,
    isProjectExpanded,
    setProjectExpanded,
    setSidebarCollapsed,
    toggleSidebar,
    setTheme,
    cycleTheme,
    saveQuickSendMessages
  }
})
