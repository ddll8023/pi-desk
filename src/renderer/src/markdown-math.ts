/**
 * 数学公式的定界符解析与渲染：解析只产出占位元素，渲染由 KaTeX 在清洗后的 DOM 上原地完成。
 *
 * 解析侧把公式换成 `span` 占位元素（class 区分行内与显示，公式源文本按文本节点转义），公式本身
 * 不进入 HTML 字符串；渲染侧在 DOMPurify 清洗之后读取占位元素的文本并调用 `katex.render`，
 * 由 KaTeX 直接构建 DOM，因此清洗白名单不需要放开 `style`，也不引入 MathML 标签。KaTeX 以
 * `trust: false` 运行，`\href`、`\url`、`\includegraphics` 与自定义 class/id 都不会被写出。
 *
 * 定界符支持 `$$…$$` 与 `\[…\]`（显示）、`\(…\)` 与 `$…$`（行内）。行内 `$` 另设护栏以避开
 * JS 模板串 `${…}` 与金额写法：开启 `$` 后不能紧跟 `{`、空白或数字，闭合 `$` 前不能是空白，
 * 内容不跨行。渲染结果按「显示模式 + 公式文本」缓存，流式期间同一公式只解析一次。
 */
import katex from 'katex'
import type { TokenizerAndRendererExtension, Tokens } from 'marked'

/** 进入自定义 HTML 的文本转义由调用方注入，与 markdown.ts 共用同一实现。 */
export type EscapeHtml = (text: string) => string

/** 数学 token：`math` 来自行内定界符，`mathBlock` 来自行首的显示公式。 */
export type MathToken = {
  readonly type: 'math' | 'mathBlock'
  readonly raw: string
  readonly text: string
  readonly display: boolean
}

/** 已渲染节点的缓存上限；超出后整表清空，避免长会话里无界增长。 */
const MAX_CACHE_ENTRIES = 200

/** 键为「显示模式:公式文本」，值是脱离文档的已渲染节点；命中时克隆，不复用同一节点。 */
const renderCache = new Map<string, HTMLElement>()

/** 行内定界符：长的在前，内容不允许为空；`$` 的护栏见文件头。 */
const INLINE_PATTERNS = [
  { pattern: /^\$\$([\s\S]+?)\$\$/, display: true },
  { pattern: /^\\\[([\s\S]+?)\\\]/, display: true },
  { pattern: /^\\\(([\s\S]+?)\\\)/, display: false },
  { pattern: /^\$(?![\s{$\d])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?![\d$])/, display: false }
] as const

/** 行首的显示公式可跨行与空行；未闭合时匹配失败，交回内置解析。 */
const BLOCK_PATTERNS = [
  /^ {0,3}\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n+|$)/,
  /^ {0,3}\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\][ \t]*(?:\n+|$)/
] as const

/**
 * 注册行内公式。扩展的 tokenizer 先于 marked 内置的转义与行内代码规则执行，
 * 因此 `\[`、`\(` 不会被当成转义字符；行内代码里的定界符因位置更靠前仍由代码规则先取走。
 */
export function createMathExtension(escapeHtml: EscapeHtml): TokenizerAndRendererExtension {
  return {
    name: 'math',
    level: 'inline',
    start(src) {
      return src.search(/\$|\\[([]/)
    },
    tokenizer(src) {
      return tokenizeInline(src)
    },
    renderer(token) {
      return renderMathToken(token as MathToken, escapeHtml)
    }
  }
}

/** 注册行首的显示公式；只处理整块公式，段落中的 `$$…$$` 仍由行内扩展接管。 */
export function createDisplayMathBlockExtension(escapeHtml: EscapeHtml): TokenizerAndRendererExtension {
  return {
    name: 'mathBlock',
    level: 'block',
    tokenizer(src) {
      return tokenizeBlock(src)
    },
    renderer(token) {
      return renderMathToken(token as MathToken, escapeHtml)
    }
  }
}

/**
 * 把占位元素渲染为 KaTeX 节点。清洗后的 DOM 每轮重建，因此这里只跳过已含 `.katex` 的元素；
 * 渲染失败时保留原文并标记错误，不让整条消息失去可读性。
 */
export function renderMathInto(root: HTMLElement): void {
  const placeholders = root.querySelectorAll<HTMLElement>('.markdown-math-inline, .markdown-math-block')
  for (const placeholder of placeholders) {
    if (placeholder.querySelector('.katex') === null) renderPlaceholder(placeholder)
  }
}

/** 行内匹配：返回首个命中的定界符内容，未命中返回 undefined 交回内置规则。 */
function tokenizeInline(src: string): Tokens.Generic | undefined {
  for (const { pattern, display } of INLINE_PATTERNS) {
    const match = pattern.exec(src)
    if (match === null) continue
    const text = match[1].trim()
    if (text === '') continue
    return { type: 'math', raw: match[0], text, display }
  }
  return undefined
}

/** 块级匹配：只接受从行首开始的显示公式，未命中返回 undefined 交回内置规则。 */
function tokenizeBlock(src: string): Tokens.Generic | undefined {
  for (const pattern of BLOCK_PATTERNS) {
    const match = pattern.exec(src)
    if (match === null) continue
    const text = match[1].trim()
    if (text === '') continue
    return { type: 'mathBlock', raw: match[0], text, display: true }
  }
  return undefined
}

/** 占位元素只承载 class 与转义后的公式文本，数学 HTML 由后续的 KaTeX 渲染生成。 */
function renderMathToken(token: MathToken, escapeHtml: EscapeHtml): string {
  const className = token.display ? 'markdown-math-block' : 'markdown-math-inline'
  return `<span class="${className}">${escapeHtml(token.text)}</span>`
}

/** 单个占位元素的渲染：先查缓存，未命中才解析并缓存脱离文档的节点。 */
function renderPlaceholder(placeholder: HTMLElement): void {
  const tex = placeholder.textContent ?? ''
  if (tex === '') return
  const display = placeholder.classList.contains('markdown-math-block')
  const key = `${display ? 'D' : 'I'}:${tex}`
  const cached = renderCache.get(key)
  if (cached !== undefined) {
    placeholder.replaceChildren(cached.cloneNode(true))
    return
  }

  const holder = document.createElement('span')
  try {
    katex.render(tex, holder, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: false,
      strict: false,
      trust: false
    })
  } catch {
    placeholder.classList.add('is-error')
    placeholder.textContent = tex
    return
  }

  const rendered = holder.firstElementChild
  if (!(rendered instanceof HTMLElement)) {
    placeholder.classList.add('is-error')
    placeholder.textContent = tex
    return
  }
  if (renderCache.size >= MAX_CACHE_ENTRIES) renderCache.clear()
  renderCache.set(key, rendered)
  placeholder.replaceChildren(rendered.cloneNode(true))
}
