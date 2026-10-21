/** 由当前文档选区推导补全上下文，不持有跨项目或跨编辑器的全局状态。 */
import type { Editor } from '@tiptap/core'
import { richCommands } from './file-rich-markdown-commands'
import type { RichCommandId } from './file-rich-markdown-commands'
export interface RichSuggestion { kind: 'slash' | 'document'; from: number; to: number; query: string }
export interface RichSuggestionItem { id: string; label: string; description: string; group: string; icon: string; command?: RichCommandId; path?: string }
export function currentSuggestion(editor: Editor): RichSuggestion | null {
  const selection = editor.state.selection
  if (!editor.isEditable || !selection.empty || !selection.$from.parent.isTextblock || editor.isActive('codeBlock') || editor.isActive('code') || editor.view.composing) return null
  const prefix = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\ufffc')
  const wiki = /\[\[([^\]\n|]*)$/.exec(prefix)
  if (wiki) {
    const after = selection.$from.parent.textBetween(selection.$from.parentOffset, selection.$from.parent.content.size, '\n', '\ufffc')
    return { kind: 'document', from: selection.from - wiki[0].length, to: selection.to + (after.startsWith(']]') ? 2 : 0), query: wiki[1] ?? '' }
  }
  const slash = /(?:^|\s)\/([^/\n]{0,128})$/.exec(prefix)
  return slash ? { kind: 'slash', from: selection.from - (slash[1]?.length ?? 0) - 1, to: selection.to, query: slash[1] ?? '' } : null
}
export function suggestionItems(state: RichSuggestion, documents: readonly string[]): RichSuggestionItem[] {
  const query = state.query.trim().toLocaleLowerCase()
  if (state.kind === 'slash') return richCommands.filter(item => `${item.label} ${item.aliases}`.toLocaleLowerCase().includes(query)).map(item => ({ ...item, id: item.id, command: item.id }))
  return documents.filter(path => path.toLocaleLowerCase().includes(query)).sort((a,b) => a.length - b.length || a.localeCompare(b)).slice(0,50).map(path => ({ id: path, label: path.split('/').at(-1)?.replace(/\.(md|markdown)$/i, '') ?? path, description: path, group: '项目文档', icon: '▤', path }))
}
