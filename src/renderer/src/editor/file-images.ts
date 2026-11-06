/**
 * 文件预览里的 Markdown 图片加载：`http(s)` 远程地址直连放行，项目内相对路径经主进程读取拼成 `data:` URL。
 *
 * 远程图片交给渲染进程直接请求（依赖 CSP 的 `img-src https: http:`），不经过主进程，也不进入下面的本地图片缓存与总量预算；
 * 调用方需为这些 `img` 设置 `referrerPolicy="no-referrer"`，避免当前文档地址通过 Referer 外泄。
 * 项目内图片走主进程读取：`data:`、`file:`、绝对路径与越界路径一律拒绝，与主进程「页面只能给相对路径」的边界一致。
 * 位图按主进程返回的 MIME 直接内联，SVG 是文本，用文本拼 `data:image/svg+xml` 展示（脚本不会执行，`img` 上下文本身也不运行 SVG 脚本）。
 *
 * 本地结果按「工作区 + 项目 + 路径」缓存并合并并发请求，避免同一张图在滚动或重渲染时反复跨进程搬运；
 * 失败不缓存，重新载入文件时可以再试。远程地址不在这里缓存，交给浏览器自身的 HTTP 缓存。
 */
import { readProjectFile } from './services/project-file'
import { resolveProjectPath } from './file-markdown-links'

/** 单张图片的加载结果；`url` 与 `error` 互斥：要么有可用的地址，要么有可展示的原因。 */
export interface MarkdownImageSource {
  readonly url: string | null
  readonly error: string | null
}

/** 缓存条数上限；超出后整表清空，避免长文档里无界增长。 */
const CACHE_LIMIT = 32

const cache = new Map<string, Promise<MarkdownImageSource>>()

/**
 * 加载一张 Markdown 图片。`documentPath` 是当前预览文件的相对路径，相对地址以它所在目录为基准。
 */
export async function loadMarkdownImage(
  projectPath: string,
  documentPath: string,
  reference: string,
  workspaceId: string
): Promise<MarkdownImageSource> {
  const remote = reference.trim()
  // 远程图片直连放行：地址里出现空白或控制字符时 marked 的解析结果不可靠，改为给出可展示的原因。
  if (/^https?:\/\//i.test(remote)) {
    return /[\s\u0000-\u001f]/.test(remote) ? { url: null, error: '远程图片地址无效' } : { url: remote, error: null }
  }
  const path = resolveProjectPath(reference, documentPath)
  if (path === null) {
    return { url: null, error: '图片不在项目内' }
  }

  const key = `${workspaceId}\n${projectPath}\n${path}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const pending = readImage(projectPath, path, workspaceId)
  cache.set(key, pending)
  if (cache.size > CACHE_LIMIT) cache.clear()
  const result = await pending
  // 失败不留在缓存里，重新载入 Markdown 时还能再试一次。
  if (result.url === null && cache.get(key) === pending) cache.delete(key)
  return result
}

/** 清空缓存：Markdown 重新载入或磁盘改动后调用，让图片跟随最新内容。 */
export function clearMarkdownImageCache(): void {
  cache.clear()
}

/** 图片加载失败的展示文案：远程地址直连时拿不到失败原因，只给出来源域名。 */
export function imageFailureHint(url: string): string {
  if (!/^https?:\/\//i.test(url)) return '图片加载失败'
  try { return `远程图片加载失败：${new URL(url).host}` } catch { return '远程图片加载失败' }
}

/** 读取并转换成可直接放进 `img.src` 的地址；失败原因保持可展示。 */
async function readImage(projectPath: string, path: string, workspaceId: string): Promise<MarkdownImageSource> {
  const result = await readProjectFile(projectPath, path, workspaceId)
  if (!result.ok) return { url: null, error: result.error.message }

  const content = result.data
  if (content.workspaceId !== workspaceId || content.projectPath !== projectPath) return { url: null, error: '图片响应不属于原工作区。' }
  if (content.kind === 'image') {
    return { url: `data:${content.mimeType};base64,${content.base64}`, error: null }
  }
  if (content.kind === 'text' && path.toLowerCase().endsWith('.svg')) {
    return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.text)}`, error: null }
  }
  if (content.kind === 'unsupported') {
    return { url: null, error: content.reason === 'binary' ? '不是可预览的图片格式' : '图片超出预览上限' }
  }
  return { url: null, error: '不是可预览的图片格式' }
}
