/**
 * 文件标签的 Markdown 预览渲染：与聊天渲染器分开，因为两者的安全边界不同。
 *
 * 聊天正文里的图片一律不加载、链接只提供复制动作（消息来自模型与外部内容）；文件预览的内容来自
 * 用户自己打开的项目文件，因此额外允许「项目内图片」与「可跳转链接」，但仍然：原始 HTML 只作文本、
 * 不放开 `src`/`href`/`style`、不加载远程图片、不放行 `file:` 与越界路径。图片与链接的目标写在
 * `data-*` 属性里，由组件按类型决定是否读取文件、跳转锚点、打开标签页或交给系统浏览器。
 *
 * front matter 在解析前剥离（`---` 起止、60 行内、含 `key:` 行），渲染成默认折叠的 details，
 * 避免元信息混进正文，也避免被当成主题分隔线。
 *
 * 渲染按顶层 token 逐块进行，并同时给出每块在原文中的区间（`FileMarkdownBlock`）：预览里就地编辑后
 * 只需按区间替换原文并重绘这一块，不必整篇重建。区间一律相对原文件文本，front matter 剥离后仍按
 * 原文偏移计算，因此提交时可以直接写回编辑器文档。
 */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { Config } from 'dompurify'
import type { Tokens } from 'marked'
import { createDisplayMathBlockExtension, createMathExtension } from './markdown-math'
import { escapeHtml, renderCodeBlock, renderTable } from './markdown-shared'

/** 只开放正文语义、项目内图片、折叠块与本地控件；样式、资源地址、事件与任意 data 属性仍不允许。 */
const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'table', 'thead',
    'tbody', 'tr', 'th', 'td', 'div', 'span', 'button', 'input',
    'details', 'summary'
  ],
  ALLOWED_ATTR: [
    'class', 'type', 'disabled', 'checked', 'start', 'align', 'title',
    'tabindex', 'role', 'aria-label', 'data-image-path', 'data-image-label',
    'data-link-kind', 'data-link-target'
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_TRUSTED_TYPE: false
}

/** front matter 的识别上限：超出这个行数就不当作元信息，避免把正文里的分隔线误判。 */
const FRONT_MATTER_MAX_LINES = 60

/**
 * 渲染阶段判定一次的链接分类：点击时只按分类执行，不再重新解析地址。
 * 后处理阶段插入的标题锚点复用同一 `data-link-kind` 通道，取值不在本类型内。
 */
export type FileMarkdownLinkKind = 'anchor' | 'file' | 'external' | 'copy'

/** 目录条目：在渲染后的 DOM 上提取，`id` 与标题元素的 id 一致，供锚点跳转。 */
export interface FileMarkdownTocEntry {
  readonly id: string
  readonly label: string
  readonly level: number
}

/**
 * 一个顶层块的可编辑描述。
 *
 * `kind` 决定编辑方式：`text` 直接在渲染结果上编辑，`source` 换成等宽源码框，`skip` 不参与编辑。
 * `start`/`end` 是提交时被替换的原文区间：`text` 块只覆盖文字本身（保留 `## `、`- `、`> ` 等标记），
 * `source` 块覆盖整块源码。`path` 是从顶层元素到可编辑元素的子元素路径，空数组表示顶层元素自身。
 */
export interface FileMarkdownBlock {
  /** 顶层 token 序号；front matter 用 -1。局部重绘按它定位整块元素。 */
  readonly tokenIndex: number
  readonly kind: 'text' | 'source' | 'skip'
  readonly start: number
  readonly end: number
  readonly path: readonly number[]
  /** 任务复选框里那个字符的偏移；-1 表示这一块没有复选框。 */
  readonly checkbox: number
}

/** 一次渲染的产物：可直接写入容器的 HTML，以及与之顺序一致的块描述。 */
export interface FileMarkdownDocument {
  readonly html: string
  readonly blocks: readonly FileMarkdownBlock[]
}

