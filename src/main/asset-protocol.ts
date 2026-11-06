/** 本地资产边界：注册应用及 HTML 预览协议，解析应用页面地址并定义生产 CSP；应用协议只提供构建资产，预览协议的处理器仅登记到独立会话。 */

import { realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net, protocol } from 'electron'
import { devServerPortFromEnv } from '../shared/dev-server'
import { PROJECT_HTML_PREVIEW_SCHEME } from '../shared/project-file-api'

export const rendererRoot = resolve(__dirname, '../renderer')
export const productionCsp = [
  "default-src 'none'",
  "script-src 'self'",
  // 终端组件在运行时按测量结果写样式（xterm 的滚动条颜色等），因此样式源放开内联；
  // 脚本与连接仍只允许自身，页面不加载任何远程脚本或远程连接。
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  // data: 与 blob: 用于本地图片附件的缩略图展示；http: 与 https: 仅供 Markdown 预览直连文档里的远程图片，
  // 这些 img 由调用方设置 no-referrer，其余远程内容（脚本、样式、连接）仍然不放开。
  "img-src 'self' data: blob: https: http:",
  // data: 与 blob: 允许 PDF.js 等组件动态加载解析后的内嵌字体。
  "font-src 'self' data: blob:",
  // worker-src 放开同源和 blob，支持 PDF.js 等组件创建 Web Worker。
  "worker-src 'self' blob:",
  "object-src 'none'",
  // frame-src 允许嵌入受限的 webview 网页容器，支持 http/https/about 外部页面。
  "frame-src 'self' http: https: about: data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

/** 开发页面地址由 dev server 端口拼出；端口来自环境变量，与 vite 配置共用同一解析。 */
export const DEVELOPMENT_PAGE_URL = `http://127.0.0.1:${devServerPortFromEnv(process.env.PI_DESK_DEV_SERVER_PORT)}/`
/** 打包态页面由应用协议提供；与 `registerAssetProtocol` 的 host 限制保持一致。 */
export const APPLICATION_PAGE_URL = 'app://desktop/index.html'

/** 必须在 ready 前注册；赋予应用协议 fetch 与 CORS 特权以支持 Module Worker，不赋予绕过 CSP 或运行 Service Worker 的权限。 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    // 仅预览独立 session 注册处理器；标准地址支持相对资源，不赋予 CSP 绕过或 Service Worker 权限。
    { scheme: PROJECT_HTML_PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export function getPageUrl(): string {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (app.isPackaged || !developmentUrl) return APPLICATION_PAGE_URL

  if (new URL(developmentUrl).href !== DEVELOPMENT_PAGE_URL) {
    throw new Error('开发页面地址不在允许范围内。')
  }
  return DEVELOPMENT_PAGE_URL
}

export function isInsideDirectory(root: string, candidate: string): boolean {
  const pathname = relative(root, candidate)
  return pathname !== ''
    && pathname !== '..'
    && !pathname.startsWith(`..${sep}`)
    && !isAbsolute(pathname)
}

export function assetError(status: number): Response {
  return new Response('应用资源不可用。', {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Security-Policy': productionCsp,
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

export function registerAssetProtocol(): void {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.protocol !== 'app:' || url.hostname !== 'desktop'
        || url.port || url.username || url.password || url.search || url.hash) {
        return assetError(403)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return assetError(405)
      }

      const pathname = decodeURIComponent(url.pathname)
      // 同时拒绝 Windows 分隔符、盘符、ADS 与控制字符。
      if (!pathname.startsWith('/') || /[\\:\u0000-\u001f]/.test(pathname)) {
        return assetError(403)
      }
      const resource = pathname.slice(1)
      if (resource.split('/').some((part) => !part || part === '.' || part === '..')) {
        return assetError(403)
      }
      if (resource !== 'index.html' && !resource.startsWith('assets/')) {
        return assetError(404)
      }
      const contentType = contentTypes[extname(resource)]
      if (!contentType) return assetError(404)

      const root = await realpath(rendererRoot)
      const candidate = resolve(root, resource)
      if (!isInsideDirectory(root, candidate)) return assetError(403)
      const asset = await realpath(candidate)
      // realpath 后再次限制边界，避免符号链接把应用协议变成任意文件入口。
      if (!isInsideDirectory(root, asset)) return assetError(403)

      const response = await net.fetch(pathToFileURL(asset).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', contentType)
      headers.set('Content-Security-Policy', productionCsp)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers
      })
    } catch {
      // 不将安装路径、底层文件错误或内部堆栈回传给页面。
      return assetError(404)
    }
  })
}
