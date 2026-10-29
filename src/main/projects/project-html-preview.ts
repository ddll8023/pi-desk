/** HTML 文件预览：本地资源限定在所属项目内，主文档使用内存快照；网络资源遵守 Chromium 的跨域与混合内容限制，不暴露桌面桥接、Node 或本地写入能力。 */
import { randomUUID } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import { session } from 'electron'
import type { Session, WebContents, WebPreferences } from 'electron'
import type { DesktopErrorCode } from '../../shared/desktop-api'
import {
  PROJECT_FILE_TEXT_MAX_BYTES,
  PROJECT_HTML_PREVIEW_PARTITION_PREFIX,
  PROJECT_HTML_PREVIEW_SCHEME
} from '../../shared/project-file-api'
import type {
  ProjectHtmlPreviewData, ProjectHtmlPreviewReleaseResult, ProjectHtmlPreviewRequest, ProjectHtmlPreviewResult
} from '../../shared/project-file-api'
import { isInsideRoot, resolveProjectEntryAbsolute } from './project-entry-path'

interface PreviewRecord {
  readonly id: string
  readonly ownerId: number
  readonly projectPath: string
  readonly root: string
  readonly path: string
  readonly partition: string
  readonly session: Session
  readonly guests: Set<WebContents>
  text: string
  revision: number
}

/** 只允许可用于网页展示的类型；未知扩展名不作为下载或任意文件读取入口。 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
}

/** 页面脚本是被预览内容，不是可信应用代码；开放普通网页资源，但禁止插件、子框架、表单提交与工作线程。 */
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:",
  "style-src 'self' 'unsafe-inline' https: http:",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "connect-src 'self' https: http: wss: ws:",
  "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
  "base-uri 'self'", "form-action 'none'", "frame-ancestors 'none'"
].join('; ')

function failure(code: DesktopErrorCode, message: string): { ok: false; error: { code: DesktopErrorCode; message: string } } {
  return { ok: false, error: { code, message } }
}

function headers(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': PREVIEW_CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }
}

function unavailable(status: number): Response {
  return new Response('预览资源不可用。', { status, headers: headers('text/plain; charset=utf-8') })
}

function resourcePath(url: URL, record: PreviewRecord): string | null {
  if (url.protocol !== `${PROJECT_HTML_PREVIEW_SCHEME}:` || url.hostname !== record.id || url.port || url.username || url.password) return null
  try {
    const path = decodeURIComponent(url.pathname)
    // 同时拦截路径穿越、Windows 分隔符、ADS 和控制字符，不把 URL 查询串当成本地文件名。
    if (!path.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(path)) return null
    const parts = path.slice(1).split('/')
    return parts.some(part => !part || part === '.' || part === '..') ? null : parts.join('/')
  } catch { return null }
}

/** 读取量由已打开文件的元数据约束；文件在读取期间增长时拒绝，不分配无界缓冲或返回截断资源。 */
async function readBoundedAsset(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > PROJECT_FILE_TEXT_MAX_BYTES) return null
    const bytes = new Uint8Array(info.size + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    return length > info.size ? null : bytes.subarray(0, length)
  } finally { await handle.close() }
}

export class ProjectHtmlPreview {
  private readonly records = new Map<string, PreviewRecord>()
  private readonly previewSessions = new WeakSet<Session>()
  private readonly ownerGenerations = new Map<number, number>()

  constructor(private readonly resolveProjectPath: (requested: string) => Promise<string | null>) {}

