/**
 * 预览就地编辑的收尾：把渲染后的行内 DOM 还原成 Markdown 片段。
 *
 * 只处理段落、标题、列表条目、引用段这类「纯行内」块：粗体、斜体、删除线、行内代码与链接按标记
 * 还原，其余元素递归取文本。含图片、公式、代码块、表格、嵌套列表的块不进入这里——渲染器已把它们
 * 标成源码编辑，避免改一次渲染结果就丢掉这些结构。
 *
 * 已知失真边界：用户无法新增标记（编辑态是纯文本输入），嵌套强调会被拍平成单层，
 * 行内代码里出现反引号时按内容选择更长的围栏。文本节点按 Markdown 标点转义，避免编辑后的文字
 * 被重新解析成标记。
 */

/** 需要转义的标点：只覆盖会把文字重新解释成标记的那几个，其余保持原样便于阅读源码。 */
const ESCAPE_PATTERN = /[\\`*_[\]~]/g

/** 预览里的链接是带 `data-link-target` 的按钮，不是 `<a>`，还原时按同一份地址生成行内链接。 */
const LINK_CLASS = 'markdown-link'

/** 标题锚点与代码复制按钮是预览的本地控件，不属于正文，序列化时跳过。 */
const SKIP_CLASSES = ['markdown-heading-anchor', 'markdown-code-copy']

/** 把一棵行内 DOM 还原成 Markdown 片段；调用方保证传入的是纯行内块。 */
export function serializeInlineMarkdown(root: Node): string {
  const parts: string[] = []
  collect(root, parts)
  return parts.join('')
}

/** 递归收集：文本节点转义后原样输出，已知行内元素补上标记，未知元素只取内容。 */
function collect(node: Node, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push(escapeText(child.nodeValue ?? ''))
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
        collect(child, out)
        out.push('**')
        continue
      case 'EM':
      case 'I':
        out.push('*')
        collect(child, out)
        out.push('*')
        continue
      case 'DEL':
      case 'S':
        out.push('~~')
        collect(child, out)
        out.push('~~')
        continue
      case 'CODE':
        out.push(codeSpan(child.textContent ?? ''))
        continue
      case 'BUTTON':
        if (child.classList.contains(LINK_CLASS) && child.dataset.linkTarget !== undefined) {
          out.push('[')
          collect(child, out)
          out.push(`](${linkTarget(child.dataset.linkTarget)})`)
          continue
        }
        collect(child, out)
        continue
      default:
        collect(child, out)
    }
  }
}

/** 文本转义：`\u00a0` 是编辑时浏览器插入的不换行空格，统一还原成普通空格。 */
function escapeText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(ESCAPE_PATTERN, (char) => `\\${char}`)
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
