/** 整篇文档的键盘结构操作：列表与表格规则参考 ORCA；普通 Enter 交还 Tiptap，不再提交单个输入块。 */
import type { Editor } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { isInTable, moveCellForward, nextCell, selectionCell } from '@tiptap/pm/tables'

type ItemType = 'listItem' | 'taskItem'
function listContext(editor: Editor) {
  const { $from } = editor.state.selection
  let item: { type: ItemType; depth: number } | null = null
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name
    if (name !== 'listItem' && name !== 'taskItem') continue
    if (!item) item = { type: name, depth }
    else return { ...item, parentType: name, parentList: $from.node(depth - 1) }
  }
  return item ? { ...item, parentType: null, parentList: null } : null
}

function outdentList(editor: Editor): boolean {
  const context = listContext(editor)
  if (!context) return false
  if (!context.parentType || context.parentType === context.type || !context.parentList) return editor.commands.liftListItem(context.type)
  // 混合任务/普通列表提升前先分离当前子树，不能把仍留在原层级的兄弟项一起改类型。
  let { $from } = editor.state.selection
  if ($from.index(context.depth - 1) > 0) editor.view.dispatch(editor.state.tr.split($from.before(context.depth), 1))
  const state = editor.state
  $from = state.selection.$from
  const position = $from.before(context.depth - 1)
  const list = state.doc.nodeAt(position)
  const itemType = state.schema.nodes[context.parentType]
  if (!list || !itemType) return false
  const items = list.children.map(item => itemType.create(null, item.content, item.marks))
  const replacement = context.parentList.type.create(context.parentList.attrs, Fragment.from(items), list.marks)
  const tr = state.tr.replaceWith(position, position + list.nodeSize, replacement)
  tr.setSelection(TextSelection.create(tr.doc, state.selection.from, state.selection.to))
  editor.view.dispatch(tr)
  return editor.commands.liftListItem(context.parentType)
}

function emptyOrderedContext(editor: Editor) {
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parent.content.size || selection.$from.parent.type.name !== 'paragraph') return null
  const { $from } = selection
  const context = listContext(editor)
  if (!context || context.type !== 'listItem') return null
  const listDepth = context.depth - 1
  const list = $from.node(listDepth)
  return list.type.name === 'orderedList' ? { ...context, listDepth, list, item: $from.node(context.depth) } : null
}
export function isSingleEmptyOrderedList(editor: Editor): boolean {
  const context = emptyOrderedContext(editor)
  return !!context && !context.parentType && context.list.childCount === 1 && context.item.childCount === 1
}

function orderedEnter(editor: Editor, typedMarker: boolean): boolean {
  const context = emptyOrderedContext(editor)
  if (!context || context.parentType || context.item.childCount !== 1) return false
  const { state } = editor
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  const { $from } = state.selection
  const from = $from.before(context.listDepth)
  const to = $from.after(context.listDepth)
  if (typedMarker && context.list.childCount === 1) {
    const marker = paragraph.create(null, state.schema.text(`${context.list.attrs.start ?? 1}.`))
    const tr = state.tr.replaceWith(from, to, [marker, paragraph.create()])
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + marker.nodeSize + 1)).scrollIntoView())
    return true
  }
  if (context.list.childCount > 1 && $from.index(context.listDepth) === context.list.childCount - 1) {
    const remaining = context.list.copy(context.list.content.cut(0, context.list.content.size - context.item.nodeSize))
    const tr = state.tr.replaceWith(from, to, [remaining, paragraph.create()])
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + remaining.nodeSize + 1)).scrollIntoView())
    return true
  }
  return false
}

function orderedBackspace(editor: Editor): boolean {
  const context = emptyOrderedContext(editor)
  if (!context) return false
  const { state } = editor
  const { $from } = state.selection
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  if (context.parentType === 'listItem' && context.list.childCount === 1) {
    const from = $from.before(context.listDepth)
    const tr = state.tr.replaceWith(from, $from.after(context.listDepth), paragraph.create())
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView())
    return true
  }
  const index = $from.index(context.depth)
  if (index > 0 && context.item.child(index - 1).type.name === 'paragraph') {
    const from = $from.before($from.depth)
    const tr = state.tr.delete(from, $from.after($from.depth))
    editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from - 1)).scrollIntoView())
    return true
  }
  return false
}

function tableEnter(editor: Editor): boolean {
  if (!isInTable(editor.state)) return false
  const moveDown = (): boolean => {
    const state = editor.state
    const next = nextCell(selectionCell(state), 'vert', 1)
    if (!next) return false
    editor.view.dispatch(state.tr.setSelection(TextSelection.between(next, moveCellForward(next))).scrollIntoView())
    return true
  }
  if (!moveDown() && editor.can().addRowAfter()) { editor.commands.addRowAfter(); moveDown() }
  return true
}

/** 仅删除空结构，不把图片或原子节点误判为空单元格。 */
function tableBackspace(editor: Editor): boolean {
  const { state } = editor
  if (!state.selection.empty || !isInTable(state)) return false
  const cell = selectionCell(state)
  const empty = (node: import('@tiptap/pm/model').Node): boolean => node.children.every(child => child.isTextblock && child.content.size === 0)
  if (!cell.nodeAfter || !empty(cell.nodeAfter) || state.selection.from !== cell.pos + 2) return false
  if (!cell.parent.children.every(empty)) { editor.commands.goToPreviousCell(); return true }
  if (cell.node(-1).childCount <= 1) return editor.commands.deleteTable()
  if (cell.parent.firstChild?.type.spec.tableRole === 'header_cell') return true
  return editor.commands.deleteRow()
}

