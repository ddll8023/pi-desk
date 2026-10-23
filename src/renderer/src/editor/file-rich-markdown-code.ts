/** 富文本代码块：内容由 ProseMirror 管理，高亮通过位置装饰显示，复制控件不参与文档序列化。 */
import { CodeBlock } from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import FileRichMarkdownCodeBlock from './components/FileRichMarkdownCodeBlock.vue'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { codeHighlightRanges } from './file-code-highlight'

export function createRichCodeBlock() {
  return CodeBlock.extend({
    addNodeView() { return VueNodeViewRenderer(FileRichMarkdownCodeBlock) },
    renderMarkdown(node) {
      const text = node.content?.map(child => child.text ?? '').join('') ?? ''
      const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
      const fence = '`'.repeat(Math.max(3, longest + 1))
      const language = String(node.attrs?.language ?? '').replace(/[\r\n`]/g, '')
      return `${fence}${language}\n${text}\n${fence}`
    },
    addProseMirrorPlugins() {
      const parent = this.parent?.() ?? []
      const key = new PluginKey<DecorationSet>('fileRichCodeHighlight')
      return [...parent, new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(transaction, previous) {
            const update: unknown = transaction.getMeta(key)
            if (update instanceof DecorationSet) return update
            return transaction.docChanged ? previous.map(transaction.mapping, transaction.doc) : previous
          }
        },
        props: { decorations: state => key.getState(state) ?? DecorationSet.empty },
        view(initialView) {
          let disposed = false
          let generation = 0
          const refresh = async (view: EditorView): Promise<void> => {
            const current = ++generation
            const doc = view.state.doc
            const jobs: Promise<Decoration[]>[] = []
            let total = 0
            doc.descendants((node, position) => {
              if (node.type.name !== 'codeBlock' || jobs.length >= 200 || total + node.textContent.length > 1_000_000) return
              total += node.textContent.length
              jobs.push(codeHighlightRanges(node.textContent, String(node.attrs.language ?? '')).then(ranges => ranges.map(range => Decoration.inline(position + 1 + range.from, position + 1 + range.to, { class: range.className }))))
            })
            const decorations = (await Promise.all(jobs)).flat()
            if (disposed || current !== generation || view.isDestroyed || view.state.doc !== doc) return
            view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(doc, decorations)).setMeta('addToHistory', false))
          }
          void refresh(initialView)
          return {
            update(view, previous) { if (view.state.doc !== previous.doc) void refresh(view) },
            destroy() { disposed = true; generation += 1 }
          }
        }
      })]
    }
  }).configure({ defaultLanguage: null, enableTabIndentation: true, tabSize: 2 })
}
