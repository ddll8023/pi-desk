/**
 * 文件预览里的围栏代码高亮：复用文件编辑器已有的 CodeMirror 语言包，不引入第二套高亮引擎。
 *
 * 语言由围栏标签决定（只读入口从代码块头部读取，先查常见别名，再用 `LanguageDescription.matchLanguageName`），
 * 匹配不到时保持纯文本。语言包按需动态加载，因此未出现过的语言不会进入首屏包。
 *
 * 只读入口替换 code 元素的子节点；富文本入口返回高亮区间，由调用方生成位置装饰，不直接改写正文 DOM。
 * 两个入口共用语言包和语义类名，均不生成待注入的 HTML 字符串。单块大小在本模块限制；
 * 只读入口还在此限制块数和累计字符数，富文本的累计预算由调用方控制。
 */
import { LanguageDescription } from '@codemirror/language'
import type { LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'

/** 单个代码块的高亮上限；更大的块通常是从别处粘进来的生成物，高亮的收益低于解析成本。 */
const MAX_BLOCK_CHARS = 200_000
/** 单次预览最多高亮的块数。 */
const MAX_BLOCKS = 200
/** 单次预览累计高亮的字符上限。 */
const MAX_TOTAL_CHARS = 1_000_000

/** 围栏标签到语言名的常见别名；未命中的标签再交给 CodeMirror 的语言表匹配。 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  node: 'JavaScript',
  py: 'Python',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  console: 'Shell',
  yml: 'YAML',
  md: 'Markdown',
  'c++': 'C++',
  cpp: 'C++',
  cxx: 'C++',
  cs: 'C#',
  rs: 'Rust',
  golang: 'Go',
  kt: 'Kotlin',
  ps1: 'PowerShell',
  powershell: 'PowerShell',
  proto: 'ProtoBuf',
  dockerfile: 'Dockerfile',
  toml: 'TOML',
  htm: 'HTML',
  xhtml: 'HTML',
  jsonc: 'JSON',
  json5: 'JSON',
  vue: 'Vue',
  text: '',
  txt: '',
  plaintext: ''
}

/** 语义类名到高亮标签的映射；颜色令牌定义在 `assets/styles/base.css`。 */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'tok-keyword' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], class: 'tok-comment' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'tok-number' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName], class: 'tok-function' },
  { tag: [tags.definition(tags.variableName), tags.propertyName, tags.attributeName], class: 'tok-property' },
  { tag: [tags.tagName, tags.angleBracket], class: 'tok-tag' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], class: 'tok-punctuation' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.invalid, class: 'tok-invalid' }
])

/** 已加载的语言支持按语言名缓存；`load()` 失败记成 null，避免重复尝试同一份坏包。 */
const supportCache = new Map<string, Promise<LanguageSupport | null>>()

/**
 * 高亮根节点下所有围栏代码块。`isStale` 在每次异步等待后检查，内容已更新时立即放弃，
 * 避免迟到的结果覆盖新文档。
 */
export async function highlightCodeBlocks(root: HTMLElement, isStale: () => boolean): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('.markdown-code-block > pre > code')
  if (blocks.length === 0 || blocks.length > MAX_BLOCKS) return

  let total = 0
  for (const code of blocks) {
    if (isStale()) return
    const text = code.textContent ?? ''
    if (text === '' || text.length > MAX_BLOCK_CHARS) continue
    if (total + text.length > MAX_TOTAL_CHARS) return
    total += text.length

    const label = code.parentElement?.parentElement
      ?.querySelector('.markdown-code-language')?.textContent ?? ''
    const support = await loadLanguage(label)
    if (isStale()) return
    if (support === null) continue
    applyHighlight(code, text, support)
  }
}

/** 语言标签 → 语言支持；别名优先，其次按名称/别名模糊匹配。空标签与未知标签返回 null。 */
export async function loadLanguage(label: string): Promise<LanguageSupport | null> {
  const normalized = label.trim().toLowerCase()
  // 用 hasOwn 而不是 `in`：后者会把 prototype 上的键（如 `constructor`）当成别名。
  if (normalized === '' || Object.hasOwn(LANGUAGE_ALIASES, normalized)) {
    const alias = LANGUAGE_ALIASES[normalized]
    if (alias === undefined || alias === '') return null
    return loadByName(alias)
  }
  return loadByName(label.trim())
}

async function loadByName(name: string): Promise<LanguageSupport | null> {
  const cached = supportCache.get(name)
  if (cached !== undefined) return cached

  const description = LanguageDescription.matchLanguageName(languages, name, true)
  if (description === null) return null

  const pending = description.load().catch(() => null)
  supportCache.set(name, pending)
  return pending
}

/** 返回富文本高亮区间；未知语言、单块超限或解析失败返回空数组，块数及累计预算由调用方控制。 */
export async function codeHighlightRanges(text: string, label: string): Promise<readonly { from: number; to: number; className: string }[]> {
  if (text.length > MAX_BLOCK_CHARS) return []
  const support = await loadLanguage(label)
  if (support === null) return []
  const ranges: { from: number; to: number; className: string }[] = []
  try {
    highlightTree(support.language.parser.parse(text), highlighter, (from, to, className) => {
      ranges.push({ from, to, className })
    })
  } catch { return [] }
  return ranges
}

/** 用解析树把代码文本切成带语义类名的 span；解析失败时保留原文，不影响可读性。 */
function applyHighlight(code: HTMLElement, text: string, support: LanguageSupport): void {
  let tree: ReturnType<LanguageSupport['language']['parser']['parse']>
  try {
    tree = support.language.parser.parse(text)
  } catch {
    return
  }

  const parts: (string | HTMLElement)[] = []
  let cursor = 0
  try {
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > cursor) parts.push(text.slice(cursor, from))
      const span = document.createElement('span')
      span.className = classes
      span.textContent = text.slice(from, to)
      parts.push(span)
      cursor = to
    })
  } catch {
    return
  }
  if (cursor < text.length) parts.push(text.slice(cursor))

  // 用 DocumentFragment 逐项追加：大块代码会产生上万个节点，展开参数调用可能超出引擎上限。
  const fragment = document.createDocumentFragment()
  for (const part of parts) {
    fragment.append(typeof part === 'string' ? document.createTextNode(part) : part)
  }
  code.replaceChildren(fragment)
}
