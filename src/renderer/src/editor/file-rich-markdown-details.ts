/** 折叠块的结构化 Markdown 编辑：标题、正文和退出规则参考 ORCA；原始属性只用于源码回写，不进入 DOM。 */
import { decodeHtmlEntities } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { TextSelection } from '@tiptap/pm/state'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { escapeHtml } from '../ui/markdown-shared'

/** 查找配对结束标签，跳过注释、围栏代码与行内代码中的伪标签。 */
export function matchRichDetails(source: string): { raw: string; attributes: string; inner: string } | null {
  const opening = /^ {0,3}<details\b([^>]*)>/i.exec(source)
  if (!opening) return null
  const markers = /<!--[\s\S]*?-->|^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)[^\n]*?\2(?!`)|<\/?(?:details|pre|code)\b[^>]*>/gim
  markers.lastIndex = opening[0].length
  let depth = 1
  let fence = ''
  let rawCode = ''
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
    const closing = tag[1] === '/'
    const name = tag[2]?.toLowerCase() ?? ''
    if (rawCode) { if (closing && name === rawCode) rawCode = ''; continue }
    if (name !== 'details') { if (!closing) rawCode = name; continue }
    depth += closing ? -1 : 1
    if (depth === 0) return { raw: source.slice(0, markers.lastIndex), attributes: opening[1] ?? '', inner: source.slice(opening[0].length, match.index) }
  }
  return null
}

function summaryToBody(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection
  if (!empty || $from.parent.type.name !== 'detailsSummary') return false
  const depth = $from.depth - 1
  const node = $from.node(depth)
  if (node.type.name !== 'details' || !node.attrs.open) return false
  const position = $from.before(depth) + 1 + node.child(0).nodeSize + 2
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(position))).scrollIntoView())
  return true
}

function leaveEmptyBody(editor: Editor, backward: boolean): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock || $from.parent.content.size || $from.depth < 3) return false
  const contentDepth = $from.depth - 1
  const content = $from.node(contentDepth)
  const depth = contentDepth - 1
  const details = $from.node(depth)
  if (content.type.name !== 'detailsContent' || details.type.name !== 'details') return false
  const tr = state.tr
  if (backward) {
    if (content.childCount !== 1) return false
    const target = $from.before(depth) + details.child(0).nodeSize
    tr.setSelection(TextSelection.near(tr.doc.resolve(target), -1))
  } else {
    if ($from.index(contentDepth) !== content.childCount - 1) return false
    const paragraph = state.schema.nodes.paragraph?.createAndFill()
    if (!paragraph) return false
    let position = $from.after(depth)
    if (content.childCount > 1) {
      const from = $from.before($from.depth)
      const to = $from.after($from.depth)
      tr.delete(from, to)
      position -= to - from
    }
    tr.insert(position, paragraph).setSelection(TextSelection.create(tr.doc, position + 1))
  }
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

export function createRichDetails(codec: RichMarkdownCodec) {
  const RichDetails = Details.extend({
    priority: 1000,
    addAttributes() {
      return { ...this.parent?.(), sourceAttributes: { default: '', rendered: false } }
    },
    addKeyboardShortcuts() {
      const parent = this.parent?.() ?? {}
      return { ...parent, Enter: ({ editor }) => summaryToBody(editor) || parent.Enter?.({ editor }) || false }
    },
    markdownTokenName: 'details',
    markdownTokenizer: {
      name: 'details', level: 'block', start(source) {
        const raw = source.search(/<details\b/i)
        const encoded = source.indexOf(`${codec.prefix}details:`)
        return raw < 0 ? encoded : encoded < 0 ? raw : Math.min(raw, encoded)
      },
      tokenize(source, _tokens, lexer) {
        const transported = codec.match(source, 'details')
        const block = matchRichDetails(transported?.value ?? source)
        if (!block) return undefined
        const summary = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*/i.exec(block.inner)
        if (!summary) return { type: 'rawMarkdownBlock', raw: transported?.raw ?? block.raw, text: block.raw }
        return {
          type: 'details', raw: transported?.raw ?? block.raw,
          attributes: block.attributes,
          open: /(?:^|\s)open(?:\s|=|$)/i.test(block.attributes),
          summaryTokens: lexer.inlineTokens(codec.prepareInline(decodeHtmlEntities(summary[1] ?? ''))),
          bodyTokens: lexer.blockTokens(codec.prepare(block.inner.slice(summary[0].length)))
        }
      }
    },
    parseMarkdown(token, helpers) {
      const body = helpers.parseChildren(token.bodyTokens ?? [])
      return helpers.createNode('details', { open: token.open === true, sourceAttributes: token.attributes ?? '' }, [
        helpers.createNode('detailsSummary', {}, helpers.parseInline(token.summaryTokens ?? [])),
        helpers.createNode('detailsContent', {}, body.length ? body : [helpers.createNode('paragraph')])
      ])
    },
    renderMarkdown(node, helpers) {
      const summary = node.content?.find(child => child.type === 'detailsSummary')
      const content = node.content?.find(child => child.type === 'detailsContent')
      const attributes = String(node.attrs?.sourceAttributes ?? '').replace(/(?:^|\s)open(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+))?/gi, '').trim()
      const attrs = [attributes, node.attrs?.open ? 'open' : ''].filter(Boolean).join(' ')
      return `<details${attrs ? ` ${attrs}` : ''}>\n<summary>${escapeHtml(helpers.renderChildren(summary?.content ?? [], ''))}</summary>\n\n${helpers.renderChildren(content?.content ?? [], '\n\n')}\n\n</details>`
    }
  }).configure({
    persist: true,
    HTMLAttributes: { class: 'file-rich-details' },
    renderToggleButton: ({ element, isOpen }) => { element.setAttribute('aria-label', isOpen ? '折叠内容' : '展开内容'); element.textContent = isOpen ? '▾' : '▸' }
  })
  return [RichDetails, DetailsSummary.extend({
    content: 'inline*',
    markdownTokenizer: { name: 'detailsSummary', tokenize: () => undefined }
  }), DetailsContent.extend({
    priority: 1000,
    markdownTokenizer: { name: 'detailsContent', tokenize: () => undefined },
    addKeyboardShortcuts() {
      const parent = this.parent?.() ?? {}
      return {
        ...parent,
        Enter: ({ editor }) => leaveEmptyBody(editor, false) || parent.Enter?.({ editor }) || false,
        Backspace: ({ editor }) => leaveEmptyBody(editor, true) || parent.Backspace?.({ editor }) || false
      }
    }
  })]
}