/** 只在本文件内部使用的 token 视图：marked 的 Token 是联合类型，这里只关心块级结构用到的字段。 */
interface BlockToken {
  readonly type: string
  readonly raw: string
  readonly text?: string
  readonly task?: boolean
  readonly tokens?: readonly BlockToken[]
  readonly items?: readonly BlockToken[]
}

const parser = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  extensions: [createDisplayMathBlockExtension(escapeHtml), createMathExtension(escapeHtml)],
  renderer: {
    code({ text, lang }) {
      return renderCodeBlock(text, lang)
    },
    html({ text, block }) {
      // 原始 HTML 一律当文本：块级给等宽代码块，行内按纯文本输出，不交给浏览器解释。
      return block ? renderCodeBlock(text, 'html') : escapeHtml(text)
    },
    text(token) {
      if ('escaped' in token && token.escaped && !token.tokens) return escapeHtml(token.text)
      return false
    },
    image({ href, text }) {
      const label = text === '' ? '图片' : text
      if (href.trim() === '') return imagePlaceholder(label, '图片地址为空，未加载')
      // 只记录地址与替代文本，不写 src：读取与否由组件按项目边界判断后再创建 img 节点。
      return `<span class="file-markdown-image-frame" data-image-path="${escapeHtml(href)}" data-image-label="${escapeHtml(label)}">${escapeHtml(`图片：${label}`)}（加载中…）</span>`
    },
    link({ href, tokens }) {
      const target = href.trim()
      const kind = classifyLinkKind(target)
      const title = linkTitle(kind, target)
      // 地址保存在惰性 data 属性里，而不是 href；协议与越界判定在点击时按分类处理。
      return `<button type="button" class="markdown-link" data-link-kind="${kind}" data-link-target="${escapeHtml(target)}" title="${escapeHtml(title)}">${this.parser.parseInline(tokens)}</button>`
    },
    table(token: Tokens.Table) {
      return renderTable(this, token)
    },
    checkbox({ checked }) {
      return `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成任务' : '未完成任务'}"> `
    }
  }
})

/**
 * 渲染文件预览的 Markdown。解析或清洗失败时返回 null，由组件用文本插值保留原文，
 * 不输出错误堆栈，也不因为一段坏内容让整个标签空白。
 */
export function renderFileMarkdown(text: string): FileMarkdownDocument | null {
  try {
    const doc = lexDocument(text)
    // front matter 不经 marked 解析，先拼成折叠块再与正文一起清洗，保证整段输出只有一道边界。
    // 传 options 会让 Parser 丢掉实例上的自定义 renderer，因此这里只用默认选项。
    const parts = doc.tokens.map((token) => parser.parser([token]))
    if (doc.frontMatter !== null) parts.unshift(renderFrontMatter(doc.frontMatter))
    return { html: DOMPurify.sanitize(parts.join(''), SANITIZE_CONFIG), blocks: doc.blocks }
  } catch {
    return null
  }
}

/**
 * 只解析结构、不生成 HTML：就地编辑提交前用它确认块数没变，
 * 块数变了说明编辑改变了文档结构，只能整篇重建。
 */
export function lexFileMarkdown(text: string): readonly FileMarkdownBlock[] {
  try {
    return lexDocument(text).blocks
  } catch {
    return []
  }
}

/** 渲染单个顶层块（已清洗），用于就地编辑后的局部重绘；`tokenIndex` 为 -1 时渲染 front matter。 */
export function renderFileMarkdownBlock(text: string, tokenIndex: number): string | null {
  try {
    const doc = lexDocument(text)
    if (tokenIndex === -1) {
      return doc.frontMatter === null
        ? null
        : DOMPurify.sanitize(renderFrontMatter(doc.frontMatter), SANITIZE_CONFIG)
    }
    const token = doc.tokens[tokenIndex]
    if (token === undefined) return null
    return DOMPurify.sanitize(parser.parser([token]), SANITIZE_CONFIG)
  } catch {
    return null
  }
}

