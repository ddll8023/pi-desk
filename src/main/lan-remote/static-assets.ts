/** 只提供独立手机构建目录中的首页和 assets；真实路径复核阻止目录穿越与符号链接逃逸，不代理开发服务器。 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml'
}
const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'",
  "img-src 'self' data: blob:", "font-src 'self'", "object-src 'none'", "frame-src 'none'", "frame-ancestors 'none'",
  "base-uri 'none'", "form-action 'none'"].join('; ')
function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
export class LanMobileAssets {
  private root: string | null = null
  async prepare(): Promise<void> {
    try {
      const root = await realpath(resolve(__dirname, '../lan-mobile'))
      const entry = await realpath(resolve(root, 'index.html'))
      if (!inside(root, entry) || !(await stat(entry)).isFile()) throw new Error('无效的手机页面入口。')
      this.root = root
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`手机网页资源不可用：${detail}。请使用包含 lan-mobile:build 的开发或构建入口生成手机页面。`)
    }
  }
  /** 返回 false 表示不是静态路由，调用方继续走设备认证；静态资源不包含凭据或会话数据。 */
  async serve(pathname: string, method: string | undefined, response: ServerResponse): Promise<boolean> {
    if (method !== 'GET' && method !== 'HEAD') return false
    const entry = pathname === '/' || pathname === '/pair' || pathname === '/index.html'
    if (!entry && !pathname.startsWith('/assets/')) return false
    let path: string
    try { path = decodeURIComponent(pathname) } catch { this.notFound(response); return true }
    if (!this.root || (!entry && (/[\\:\u0000-\u001f]/.test(path)
      || path.slice(1).split('/').some(part => !part || part === '.' || part === '..')))) {
      this.notFound(response); return true
    }
    const resource = entry ? 'index.html' : path.slice(1)
    const type = TYPES[extname(resource)]
    if (!type || (!entry && resource.endsWith('.html'))) { this.notFound(response); return true }
    try {
      if (this.root === null) throw new Error('手机页面未准备。')
      const file = await realpath(resolve(this.root, resource))
      const info = await stat(file)
      if (!inside(this.root, file) || !info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('资源不在允许范围。')
      const bytes = await readFile(file)
      if (response.destroyed || response.writableEnded) return true
      response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': CSP,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.end(method === 'HEAD' ? undefined : bytes)
    } catch { this.notFound(response) }
    return true
  }
  private notFound(response: ServerResponse): void {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('手机网页资源不可用。')
  }
}
