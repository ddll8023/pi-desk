/** 文件 Markdown 的只读安全渲染与项目内导航。富文本编辑另由 Tiptap 负责；这里不再维护块区间或局部编辑状态。 */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { Config } from 'dompurify'
import type { Token, TokenizerAndRendererExtension, Tokens } from 'marked'
import { createDisplayMathBlockExtension, createMathExtension } from '../ui/markdown-math'
import { escapeHtml, renderCodeBlock, renderTable } from '../ui/markdown-shared'

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'button', 'input', 'details', 'summary'],
  ALLOWED_ATTR: ['class', 'type', 'disabled', 'checked', 'start', 'align', 'title', 'open', 'tabindex', 'role', 'aria-label', 'data-image-path', 'data-image-label', 'data-link-kind', 'data-link-target'],
  ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_TRUSTED_TYPE: false
}
const CALLOUT_TITLES: Readonly<Record<string, string>> = { NOTE: '注意', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '危险' }
export type FileMarkdownLinkKind = 'anchor' | 'file' | 'external' | 'copy'
export interface FileMarkdownTocEntry { readonly id: string; readonly label: string; readonly level: number }
export interface FileMarkdownDocument { readonly html: string }

/** 大文档在解析前回退源码，避免先创建整篇排版 DOM 再降级。 */
export function canPreviewFileMarkdown(text: string): boolean { return text.length <= 300_000 }

const parser = new Marked({
  gfm: true, breaks: true, async: false,
  extensions: [createDisplayMathBlockExtension(escapeHtml), createMathExtension(escapeHtml), createDetailsBlockExtension()],
  renderer: {
    code: ({ text, lang }) => renderCodeBlock(text, lang),
    html: ({ text, block }) => block ? renderCodeBlock(text, 'html') : escapeHtml(text),
    text(token) { return 'escaped' in token && token.escaped && !token.tokens ? escapeHtml(token.text) : false },
    image({ href, text }) {
      const label = text || '图片'
      if (!href.trim()) return `<span class="file-markdown-image-fallback">${escapeHtml(label)}（图片地址为空）</span>`
      return `<span class="file-markdown-image-frame" data-image-path="${escapeHtml(href)}" data-image-label="${escapeHtml(label)}">${escapeHtml(label)}（加载中…）</span>`
    },
    link({ href, tokens }) {
      const target = href.trim()
      return `<button type="button" class="markdown-link" data-link-kind="${classifyLinkKind(target)}" data-link-target="${escapeHtml(target)}" title="${escapeHtml(target)}">${this.parser.parseInline(tokens)}</button>`
    },
    table(token: Tokens.Table) { return renderTable(this, token) },
    checkbox: ({ checked }) => `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成任务' : '未完成任务'}"> `
  }
})

/** 只在清洗之后输出 HTML；原始地址不进入 src/href，读取与打开操作由组件代理。 */
export function renderFileMarkdown(text: string): FileMarkdownDocument | null {
  if (!canPreviewFileMarkdown(text)) return null
  try {
    const { frontMatter, body } = splitFrontMatter(text)
    const metadata = frontMatter === null ? '' : `<details class="file-markdown-frontmatter"><summary>Front Matter</summary><pre class="scroll-area">${escapeHtml(frontMatter)}</pre></details>\n`
    const html = parser.parse(body)
    return typeof html === 'string' ? { html: DOMPurify.sanitize(metadata + html, SANITIZE_CONFIG) } : null
  } catch { return null }
}

