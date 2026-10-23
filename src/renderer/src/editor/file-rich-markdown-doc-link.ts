/** 项目文档链接：双括号、别名、标题锚点与原位编辑；机制参考 ORCA，许可见 licenses/orca-MIT.txt。 */
import { Node } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'

export interface DocumentCatalog { entries: readonly string[]; loaded: boolean; truncated: boolean }
export function parseDocumentLink(body: string): { target: string; label: string | null } | null {
  const separator = body.indexOf('|')
  const target = (separator < 0 ? body : body.slice(0, separator)).trim()
  const label = separator < 0 ? null : body.slice(separator + 1).trim()
  return target && !/[\n\r[\]]/.test(target) && (separator < 0 || !!label) ? { target, label } : null
}
export function formatDocumentLink(target: string, label: string | null = null): string { return `[[${target}${label ? `|${label}` : ''}]]` }
const keyOf = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase()
const withoutExtension = (value: string): string => value.replace(/\.(md|markdown)$/i, '')
export function resolveDocumentLink(target: string, catalog: DocumentCatalog): { path: string; anchor: string | null } | null {
  const hash = target.indexOf('#')
  const file = hash < 0 ? target : target.slice(0, hash)
  const key = keyOf(file)
  let matches = catalog.entries.filter(path => keyOf(path) === key)
  if (!matches.length) matches = catalog.entries.filter(path => withoutExtension(keyOf(path)) === withoutExtension(key))
  if (!matches.length && !key.includes('/')) matches = catalog.entries.filter(path => withoutExtension(keyOf(path.split('/').at(-1) ?? '')) === withoutExtension(key))
  return matches.length === 1 && matches[0] ? { path: matches[0], anchor: hash < 0 ? null : target.slice(hash + 1) } : null
}

export function createDocumentLinkNodes(codec: RichMarkdownCodec, catalog: DocumentCatalog) {
  const literal = Node.create({
    name: 'markdownDocLiteral', inline: true, group: 'inline', atom: true,
    addAttributes: () => ({ value: { default: '' } }),
    markdownTokenName: 'markdownDocLiteral',
    markdownTokenizer: { name: 'markdownDocLiteral', level: 'inline', start: source => source.indexOf('\\[['), tokenize(source) {
      const match = /^\\\[\[[^\n]*?\]\]/.exec(source)
      return match ? { type: 'markdownDocLiteral', raw: match[0], text: match[0] } : undefined
    } },
    parseMarkdown: (token, helpers) => helpers.createNode('markdownDocLiteral', { value: token.text }),
    renderMarkdown: node => String(node.attrs?.value ?? ''),
    renderText: ({ node }) => String(node.attrs.value).slice(1),
    parseHTML: () => [{ tag: 'span[data-doc-literal]', getAttrs: element => ({ value: element.getAttribute('data-doc-literal') ?? '' }) }],
    renderHTML: ({ node }) => ['span', { 'data-doc-literal': node.attrs.value, contenteditable: 'false' }, String(node.attrs.value).slice(1)]
  })
  const link = Node.create({
    name: 'markdownDocLink', inline: true, group: 'inline', atom: true, selectable: true,
    addAttributes: () => ({ target: { default: '' }, label: { default: null } }),
    markdownTokenName: 'markdownDocLink',
    markdownTokenizer: { name: 'markdownDocLink', level: 'inline', start: source => source.indexOf('[['), tokenize(source) {
      if (source.startsWith(codec.prefix)) return undefined
      const match = /^\[\[([^\n[\]]+)\]\]/.exec(source)
      const parsed = match?.[1] ? parseDocumentLink(match[1]) : null
      return parsed && match ? { type: 'markdownDocLink', raw: match[0], text: parsed.target, label: parsed.label } : undefined
    } },
    parseMarkdown: (token, helpers) => helpers.createNode('markdownDocLink', { target: token.text, label: typeof token.label === 'string' ? token.label : null }),
    renderMarkdown: node => formatDocumentLink(String(node.attrs?.target ?? ''), typeof node.attrs?.label === 'string' ? node.attrs.label : null),
    renderText: ({ node }) => String(node.attrs.label || node.attrs.target),
    parseHTML: () => [{ tag: 'span[data-doc-target]', getAttrs: element => ({ target: element.getAttribute('data-doc-target') ?? '', label: element.getAttribute('data-doc-label') }) }],
    renderHTML: ({ node }) => ['span', { 'data-doc-target': node.attrs.target, 'data-doc-label': node.attrs.label, 'data-link-kind': 'document', 'data-link-target': node.attrs.target, class: 'markdown-link file-rich-doc-link', contenteditable: 'false' }, String(node.attrs.label || node.attrs.target)],
    addProseMirrorPlugins() {
      return [new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft','ArrowRight'].includes(event.key)) return false
            const selection = view.state.selection
            if (!(selection instanceof TextSelection) || !selection.empty) return false
            const before = event.key === 'ArrowLeft'
            const adjacent = before ? selection.$from.nodeBefore : selection.$from.nodeAfter
            if (adjacent?.type.name !== 'markdownDocLink') return false
            const text = formatDocumentLink(String(adjacent.attrs.target), adjacent.attrs.label)
            const from = before ? selection.from - adjacent.nodeSize : selection.from
            const tr = view.state.tr.replaceWith(from, from + adjacent.nodeSize, view.state.schema.text(text, adjacent.marks))
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, before ? from + text.length - 2 : from + 2)))
            return true
          },
          decorations(state) {
            const decorations: Decoration[] = []
            if (catalog.loaded) state.doc.descendants((node, pos) => {
              if (node.type.name !== 'markdownDocLink') return
              const missing = !resolveDocumentLink(String(node.attrs.target), catalog)
              if (missing) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: catalog.truncated ? 'is-unresolved' : 'is-missing', title: catalog.truncated ? '索引未完整，目标尚未确认' : '文档不存在或名称有歧义' }))
            })
            return DecorationSet.create(state.doc, decorations)
          }
        },
        appendTransaction(transactions, _oldState, state) {
          if (!transactions.some(tr => tr.docChanged || tr.selectionSet)) return null
          const tr = state.tr
          state.doc.descendants((node, pos, parent) => {
            if (!node.isText || parent?.type.name === 'codeBlock' || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return
            for (const match of (node.text ?? '').matchAll(/\[\[([^\n[\]]+)\]\]/g)) {
              const from = pos + (match.index ?? 0)
              const to = from + match[0].length
              if (state.selection.from > from && state.selection.from <= to) continue
              const parsed = parseDocumentLink(match[1] ?? '')
              const backslashes = node.text?.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0
              const escaped = backslashes % 2 === 1
              const type = escaped ? state.schema.nodes.markdownDocLiteral : state.schema.nodes.markdownDocLink
              if (parsed && type) tr.replaceWith(tr.mapping.map(escaped ? from - 1 : from), tr.mapping.map(to), type.create(escaped ? { value: `\\${match[0]}` } : parsed, null, node.marks))
            }
          })
          return tr.docChanged ? tr : null
        }
      })]
    }
  })
  return [literal, link]
}
