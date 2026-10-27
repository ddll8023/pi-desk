/**
 * 内置浏览器契约：标签状态、URL 规范化，以及受限截图、元素选择与取消的跨进程接口和结果校验。
 *
 * 浏览器标签在工作区内独立维护导航状态与标题；主窗口通过受限的 webview 承载网页渲染，
 * 状态与历史仅在页面内保存，不跨应用重启持久化。
 */

/** 受限网页截图通道；只接受属于主窗口的 webview。 */
export const BROWSER_CAPTURE_CHANNEL = 'browser:capture'
export const BROWSER_PICK_ELEMENT_CHANNEL = 'browser:pick-element'
export const BROWSER_CANCEL_PICK_CHANNEL = 'browser:cancel-pick'

/** 坐标相对于被捕获网页视口，结构和样式均为不可信页面提供的数据。 */
export interface BrowserElementContext {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly html: string
  readonly styles: string
  readonly warning: string | null
}

export type BrowserElementPickResult =
  | { readonly ok: true; readonly dataUrl: string; readonly element: BrowserElementContext }
  | { readonly ok: false; readonly error: string; readonly cancelled?: boolean }

export function isBrowserElementContext(value: unknown): value is BrowserElementContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const coordinates = [item.x, item.y, item.width, item.height]
  return coordinates.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
    && typeof item.x === 'number' && typeof item.y === 'number'
    && typeof item.width === 'number' && typeof item.height === 'number'
    && item.width > 0 && item.height > 0 && item.x + item.width <= 1.000001 && item.y + item.height <= 1.000001
    && typeof item.html === 'string' && item.html.length <= 4096
    && typeof item.styles === 'string' && item.styles.length <= 4096
    && (item.warning === null || (typeof item.warning === 'string' && item.warning.length <= 512))
}

export function isBrowserElementPickResult(value: unknown): value is BrowserElementPickResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (result.ok === true) return typeof result.dataUrl === 'string'
    && result.dataUrl.startsWith('data:image/png;base64,') && isBrowserElementContext(result.element)
  return result.ok === false && typeof result.error === 'string'
    && (result.cancelled === undefined || typeof result.cancelled === 'boolean')
}

export type BrowserCaptureResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly error: string }

export interface BrowserCaptureApi {
  readonly captureBrowser: (webContentsId: number) => Promise<BrowserCaptureResult>
  readonly pickBrowserElement: (webContentsId: number) => Promise<BrowserElementPickResult>
  readonly cancelBrowserElementPick: (webContentsId: number) => Promise<void>
}

export function isBrowserCaptureResult(value: unknown): value is BrowserCaptureResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return result.ok === true
    ? typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/png;base64,')
    : result.ok === false && typeof result.error === 'string'
}

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
