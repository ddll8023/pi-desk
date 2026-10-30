/**
 * 保存侧栏与右侧面板的界面偏好（含侧栏展开的项目路径）、Markdown 默认视图、终端链接打开模式、快捷发送短语、
 * 扩展自动更新开关与生成式 UI 开关；窗口状态由主进程独占，不保存 Runtime 数据或单个消息块的临时开合状态。
 *
 * 界面偏好是一份整体载荷：折叠状态、主题、展开的项目路径、右侧面板开合/宽度/页签、Markdown 默认视图与终端链接打开模式
 * 一起写入，任一变化都保存当前完整值，避免分字段保存互相覆盖；保存单飞，保存期间的新变化在收敛后补写一次。
 * 展开的项目路径只记录哪些项目展开过，顺序不参与展示；右侧面板宽度对同一窗口只有一个值，不按项目区分。
 * 自动更新开关默认关，只有用户显式打开后主进程才会在启动检查后自动更新扩展。
 * 生成式 UI 开关区分「最近保存值」与「当前会话已生效值」：它在会话创建期读取，保存本身不重建会话，
 * 两者不等就表示还要重新加载资源才生效；生效标记由重载成功处统一写入。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  DEFAULT_FILE_EXCLUDE_PATTERNS,
  DEFAULT_QUICK_SEND_MESSAGES,
  DEFAULT_RIGHT_PANEL_WIDTH,
  MAX_FILE_EXCLUDE_PATTERNS,
  MAX_FILE_EXCLUDE_PATTERN_LENGTH,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH
} from '../../../../shared/preferences-api'
import type { PreferencesError, MarkdownDefaultView, RightPanelTab, TerminalLinkOpenMode, UiPreferences, UiTheme } from '../../../../shared/preferences-api'
import { getAutoUpdate, getGenui, getPreferences, getQuickSend, setAutoUpdate, setGenui, setQuickSend, setUiPreferences } from '../services/preferences'

/** 快捷发送短语的保存状态；失败保留原列表并把原因交给设置页展示。 */
type QuickSendView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'error'; readonly error: PreferencesError }

/** 自动更新开关的保存状态；与短语分开，失败原因只影响这一个控件。 */
type AutoUpdateView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'error'; readonly error: PreferencesError }

/** 生成式 UI 开关的保存状态；与自动更新开关分开，失败原因只影响这一个控件。 */
type GenuiView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'error'; readonly error: PreferencesError }

