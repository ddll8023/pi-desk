<!-- 富文本渲染与交互适配器：文档装载和提交交给会话，工具栏与查找界面交给 Markdown 页面。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import { TextSelection } from '@tiptap/pm/state'
import { createRichMarkdownCodec } from '../file-rich-markdown-codec'
import { createRichMarkdownSession } from '../file-rich-markdown-session'
import { readHeadingEntries } from '../file-markdown-dom'
import { richEditorOptions } from '../file-rich-markdown'
import type { MathEditRequest } from '../file-rich-markdown-media'
import { isSingleEmptyOrderedList } from '../file-rich-markdown-keyboard'
import type { RichMarkdownDraft } from '../file-rich-markdown-draft'
import { runRichCommand } from '../file-rich-markdown-commands'
import type { RichCommandId } from '../file-rich-markdown-commands'
import { currentSuggestion, suggestionItems } from '../file-rich-markdown-suggestions'
import type { RichSuggestion, RichSuggestionItem } from '../file-rich-markdown-suggestions'
import type { DocumentCatalog } from '../file-rich-markdown-doc-link'
import { EMPTY_MARKDOWN_SEARCH, EMPTY_MARKDOWN_SEARCH_STATUS } from '../file-markdown-view'
import type { MarkdownEditingView, MarkdownFormatState, MarkdownSearchQuery, MarkdownSearchStatus, MarkdownSurfaceState } from '../file-markdown-view'
import { replaceRichSearch, richSearchState, updateRichSearch } from '../file-rich-markdown-search'
import { insertRichImage } from '../file-rich-markdown-image-insert'
import { listMarkdownDocuments } from '../services/project-file'
import FileRichMarkdownSuggestions from './FileRichMarkdownSuggestions.vue'
import FileRichMarkdownLinkPopover from './FileRichMarkdownLinkPopover.vue'
import FileRichMarkdownEmojiPicker from './FileRichMarkdownEmojiPicker.vue'
import FileRichMarkdownTableControls from './FileRichMarkdownTableControls.vue'

const props = defineProps<{
  readonly text: string
  readonly path: string
  readonly projectPath: string
  readonly active: boolean
  readonly showFrontmatter: boolean
  readonly searching: boolean
  readonly recovery: RichMarkdownDraft | null
  readonly reportAssetNotice: ((message: string) => void) | null
}>()
const emit = defineEmits<{
  edit: [text: string]
  pendingEdit: [pending: boolean]
  draft: [snapshot: RichMarkdownDraft | null]
  updated: []
  error: [message: string]
  state: [state: MarkdownSurfaceState]
  searchRequest: [replace: boolean]
  closeSearch: []
  copy: [text: string]
  documents: [catalog: DocumentCatalog]
}>()
const editor = shallowRef<Editor | null>(null)
const codec = createRichMarkdownCodec()
const reportAssetNotice = props.reportAssetNotice
const keyboard = { typedOrderedMarker: false }
const suggestion = shallowRef<RichSuggestion | null>(null)
const suggestionIndex = ref(0)
const catalog = reactive<DocumentCatalog>({ entries: [], loaded: false, truncated: false })
const documentsLoading = ref(false)
const documentsMessage = ref('')
const items = computed(() => suggestion.value ? suggestionItems(suggestion.value, catalog.entries) : [])
const menuId = `rich-${codec.prefix.replace(/[^a-z0-9]/gi, '')}`
const point = ref({ left: 0, top: 0 })
const linkOpen = ref(false)
const emojiOpen = ref(false)
const mathEdit = ref<MathEditRequest | null>(null)
const mathSource = ref('')
const mathInput = ref<HTMLTextAreaElement | null>(null)
const mathDialog = ref<HTMLDialogElement | null>(null)
let disposed = false
let generation = 0
let docsVersion = 0
let docsReadAt = 0
let dismissed = ''

const session = createRichMarkdownSession({
  text: props.text, codec, recovery: props.recovery,
  onText: text => emit('edit', text),
  onPending: pending => emit('pendingEdit', pending),
  onDraft: draft => emit('draft', draft),
  onState: state => emit('state', state),
  onOperationError: message => emit('error', message),
  onReplace: () => {
    generation += 1
    closeTransient()
    mathDialog.value?.close(); mathEdit.value = null
    void nextTick(() => { if (!disposed) emit('updated') })
  }
})
const { frontmatter } = session

