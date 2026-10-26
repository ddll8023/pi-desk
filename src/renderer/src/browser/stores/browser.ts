/**
 * 内置浏览器状态：管理各浏览器标签的导航状态、页面标题、加载状态与地址栏输入。
 *
 * 浏览器标签在工作区内独立维护；状态仅存留在前端内存中，不跨应用重启持久化。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { BLANK_PAGE_URL, DEFAULT_BROWSER_TITLE, normalizeBrowserUrl } from '../../../../shared/browser-api.ts'
import type { BrowserTabState } from '../../../../shared/browser-api.ts'

export const useBrowserStore = defineStore('browser', () => {
  /** 键为标签 key，值为单个浏览器标签的状态。 */
  const tabs = ref<Record<string, BrowserTabState>>({})

  /**
   * 确保指定 tabKey 的标签状态存在；如果不存在则初始化。
   */
  function ensureTab(tabKey: string, projectPath: string, initialUrl?: string): BrowserTabState {
    const existing = tabs.value[tabKey]
    if (existing !== undefined) return existing

    const targetUrl = initialUrl ? normalizeBrowserUrl(initialUrl) : BLANK_PAGE_URL
    const initialInput = targetUrl === BLANK_PAGE_URL ? '' : targetUrl
    const initialTitle = targetUrl === BLANK_PAGE_URL ? DEFAULT_BROWSER_TITLE : targetUrl

    const created: BrowserTabState = {
      tabKey,
      projectPath,
      url: targetUrl,
      inputUrl: initialInput,
      title: initialTitle,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      favicon: null,
      error: null
    }

    tabs.value = {
      ...tabs.value,
      [tabKey]: created
    }
    return created
  }

  /**
   * 移除标签状态（关闭标签时调用）。
   */
  function removeTab(tabKey: string): void {
    if (tabs.value[tabKey] === undefined) return
    const next = { ...tabs.value }
    delete next[tabKey]
    tabs.value = next
  }

  /**
   * 更新地址栏输入框的临时文本。
   */
  function setInputUrl(tabKey: string, inputUrl: string): void {
    const current = tabs.value[tabKey]
    if (current === undefined) return
    tabs.value = {
      ...tabs.value,
      [tabKey]: { ...current, inputUrl }
    }
  }

  /**
   * 导航到指定 URL；会自动执行规范化并同步输入框。
   */
  function navigate(tabKey: string, rawUrl: string): void {
    const current = tabs.value[tabKey]
    if (current === undefined) return
    const normalized = normalizeBrowserUrl(rawUrl)
    tabs.value = {
      ...tabs.value,
      [tabKey]: {
        ...current,
        url: normalized,
        inputUrl: normalized === BLANK_PAGE_URL ? '' : normalized,
        error: null
      }
    }
  }

  /**
   * webview 回报的导航状态更新（如 canGoBack/Forward、title、loading 等）。
   */
  function updateNavigationState(
    tabKey: string,
    updates: {
      readonly canGoBack?: boolean
      readonly canGoForward?: boolean
      readonly loading?: boolean
      readonly url?: string
      readonly title?: string
      readonly error?: string | null
    }
  ): void {
    const current = tabs.value[tabKey]
    if (current === undefined) return

    const nextUrl = updates.url ?? current.url
    const nextTitle = updates.title !== undefined && updates.title.trim() !== ''
      ? updates.title.trim()
      : (nextUrl === BLANK_PAGE_URL ? DEFAULT_BROWSER_TITLE : nextUrl)

    tabs.value = {
      ...tabs.value,
      [tabKey]: {
        ...current,
        ...(updates.canGoBack !== undefined ? { canGoBack: updates.canGoBack } : {}),
        ...(updates.canGoForward !== undefined ? { canGoForward: updates.canGoForward } : {}),
        ...(updates.loading !== undefined ? { loading: updates.loading } : {}),
        ...(updates.url !== undefined
          ? {
              url: updates.url,
              inputUrl: updates.url === BLANK_PAGE_URL ? '' : updates.url
            }
          : {}),
        title: nextTitle,
        error: updates.error !== undefined ? updates.error : current.error
      }
    }
  }

  return {
    tabs,
    ensureTab,
    removeTab,
    setInputUrl,
    navigate,
    updateNavigationState
  }
})
