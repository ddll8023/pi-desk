/**
 * 内置浏览器契约与公共常量：定义标签状态、URL 规范化工具与起始页常量。
 *
 * 浏览器标签在工作区内独立维护导航状态与标题；主窗口通过受限的 webview 承载网页渲染，
 * 状态与历史仅在页面内保存，不跨应用重启持久化。
 */

/** 浏览器标签键前缀，如 `browser:1710000000000`。 */
export const BROWSER_KEY_PREFIX = 'browser:'

/** 纯净空白页地址。 */
export const BLANK_PAGE_URL = 'about:blank'

/** 新建空白标签时的默认展示标题。 */
export const DEFAULT_BROWSER_TITLE = '新标签页'

/** 单个浏览器标签的运行状态。 */
export interface BrowserTabState {
  readonly tabKey: string
  readonly projectPath: string
  readonly url: string
  readonly inputUrl: string
  readonly title: string
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly favicon: string | null
  readonly error: string | null
}

/**
 * 将用户在地址栏输入的文本规范化为可导航的完整 URL。
 *
 * 规则：
 * 1. 空内容或空白串解析为 `about:blank`；
 * 2. 已经带有 `http://` 或 `https://` 或 `about:` 的保持原样；
 * 3. `localhost`、`127.0.0.1` 或形如 `xxx.yyy` 的域名补全 `http://`；
 * 4. 其余文本默认补全 `https://`，便于直接访问常见服务与文档。
 */
export function normalizeBrowserUrl(rawInput: string): string {
  const trimmed = rawInput.trim()
  if (!trimmed || trimmed === BLANK_PAGE_URL) {
    return BLANK_PAGE_URL
  }

  // 已经带有协议
  if (/^(https?|about|file):/i.test(trimmed)) {
    return trimmed
  }

  // 本地开发服务地址（localhost、127.0.0.1）优先使用 http://
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`
  }

  // 包含域名点号且没有空格（如 example.com、vitejs.dev/guide 等）
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return `https://${trimmed}`
  }

  // IP 地址带端口或路径
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?(\/.*)?$/.test(trimmed)) {
    return `http://${trimmed}`
  }

  // 默认尝试以 https:// 访问
  return `https://${trimmed}`
}