function error(message: string): void { emit('error', message) }
function signature(state: RichSuggestion | null): string { return state ? `${state.kind}:${state.from}:${state.query}` : '' }
function closeSuggestions(): void { dismissed = signature(suggestion.value); suggestion.value = null }
function caretPoint(): void {
  const current = editor.value
  if (!current || current.isDestroyed) return
  try { const rect = current.view.coordsAtPos(current.state.selection.from); point.value = { left: rect.left, top: rect.bottom + 3 } }
  catch { /* 分离中的视图不量算浮层。 */ }
}
function closeTransient(): void {
  closeSuggestions(); linkOpen.value = false; emojiOpen.value = false
  if (props.searching) emit('closeSearch')
}
function onViewportScroll(event: Event): void {
  if (event.target instanceof Element && event.target.closest('.file-rich-suggestions,.file-rich-link-popover,.file-rich-emoji-picker')) return
  caretPoint()
}
function updateSuggestions(): void {
  const current = editor.value
  if (!current || disposed || !props.active || linkOpen.value || emojiOpen.value || props.searching || mathEdit.value) return
  const next = currentSuggestion(current)
  if (!next) dismissed = ''
  if (signature(next) === dismissed) { suggestion.value = null; return }
  if (signature(next) !== signature(suggestion.value)) suggestionIndex.value = 0
  suggestion.value = next
  if (next) { caretPoint(); if (next.kind === 'document') void loadDocuments() }
  suggestionIndex.value = Math.min(suggestionIndex.value, Math.max(0, items.value.length - 1))
}
async function loadDocuments(): Promise<void> {
  if (documentsLoading.value || Date.now() - docsReadAt < 3000) return
  const version = ++docsVersion
  const project = props.projectPath; const path = props.path
  documentsLoading.value = true
  const result = await listMarkdownDocuments(project, path)
  if (disposed || version !== docsVersion || props.projectPath !== project || props.path !== path) return
  documentsLoading.value = false; docsReadAt = Date.now()
  if (!result.ok) { documentsMessage.value = result.error.message; return }
  if (result.data.projectPath !== project) return
  catalog.entries = result.data.entries; catalog.loaded = true; catalog.truncated = result.data.truncated
  documentsMessage.value = catalog.truncated ? '项目索引未完整，未命中不代表文件不存在。' : ''
  emit('documents', { entries: [...catalog.entries], loaded: catalog.loaded, truncated: catalog.truncated })
  const current = editor.value
  if (current && !current.isDestroyed) current.view.dispatch(current.state.tr.setMeta('docLinksUpdated', true).setMeta('addToHistory', false))
}
function openLink(position?: number): void {
  const current = editor.value
  if (!current) return
  if (position !== undefined) current.commands.setTextSelection(position)
  closeTransient(); caretPoint(); linkOpen.value = true
}
function closeLink(restoreFocus: boolean): void { linkOpen.value = false; if (restoreFocus) focus() }
function openEmoji(): void { closeTransient(); caretPoint(); emojiOpen.value = true }
function image(bytes?: () => Promise<Uint8Array>): void {
  const current = editor.value
  if (!current) return
  closeSuggestions()
  const epoch = generation
  insertRichImage(current, props.projectPath, props.path, () => !disposed && props.active && generation === epoch && editor.value === current, message => { if (disposed || !props.active) reportAssetNotice?.(message); else error(message) }, bytes)
}
function command(id: RichCommandId): boolean {
  const current = editor.value
  return !!current && props.active && runRichCommand(current, id, { link: openLink, emoji: openEmoji, image: () => image() })
}
function choose(item: RichSuggestionItem): void {
  const current = editor.value; const state = suggestion.value
  if (!current || !state) return
  closeSuggestions()
  if (item.path) current.chain().focus().insertContentAt({ from: state.from, to: state.to }, { type: 'markdownDocLink', attrs: { target: item.path.replace(/\.(md|markdown)$/i, ''), label: null } }).run()
  else if (item.command) { current.chain().focus().deleteRange({ from: state.from, to: state.to }).run(); command(item.command) }
}
function keydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || editor.value?.view.composing) return false
  if (suggestion.value && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) {
    if ((event.key === 'Enter' || event.key === 'Tab') && !items.value.length) { closeSuggestions(); return false }
    event.preventDefault()
    if (event.key === 'Escape') closeSuggestions()
    else if (event.key === 'Enter' || event.key === 'Tab') { const item = items.value[suggestionIndex.value]; if (item) choose(item); else closeSuggestions() }
    else if (items.value.length) suggestionIndex.value = (suggestionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + items.value.length) % items.value.length
    return true
  }
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'k' && !event.altKey) { event.preventDefault(); openLink(); return true }
  if (((event.metaKey || event.ctrlKey) && key === 'f') || (event.ctrlKey && key === 'h' && !/Mac/i.test(navigator.platform))) {
    event.preventDefault()
    if (!mathEdit.value) { closeSuggestions(); linkOpen.value = false; emojiOpen.value = false; emit('searchRequest', event.altKey || key === 'h') }
    return true
  }
  return false
}
function editMath(request: MathEditRequest): void {
  closeTransient(); mathEdit.value = request; mathSource.value = request.latex
  void nextTick(() => { mathDialog.value?.showModal(); mathInput.value?.focus() })
}
function closeMath(): void { mathDialog.value?.close(); mathEdit.value = null; focus() }
function applyMath(): void {
  const current = editor.value; const request = mathEdit.value
  if (!current || !request) return
  const node = current.state.doc.nodeAt(request.position)
  if (!node || node.type.name !== request.type || String(node.attrs.latex) !== request.latex) { error('公式位置或内容已变化，请重新选择。'); closeMath(); return }
  current.view.dispatch(current.state.tr.setNodeMarkup(request.position, undefined, { ...node.attrs, latex: mathSource.value, original: '' }).scrollIntoView())
  closeMath()
}
function focus(): void { editor.value?.commands.focus(undefined, { scrollIntoView: false }) }
function navigateTo(id: string): boolean {
  const current = editor.value
  const heading = current?.view.dom.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (!current || !heading || !current.isEditable) return false
  const position = current.view.posAtDOM(heading, 0)
  const resolved = current.state.doc.resolve(position)
  const tr = current.state.tr
  for (let depth = resolved.depth; depth > 0; depth--) {
    const node = resolved.node(depth)
    if (node.type.name === 'details' && !node.attrs.open) tr.setNodeMarkup(resolved.before(depth), undefined, { ...node.attrs, open: true })
  }
  current.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(position))).scrollIntoView())
  focus()
  return true
}
function getFormatState(): MarkdownFormatState {
  const current = editor.value
  if (!current || current.isDestroyed || !current.isEditable) return { enabled: false, active: [] }
  const active: RichCommandId[] = []
  const names: readonly (readonly [RichCommandId, string])[] = [
    ['paragraph', 'paragraph'], ['bold', 'bold'], ['italic', 'italic'], ['strike', 'strike'],
    ['bullet', 'bulletList'], ['ordered', 'orderedList'], ['task', 'taskList'], ['quote', 'blockquote'], ['link', 'link'], ['code', 'codeBlock']
  ]
  for (const [id, name] of names) if (current.isActive(name)) active.push(id)
  for (const level of [1, 2, 3, 4, 5] as const) if (current.isActive('heading', { level })) active.push(`h${level}`)
  return { enabled: true, active }
}
function getSearchStatus(): MarkdownSearchStatus {
  const current = editor.value
  const state = current && !current.isDestroyed ? richSearchState(current) : undefined
  return state ? { total: state.matches.length, active: state.options.active, truncated: state.truncated } : EMPTY_MARKDOWN_SEARCH_STATUS
}
function setSearch(query: MarkdownSearchQuery, reveal = false): MarkdownSearchStatus {
  const current = editor.value
  if (!current || current.isDestroyed || !current.isEditable) return EMPTY_MARKDOWN_SEARCH_STATUS
  const previous = richSearchState(current)?.options
  const same = previous?.query === query.query && previous.caseSensitive === query.caseSensitive && previous.wholeWord === query.wholeWord
  updateRichSearch(current, { ...query, active: same && previous ? previous.active : 0 }, reveal)
  return getSearchStatus()
}
function moveMatch(step: number): MarkdownSearchStatus {
  const current = editor.value
  const state = current && !current.isDestroyed ? richSearchState(current) : undefined
  if (current && state?.matches.length) updateRichSearch(current, { ...state.options, active: (state.options.active + step + state.matches.length) % state.matches.length }, true)
  return getSearchStatus()
}
function clearSearch(): void {
  const current = editor.value
  if (current && !current.isDestroyed) updateRichSearch(current, { ...EMPTY_MARKDOWN_SEARCH, active: 0 })
}
function replaceMatch(replacement: string, all: boolean): boolean {
  const current = editor.value
  if (!current || !props.active || !replaceRichSearch(current, replacement, all)) return false
  moveMatch(0)
  return true
}

