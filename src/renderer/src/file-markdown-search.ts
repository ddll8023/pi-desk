/**
 * 文件预览的查找：在渲染后的正文 DOM 上按文本节点匹配，用 CSS Custom Highlight API 着色。
 *
 * 按可见块收集文本，粗体、链接等行内边界不打断匹配；块边界与显式换行分开处理。
 * 隐藏的元信息、未展开的折叠正文与本地控件不参与查找。命中数有上限，界面以「+」标注截断。
 * 浏览器不支持 Highlight API 时降级为「只计数与跳转、不着色」：查找本身仍可用，不抛错。
 *
 * 预览自带的控件（代码块头部、标题锚点）不是正文，查找时跳过，避免命中「复制」「#」这类按钮文字。
 */

/** 单次查找的匹配上限：再多也读不完，继续扫描只会拖慢长文档。 */
const MAX_MATCHES = 500

/** 不参与查找的预览控件；代码块语言标签与复制键、标题锚点都在此列。 */
const SKIP_SELECTOR = '.markdown-code-header, .markdown-heading-anchor, input, textarea, [hidden]'
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'TD', 'TH', 'DETAILS', 'SUMMARY', 'HR'])

/** 普通匹配与当前匹配的高亮名；同一时间只注册这两个。 */
const MATCH_HIGHLIGHT = 'file-preview-search-match'
const ACTIVE_HIGHLIGHT = 'file-preview-search-active-match'

/** 一次查找的结果；`truncated` 为真表示命中数已达上限，界面需提示还有更多。 */
export interface FileMarkdownSearchResult {
  readonly ranges: readonly Range[]
  readonly truncated: boolean
}

/** Highlight API 的最小形状；不依赖 lib 里的可选类型，旧运行环境下也能安全探测。 */
interface HighlightLike {
  add(range: Range): void
}

type HighlightConstructor = new (...ranges: Range[]) => HighlightLike

interface HighlightRegistry {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}

/** 取高亮构造器；运行环境没有该 API 时返回 null，由调用方跳过着色。 */
function highlightConstructor(): HighlightConstructor | null {
  const candidate = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight
  return typeof candidate === 'function' ? candidate : null
}

/** 取高亮注册表；与构造器同源，缺失时一并降级。 */
function highlightRegistry(): HighlightRegistry | null {
  const candidate = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights
  return candidate ?? null
}

/** 一个可见块里的原始文本节点与偏移，匹配完成后据此恢复跨行内标签的 Range。 */
interface TextPart {
  readonly node: Text
  readonly start: number
  readonly end: number
}

/** 在可见正文中匹配；大小写转换改变长度的文本段不参与，避免字符偏移错位。 */
export function collectMatches(
  root: HTMLElement,
  query: string,
  limit: number = MAX_MATCHES
): FileMarkdownSearchResult {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { ranges: [], truncated: false }
  const ranges: Range[] = []
  let truncated = false
  let text = ''
  let parts: TextPart[] = []

  const flush = (): void => {
    const haystack = text.toLowerCase()
    if (haystack.length === text.length) {
      let from = 0
      while (!truncated) {
        const index = haystack.indexOf(needle, from)
        if (index < 0) break
        if (ranges.length >= limit) { truncated = true; break }
        const end = index + needle.length
        const first = parts.find(part => part.end > index)
        const last = parts.find(part => part.end >= end)
        if (first !== undefined && last !== undefined) {
          const range = document.createRange()
          range.setStart(first.node, index - first.start)
          range.setEnd(last.node, end - last.start)
          ranges.push(range)
        }
        from = end
      }
    }
    text = ''
    parts = []
  }

  const walk = (node: Node): void => {
    if (truncated) return
    if (node instanceof Text) {
      if (node.data !== '') {
        parts.push({ node, start: text.length, end: text.length + node.data.length })
        text += node.data
      }
      return
    }
    if (!(node instanceof HTMLElement)) return
    const style = window.getComputedStyle(node)
    if (node.matches(SKIP_SELECTOR) || style.display === 'none' || style.visibility === 'hidden') {
      flush()
      return
    }
    const block = BLOCK_TAGS.has(node.tagName)
    if (block || node.tagName === 'BR') flush()
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = node.querySelector(':scope > summary')
      if (summary !== null) walk(summary)
    } else {
      for (const child of node.childNodes) walk(child)
    }
    if (block || node.tagName === 'BR') flush()
  }
  walk(root)
  flush()
  return { ranges, truncated }
}

/**
 * 注册高亮：当前匹配单独一组，其余匹配另一组，两者颜色不同。
 * 每次调用先清掉上一次的注册，避免旧 Range 残留在已卸载的节点上。
 */
export function applyHighlights(ranges: readonly Range[], activeIndex: number): void {
  const registry = highlightRegistry()
  const HighlightClass = highlightConstructor()
  if (registry === null || HighlightClass === null) return

  registry.delete(MATCH_HIGHLIGHT)
  registry.delete(ACTIVE_HIGHLIGHT)
  if (ranges.length === 0) return

  const active = ranges[activeIndex]
  const others = active === undefined ? ranges : ranges.filter((range) => range !== active)
  if (others.length > 0) registry.set(MATCH_HIGHLIGHT, new HighlightClass(...others))
  if (active !== undefined) registry.set(ACTIVE_HIGHLIGHT, new HighlightClass(active))
}

/** 清空查找高亮；关闭查找、切换文件与卸载时都要调用，否则高亮会停在旧内容上。 */
export function clearHighlights(): void {
  const registry = highlightRegistry()
  if (registry === null) return
  registry.delete(MATCH_HIGHLIGHT)
  registry.delete(ACTIVE_HIGHLIGHT)
}

/** 把匹配滚动到视口中间；量不到尺寸（尚未布局或已脱离文档）时不动滚动位置。 */
export function scrollRangeIntoView(range: Range, container: HTMLElement): void {
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return
  const bounds = container.getBoundingClientRect()
  const offset = rect.top - bounds.top + container.scrollTop
  const top = Math.max(0, offset - container.clientHeight / 2 + rect.height / 2)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  container.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' })
}