interface DetailsToken extends Tokens.Generic { readonly open: boolean; readonly summaryTokens: Token[]; readonly tokens: Token[] }
function detailsBoundary(source: string): { openingEnd: number; closingStart: number; end: number } | null {
  const opening = /^ {0,3}<details\b[^>]*>/i.exec(source)
  if (!opening) return null
  const markers = /<!--[\s\S]*?-->|^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)[^\n]*?\2(?!`)|<\/?(?:details|pre|code)\b[^>]*>/gim
  markers.lastIndex = opening[0].length
  let depth = 1; let fence = ''; let rawCode = ''
  for (let match = markers.exec(source); match; match = markers.exec(source)) {
    const value = match[0]
    if (value.startsWith('<!--')) continue
    const delimiter = match[1]
    if (delimiter) {
      if (rawCode) continue
      if (!fence) fence = delimiter
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && value.trim() === delimiter) fence = ''
      continue
    }
    if (fence) continue
    const tag = /^<(\/?)(details|pre|code)\b/i.exec(value)
    if (!tag) continue
    const closing = tag[1] === '/'; const name = tag[2]?.toLowerCase() ?? ''
    if (rawCode) { if (closing && name === rawCode) rawCode = ''; continue }
    if (name !== 'details') { if (!closing) rawCode = name; continue }
    depth += closing ? -1 : 1
    if (!depth) {
      const trailing = /^[ \t]*(?:\r?\n)*/.exec(source.slice(markers.lastIndex))?.[0] ?? ''
      return { openingEnd: opening[0].length, closingStart: match.index, end: markers.lastIndex + trailing.length }
    }
  }
  return null
}
function createDetailsBlockExtension(): TokenizerAndRendererExtension {
  return {
    name: 'detailsBlock', level: 'block', childTokens: ['summaryTokens', 'tokens'],
    start: source => source.search(/^ {0,3}<details[\s>]/im),
    tokenizer(source) {
      const boundary = detailsBoundary(source)
      if (!boundary) return undefined
      const inner = source.slice(boundary.openingEnd, boundary.closingStart)
      const summary = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>[ \t]*(?:\r?\n)?/i.exec(inner)
      const content = (summary ? inner.slice(summary[0].length) : inner).replace(/^\s*\n/, '')
      const attributes = source.slice(0, boundary.openingEnd).replace(/^ {0,3}<details\b|>$/gi, '').matchAll(/(?:^|\s)([^\s=<>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)
      return { type: 'detailsBlock', raw: source.slice(0, boundary.end), open: Array.from(attributes).some(attribute => attribute[1]?.toLowerCase() === 'open'), summaryTokens: this.lexer.inlineTokens(summary?.[1] ?? '详细内容'), tokens: this.lexer.blockTokens(content) }
    },
    renderer(token) {
      const details = token as DetailsToken
      return `<details class="file-markdown-details"${details.open ? ' open' : ''}><summary>${this.parser.parseInline(details.summaryTokens)}</summary><div class="file-markdown-details-body">${this.parser.parse(details.tokens)}</div></details>\n`
    }
  }
}

/** 提示块的 DOM 补全只供只读渲染器使用，不允许用于富文本管理的 DOM。 */
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

/** 只读标题补全；富文本使用位置装饰生成同样的 id 与按钮。 */
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
export function headingSlug(label: string): string {
  return label.toLowerCase().replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section'
}

/** / 表示项目根；协议、控制字符、反斜杠和越界回退都不交给主进程读取。 */
export function resolveProjectPath(reference: string, documentPath: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null
  let decoded: string
  try { decoded = decodeURIComponent(trimmed.split(/[?#]/, 1)[0] ?? '') } catch { return null }
  const segments = decoded.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) return null; segments.pop(); continue }
    if (segment.includes('\\') || /[\u0000-\u001f]/.test(segment)) return null
    segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}
export function resolveFileMarkdownLink(reference: string, documentPath: string): { readonly path: string; readonly anchor: string | null } | null {
  const path = resolveProjectPath(reference, documentPath)
  if (!path) return null
  const index = reference.indexOf('#')
  let anchor = index < 0 ? '' : reference.slice(index + 1)
  try { anchor = decodeURIComponent(anchor) } catch { /* 无效编码按原文定位。 */ }
  return { path, anchor: anchor || null }
}
export function classifyLinkKind(target: string): FileMarkdownLinkKind {
  if (target.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(target)) return 'external'
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) ? 'copy' : 'file'
}
function splitFrontMatter(text: string): { frontMatter: string | null; body: string } {
  const lines = text.split('\n')
  if (lines.length < 3 || lines[0]?.trim() !== '---') return { frontMatter: null, body: text }
  for (let index = 1; index < Math.min(lines.length, 61); index += 1) {
    if (lines[index]?.trim() !== '---' && lines[index]?.trim() !== '...') continue
    const block = lines.slice(1, index)
    if (!block.some(line => /^[\w.-]+\s*:/.test(line))) break
    return { frontMatter: block.join('\n'), body: lines.slice(index + 1).join('\n') }
  }
  return { frontMatter: null, body: text }
}