export const usePreferencesStore = defineStore('preferences', () => {
  const sidebarCollapsed = ref(false)
  const theme = ref<UiTheme>('system')
  /** 侧栏中保持展开的项目路径；顺序不参与展示，只用于判断某个项目是否展开。 */
  const expandedProjects = ref<readonly string[]>([])
  /** 右侧面板是否展开；默认展开，与主进程默认值一致，折叠状态会被记住。 */
  const rightPanelOpen = ref(true)
  /** 右侧面板宽度（像素）；拖拽期间由组件本地接管，松手后才走这里持久化。 */
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)
  /** 右侧面板当前页签：文件树或源代码管理；切换只换内容，不改宽度与开合。 */
  const rightPanelTab = ref<RightPanelTab>('files')
  /** Markdown 文件新标签的默认视图；只影响新打开的标签，已打开的保持各自当前视图。 */
  const markdownDefaultView = ref<MarkdownDefaultView>('preview')
  /** 终端点击链接时的打开方式；默认每次弹窗选择。 */
  const terminalLinkOpenMode = ref<TerminalLinkOpenMode>('ask')
  /** 是否在右侧文件树中显示已被排除/隐藏的文件；默认隐藏。 */
  const showHiddenFiles = ref(false)
  /** 文件排除/隐藏规则列表。 */
  const fileExcludePatterns = ref<readonly string[]>([...DEFAULT_FILE_EXCLUDE_PATTERNS])
  /** 快捷发送下拉的候选短语；顺序即展示顺序，读取失败或非法时为默认列表。 */
  const quickSendMessages = ref<string[]>([...DEFAULT_QUICK_SEND_MESSAGES])
  const quickSendView = ref<QuickSendView>({ phase: 'idle' })
  /** 扩展自动更新开关；读取失败或非法时按关闭处理，不把未知当成已开启。 */
  const extensionAutoUpdate = ref(false)
  const autoUpdateView = ref<AutoUpdateView>({ phase: 'idle' })
  /** 生成式 UI 开关；读取失败或非法时按开启处理，与产品默认口径一致。 */
  const genuiEnabled = ref(true)
  const genuiView = ref<GenuiView>({ phase: 'idle' })
  /**
   * 最近一次保存成功的开关值。与 `genuiAppliedEnabled` 不等，就说明改动还没在当前会话生效：
   * 开关只在会话创建期读取，保存本身不重建会话。
   */
  const genuiSavedEnabled = ref(true)
  /** 当前运行中的会话实际采用的开关值；由启动读取与重载成功回调写入，不落盘。 */
  const genuiAppliedEnabled = ref(true)
  /** 开关是否成功从配置读到；读失败时界面显示的是默认值，设置页据此提示。 */
  const genuiLoaded = ref(false)
  /** 首次读取是否已结束；用于侧栏挂载与设置控件启用，读取失败也结束等待。 */
  const ready = ref(false)
  const actionError = ref<PreferencesError | null>(null)
  /** 界面偏好保存单飞；同一时刻只有一个写请求，期间的新变化在收敛后补写一次。 */
  let saving: Promise<void> | null = null
  let saveQueued = false

  async function initialize(): Promise<void> {
    if (ready.value) return

    // 四份偏好互相独立：快捷发送、自动更新或生成式 UI 开关读取失败不影响侧栏与主题，也不把启动变成阻塞。
    const [result, quickSend, autoUpdate, genui] = await Promise.all([
      getPreferences(),
      getQuickSend(),
      getAutoUpdate(),
      getGenui()
    ])
    if (result.ok) {
      sidebarCollapsed.value = result.data.sidebarCollapsed
      theme.value = result.data.theme
      expandedProjects.value = [...result.data.expandedProjects]
      rightPanelOpen.value = result.data.rightPanelOpen
      rightPanelWidth.value = result.data.rightPanelWidth
      rightPanelTab.value = result.data.rightPanelTab
      markdownDefaultView.value = result.data.markdownDefaultView
      terminalLinkOpenMode.value = result.data.terminalLinkOpenMode
      showHiddenFiles.value = result.data.showHiddenFiles
      fileExcludePatterns.value = [...result.data.fileExcludePatterns]
    } else actionError.value = result.error
    if (quickSend.ok) quickSendMessages.value = [...quickSend.data.messages]
    if (autoUpdate.ok) extensionAutoUpdate.value = autoUpdate.data.enabled
    if (genui.ok) {
      genuiEnabled.value = genui.data.enabled
      // 启动时读到的值就是本次运行将要采用的值：会话都还没建立，不存在待生效的改动。
      genuiSavedEnabled.value = genui.data.enabled
      genuiAppliedEnabled.value = genui.data.enabled
      genuiLoaded.value = true
    }
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
      expandedProjects: [...expandedProjects.value],
      rightPanelOpen: rightPanelOpen.value,
      rightPanelWidth: rightPanelWidth.value,
      rightPanelTab: rightPanelTab.value,
      markdownDefaultView: markdownDefaultView.value,
      terminalLinkOpenMode: terminalLinkOpenMode.value,
      showHiddenFiles: showHiddenFiles.value,
      fileExcludePatterns: [...fileExcludePatterns.value]
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
      rightPanelOpen.value = result.data.rightPanelOpen
      rightPanelWidth.value = result.data.rightPanelWidth
      rightPanelTab.value = result.data.rightPanelTab
      markdownDefaultView.value = result.data.markdownDefaultView
      terminalLinkOpenMode.value = result.data.terminalLinkOpenMode
      showHiddenFiles.value = result.data.showHiddenFiles
      fileExcludePatterns.value = [...result.data.fileExcludePatterns]
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

  /** 切换右侧面板开合；本地先生效，保存失败只提示，不回滚用户操作。 */
  async function setRightPanelOpen(next: boolean): Promise<void> {
    if (rightPanelOpen.value === next) return

    rightPanelOpen.value = next
    await persistUi()
  }

  /** 切换右侧面板开合（供标题栏按钮直接调用，不等待保存结果）。 */
  function toggleRightPanel(): void {
    void setRightPanelOpen(!rightPanelOpen.value)
  }

  /**
   * 保存右侧面板宽度：越界值先收敛到存储边界内，再本地生效并持久化。
   * 拖拽过程中不调用这里，松手才提交一次，避免每帧写配置。
   */
  async function setRightPanelWidth(next: number): Promise<void> {
    const clamped = Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(next)))
    if (rightPanelWidth.value === clamped) return

    rightPanelWidth.value = clamped
    await persistUi()
  }

  /** 切换右侧面板页签；本地立即生效并持久化，保存失败只提示，不回滚用户操作。 */
  async function setRightPanelTab(next: RightPanelTab): Promise<void> {
    if (rightPanelTab.value === next) return

    rightPanelTab.value = next
    await persistUi()
  }

  /** 切换主题；本地先切换，主进程应用 `themeSource`，保存失败只提示，不回滚用户操作。 */
  async function setTheme(next: UiTheme): Promise<void> {
    if (theme.value === next) return

    theme.value = next
    await persistUi()
  }

  /** 切换 Markdown 默认视图；本地先生效，保存失败只提示，不回滚用户操作。 */
  async function setMarkdownDefaultView(next: MarkdownDefaultView): Promise<void> {
    if (markdownDefaultView.value === next) return

    markdownDefaultView.value = next
    await persistUi()
  }

  /** 切换终端链接打开模式；本地立即生效并持久化，保存失败只提示，不回滚用户操作。 */
  async function setTerminalLinkOpenMode(next: TerminalLinkOpenMode): Promise<void> {
    if (terminalLinkOpenMode.value === next) return

    terminalLinkOpenMode.value = next
    await persistUi()
  }

  /** 切换是否在文件树中展示已被排除/隐藏的文件。 */
  async function setShowHiddenFiles(next: boolean): Promise<void> {
    if (showHiddenFiles.value === next) return

    showHiddenFiles.value = next
    await persistUi()
  }

  /** 整体更新文件排除规则清单。 */
  async function setFileExcludePatterns(patterns: readonly string[]): Promise<void> {
    const accepted: string[] = []
    const seen = new Set<string>()
    for (const entry of patterns) {
      const trimmed = entry.trim()
      if (trimmed === '' || trimmed.length > MAX_FILE_EXCLUDE_PATTERN_LENGTH || seen.has(trimmed)) continue
      seen.add(trimmed)
      accepted.push(trimmed)
      if (accepted.length >= MAX_FILE_EXCLUDE_PATTERNS) break
    }
    fileExcludePatterns.value = accepted
    await persistUi()
  }

  /** 向排除规则清单中添加一条规则；若已存在则直接返回成功。 */
  async function addFileExcludePattern(pattern: string): Promise<boolean> {
    const trimmed = pattern.trim()
    if (trimmed === '' || trimmed.length > MAX_FILE_EXCLUDE_PATTERN_LENGTH) return false
    if (fileExcludePatterns.value.includes(trimmed)) return true
    if (fileExcludePatterns.value.length >= MAX_FILE_EXCLUDE_PATTERNS) return false
    await setFileExcludePatterns([...fileExcludePatterns.value, trimmed])
    return true
  }

  /** 从排除规则清单中移除一条规则。 */
  async function removeFileExcludePattern(pattern: string): Promise<void> {
    const next = fileExcludePatterns.value.filter((item) => item !== pattern)
    if (next.length !== fileExcludePatterns.value.length) {
      await setFileExcludePatterns(next)
    }
  }

  /** 启闭某项排除规则。 */
  async function toggleFileExcludePattern(pattern: string): Promise<void> {
    if (fileExcludePatterns.value.includes(pattern)) {
      await removeFileExcludePattern(pattern)
    } else {
      await addFileExcludePattern(pattern)
    }
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

  /**
   * 保存扩展自动更新开关：保存成功才用主进程确认后的值覆盖当前值，失败保留原值并暴露错误；
   * 返回是否成功，供设置页决定要不要把开关退回原位。
   */
  async function saveExtensionAutoUpdate(enabled: boolean): Promise<boolean> {
    if (autoUpdateView.value.phase === 'saving') return false

    autoUpdateView.value = { phase: 'saving' }
    const result = await setAutoUpdate({ enabled })
    if (!result.ok) {
      autoUpdateView.value = { phase: 'error', error: result.error }
      return false
    }
    extensionAutoUpdate.value = result.data.enabled
    autoUpdateView.value = { phase: 'idle' }
    return true
  }

  /**
   * 保存生成式 UI 开关：保存成功才用主进程确认后的值覆盖当前值，失败保留原值并暴露错误。
   * 开关只影响会话创建期，因此这里不重载资源——生效时机由设置页说明，并交给用户决定。
   */
  async function saveGenuiEnabled(enabled: boolean): Promise<boolean> {
    if (genuiView.value.phase === 'saving') return false

    genuiView.value = { phase: 'saving' }
    const result = await setGenui({ enabled })
    if (!result.ok) {
      genuiView.value = { phase: 'error', error: result.error }
      return false
    }
    genuiEnabled.value = result.data.enabled
    genuiSavedEnabled.value = result.data.enabled
    genuiView.value = { phase: 'idle' }
    return true
  }

  /**
   * 标记开关已在运行中的会话生效：设置页在重载成功后调用。
   * 传当前保存值而不是重新读一次配置，避免重载期间又被改过时记错。
   */
  function markGenuiApplied(enabled: boolean): void {
    genuiAppliedEnabled.value = enabled
  }

  return {
    sidebarCollapsed,
    theme,
    expandedProjects,
    rightPanelOpen,
    rightPanelWidth,
    rightPanelTab,
    markdownDefaultView,
    terminalLinkOpenMode,
    showHiddenFiles,
    fileExcludePatterns,
    quickSendMessages,
    quickSendView,
    extensionAutoUpdate,
    autoUpdateView,
    genuiEnabled,
    genuiView,
    genuiSavedEnabled,
    genuiAppliedEnabled,
    genuiLoaded,
    ready,
    actionError,
    initialize,
    isProjectExpanded,
    setProjectExpanded,
    setSidebarCollapsed,
    toggleSidebar,
    setRightPanelOpen,
    toggleRightPanel,
    setRightPanelWidth,
    setRightPanelTab,
    setTheme,
    setMarkdownDefaultView,
    setTerminalLinkOpenMode,
    setShowHiddenFiles,
    setFileExcludePatterns,
    addFileExcludePattern,
    removeFileExcludePattern,
    toggleFileExcludePattern,
    saveQuickSendMessages,
    saveExtensionAutoUpdate,
    saveGenuiEnabled,
    markGenuiApplied
  }
})
