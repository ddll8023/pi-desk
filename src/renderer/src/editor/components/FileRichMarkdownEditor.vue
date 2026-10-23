<!-- 整篇富文本 Markdown 编辑器：保留实例、事务与撤销，工具层参考 ORCA；序列化失败也先保留结构草稿。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import type { Editor as CoreEditor } from '@tiptap/core'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { createRichMarkdownCodec, splitRichFrontmatter } from '../file-rich-markdown-codec'
import { richEditorOptions } from '../file-rich-markdown'
import { equivalentRichDocuments, installLiteralSerialization, serializeRichSource } from '../file-rich-markdown-source'
import type { RichSourceBaseline } from '../file-rich-markdown-source'
import type { MathEditRequest } from '../file-rich-markdown-media'
import { isSingleEmptyOrderedList } from '../file-rich-markdown-keyboard'
import { serializationDocument } from '../file-rich-markdown-nodes'
import { captureRichDraft, restoreRichDraft, replaceRichEditorState } from '../file-rich-markdown-draft'
import type { RichMarkdownDraft } from '../file-rich-markdown-draft'
import { runRichCommand } from '../file-rich-markdown-commands'
import type { RichCommandId } from '../file-rich-markdown-commands'
import { currentSuggestion, suggestionItems } from '../file-rich-markdown-suggestions'
import type { RichSuggestion, RichSuggestionItem } from '../file-rich-markdown-suggestions'
import type { DocumentCatalog } from '../file-rich-markdown-doc-link'
import { insertRichImage } from '../file-rich-markdown-image-insert'
import { listMarkdownDocuments } from '../services/project-file'
import FileRichMarkdownToolbar from './FileRichMarkdownToolbar.vue'
import FileRichMarkdownSuggestions from './FileRichMarkdownSuggestions.vue'
import FileRichMarkdownLinkPopover from './FileRichMarkdownLinkPopover.vue'
import FileRichMarkdownEmojiPicker from './FileRichMarkdownEmojiPicker.vue'
import FileRichMarkdownTableControls from './FileRichMarkdownTableControls.vue'
import FileRichMarkdownSearchBar from './FileRichMarkdownSearchBar.vue'

const props = defineProps<{ readonly text: string; readonly path: string; readonly projectPath: string; readonly active: boolean; readonly showFrontmatter: boolean; readonly recovery?: RichMarkdownDraft | null; readonly reportAssetNotice?: ((message: string) => void) | null }>()
const emit = defineEmits<{ edit: [text: string]; pendingEdit: [pending: boolean]; draft: [snapshot: RichMarkdownDraft | null]; updated: []; error: [message: string]; notice: [message: string]; ready: [ready: boolean]; copy: [text: string]; documents: [catalog: DocumentCatalog] }>()
const editor = shallowRef<Editor | null>(null)
const codec = createRichMarkdownCodec()
const initial = splitRichFrontmatter(props.text)
const recovery = props.recovery
const reportAssetNotice = props.reportAssetNotice
const frontmatter = ref(initial.prefix)
const baseline: RichSourceBaseline = { original: initial.body, canonical: '' }
const keyboard = { typedOrderedMarker: false }
const revision = ref(0)
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
const searchOpen = ref(false)
const replaceOpen = ref(false)
const searchBar = ref<InstanceType<typeof FileRichMarkdownSearchBar> | null>(null)
const mathEdit = ref<MathEditRequest | null>(null)
const mathSource = ref('')
const mathInput = ref<HTMLTextAreaElement | null>(null)
const mathDialog = ref<HTMLDialogElement | null>(null)
let lastText = props.text
let timer: number | null = null
let pending = false
let applying = true
let initialized = false
let disposed = false
let generation = 0
let docsVersion = 0
let docsReadAt = 0
let dismissed = ''

