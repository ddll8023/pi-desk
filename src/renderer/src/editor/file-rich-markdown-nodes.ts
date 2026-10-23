/** 富文本基础节点、标题装饰与文末输入区；借鉴 ORCA 的节点修正与源码保真机制，许可见 licenses/orca-MIT.txt。 */
import { Extension, Node } from '@tiptap/core'
import type { Editor, MarkdownLexerConfiguration, MarkdownToken, MarkdownTokenizer } from '@tiptap/core'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Code } from '@tiptap/extension-code'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN, TaskList } from '@tiptap/extension-list'
import { TrailingNode } from '@tiptap/extensions'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { headingSlug } from './file-markdown-links'

const paragraphParser = Paragraph.config.parseMarkdown
export const RichParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    if (!paragraphParser || (token.tokens?.length === 1 && token.tokens[0]?.type === 'image')) {
      return helpers.createNode('paragraph', {}, helpers.parseInline(token.tokens ?? []))
    }
    return paragraphParser(token, helpers)
  }
})
export const RichCode = Code.extend({ excludes: 'code' })
const orderedTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer
const orderedStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)
export const RichOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...orderedTokenizer,
    tokenize(source, tokens, lexer) {
      return orderedStart.test(source) ? orderedTokenizer.tokenize(source, tokens, lexer) : undefined
    }
  }
})

/** 上游把任务清单的对齐续行识别成缩进代码，需要在建立节点前纠正。 */
function normalizeTaskToken(token: MarkdownToken, lexer: MarkdownLexerConfiguration): void {
  const nested = token.nestedTokens as MarkdownToken[] | undefined
  const first = nested?.[0]
  if (token.type === 'taskItem' && first?.type === 'code' && first.codeBlockStyle === 'indented' && typeof first.text === 'string') {
    first.type = 'paragraph'
    first.raw = first.text
    first.tokens = lexer.inlineTokens(first.text)
    delete first.codeBlockStyle
  }
  for (const child of [...(token.items ?? []), ...(nested ?? [])]) normalizeTaskToken(child, lexer)
}
const taskTokenizer = TaskList.config.markdownTokenizer as MarkdownTokenizer
export const RichTaskList = TaskList.extend({
  markdownTokenizer: {
    ...taskTokenizer,
    tokenize(source, tokens, lexer) {
      if (typeof taskTokenizer.start === 'function' && taskTokenizer.start(source) !== 0) return undefined
      const token = taskTokenizer.tokenize(source, tokens, lexer)
      if (token) normalizeTaskToken(token, lexer)
      return token
    }
  }
})

/** 原始 HTML 以只读文字节点保留；HTML 粘贴也只能从文字恢复值，不能注入标记。 */
export function rawSourceNode(codec: RichMarkdownCodec, inline: boolean) {
  const name = inline ? 'rawMarkdownInline' : 'rawMarkdownBlock'
  const kind = inline ? 'inline' : 'block'
  return Node.create({
    name, inline, group: inline ? 'inline' : 'block', atom: true,
    addAttributes: () => ({ value: { default: '', rendered: false } }),
    markdownTokenName: name,
    markdownTokenizer: {
      name, level: inline ? 'inline' : 'block',
      start: inline ? () => -1 : source => source.indexOf(`${codec.prefix}${kind}:`),
      tokenize(source) {
        const match = codec.match(source, kind)
        return match ? { type: name, raw: match.raw, text: match.value } : undefined
      }
    },
    parseMarkdown: (token, helpers) => helpers.createNode(name, { value: token.text ?? '' }),
    renderMarkdown: node => typeof node.attrs?.value === 'string' ? node.attrs.value : '',
    renderText: ({ node }) => String(node.attrs.value ?? ''),
    parseHTML: () => [{ tag: `${inline ? 'span' : 'div'}[data-rich-source="${kind}"]`, getAttrs: element => ({ value: element.textContent ?? '' }) }],
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { 'data-rich-source': kind, contenteditable: 'false', class: 'file-rich-raw-source' }, String(node.attrs.value ?? '')]
  })
}

