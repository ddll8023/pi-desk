/** 可恢复富文本草稿：保存文档结构而非仅保存已成功序列化的 Markdown，只在当前窗口内使用。 */
import type { Editor, JSONContent } from '@tiptap/core'
import { EditorState, Selection } from '@tiptap/pm/state'
import type { RichSourceBaseline } from './file-rich-markdown-source'
import { hasSyntheticTrailing, restoreSyntheticTrailing } from './file-rich-markdown-nodes'

export interface RichMarkdownDraft {
  readonly text: string
  readonly frontmatter: string
  readonly document: JSONContent
  readonly selection: Record<string, unknown>
  readonly baseline: RichSourceBaseline
  readonly syntheticTrailing: boolean
}

export function captureRichDraft(editor: Editor, text: string, frontmatter: string, baseline: RichSourceBaseline): RichMarkdownDraft {
  return { text, frontmatter, document: editor.getJSON(), selection: editor.state.selection.toJSON(), baseline: { ...baseline }, syntheticTrailing: hasSyntheticTrailing(editor) }
}

/** Vue Tiptap 的 state 是事务驱动缓存；替换文档时同步该缓存，不能只更新底层 view。 */
export function replaceRichEditorState(editor: Editor, nextState: EditorState): void {
  editor.emit('beforeTransaction', { editor, transaction: nextState.tr, nextState })
  editor.view.updateState(nextState)
}

/** 只准备恢复状态，不修改现有实例；JSON 草稿严格检查，不套用 Markdown 的标记修正规则。 */
export function prepareRichDraft(editor: Editor, draft: RichMarkdownDraft): EditorState {
  const doc = editor.schema.nodeFromJSON(draft.document)
  doc.check()
  let selection: Selection
  try { selection = Selection.fromJSON(doc, draft.selection) } catch { selection = Selection.atEnd(doc) }
  return EditorState.create({ schema: editor.schema, doc, selection, plugins: editor.state.plugins })
}

/**
 * 接管由 prepareRichDraft 为同一编辑器和草稿准备的 prepared 状态，恢复文档、选区及文末输入区标记。
 * 会话须先完成文档检查与基线准备；本函数不删除窗口中保存的恢复草稿。
 */
export function restoreRichDraft(editor: Editor, draft: RichMarkdownDraft, prepared: EditorState): void {
  replaceRichEditorState(editor, prepared)
  if (draft.syntheticTrailing) restoreSyntheticTrailing(editor)
}