/** 解析结果：front matter 源码、顶层 token 与顺序一致的块描述。 */
interface LexedDocument {
  readonly frontMatter: string | null
  readonly tokens: readonly Tokens.Generic[]
  readonly blocks: readonly FileMarkdownBlock[]
}

/** 逐顶层 token 解析并计算原文区间；区间靠累加 `raw.length` 得到，与 marked 的切分保持一致。 */
function lexDocument(text: string): LexedDocument {
  const { frontMatter, body, bodyOffset } = splitFrontMatter(text)
  const tokens = parser.lexer(body) as unknown as readonly BlockToken[]
  const blocks: FileMarkdownBlock[] = []
  if (frontMatter !== null) {
    blocks.push({ tokenIndex: -1, kind: 'source', start: 0, end: bodyOffset, path: [], checkbox: -1 })
  }

  let cursor = bodyOffset
  tokens.forEach((token, index) => {
    const start = cursor
    cursor += token.raw.length
    blocks.push(...describeToken(token, index, start))
  })
  return { frontMatter, tokens: tokens as unknown as readonly Tokens.Generic[], blocks }
}

/** 按 token 类型给出块描述；无法定位文字时退化为整块源码编辑，绝不猜区间。 */
function describeToken(token: BlockToken, index: number, start: number): readonly FileMarkdownBlock[] {
  const end = start + token.raw.length
  const whole: FileMarkdownBlock = { tokenIndex: index, kind: 'source', start, end, path: [], checkbox: -1 }
  switch (token.type) {
    case 'space':
    case 'def':
    // 顶层 text token 只渲染出裸文本节点，不占顶层元素位，也就无法就地编辑。
    case 'text':
      return [{ ...whole, kind: 'skip' }]
    case 'paragraph':
    case 'heading': {
      const range = locateText(token.raw, start, token.text ?? '', 0)
      if (range === null) return [whole]
      return [{ ...whole, kind: 'text', start: range.start, end: range.end }]
    }
    case 'blockquote':
      return describeBlockquote(token, whole)
    case 'list':
      return describeList(token, whole)
    default:
      // 代码块、表格、公式块、原始 HTML、分隔线都以源码编辑。
      return [whole]
  }
}

/** 引用的每一段各自可编辑；出现列表、代码块等嵌套结构时整块按源码编辑，避免改一段丢掉其余结构。 */
function describeBlockquote(token: BlockToken, whole: FileMarkdownBlock): readonly FileMarkdownBlock[] {
  const children = (token.tokens ?? []).filter((child) => child.type !== 'space')
  // 只有段落与标题能对应到可定位的元素；裸文本节点与其它块一律整块按源码编辑。
  const simple = children.length > 0 && children.every((child) => (
    child.type === 'paragraph' || child.type === 'heading'
  ))
  if (!simple) return [{ ...whole, kind: 'source' }]

  const blocks: FileMarkdownBlock[] = []
  let from = 0
  for (const [childIndex, child] of children.entries()) {
    const range = locateText(token.raw, whole.start, child.text ?? '', from)
    if (range === null) return [{ ...whole, kind: 'source' }]
    blocks.push({ ...whole, kind: 'text', start: range.start, end: range.end, path: [childIndex] })
    from = range.end - whole.start
  }
  return blocks
}

/**
 * 列表按条目给出块：只有一个段落/文本的条目就地编辑文字，带嵌套列表或第二段的条目整条按源码编辑。
 * 任务复选框的字符偏移随条目一起给出，点击时只需替换这一个字符。
 */