/** 空段与软换行连接参考 ORCA；绝不穿过列表项或表格单元格的结构边界。 */
function deleteBlankBoundary(editor: Editor, backward: boolean): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock) return false
  for (let depth = 1; depth < $from.depth; depth++) if (['listItem','taskItem','tableCell','tableHeader'].includes($from.node(depth).type.name)) return false
  const current = $from.parent
  if (backward ? $from.parentOffset !== 0 : $from.parentOffset !== current.content.size) return false
  const parent = $from.node($from.depth - 1)
  const index = $from.index($from.depth - 1)
  const neighbor = parent.maybeChild(index + (backward ? -1 : 1))
  if (!neighbor) return false
  const start = $from.before($from.depth); const end = $from.after($from.depth)
  const isBlank = (node: import('@tiptap/pm/model').Node): boolean => node.type.name === 'paragraph' && node.content.size === 0
  const tr = state.tr
  let cursor: number
  if (isBlank(current)) { tr.delete(start, end); cursor = backward ? start - 1 : start }
  else if (isBlank(neighbor)) { tr.delete(backward ? start - neighbor.nodeSize : end, backward ? start : end + neighbor.nodeSize); cursor = backward ? tr.mapping.map(state.selection.from, -1) : end - 1 }
  else {
    const left = backward ? neighbor : current; const right = backward ? current : neighbor
    if (!['paragraph','heading'].includes(left.type.name) || !['paragraph','heading'].includes(right.type.name)) return false
    const from = backward ? start - neighbor.nodeSize : start
    const to = backward ? end : end + neighbor.nodeSize
    if (left.type.name === 'paragraph' && (left.textContent.includes('\n') || right.type.name === 'paragraph' && right.textContent.includes('\n'))) {
      const content = left.content.append(right.content)
      if (!left.type.validContent(content)) return false
      tr.replaceWith(from, to, left.type.create(left.attrs, content, left.marks))
    } else if (left.type.name === 'heading' && right.type.name === 'paragraph' && right.textContent.includes('\n')) {
      let newline = -1
      right.forEach((child, offset) => { if (newline < 0 && child.isText && child.text?.includes('\n')) newline = offset + child.text.indexOf('\n') })
      if (newline < 0) return false
      const content = left.content.append(right.content.cut(0, newline))
      if (!left.type.validContent(content)) return false
      const nodes = [left.type.create(left.attrs, content, left.marks)]
      if (newline + 1 < right.content.size) nodes.push(right.type.create(right.attrs, right.content.cut(newline + 1), right.marks))
      tr.replaceWith(from, to, nodes)
    } else return false
    cursor = from + 1 + left.content.size
  }
  const position = Math.max(0, Math.min(cursor, tr.doc.content.size))
  editor.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(position))).scrollIntoView())
  return true
}

function indentSelectedCode(editor: Editor, backward: boolean): boolean {
  const { state } = editor
  const { $from, $to, empty } = state.selection
  if ($from.parent.type.name !== 'codeBlock' || $from.parent !== $to.parent || (empty && !backward)) return false
  const text = $from.parent.textContent
  const first = $from.parentOffset === 0 ? 0 : text.lastIndexOf('\n', $from.parentOffset - 1) + 1
  const last = !empty && $to.parentOffset > 0 && text[$to.parentOffset - 1] === '\n' ? $to.parentOffset - 1 : $to.parentOffset
  const positions: number[] = [first]
  for (let offset = text.indexOf('\n', first); offset >= 0 && offset < last; offset = text.indexOf('\n', offset + 1)) positions.push(offset + 1)
  const tr = state.tr
  for (const offset of positions.reverse()) {
    const position = $from.start() + offset
    if (backward) { const indent = /^(?:\t| {1,2})/.exec(text.slice(offset))?.[0]; if (indent) tr.delete(position, position + indent.length) }
    else tr.insertText('  ', position)
  }
  if (tr.docChanged) editor.view.dispatch(tr.setSelection(state.selection.map(tr.doc, tr.mapping)).scrollIntoView())
  return true
}

export interface RichKeyboardState { typedOrderedMarker: boolean }
export function handleRichKey(editor: Editor, event: KeyboardEvent, keyboard: RichKeyboardState): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || editor.view.composing) return false
  if (event.key === 'Enter') {
    if (tableEnter(editor) || (!event.shiftKey && !event.metaKey && !event.ctrlKey && orderedEnter(editor, keyboard.typedOrderedMarker))) {
      keyboard.typedOrderedMarker = false
      event.preventDefault()
      return true
    }
    return false
  }
  if (event.key === 'Backspace' && (tableBackspace(editor) || orderedBackspace(editor) || deleteBlankBoundary(editor, true))) { event.preventDefault(); return true }
  if (event.key === 'Delete' && deleteBlankBoundary(editor, false)) { event.preventDefault(); return true }
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return false
  if (indentSelectedCode(editor, event.shiftKey)) { event.preventDefault(); return true }
  if (editor.isActive('table')) {
    event.preventDefault()
    if (event.shiftKey) editor.commands.goToPreviousCell()
    else if (!editor.commands.goToNextCell() && editor.can().addRowAfter()) editor.chain().addRowAfter().goToNextCell().run()
    return true
  }
  if (editor.isActive('codeBlock')) return false
  const list = listContext(editor)
  if (list) {
    event.preventDefault()
    if (event.shiftKey) outdentList(editor)
    else editor.commands.sinkListItem(list.type)
    return true
  }
  // 代码块交给启用缩进的 CodeBlock 扩展；其他位置保留浏览器正常的键盘焦点导航。
  return false
}