onMounted(() => {
  window.addEventListener('scroll', onViewportScroll, true)
  window.addEventListener('resize', onViewportScroll)
  try {
    const options = richEditorOptions({ codec, keyboard, catalog, editor: () => editor.value, path: () => props.path, projectPath: () => props.projectPath, editMath, error, contentFailure: session.operationFailure, copy: text => emit('copy', text), keydown, openLink, pasteImage: file => image(() => file.arrayBuffer().then(buffer => new Uint8Array(buffer))) })
    const current = new Editor({
      ...options, content: { type: 'doc', content: [{ type: 'paragraph' }] }, contentType: 'json', editable: false, enableContentCheck: true,
      onCreate: ({ editor: created }) => {
        if (disposed || !session.initialize(created)) return
        if (!session.syncText(props.text)) return
        void loadDocuments()
        void nextTick(() => { if (!disposed) emit('updated') })
      },
      onUpdate: ({ editor: updated }) => {
        if (!session.changed()) return
        if (!isSingleEmptyOrderedList(updated)) keyboard.typedOrderedMarker = false
        emit('updated')
      },
      onTransaction: ({ transaction }) => {
        if (mathEdit.value && transaction.docChanged) {
          const mapped = transaction.mapping.mapResult(mathEdit.value.position, 1)
          if (mapped.deletedAcross || mapped.deletedAfter) closeMath()
          else mathEdit.value = { ...mathEdit.value, position: mapped.pos }
        }
        emit('updated')
        void nextTick(updateSuggestions)
      },
      onBlur: () => { session.flushEdit(); emit('updated') },
      onContentError: ({ error: cause }) => session.contentError(cause)
    })
    editor.value = current
  } catch (cause) { session.fail(cause, 'schema') }
})
watch([suggestion, suggestionIndex, items], () => {
  const root = editor.value?.view.dom
  if (!root) return
  if (suggestion.value && items.value.length) { root.setAttribute('aria-controls', menuId); root.setAttribute('aria-activedescendant', `${menuId}-${suggestionIndex.value}`) }
  else { root.removeAttribute('aria-controls'); root.removeAttribute('aria-activedescendant') }
})
watch(() => props.text, text => { if (props.active) session.syncText(text) })
watch(() => props.searching, value => { if (value) { closeSuggestions(); linkOpen.value = false; emojiOpen.value = false } })
watch(() => props.active, active => {
  if (!active) { session.flushEdit(); closeTransient(); mathDialog.value?.close(); mathEdit.value = null }
  else session.syncText(props.text)
})
onBeforeUnmount(() => {
  disposed = true; generation += 1; docsVersion += 1
  session.dispose()
  window.removeEventListener('scroll', onViewportScroll, true)
  window.removeEventListener('resize', onViewportScroll)
  mathDialog.value?.close()
  editor.value?.destroy(); editor.value = null
})
const adapter: MarkdownEditingView = {
  flushEdit: session.flushEdit, getText: session.getText, getDraft: session.getDraft,
  getRoot: () => editor.value?.isEditable ? editor.value.view.dom : null,
  getToc: () => editor.value?.isEditable ? readHeadingEntries(editor.value.view.dom) : [],
  focus, navigateTo, getFormatState, runCommand: command,
  setSearch, moveMatch, clearSearch, getSearchStatus, replaceMatch,
  focusEnd: () => { editor.value?.commands.focus('end', { scrollIntoView: false }) }
}
defineExpose(adapter)
</script>

