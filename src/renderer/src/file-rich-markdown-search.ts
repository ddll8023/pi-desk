/** 富文本查找替换：匹配位置与高亮属于 ProseMirror 状态，替换通过单一事务进入撤销历史。 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as DocumentNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
export interface RichSearchOptions { query: string; caseSensitive: boolean; wholeWord: boolean; active: number }
export interface RichSearchState { options: RichSearchOptions; matches: { from: number; to: number }[]; truncated: boolean; decorations: DecorationSet }
const searchKey = new PluginKey<RichSearchState>('fileRichSearch')
const EMPTY: RichSearchOptions = { query: '', caseSensitive: false, wholeWord: false, active: 0 }
const LIMIT = 10000
const word = (value: string): boolean => /[\p{L}\p{N}\p{M}_]/u.test(value)

function buildSearch(doc: DocumentNode, options: RichSearchOptions): RichSearchState {
  const matches: { from: number; to: number }[] = []
  let truncated = false
  if (options.query) {
    const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, options.caseSensitive ? 'gu' : 'giu')
    doc.descendants((node, pos) => {
      if (!node.isTextblock || truncated) return !truncated
      let text = ''
      let start = pos + 1
      const scan = (): void => {
        pattern.lastIndex = 0
        for (const match of text.matchAll(pattern)) {
          const from = match.index ?? 0
          const to = from + match[0].length
          if (options.wholeWord && (word(text.slice(0,from).match(/.$/u)?.[0] ?? '') || word(String.fromCodePoint(text.codePointAt(to) ?? 32)))) continue
          if (matches.length >= LIMIT) { truncated = true; break }
          matches.push({ from: start + from, to: start + to })
        }
      }
      node.forEach((child, offset) => {
        if (child.isText) text += child.text ?? ''
        else { scan(); text = ''; start = pos + 1 + offset + child.nodeSize }
      })
      scan()
      return false
    })
  }
  const active = Math.max(0, Math.min(options.active, matches.length - 1))
  return { options: { ...options, active }, matches, truncated, decorations: DecorationSet.create(doc, matches.map((match,index) => Decoration.inline(match.from, match.to, { class: `file-rich-search-match${index === active ? ' is-active' : ''}` }))) }
}
export const RichSearch = Extension.create({
  name: 'fileRichSearch',
  addProseMirrorPlugins() {
    return [new Plugin<RichSearchState>({ key: searchKey,
      state: { init: (_,state) => buildSearch(state.doc, EMPTY), apply(tr, previous) {
        const options = tr.getMeta(searchKey) as RichSearchOptions | undefined
        return options || tr.docChanged ? buildSearch(tr.doc, options ?? previous.options) : previous
      } },
      props: { decorations: state => searchKey.getState(state)?.decorations ?? DecorationSet.empty }
    })]
  }
})
export function richSearchState(editor: Editor): RichSearchState | undefined { return searchKey.getState(editor.state) }
export function updateRichSearch(editor: Editor, options: RichSearchOptions, reveal = false): void {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, { ...options }).setMeta('addToHistory', false))
  const current = richSearchState(editor)
  const match = current?.matches[current.options.active]
  if (reveal && match) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView().setMeta('addToHistory', false))
}
export function replaceRichSearch(editor: Editor, replacement: string, all: boolean): boolean {
  const state = richSearchState(editor)
  if (!state || !editor.isEditable || editor.view.composing || (all && state.truncated)) return false
  const targets = all ? state.matches : state.matches.slice(state.options.active, state.options.active + 1)
  if (!targets.length) return false
  const tr = editor.state.tr
  for (const match of [...targets].reverse()) tr.insertText(replacement, match.from, match.to)
  editor.view.dispatch(tr.scrollIntoView())
  return true
}