function describeList(token: BlockToken, whole: FileMarkdownBlock): readonly FileMarkdownBlock[] {
  const blocks: FileMarkdownBlock[] = []
  let itemOffset = 0
  for (const [itemIndex, item] of (token.items ?? []).entries()) {
    const itemStart = whole.start + itemOffset
    const itemEnd = itemStart + item.raw.length
    itemOffset += item.raw.length

    const checkbox = item.task === true ? locateCheckbox(item.raw, itemStart) : -1
    // 复选框与空白不算结构；剩下多个子块说明条目里还有嵌套结构。
    const children = (item.tokens ?? []).filter((child) => child.type !== 'space' && child.type !== 'checkbox')
    if (children.length !== 1) {
      blocks.push({ ...whole, kind: 'source', start: itemStart, end: itemEnd, path: [itemIndex], checkbox: -1 })
      continue
    }

    const child = children[0] as BlockToken
    // 松散列表的条目内容包在段落里，紧列表直接是文本节点。
    const loose = child.type === 'paragraph' || child.type === 'heading'
    const range = locateText(token.raw, whole.start, child.text ?? '', itemStart - whole.start)
    if (range === null) {
      blocks.push({ ...whole, kind: 'source', start: itemStart, end: itemEnd, path: [itemIndex], checkbox: -1 })
      continue
    }
    blocks.push({
      ...whole,
      kind: 'text',
      start: range.start,
      end: range.end,
      path: loose ? [itemIndex, 0] : [itemIndex],
      checkbox
    })
  }
  return blocks.length === 0 ? [{ ...whole, kind: 'skip' }] : blocks
}

/** 在 `raw` 里从 `from` 之后找文字，返回原文绝对区间；找不到返回 null，由调用方退化处理。 */
function locateText(
  raw: string,
  absoluteStart: number,
  text: string,
  from: number
): { readonly start: number; readonly end: number } | null {
  if (text === '') return null
  const index = raw.indexOf(text, from)
  if (index < 0) return null
  return { start: absoluteStart + index, end: absoluteStart + index + text.length }
}

/** 任务条目里的 `[ ]`/`[x]` 位于条目开头；返回方括号内字符的绝对偏移。 */
function locateCheckbox(raw: string, absoluteStart: number): number {
  const match = /\[([ xX])\]/.exec(raw)
  return match === null ? -1 : absoluteStart + match.index + 1
}

/** 图片地址为空时的占位片段；仍走同一套清洗流程，不输出原始地址。 */
function imagePlaceholder(label: string, reason: string): string {
  return `<span class="file-markdown-image-fallback">${escapeHtml(label)}（${escapeHtml(reason)}）</span>`
}

/**
 * 为标题补上唯一 id、追加可复制的标题锚点，并提取目录条目；已存在 id 的标题沿用原值，重复的 slug 追加序号。
 * 在清洗后的 DOM 上进行，因此标题文本里可能残留行内代码、链接等节点，只取 textContent。
 * 锚点按钮插在标题文字之后：重复调用时先移除旧锚点，否则第二次会把「#」算进标题文本。
 */
export function ensureHeadingIds(root: HTMLElement): readonly FileMarkdownTocEntry[] {
  const entries: FileMarkdownTocEntry[] = []
  const used = new Set<string>()
  for (const heading of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    heading.querySelector('.markdown-heading-anchor')?.remove()
    const label = (heading.textContent ?? '').trim()
    if (label === '') continue
    let id = heading.id === '' ? headingSlug(label) : heading.id
    if (used.has(id)) {
      let suffix = 2
      while (used.has(`${id}-${suffix}`)) suffix += 1
      id = `${id}-${suffix}`
    }
    used.add(id)
    heading.id = id
    appendHeadingAnchor(heading, id, label)
    entries.push({ id, label, level: Number(heading.tagName.slice(1)) })
  }
  return entries
}

/**
 * 追加标题锚点：点击由预览组件代理，把「文件路径#标题 id」复制到剪贴板，便于在对话里引用小节。
 * 按钮只带 data 属性、不带 href，与正文链接同一套安全边界。
 */
function appendHeadingAnchor(heading: HTMLElement, id: string, label: string): void {
  const anchor = document.createElement('button')
  anchor.type = 'button'
  anchor.className = 'markdown-heading-anchor'
  anchor.dataset.linkKind = 'heading'
  anchor.dataset.linkTarget = `#${id}`
  anchor.title = '复制标题引用'
  anchor.setAttribute('aria-label', `复制标题引用：${label}`)
  anchor.textContent = '#'
  heading.append(anchor)
}