<template>
  <div class="file-rich-surface" @compositionend="session.scheduleCommit">
    <details v-if="frontmatter && showFrontmatter" class="file-markdown-frontmatter"><summary>Front Matter（在源码中编辑）</summary><pre class="scroll-area">{{ frontmatter }}</pre></details>
    <EditorContent v-if="editor" :editor="editor" />
    <FileRichMarkdownTableControls v-if="editor" :editor="editor" :active="active" />
    <FileRichMarkdownSuggestions v-if="suggestion" :items="items" :active="suggestionIndex" :left="point.left" :top="point.top" :menu-id="menuId" :loading="documentsLoading" :message="suggestion.kind === 'document' ? documentsMessage : ''" @choose="choose" @hover="suggestionIndex = $event" @close="closeSuggestions" />
    <FileRichMarkdownLinkPopover v-if="linkOpen && editor" :editor="editor" :left="point.left" :top="point.top" @close="closeLink" @notice="emit('error', $event)" />
    <FileRichMarkdownEmojiPicker v-if="emojiOpen && editor" :editor="editor" :left="point.left" :top="point.top" @close="emojiOpen = false" @notice="error" />
    <Teleport to="body"><dialog v-if="mathEdit" ref="mathDialog" class="file-rich-math-dialog" aria-label="修改公式" @cancel.prevent="closeMath"><form class="file-rich-math-editor" @submit.prevent="applyMath"><label :for="`${menuId}-math`">公式源码</label><textarea :id="`${menuId}-math`" ref="mathInput" v-model="mathSource" rows="3" spellcheck="false"></textarea><div><button type="button" @click="closeMath">取消</button><button type="submit" @click="applyMath">应用</button></div></form></dialog></Teleport>
  </div>
</template>