  async prepare(owner: WebContents, request: ProjectHtmlPreviewRequest): Promise<ProjectHtmlPreviewResult> {
    const ownerId = owner.id
    const generation = this.ownerGenerations.get(ownerId)
    if (Buffer.byteLength(request.text, 'utf8') > PROJECT_FILE_TEXT_MAX_BYTES) return failure('INVALID_REQUEST', 'HTML 内容超过预览上限。')
    const projectPath = await this.resolveProjectPath(request.projectPath)
    if (!projectPath) return failure('INVALID_REQUEST', '文件所属项目未登记或已被移除。')
    try {
      const root = await realpath(projectPath)
      const resolved = await resolveProjectEntryAbsolute(root, request.path)
      if (!resolved.ok) return resolved
      const info = await lstat(resolved.absolutePath)
      if (!info.isFile() || info.isSymbolicLink() || !/\.html?$/i.test(resolved.relativePath)) return failure('INVALID_REQUEST', '只能预览项目内普通 HTML 文件。')
      if (info.size > PROJECT_FILE_TEXT_MAX_BYTES) return failure('INVALID_REQUEST', 'HTML 文件超过预览上限。')
      const registered = await this.resolveProjectPath(projectPath)
      if (!registered || owner.isDestroyed() || this.ownerGenerations.get(ownerId) !== generation) return failure('INVALID_REQUEST', '预览所属窗口或项目已关闭。')
      let record = request.previewId === null ? undefined : this.records.get(request.previewId)
      if (request.previewId !== null && (!record || record.ownerId !== ownerId || record.root !== root || record.path !== resolved.relativePath)) {
        return failure('INVALID_REQUEST', '原预览已释放或不属于当前文档，请重新打开预览。')
      }
      if (!record) {
        const id = randomUUID()
        const partition = `${PROJECT_HTML_PREVIEW_PARTITION_PREFIX}${id}`
        const isolated = session.fromPartition(partition, { cache: false })
        record = {
          id, partition, ownerId, projectPath, root, path: resolved.relativePath,
          session: isolated, guests: new Set(), text: request.text, revision: 0
        }
        this.previewSessions.add(isolated)
        try { this.configureSession(record) }
        catch (error) { this.dispose(record); throw error }
        this.records.set(id, record)
      }
      record.text = request.text
      record.revision += 1
      return { ok: true, data: this.location(record) }
    } catch (error) {
      return failure('INTERNAL_ERROR', `无法准备 HTML 预览：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  release(ownerId: number, id: string): ProjectHtmlPreviewReleaseResult {
    const record = this.records.get(id)
    if (!record) return { ok: true }
    if (record.ownerId !== ownerId) return failure('FORBIDDEN', '预览不属于当前窗口。')
    this.dispose(record)
    return { ok: true }
  }

  releaseOwner(ownerId: number): void {
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1)
    for (const record of this.records.values()) if (record.ownerId === ownerId) this.dispose(record)
  }

  releaseProject(projectPath: string): void {
    for (const record of this.records.values()) {
      const matches = process.platform === 'win32'
        ? record.projectPath.toLowerCase() === projectPath.toLowerCase() : record.projectPath === projectPath
      if (matches) this.dispose(record)
    }
  }

  /** 只有可信主窗口已登记的预览才能使用专属 partition，不能从 DOM 临时拼一个本地文件容器。 */
  configureWebview(ownerId: number, preferences: WebPreferences, params: Record<string, string>): boolean {
    const partition = params.partition ?? preferences.partition ?? ''
    const id = partition.slice(PROJECT_HTML_PREVIEW_PARTITION_PREFIX.length)
    const record = this.records.get(id)
    if (!partition.startsWith(PROJECT_HTML_PREVIEW_PARTITION_PREFIX) || !record || record.ownerId !== ownerId) return false
    try {
      const url = new URL(params.src ?? '')
      if (resourcePath(url, record) !== record.path) return false
    } catch { return false }
    preferences.partition = record.partition
    preferences.session = record.session
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.nodeIntegrationInWorker = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.webviewTag = false
    preferences.allowRunningInsecureContent = false
    preferences.navigateOnDragDrop = false
    delete preferences.preload
    return true
  }

  attachGuest(ownerId: number, guest: WebContents): void {
    const record = [...this.records.values()].find(item => item.ownerId === ownerId && item.session === guest.session)
    if (!record) {
      // 释放可能早于容器的异步挂载；迟到的专属容器不能成为无主管理的页面。
      if (this.previewSessions.has(guest.session)) guest.close()
      return
    }
    record.guests.add(guest)
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 禁止页面把预览变成浏览器；hash 等页内交互不触发这些文档导航事件。
    guest.on('will-navigate', event => event.preventDefault())
    guest.on('will-frame-navigate', event => event.preventDefault())
    guest.on('will-redirect', event => event.preventDefault())
    guest.on('will-attach-webview', event => event.preventDefault())
    guest.on('will-prevent-unload', event => event.preventDefault())
    guest.once('destroyed', () => record.guests.delete(guest))
  }

  private location(record: PreviewRecord): ProjectHtmlPreviewData {
    const path = record.path.split('/').map(part => encodeURIComponent(part)).join('/')
    return {
      previewId: record.id, partition: record.partition,
      url: `${PROJECT_HTML_PREVIEW_SCHEME}://${record.id}/${path}?revision=${record.revision}`
    }
  }

  private configureSession(record: PreviewRecord): void {
    const isolated = record.session
    isolated.setPermissionCheckHandler(() => false)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.on('will-download', event => event.preventDefault())
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try {
        const url = new URL(details.url)
        const current = this.records.get(record.id) === record
        if (current && details.resourceType !== 'subFrame') {
          const path = resourcePath(url, record)
          allowed = details.resourceType === 'mainFrame'
            ? path === record.path
            : path !== null || ['https:', 'http:', 'wss:', 'ws:', 'data:', 'blob:'].includes(url.protocol)
        }
      } catch { /* 非法 URL 与已释放的预览均拒绝，不放行 file: 或应用协议。 */ }
      callback({ cancel: !allowed })
    })
    isolated.protocol.handle(PROJECT_HTML_PREVIEW_SCHEME, request => this.readResource(record, request))
  }

  private async readResource(record: PreviewRecord, request: Request): Promise<Response> {
    if (this.records.get(record.id) !== record) return unavailable(410)
    if (request.method !== 'GET' && request.method !== 'HEAD') return unavailable(405)
    try {
      const path = resourcePath(new URL(request.url), record)
      if (!path) return unavailable(403)
      const contentType = CONTENT_TYPES[extname(path).toLowerCase()]
      if (!contentType || !await this.resolveProjectPath(record.projectPath)) return unavailable(404)
      const root = await realpath(record.projectPath)
      if (root !== record.root) return unavailable(403)
      const resolved = await resolveProjectEntryAbsolute(root, path)
      if (!resolved.ok) return unavailable(403)
      const info = await lstat(resolved.absolutePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > PROJECT_FILE_TEXT_MAX_BYTES) return unavailable(403)
      const actual = await realpath(resolved.absolutePath)
      if (!isInsideRoot(root, actual) || this.records.get(record.id) !== record) return unavailable(403)
      if (path === record.path) {
        return new Response(request.method === 'HEAD' ? null : record.text, { headers: headers(contentType) })
      }
      if (request.method === 'HEAD') return new Response(null, { headers: headers(contentType) })
      const bytes = await readBoundedAsset(actual)
      if (!bytes || this.records.get(record.id) !== record) return unavailable(403)
      return new Response(bytes, { headers: headers(contentType) })
    } catch {
      // 资源错误不把底层文件路径或异常堆栈泄露给预览中的脚本。
      return unavailable(404)
    }
  }

  private dispose(record: PreviewRecord): void {
    this.records.delete(record.id)
    record.text = ''
    for (const guest of record.guests) if (!guest.isDestroyed()) guest.close()
    record.guests.clear()
    record.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }))
    if (record.session.protocol.isProtocolHandled(PROJECT_HTML_PREVIEW_SCHEME)) record.session.protocol.unhandle(PROJECT_HTML_PREVIEW_SCHEME)
    // partition 不带 persist:，缓存及网页存储仅在本次应用内存在；释放后再主动清掉页面数据。
    void record.session.clearStorageData().catch(error => console.error('[html-preview] 清理预览存储失败：', error))
  }
}
