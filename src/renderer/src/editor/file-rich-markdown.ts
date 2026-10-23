/** 文件富文本的节点组装与交互接线；Markdown 转换独立于页面和编辑器生命周期，不影响聊天 Markdown。 */
import type { Editor, EditorOptions } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { RichSearch } from './file-rich-markdown-search'
import { createDocumentLinkNodes } from './file-rich-markdown-doc-link'
import type { DocumentCatalog } from './file-rich-markdown-doc-link'
import { RichDragGuard } from './file-rich-markdown-nodes'
import TaskItem from '@tiptap/extension-task-item'
import { TableKit } from '@tiptap/extension-table'
import { createRichMarkdownExtension } from './file-rich-markdown-parser'
import type { MarkdownFailure } from './file-markdown-view'
import { classifyLinkKind } from './file-markdown-links'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'
import { createRichCodeBlock } from './file-rich-markdown-code'
import { createRichDetails } from './file-rich-markdown-details'
import { createRichMedia } from './file-rich-markdown-media'
import type { RichMediaContext } from './file-rich-markdown-media'
import { RichCode, RichHeadingAnchors, RichOrderedList, RichParagraph, RichTaskList, RichTrailingParagraph, rawSourceNode } from './file-rich-markdown-nodes'
import { handleRichKey } from './file-rich-markdown-keyboard'
import type { RichKeyboardState } from './file-rich-markdown-keyboard'
import { copyRichSelection, pasteRichContent } from './file-rich-markdown-clipboard'

interface RichEditorContext extends RichMediaContext {
  readonly codec: RichMarkdownCodec
  readonly keyboard: RichKeyboardState
  readonly catalog: DocumentCatalog
  keydown: (event: KeyboardEvent) => boolean
  openLink: (position?: number) => void
  pasteImage: (file: File) => void
  editor: () => Editor | null
  error: (message: string) => void
  contentFailure: (failure: MarkdownFailure) => void
  copy: (text: string) => void
}

export function richEditorOptions(context: RichEditorContext): Pick<EditorOptions, 'extensions' | 'editorProps'> {
  const RichLink = Link.extend({
    addAttributes() { return { ...this.parent?.(), title: { default: null } } },
    // Mark 扩展的渲染参数只有 mark 与 HTMLAttributes（没有 node），链接地址只能从 mark.attrs 取。
    renderHTML({ mark }) {
      const address = String(mark.attrs.href ?? '')
      return ['a', { class: 'markdown-link', 'data-link-target': address, 'data-link-kind': classifyLinkKind(address), title: mark.attrs.title || null }, 0]
    },
    parseHTML() {
      return [{ tag: 'a[data-link-target]', getAttrs: element => ({ href: element.getAttribute('data-link-target') ?? '' }) }, ...(this.parent?.() ?? [])]
    }
  }).configure({ openOnClick: false, autolink: true, linkOnPaste: true })
  return {
    extensions: [
      StarterKit.configure({ link: false, code: false, codeBlock: false, orderedList: false, paragraph: false, trailingNode: false, underline: false }),
      RichParagraph, RichCode, RichOrderedList, RichTaskList,
      // TaskItem 的编辑态 NodeView 不会沿用 renderHTML 中的类型标识，需显式配置以匹配任务项布局。
      TaskItem.configure({
        nested: true,
        HTMLAttributes: { 'data-type': 'taskItem' },
        a11y: { checkboxLabel: (_node, checked) => checked ? '已完成任务' : '未完成任务' }
      }),
      RichTrailingParagraph, RichHeadingAnchors, RichLink,
      createRichCodeBlock(), ...createRichMedia(context), ...createRichDetails(context.codec),
      RichSearch, RichDragGuard, ...createDocumentLinkNodes(context.codec, context.catalog),
      Placeholder.configure({ includeChildren: true, placeholder: ({ node }) => node.type.name === 'detailsSummary' ? '折叠标题' : node.type.name === 'paragraph' ? '输入 / 插入内容…' : '' }),
      TableKit.configure({ table: { resizable: false } }),
      rawSourceNode(context.codec, true), rawSourceNode(context.codec, false), createRichMarkdownExtension(context.codec, context.contentFailure)
    ],
    editorProps: {
      attributes: { class: 'markdown-content markdown-body file-markdown-body file-rich-body', role: 'textbox', 'aria-label': 'Markdown 文档，可直接编辑', 'aria-multiline': 'true', spellcheck: 'false' },
      handleKeyDown: (_view, event) => {
        const editor = context.editor()
        if (!editor) return false
        if (context.keydown(event)) return true
        if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229 && !editor.view.composing && editor.state.selection instanceof NodeSelection) {
          const selection = editor.state.selection
          const type = selection.node.type.name
          if (type === 'inlineMath' || type === 'blockMath') {
            event.preventDefault()
            context.editMath({ position: selection.from, type, latex: String(selection.node.attrs.latex ?? '') })
            return true
          }
        }
        return handleRichKey(editor, event, context.keyboard)
      },
      handleClick: (view, position, event) => {
        const target = event.target
        if (!(target instanceof Element) || event.metaKey || event.ctrlKey) return false
        if (target.closest('.markdown-link')?.getAttribute('data-link-kind') !== 'document' && target.closest('.markdown-link')) context.openLink(position)
        if (target === view.dom) view.focus()
        return false
      },
      handleTextInput(view, from, to, text) {
        context.keyboard.typedOrderedMarker = text === ' ' && from === to && /^\d+\.$/.test(view.state.selection.$from.parent.textBetween(0, view.state.selection.$from.parentOffset))
        return false
      },
      handlePaste: (_view, event) => {
        const editor = context.editor()
        return editor ? pasteRichContent(editor, event, context.codec, context.error, context.pasteImage) : false
      },
      handleDOMEvents: {
        copy: (_view, event) => { const editor = context.editor(); return editor ? copyRichSelection(editor, event, false, context.error) : false },
        cut: (_view, event) => { const editor = context.editor(); return editor ? copyRichSelection(editor, event, true, context.error) : false }
      }
    }
  }
}
