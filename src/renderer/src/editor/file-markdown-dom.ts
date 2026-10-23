/** 文件 Markdown 渲染后的 DOM 增强：只处理已安全渲染的正文节点，不负责解析或导航。 */
import { headingSlug } from './file-markdown-links'

export interface FileMarkdownTocEntry { readonly id: string; readonly label: string; readonly level: number }
const CALLOUT_TITLES: Readonly<Record<string, string>> = { NOTE: '注意', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '危险' }

/** 为只读渲染补全 GitHub 风格提示块的标题与语义标记。 */
export function applyCallouts(root: HTMLElement): void {
  const quotes = [...(root.matches('blockquote') ? [root] : []), ...Array.from(root.querySelectorAll<HTMLElement>('blockquote'))]
  for (const quote of quotes) {
    const first = quote.firstElementChild
    const text = first?.firstChild
    if (!first || !(text instanceof Text)) continue
    const match = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(text.data)
    if (!match) continue
    const kind = (match[1] ?? '').toUpperCase()
    text.data = text.data.slice(match[0].length)
    if (!text.data) {
      if (text.nextSibling instanceof HTMLBRElement) text.nextSibling.remove()
      text.remove()
    }
    if (!first.textContent?.trim()) first.remove()
    quote.classList.add('is-callout')
    quote.dataset.callout = kind
    const title = document.createElement('p')
    title.className = 'file-markdown-callout-title'
    title.textContent = CALLOUT_TITLES[kind] ?? kind
    quote.prepend(title)
  }
}

/** 只读标题补全；富文本标题本身已有 id，只需读取目录条目。 */
export function ensureHeadingIds(root: HTMLElement): readonly FileMarkdownTocEntry[] {
  const entries: FileMarkdownTocEntry[] = []; const used = new Set<string>()
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    heading.querySelector('.markdown-heading-anchor')?.remove()
    const label = heading.textContent?.trim() ?? ''
    if (!label) continue
    const base = heading.id || headingSlug(label)
    let id = base
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`
    used.add(id); heading.id = id
    const anchor = document.createElement('button')
    anchor.type = 'button'; anchor.className = 'markdown-heading-anchor'; anchor.dataset.linkKind = 'heading'; anchor.dataset.linkTarget = `#${id}`
    anchor.title = '复制标题引用'; anchor.setAttribute('aria-label', `复制标题引用：${label}`); anchor.textContent = '#'
    heading.append(anchor)
    entries.push({ id, label, level: Number(heading.tagName.slice(1)) })
  }
  return entries
}

/** 从富文本编辑器的 heading DOM 提取目录，不修改编辑器节点。 */
export function readHeadingEntries(root: HTMLElement): readonly FileMarkdownTocEntry[] {
  return Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).flatMap(heading => {
    const copy = heading.cloneNode(true) as HTMLElement
    copy.querySelectorAll('.markdown-heading-anchor').forEach(anchor => anchor.remove())
    const label = copy.textContent?.trim() ?? ''
    return label && heading.id ? [{ id: heading.id, label, level: Number(heading.tagName.slice(1)) }] : []
  })
}