/** 标题文本转 id：保留文字、数字与连字符，其余符号折叠成单个连字符。 */
function headingSlug(label: string): string {
  const slug = label.toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug === '' ? 'section' : slug
}

/**
 * 把 Markdown 里的地址解析成项目内相对路径；解析不出或越界时返回 null。
 *
 * 规则与主进程的条目解析保持同一口径：`/` 开头视为项目根，其余相对当前文件所在目录；
 * 带 scheme 的地址（`http:`、`data:`、`file:`、Windows 盘符）一律不当作项目内路径，
 * 空段与 `.` 忽略，`..` 逐级回退且不得越过项目根。
 */
export function resolveProjectPath(reference: string, documentPath: string): string | null {
  const trimmed = reference.trim()
  if (trimmed === '' || hasScheme(trimmed)) return null
  const withoutSuffix = trimmed.split(/[?#]/, 1)[0] ?? ''
  const decoded = decodePath(withoutSuffix)
  if (decoded === null) return null

  const segments = decoded.startsWith('/') ? [] : documentPath.split('/').slice(0, -1)
  for (const raw of decoded.split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    // 反斜杠与控制字符在 POSIX 相对路径里没有合法含义，出现即视为越界写法。
    if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return null
    segments.push(raw)
  }
  return segments.length === 0 ? null : segments.join('/')
}

/** 地址分类只做前缀判断，真正的项目内解析在点击时用 `resolveProjectPath` 完成。 */
function classifyLinkKind(target: string): FileMarkdownLinkKind {
  if (target.startsWith('#')) return 'anchor'
  if (/^https?:\/\//i.test(target)) return 'external'
  if (hasScheme(target)) return 'copy'
  return 'file'
}

function linkTitle(kind: FileMarkdownLinkKind, target: string): string {
  switch (kind) {
    case 'anchor': return `跳到：${target}`
    case 'external': return `在系统浏览器中打开：${target}`
    case 'file': return `打开文件：${target}`
    case 'copy': return `复制链接地址：${target}`
  }
}

/** `scheme:` 前缀（含 Windows 盘符）都表示「不是项目内相对路径」。 */
function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

/** 百分号编码按段解码；解不开的地址直接放弃，不猜测原文。 */
function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * 剥离 front matter：只有首行是 `---`、在限定行数内遇到结束行、且块内至少有一行 `key:` 时才算。
 * 返回的 `body` 保持原换行，交给 marked 正常解析；`bodyOffset` 是正文在原文中的起点，
 * 供块区间换算回原文偏移。
 */
function splitFrontMatter(text: string): {
  readonly frontMatter: string | null
  readonly body: string
  readonly bodyOffset: number
} {
  const lines = text.split('\n')
  if (lines.length < 3) return { frontMatter: null, body: text, bodyOffset: 0 }
  if ((lines[0] ?? '').trim() !== '---') return { frontMatter: null, body: text, bodyOffset: 0 }

  const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES + 1)
  for (let index = 1; index < limit; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() !== '---' && line.trim() !== '...') continue
    const block = lines.slice(1, index)
    if (!block.some((entry) => /^[\w.-]+\s*:/.test(entry))) return { frontMatter: null, body: text, bodyOffset: 0 }
    return {
      frontMatter: block.join('\n'),
      body: lines.slice(index + 1).join('\n'),
      // 结束行连同它的换行都属于 front matter 区间。
      bodyOffset: lines.slice(0, index + 1).join('\n').length + 1
    }
  }
  return { frontMatter: null, body: text, bodyOffset: 0 }
}

/** front matter 用折叠块展示；内容仍是文本，不解析 YAML，也不提供编辑入口。 */
function renderFrontMatter(block: string): string {
  return `<details class="file-markdown-frontmatter"><summary>Front Matter</summary><pre class="scroll-area">${escapeHtml(block)}</pre></details>\n`
}
