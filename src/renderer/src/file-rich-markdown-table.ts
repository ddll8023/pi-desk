/** 表格结构命令：悬浮与右键入口共用目标校验，保护 Markdown 表头并支持多格选择。 */
import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { CellSelection, TableMap } from '@tiptap/pm/tables'
export type RichTableAction = 'row-before' | 'row-after' | 'row-delete' | 'column-before' | 'column-after' | 'column-delete' | 'table-delete'
export const richTableActions: readonly { id: RichTableAction; label: string }[] = [
  { id: 'row-before', label: '在上方插入行' }, { id: 'row-after', label: '在下方插入行' }, { id: 'row-delete', label: '删除行' },
  { id: 'column-before', label: '在左侧插入列' }, { id: 'column-after', label: '在右侧插入列' }, { id: 'column-delete', label: '删除列' }, { id: 'table-delete', label: '删除整个表格' }
]
export function tableCellPosition(editor: Editor, element: Element): number | null {
  try {
    const cell = element.closest('td,th')
    if (!cell || !editor.view.dom.contains(cell)) return null
    const resolved = editor.state.doc.resolve(editor.view.posAtDOM(cell, 0))
    for (let depth = resolved.depth; depth > 0; depth--) if (['cell','header_cell'].includes(String(resolved.node(depth).type.spec.tableRole))) return resolved.before(depth)
  } catch { /* 悬浮目标可能已被删除。 */ }
  return null
}
/** 文本拖选跨越多个单元格时也按单元格矩形处理，不能只删除右键所在的那一行。 */
function multiCellSelection(editor: Editor): CellSelection | null {
  const selection = editor.state.selection
  if (selection instanceof CellSelection) return selection
  if (selection.empty) return null
  const position = (resolved: typeof selection.$from): number | null => {
    for (let depth = resolved.depth; depth > 0; depth--) if (['cell','header_cell'].includes(String(resolved.node(depth).type.spec.tableRole))) return resolved.before(depth)
    return null
  }
  const from = position(selection.$anchor); const to = position(selection.$head)
  if (from === null || to === null || from === to) return null
  try { return CellSelection.create(editor.state.doc, from, to) } catch { return null }
}
export function richTableContext(editor: Editor, cellPosition: number) {
  if (cellPosition < 0 || cellPosition >= editor.state.doc.content.size) return null
  const resolved = editor.state.doc.resolve(cellPosition + 1)
  for (let depth = resolved.depth; depth > 0; depth--) {
    const table = resolved.node(depth)
    if (table.type.spec.tableRole !== 'table') continue
    const position = resolved.before(depth)
    const map = TableMap.get(table)
    const header = table.firstChild?.firstChild?.type.spec.tableRole === 'header_cell'
    const selected = new Set<number>()
    const selection = multiCellSelection(editor)
    if (selection) selection.forEachCell((_node, pos) => selected.add(pos))
    if (!selected.has(cellPosition)) { selected.clear(); selected.add(cellPosition) }
    const rows = new Set<number>(); const columns = new Set<number>()
    map.map.forEach((offset, index) => { if (selected.has(position + 1 + offset)) { rows.add(Math.floor(index / map.width)); columns.add(index % map.width) } })
    return { table, position, map, header, rows, columns, selected }
  }
  return null
}
export function canRunTableAction(editor: Editor, action: RichTableAction, cell: number): boolean {
  const context = richTableContext(editor, cell)
  if (!context || !editor.isEditable) return false
  if (action === 'row-before' && context.header && context.rows.has(0)) return false
  if (action === 'row-delete' && context.header && context.rows.has(0) && context.rows.size < context.map.height) return false
  return true
}
export function runTableAction(editor: Editor, action: RichTableAction, cell: number): boolean {
  const selection = multiCellSelection(editor)
  if (selection && !selection.eq(editor.state.selection)) editor.view.dispatch(editor.state.tr.setSelection(selection))
  if (!canRunTableAction(editor, action, cell)) return false
  const context = richTableContext(editor, cell)
  if (!context) return false
  if (!(editor.state.selection instanceof CellSelection) || !context.selected.has(editor.state.selection.$anchorCell.pos)) {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cell + 1))))
  }
  const chain = editor.chain().focus()
  switch (action) {
    case 'row-before': return chain.addRowBefore().run()
    case 'row-after': return chain.addRowAfter().run()
    case 'row-delete': return context.rows.size >= context.map.height ? chain.deleteTable().run() : chain.deleteRow().run()
    case 'column-before': return chain.addColumnBefore().run()
    case 'column-after': return chain.addColumnAfter().run()
    case 'column-delete': return context.columns.size >= context.map.width ? chain.deleteTable().run() : chain.deleteColumn().run()
    case 'table-delete': return chain.deleteTable().run()
  }
}
