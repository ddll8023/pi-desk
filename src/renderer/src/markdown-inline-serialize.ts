/**
 * 预览就地编辑的收尾：把渲染后的行内 DOM 还原成 Markdown 片段。
 *
 * 只处理段落、标题、列表条目、引用段这类「纯行内」块：粗体、斜体、删除线、行内代码与链接按标记
 * 还原，其余元素递归取文本。含图片、公式、代码块、表格、嵌套列表的块不进入这里——渲染器已把它们
 * 标成源码编辑，避免改一次渲染结果就丢掉这些结构；带 `[!NOTE]` 一类标记的提示块同样按源码编辑，
 * 因为标记本身在渲染时已被剥离，行内序列化写不回去。
 *
 * 已知失真边界：用户无法新增标记（编辑态是纯文本输入），嵌套强调会被拍平成单层，
 * 行内代码里出现反引号时按内容选择更长的围栏。文本节点只在标点会被重新解析成标记时才转义，
 * 其余标点原样保留：`2~3`、`ui_inspect` 这类写法写回后不会变成 `2\~3`、`ui\_inspect`。
 */
import { Marked } from 'marked'
import { createDisplayMathBlockExtension, createMathExtension } from './markdown-math'
import { escapeHtml } from './markdown-shared'

/** 需要检查的标点：只有真的被解析成标记或实体时才保留反斜杠，其余原样写出。 */
const ESCAPE_CHARS_GLOBAL = /[\\`*_[\]~<>$]/g

/**
 * 转义判定的专用实例：扩展与预览同源，单换行分行也保持同一口径。
 * 这里比较的是「两种写法渲染后是否等价」，预览会把软换行渲染成 `<br>`，
 * 因此比较器也必须这样，否则跨软换行的行首标点会被误判为等价。
 */
const parser = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  extensions: [createDisplayMathBlockExtension(escapeHtml), createMathExtension(escapeHtml)]
})

/** 预览里的链接是带 `data-link-target` 的按钮，不是 `<a>`，还原时按同一份地址生成行内链接。 */
const LINK_CLASS = 'markdown-link'

/** 标题锚点与代码复制按钮是预览的本地控件，不属于正文，序列化时跳过。 */
const SKIP_CLASSES = ['markdown-heading-anchor', 'markdown-code-copy']

/**
 * 行首的 `[ ]`/`[x]`：在列表条目正文里会被重新解析成任务标记。
 * 块级比较看不出这一点（单独一段时两种写法都是普通文字），因此对列表条目单独保留转义。
 */
const TASK_MARKER_PREFIX = /^\[[ xX]\]/

/** 序列化选项：`inListItem` 为 true 时额外保护行首的任务标记。 */
export interface InlineSerializeOptions {
  /** 可编辑块是否位于列表条目内：影响行首 `[ ]` 的转义。 */
  readonly inListItem?: boolean
}

/**
 * 把一棵行内 DOM 还原成 Markdown 片段；调用方保证传入的是纯行内块。
 *
 * 文本节点的标点转义只在必要时保留：先分别拼出「全转义」与「全原样」两个版本，再各渲染一次。
 * 两者渲染结果相同说明这些标点本来就不会被解析成标记，直接写原样（`2~3`、`ui_inspect` 不会被
 * 改成 `2\~3`、`ui\_inspect`）；结果不同说明不转义会改变排版（如 `a *b* c` 变成斜体，
 * 行首的 `* ` 变成列表），此时沿用全转义版本。
 * 按整块而不是单个文本节点判定，跨节点的标记拼接也一并考虑在内。
 */
export function serializeInlineMarkdown(root: Node, options: InlineSerializeOptions = {}): string {
  const plain = serialize(root, false)
  const escaped = serialize(root, true)
  if (options.inListItem === true && TASK_MARKER_PREFIX.test(plain)) return escaped
  return renderFragmentHtml(plain) === renderFragmentHtml(escaped) ? plain : escaped
}

/** 拼一次片段：`escape` 为 true 时给文本节点的标点加反斜杠。 */
function serialize(root: Node, escape: boolean): string {
  const parts: string[] = []
  collect(root, parts, escape)
  return parts.join('')
}

/** 递归收集：文本节点按需转义后原样输出，已知行内元素补上标记，未知元素只取内容。 */
function collect(node: Node, out: string[], escape: boolean): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.nodeValue ?? '').replace(/\u00a0/g, ' ')
      out.push(escape ? escapeText(text) : text)
      continue
    }
    if (!(child instanceof HTMLElement)) continue
    if (SKIP_CLASSES.some((name) => child.classList.contains(name))) continue

    switch (child.tagName) {
      case 'INPUT':
        // 任务复选框由列表条目自己的区间承担，不写进行内文本。
        continue
      case 'BR':
        out.push('  \n')
        continue
      case 'STRONG':
      case 'B':
        out.push('**')
        collect(child, out, escape)
        out.push('**')
        continue
      case 'EM':
      case 'I':
        out.push('*')
        collect(child, out, escape)
        out.push('*')
        continue
      case 'DEL':
      case 'S':
        out.push('~~')
        collect(child, out, escape)
        out.push('~~')
        continue
      case 'CODE':
        out.push(codeSpan(child.textContent ?? ''))
        continue
      case 'BUTTON':
        if (child.classList.contains(LINK_CLASS) && child.dataset.linkTarget !== undefined) {
          out.push('[')
          collect(child, out, escape)
          out.push(`](${linkTarget(child.dataset.linkTarget)})`)
          continue
        }
        collect(child, out, escape)
        continue
      default:
        collect(child, out, escape)
    }
  }
}

/** 文本转义：给会参与行内标记的标点加反斜杠，是最保守的写法。 */
function escapeText(text: string): string {
  return text.replace(ESCAPE_CHARS_GLOBAL, (char) => `\\${char}`)
}

/**
 * 按预览同一套解析配置（含单换行分行）把一段源码渲染成 HTML，只用于比较两种写法是否等价。
 * 用整块渲染而不是行内渲染：行首的 `* `、`> ` 这类写法只有经过块级解析才能看出差别。
 */
function renderFragmentHtml(source: string): string {
  try {
    // 不传 options：本实例的扩展与渲染器都在默认配置里，传了反而可能丢掉自定义部分。
    const html: unknown = parser.parse(source)
    return typeof html === 'string' ? html : ''
  } catch {
    // 解析异常时返回与输入相关的结果：两种写法必然不等，由调用方回退到转义版本。
    return `\u0000${source}`
  }
}

/** 行内代码：围栏长度取内容里最长反引号串加一；首尾是反引号时补空格，避免围栏与内容粘在一起。 */
function codeSpan(text: string): string {
  if (text === '') return '``'
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** 链接地址含空格或括号时用尖括号包裹，否则 Markdown 会把它们当成地址的结束符。 */
function linkTarget(target: string): string {
  return /[\s()<>]/.test(target) ? `<${target}>` : target
}
