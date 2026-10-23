/** 富文本剪贴板：结构化复制、清洗 HTML 与 Markdown 粘贴；图片字节交给受控导入，不直接读取外部路径或远程资源。 */
import DOMPurify from 'dompurify'
import { PROJECT_FILE_IMAGE_MAX_BYTES } from '../../../shared/project-file-api'
import { DOMSerializer } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/core'
import type { RichMarkdownCodec } from './file-rich-markdown-codec'

/** 只有剪贴板写入完成才删除选区；不能让复制失败变成内容丢失。 */
export function copyRichSelection(editor: Editor, event: ClipboardEvent, cut: boolean, onError: (message: string) => void): boolean {
  const data = event.clipboardData
  const selected = window.getSelection()?.anchorNode
  const selectionElement = selected instanceof Element ? selected : selected?.parentElement
  // 阻止 ProseMirror 的默认剪切处理，但保留浏览器对只读图表/公式文字的原生复制。
  if (selected?.getRootNode() instanceof ShadowRoot || selectionElement?.closest('[contenteditable="false"]')) return true
  const { state } = editor
  if (!data || state.selection.empty || editor.view.composing) return false
  try {
    const slice = state.selection.content()
    const markdown = editor.markdown?.serialize({ type: 'doc', content: slice.content.toJSON() })
      ?? state.doc.textBetween(state.selection.from, state.selection.to, '\n\n')
    const holder = document.createElement('div')
    holder.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content))
    data.setData('text/plain', markdown)
    data.setData('text/html', holder.innerHTML)
    event.preventDefault()
    if (cut && editor.isEditable) editor.view.dispatch(state.tr.deleteSelection().scrollIntoView())
    return true
  } catch (error) {
    onError(`无法复制内容：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export function pasteRichContent(editor: Editor, event: ClipboardEvent, codec: RichMarkdownCodec, onError: (message: string) => void, onImage: (file: File) => void): boolean {
  if (!event.clipboardData || editor.view.composing) return false
  const image = Array.from(event.clipboardData.files).find(file => file.type.startsWith('image/'))
  if (image && !editor.isActive('codeBlock')) {
    event.preventDefault()
    if (image.size > PROJECT_FILE_IMAGE_MAX_BYTES) onError('图片超过导入上限。')
    else onImage(image)
    return true
  }
  const text = event.clipboardData.getData('text/plain')
  const html = event.clipboardData.getData('text/html')
  if (!text && !html) {
    if (event.clipboardData.files.length) { event.preventDefault(); onError('此位置或剪贴板文件类型不支持图片插入。'); return true }
    return false
  }
  event.preventDefault()
  try {
    if (editor.isActive('codeBlock')) {
      editor.view.dispatch(editor.state.tr.insertText(text).scrollIntoView())
    } else if (html) {
      const clean = DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'label', 'input', 'details', 'summary'],
        ALLOWED_ATTR: ['class', 'href', 'src', 'alt', 'title', 'start', 'type', 'checked', 'data-type', 'data-checked', 'data-file-image', 'data-image-reference', 'data-alt', 'data-title', 'data-link-target', 'data-link-kind', 'data-file-math', 'data-latex', 'data-display', 'data-rich-source', 'data-doc-target', 'data-doc-label', 'data-doc-literal'],
        ALLOW_DATA_ATTR: false
      })
      editor.commands.insertContent(clean, { contentType: 'html', parseOptions: { preserveWhitespace: true } })
    } else {
      const prepared = codec.prepare(text.replace(/\r\n?/g, '\n'))
      const json = editor.markdown?.parse(prepared)
      if (!json) throw new Error('Markdown 解析器尚未就绪。')
      const content = json.content ?? []
      const first = content[0]
      editor.commands.insertContent(content.length === 1 && first?.type === 'paragraph' ? first.content ?? [] : content)
    }
    return true
  } catch (error) {
    onError(`无法粘贴内容：${error instanceof Error ? error.message : String(error)}`)
    return true
  }
}