const trailingKey = new PluginKey<DocumentNode | null>('fileRichTrailingParagraph')
export const RichTrailingParagraph = TrailingNode.extend({
  addProseMirrorPlugins() {
    const plugins = (this.parent?.() ?? []).map(plugin => {
      const append = plugin.spec.appendTransaction
      return !append ? plugin : new Plugin({
        ...plugin.spec,
        appendTransaction(transactions, oldState, state) {
          const transaction = append.call(plugin, transactions, oldState, state)
          if (transaction) transaction.setMeta(trailingKey, transaction.doc.lastChild)
          return transaction
        }
      })
    })
    return [...plugins, new Plugin<DocumentNode | null>({
      key: trailingKey,
      state: {
        init: () => null,
        apply(transaction, previous, oldState) {
          const inserted: unknown = transaction.getMeta(trailingKey)
          if (inserted === transaction.doc.lastChild && transaction.doc.lastChild) return transaction.doc.lastChild
          if (!previous || !transaction.docChanged) return previous
          let start = oldState.doc.content.size - previous.nodeSize
          let touched = false
          for (const map of transaction.mapping.maps) {
            map.forEach((from, to) => { if (from <= start + previous.nodeSize && to > start) touched = true })
            start = map.map(start, 1)
          }
          return !touched && transaction.doc.lastChild === previous ? previous : null
        }
      }
    })]
  }
})
export function hasSyntheticTrailing(editor: Editor): boolean { return !!editor.state.doc.lastChild && trailingKey.getState(editor.state) === editor.state.doc.lastChild }
export function restoreSyntheticTrailing(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(trailingKey, editor.state.doc.lastChild).setMeta('addToHistory', false))
}

/** 原子节点拖拽交回结构化编辑器，避免浏览器复制节点内部的展示 DOM。 */
export const RichDragGuard = Extension.create({
  name: 'fileRichDragGuard',
  addProseMirrorPlugins() {
    return [new Plugin({ props: { handleDOMEvents: { dragstart: (_view, event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.closest('button,input,textarea,select')) return false
      event.preventDefault()
      return true
    } } } })]
  }
})

export function serializationDocument(editor: Editor): DocumentNode {
  const doc = editor.state.doc
  const synthetic = trailingKey.getState(editor.state)
  return synthetic && doc.childCount > 1 && doc.lastChild === synthetic ? doc.copy(doc.content.cut(0, doc.content.size - synthetic.nodeSize)) : doc
}

/** 标题控件必须用装饰生成，不能在 ProseMirror 管理的文本节点里直接插按钮。 */
function headingDecorations(doc: DocumentNode): DecorationSet {
  const decorations: Decoration[] = []
  const used = new Set<string>()
  doc.descendants((node, position) => {
    if (node.type.name === 'blockquote') {
      const first = node.firstChild
      const text = first?.firstChild
      const marker = text?.isText ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text.text ?? '') : null
      if (marker && first) {
        const kind = (marker[1] ?? '').toUpperCase()
        const titles: Readonly<Record<string, string>> = { NOTE: '注意', TIP: '提示', IMPORTANT: '重要', WARNING: '警告', CAUTION: '危险' }
        decorations.push(Decoration.node(position, position + node.nodeSize, { class: 'is-callout', 'data-callout': kind }))
        decorations.push(Decoration.inline(position + 2, position + 2 + marker[0].length, { class: 'file-rich-callout-marker' }))
        if (first.textContent.trim() === marker[0].trim()) decorations.push(Decoration.node(position + 1, position + 1 + first.nodeSize, { class: 'file-rich-callout-empty-marker' }))
        decorations.push(Decoration.widget(position + 1, () => {
          const title = document.createElement('p')
          title.className = 'file-markdown-callout-title'
          title.contentEditable = 'false'
          title.textContent = titles[kind] ?? kind
          return title
        }, { side: -1, key: `callout:${position}:${kind}` }))
      }
    }
    if (node.type.name !== 'heading') return
    const label = node.textContent.trim()
    if (!label) return
    const base = headingSlug(label)
    let id = base
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`
    used.add(id)
    decorations.push(Decoration.node(position, position + node.nodeSize, { id }))
    decorations.push(Decoration.widget(position + node.nodeSize - 1, () => {
      const button = document.createElement('button')
      button.type = 'button'
      button.contentEditable = 'false'
      button.className = 'markdown-heading-anchor'
      button.dataset.linkKind = 'heading'
      button.dataset.linkTarget = `#${id}`
      button.setAttribute('aria-label', `复制标题引用：${label}`)
      button.title = '复制标题引用'
      button.textContent = '#'
      return button
    }, { side: 1, key: `${id}:${label}`, stopEvent: event => event.target instanceof Element && !!event.target.closest('.markdown-heading-anchor') }))
  })
  return DecorationSet.create(doc, decorations)
}
export const RichHeadingAnchors = Extension.create({
  name: 'fileHeadingAnchors',
  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>('fileHeadingAnchors')
    return [new Plugin({
      key,
      state: { init: (_, state) => headingDecorations(state.doc), apply: (transaction, previous) => transaction.docChanged ? headingDecorations(transaction.doc) : previous },
      props: { decorations: state => key.getState(state) ?? DecorationSet.empty }
    })]
  }
})
