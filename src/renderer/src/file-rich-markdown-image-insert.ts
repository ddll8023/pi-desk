/** 异步图片与浮层的插入目标：跟随事务映射，文件切换或目标删除后失效，不借用当前光标。 */
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { importMarkdownImage } from './services/project-file'

export function captureRichInsertion(editor: Editor, valid: () => boolean) {
  let from = editor.state.selection.from
  let to = editor.state.selection.to
  let cell = editor.state.selection instanceof CellSelection ? editor.state.selection : null
  let alive = true
  const map = ({ transaction }: { transaction: Transaction }): void => {
    if (!alive) return
    if (cell) {
      const selection = cell.map(transaction.doc, transaction.mapping)
      if (!(selection instanceof CellSelection)) { alive = false; return }
      cell = selection
    }
    const start = transaction.mapping.mapResult(from, 1)
    const end = transaction.mapping.mapResult(to, from === to ? 1 : -1)
    if (start.deletedAcross || end.deletedAcross || (from !== to && start.deletedAfter && end.deletedBefore) || start.pos > end.pos) alive = false
    from = start.pos; to = end.pos
  }
  editor.on('transaction', map)
  return {
    range: () => alive && !editor.isDestroyed && valid() && to <= editor.state.doc.content.size ? { from, to, cell } : null,
    release: () => { alive = false; editor.off('transaction', map) }
  }
}
const queues = new WeakMap<Editor, Promise<void>>()
export function insertRichImage(editor: Editor, projectPath: string, path: string, valid: () => boolean, notice: (message: string) => void, bytes?: () => Promise<Uint8Array>): void {
  const target = captureRichInsertion(editor, valid)
  // 输入顺序决定导入与插入顺序，不能让较快的第二张图片越过第一张。
  const task = (queues.get(editor) ?? Promise.resolve()).then(async () => {
    if (!target.range()) return
    const snapshot = bytes ? await bytes() : undefined
    if (!target.range()) return
    const result = await importMarkdownImage(projectPath, path, snapshot)
    if (!result.ok) { if (valid()) notice(result.error.message); return }
    if (!result.data.reference) return
    const range = target.range()
    if (!range) { notice(`图片已导入 ${result.data.path ?? ''}，原插入位置已失效，未修改正文。`); return }
    const selection = editor.state.selection
    const atTarget = selection.from === range.from && selection.to === range.to
    const image = { type: 'image', attrs: { src: result.data.reference, alt: '图片', title: null } }
    const imageType = editor.schema.nodes.image
    if (!imageType) { notice(`图片已导入 ${result.data.path ?? ''}，但当前编辑器不支持图片节点。`); return }
    const inserted = range.cell
      ? editor.commands.command(({ tr }) => { const liveSelection = tr.selection; range.cell?.replaceWith(tr, imageType.create(image.attrs)); if (!atTarget) tr.setSelection(liveSelection.map(tr.doc, tr.mapping)); return true })
      : editor.commands.insertContentAt({ from: range.from, to: range.to }, image, { updateSelection: atTarget })
    if (!inserted) notice(`图片已导入 ${result.data.path ?? ''}，但无法在原位置插入。`)
  }).catch(error => notice(error instanceof Error ? error.message : String(error))).finally(target.release)
  queues.set(editor, task)
}