function error(message: string): void { emit('error', message) }
function clearTimer(): void { if (timer !== null) clearTimeout(timer); timer = null }
function signature(state: RichSuggestion | null): string { return state ? `${state.kind}:${state.from}:${state.query}` : '' }
function closeSuggestions(): void { dismissed = signature(suggestion.value); suggestion.value = null }
function caretPoint(): void {
  const current = editor.value
  if (!current || current.isDestroyed) return
  try { const rect = current.view.coordsAtPos(current.state.selection.from); point.value = { left: rect.left, top: rect.bottom + 3 } } catch { /* 分离中的视图不量算浮层。 */ }
}
function closeTransient(): void { closeSuggestions(); linkOpen.value = false; emojiOpen.value = false; searchOpen.value = false }
function onViewportScroll(event: Event): void {
  if (event.target instanceof Element && event.target.closest('.file-rich-suggestions,.file-rich-link-popover,.file-rich-emoji-picker')) return
  caretPoint()
}
function updateSuggestions(): void {
  const current = editor.value
  if (!current || disposed || !props.active || linkOpen.value || emojiOpen.value || searchOpen.value || mathEdit.value) return
  const next = currentSuggestion(current)
  if (!next) dismissed = ''
  if (signature(next) === dismissed) { suggestion.value = null; return }
  if (signature(next) !== signature(suggestion.value)) suggestionIndex.value = 0
  suggestion.value = next
  if (next) { caretPoint(); if (next.kind === 'document') void loadDocuments() }
  suggestionIndex.value = Math.min(suggestionIndex.value, Math.max(0, items.value.length - 1))
  if (next && items.value.length) current.view.dom.setAttribute('aria-activedescendant', `${menuId}-${suggestionIndex.value}`)
  else current.view.dom.removeAttribute('aria-activedescendant')
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
  closeSuggestions(); emojiOpen.value = false; caretPoint(); linkOpen.value = true
}
function closeLink(restoreFocus: boolean): void { linkOpen.value = false; if (restoreFocus) editor.value?.commands.focus(undefined, { scrollIntoView: false }) }
function openEmoji(): void { closeSuggestions(); linkOpen.value = false; caretPoint(); emojiOpen.value = true }
function image(bytes?: () => Promise<Uint8Array>): void {
  const current = editor.value
  if (!current) return
  closeSuggestions()
  const epoch = generation
  insertRichImage(current, props.projectPath, props.path, () => !disposed && props.active && generation === epoch && editor.value === current, message => { if (disposed || !props.active) reportAssetNotice?.(message); else error(message) }, bytes)
}
function command(id: RichCommandId): void {
  const current = editor.value
  if (current) runRichCommand(current, id, { link: openLink, emoji: openEmoji, image: () => image() })
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
  if (suggestion.value && ['ArrowDown','ArrowUp','Enter','Escape','Tab'].includes(event.key)) {
    if ((event.key === 'Enter' || event.key === 'Tab') && !items.value.length) { closeSuggestions(); return false }
    event.preventDefault()
    if (event.key === 'Escape') closeSuggestions()
    else if (event.key === 'Enter' || event.key === 'Tab') { const item = items.value[suggestionIndex.value]; if (item) choose(item); else closeSuggestions() }
    else if (items.value.length) suggestionIndex.value = (suggestionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + items.value.length) % items.value.length
    return true
  }
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'k' && !event.altKey) { event.preventDefault(); openLink(); return true }
  if (((event.metaKey || event.ctrlKey) && key === 'f') || (event.ctrlKey && key === 'h' && !/Mac/i.test(navigator.platform))) { event.preventDefault(); openSearch(event.altKey || key === 'h'); return true }
  return false
}
function openSearch(replace = false): void { if (!props.active || mathEdit.value) return; closeSuggestions(); linkOpen.value = false; emojiOpen.value = false; replaceOpen.value = replace; searchOpen.value = true; void nextTick(() => searchBar.value?.focus()) }
function closeSearch(): void { searchOpen.value = false; editor.value?.commands.focus(undefined, { scrollIntoView: false }) }
function editMath(request: MathEditRequest): void {
  closeTransient(); mathEdit.value = request; mathSource.value = request.latex
  void nextTick(() => { mathDialog.value?.showModal(); mathInput.value?.focus() })
}
function closeMath(): void { mathDialog.value?.close(); mathEdit.value = null; editor.value?.commands.focus(undefined, { scrollIntoView: false }) }
function applyMath(): void {
  const current = editor.value; const request = mathEdit.value
  if (!current || !request) return
  const node = current.state.doc.nodeAt(request.position)
  if (!node || node.type.name !== request.type || String(node.attrs.latex) !== request.latex) { error('公式位置或内容已变化，请重新选择。'); closeMath(); return }
  current.view.dispatch(current.state.tr.setNodeMarkup(request.position, undefined, { ...node.attrs, latex: mathSource.value, original: '' }).scrollIntoView())
  closeMath()
}
function flushDomInput(current: Editor): void {
  const view: unknown = current.view
  if (!view || typeof view !== 'object' || !('domObserver' in view)) return
  const observer = view.domObserver
  if (observer && typeof observer === 'object' && 'flush' in observer && typeof observer.flush === 'function') observer.flush()
}
function snapshot(): RichMarkdownDraft | null {
  const current = editor.value
  return current && initialized && pending ? captureRichDraft(current, lastText, frontmatter.value, baseline) : null
}
/** 结构草稿先于可能失败的 Markdown 序列化；force 只跳过组合输入等待，不跳过语义证明。 */
function flushEdit(force = false): boolean {
  const current = editor.value
  if (!current || current.isDestroyed || !initialized) return !pending
  flushDomInput(current); clearTimer()
  if (!pending) return true
  emit('draft', snapshot())
  if (current.view.composing && !force) return false
  try {
    const text = frontmatter.value + serializeRichSource(current, codec, baseline)
    lastText = text; pending = false
    emit('draft', null); emit('edit', text); emit('pendingEdit', false)
    return true
  } catch (cause) { error(cause instanceof Error ? cause.message : String(cause)); return false }
}
function scheduleCommit(): void { clearTimer(); timer = window.setTimeout(() => { timer = null; flushEdit() }, 300) }
function getText(force = false): string | null { return flushEdit(force) ? lastText : null }
function canonicalFor(current: CoreEditor): string {
  const canonical = current.getMarkdown()
  const parsed = current.markdown?.parse(codec.prepare(canonical))
  const doc = parsed?.content?.length ? current.schema.nodeFromJSON(parsed) : current.schema.topNodeType.createAndFill()
  if (!doc || !equivalentRichDocuments(serializationDocument(current), doc)) throw new Error('此文档暂时无法无损往返 Markdown。')
  return canonical
}
function navigateTo(id: string): void {
  const current = editor.value
  const heading = current?.view.dom.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (!current || !heading) return
  const position = current.view.posAtDOM(heading, 0); const resolved = current.state.doc.resolve(position); const tr = current.state.tr
  for (let depth = resolved.depth; depth > 0; depth--) { const node = resolved.node(depth); if (node.type.name === 'details' && !node.attrs.open) tr.setNodeMarkup(resolved.before(depth), undefined, { ...node.attrs, open: true }) }
  current.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(position))).scrollIntoView())
  current.commands.focus(undefined, { scrollIntoView: false })
}
function syncExternalText(text: string): boolean {
  if (text === lastText) return true
  const current = editor.value
  if (!current || current.isDestroyed || !initialized) return false
  if (pending) { emit('draft', snapshot()); error('当前输入尚未同步，未用外部内容覆盖。'); return false }
  try {
    const parts = splitRichFrontmatter(text); const json = current.markdown?.parse(codec.prepare(parts.body))
    if (!json) throw new Error('Markdown 解析器尚未就绪。')
    const doc = json.content?.length ? current.schema.nodeFromJSON(json) : current.schema.topNodeType.createAndFill()
    if (!doc) throw new Error('无法建立空文档。')
    doc.check(); applying = true; clearTimer(); generation += 1; closeTransient()
    replaceRichEditorState(current, EditorState.create({ schema: current.schema, doc, plugins: current.state.plugins }))
    baseline.canonical = canonicalFor(current); baseline.original = parts.body; frontmatter.value = parts.prefix; lastText = text
    if (mathEdit.value) closeMath()
    emit('draft', null); emit('updated'); revision.value += 1
    return true
  } catch (cause) { error(`无法同步文档：${cause instanceof Error ? cause.message : String(cause)}`); emit('ready', false); return false }
  finally { applying = false }
}
onMounted(() => {
  window.addEventListener('scroll', onViewportScroll, true)
  window.addEventListener('resize', onViewportScroll)
  try {
    const options = richEditorOptions({ codec, keyboard, catalog, editor: () => editor.value, path: () => props.path, projectPath: () => props.projectPath, editMath, error, copy: text => emit('copy', text), keydown, openLink, pasteImage: file => image(() => file.arrayBuffer().then(buffer => new Uint8Array(buffer))) })
    const current = new Editor({ ...options, content: codec.prepare(initial.body), contentType: 'markdown', enableContentCheck: true,
      onCreate: ({ editor: created }) => {
        if (disposed) return
        try {
          created.state.doc.check(); installLiteralSerialization(created, codec); baseline.canonical = canonicalFor(created)
          initialized = true
          if (recovery && recovery.text === lastText) { restoreRichDraft(created, recovery); Object.assign(baseline, recovery.baseline); frontmatter.value = recovery.frontmatter; pending = true; emit('pendingEdit', true); scheduleCommit() }
          applying = false
          if (props.text !== lastText && !syncExternalText(props.text)) return
          emit('ready', true); void loadDocuments(); void nextTick(() => emit('updated'))
        } catch (cause) { error(`文档无法安全编辑：${cause instanceof Error ? cause.message : String(cause)}`); emit('ready', false) }
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (applying || !initialized) return
        if (!isSingleEmptyOrderedList(currentEditor)) keyboard.typedOrderedMarker = false
        pending = true; emit('pendingEdit', true); emit('updated'); scheduleCommit()
      },
      onTransaction: ({ transaction }) => {
        revision.value += 1
        if (mathEdit.value && transaction.docChanged) { const mapped = transaction.mapping.mapResult(mathEdit.value.position, 1); if (mapped.deletedAcross || mapped.deletedAfter) closeMath(); else mathEdit.value = { ...mathEdit.value, position: mapped.pos } }
        void nextTick(updateSuggestions)
      },
      onBlur: () => { flushEdit(); emit('updated') },
      onContentError: ({ error: cause }) => { error(`文档结构无法安全编辑：${cause.message}`); if (!initialized) emit('ready', false) }
    })
    editor.value = current
  } catch (cause) { error(`富文本编辑器初始化失败：${cause instanceof Error ? cause.message : String(cause)}`); emit('ready', false) }
})
watch([suggestion, suggestionIndex, items], () => {
  const root = editor.value?.view.dom
  if (!root) return
  if (suggestion.value && items.value.length) { root.setAttribute('aria-controls', menuId); root.setAttribute('aria-activedescendant', `${menuId}-${suggestionIndex.value}`) }
  else { root.removeAttribute('aria-controls'); root.removeAttribute('aria-activedescendant') }
})
watch(() => props.text, syncExternalText)
watch(() => props.active, active => { if (!active) { flushEdit(); closeTransient(); if (mathEdit.value) { mathDialog.value?.close(); mathEdit.value = null } } })
onBeforeUnmount(() => { flushEdit(true); window.removeEventListener('scroll', onViewportScroll, true); window.removeEventListener('resize', onViewportScroll); disposed = true; generation += 1; docsVersion += 1; clearTimer(); mathDialog.value?.close(); editor.value?.destroy(); editor.value = null })
defineExpose({ flushEdit, getText, navigateTo, openSearch, getDraft: snapshot, focusEnd: () => editor.value?.commands.focus('end', { scrollIntoView: false }), focus: () => editor.value?.commands.focus(undefined, { scrollIntoView: false }) })
</script>
<template>
  <div class="file-rich-surface" @compositionend="scheduleCommit">
    <FileRichMarkdownToolbar :editor="editor" :revision="revision" @command="command" />
    <details v-if="frontmatter && showFrontmatter" class="file-markdown-frontmatter"><summary>Front Matter（在源码中编辑）</summary><pre class="scroll-area">{{ frontmatter }}</pre></details>
    <!-- EditorContent 的 editor 声明为非空，未创建前不渲染它；库在 rootEl 就绪后自行挂入 view DOM。 -->
    <EditorContent v-if="editor" :editor="editor" />
    <FileRichMarkdownSearchBar v-if="searchOpen && editor" ref="searchBar" :editor="editor" :replace="replaceOpen" @close="closeSearch" />
    <FileRichMarkdownTableControls v-if="editor" :editor="editor" :active="active" />
    <FileRichMarkdownSuggestions v-if="suggestion" :items="items" :active="suggestionIndex" :left="point.left" :top="point.top" :menu-id="menuId" :loading="documentsLoading" :message="suggestion.kind === 'document' ? documentsMessage : ''" @choose="choose" @hover="suggestionIndex = $event" @close="closeSuggestions" />
    <FileRichMarkdownLinkPopover v-if="linkOpen && editor" :editor="editor" :left="point.left" :top="point.top" @close="closeLink" @notice="emit('notice', $event)" />
    <FileRichMarkdownEmojiPicker v-if="emojiOpen && editor" :editor="editor" :left="point.left" :top="point.top" @close="emojiOpen = false" @notice="error" />
    <Teleport to="body"><dialog v-if="mathEdit" ref="mathDialog" class="file-rich-math-dialog" aria-label="修改公式" @cancel.prevent="closeMath"><form class="file-rich-math-editor" @submit.prevent="applyMath"><label :for="`${menuId}-math`">公式源码</label><textarea :id="`${menuId}-math`" ref="mathInput" v-model="mathSource" rows="3" spellcheck="false"></textarea><div><button type="button" @click="closeMath">取消</button><button type="submit">应用</button></div></form></dialog></Teleport>
  </div>
</template>
