<!-- Markdown 文档页面：编辑能力及受阻原因贴近操作区，正文不通过整块焦点描边表达可编辑性。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { markdownFailureText, richMarkdownUnsupportedReason } from '../file-rich-markdown-parser'
import type { RichMarkdownDraft } from '../file-rich-markdown-draft'
import type { FileMarkdownTocEntry } from '../file-markdown-dom'
import type { DocumentCatalog } from '../file-rich-markdown-doc-link'
import { resolveDocumentLink } from '../file-rich-markdown-doc-link'
import { headingSlug, resolveFileMarkdownLink } from '../file-markdown-links'
import { EMPTY_MARKDOWN_SEARCH, EMPTY_MARKDOWN_SEARCH_STATUS } from '../file-markdown-view'
import type { FileDocumentSurface, MarkdownFormatState, MarkdownReadingView, MarkdownSearchQuery, MarkdownSearchStatus, MarkdownSurfaceState } from '../file-markdown-view'
import type { RichCommandId } from '../file-rich-markdown-commands'
import { copyText } from '../../ui/clipboard'
import { openExternalUrl } from '../services/external-url'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import FileRichMarkdownEditor from './FileRichMarkdownEditor.vue'
import FileRichMarkdownToolbar from './FileRichMarkdownToolbar.vue'
import FileMarkdownPreview from './FileMarkdownPreview.vue'
import FileMarkdownToolbar from './FileMarkdownToolbar.vue'
import FileMarkdownSearchBar from './FileMarkdownSearchBar.vue'
import FileMarkdownToc from './FileMarkdownToc.vue'
import FileMarkdownImageViewer from './FileMarkdownImageViewer.vue'

const props = defineProps<{
  readonly text: string
  readonly path: string
  readonly projectPath: string
  readonly fontSize: number
  readonly showFrontmatter: boolean
  readonly active: boolean
  readonly editable: boolean
  readonly recovery: RichMarkdownDraft | null
  readonly reportAssetNotice: ((message: string) => void) | null
  readonly anchorRequest: { readonly id: number; readonly anchor: string } | null
}>()
const emit = defineEmits<{
  edit: [text: string]
  pendingEdit: [pending: boolean]
  draft: [snapshot: RichMarkdownDraft | null]
  state: [state: MarkdownSurfaceState]
  anchorHandled: [requestId: number]
  fontSize: [size: number]
  frontmatter: [show: boolean]
  source: []
}>()
const tabs = useWorkspaceTabsStore()
const page = ref<HTMLElement | null>(null)
const shell = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const rich = ref<InstanceType<typeof FileRichMarkdownEditor> | null>(null)
const preview = ref<InstanceType<typeof FileMarkdownPreview> | null>(null)
const searchBar = ref<InstanceType<typeof FileMarkdownSearchBar> | null>(null)
const state = shallowRef<MarkdownSurfaceState>(sourceState())
const richEnabled = computed(() => state.value.phase !== 'readonly')
const adapter = computed<MarkdownReadingView | null>(() => richEnabled.value ? rich.value : preview.value)
const format = shallowRef<MarkdownFormatState>({ enabled: false, active: [] })
const canReplace = computed(() => richEnabled.value && format.value.enabled)
const toolbarFormat = computed<MarkdownFormatState>(() => props.active ? format.value : { enabled: false, active: format.value.active })
const searchAvailable = computed(() => state.value.phase !== 'initializing' && adapter.value !== null)
const toc = shallowRef<readonly FileMarkdownTocEntry[]>([])
const showToc = ref(true)
const activeHeadingId = ref('')
const narrow = ref(false)
const notice = shallowRef<{ message: string; failed: boolean } | null>(null)
const zoomed = ref<{ readonly src: string; readonly alt: string } | null>(null)
const documents = shallowRef<DocumentCatalog>({ entries: [], loaded: false, truncated: false })
const searchOpen = ref(false)
const replaceOpen = ref(false)
const query = shallowRef<MarkdownSearchQuery>(EMPTY_MARKDOWN_SEARCH)
const searchStatus = shallowRef<MarkdownSearchStatus>(EMPTY_MARKDOWN_SEARCH_STATUS)
const blockedMessage = computed(() => state.value.phase === 'blocked' ? markdownFailureText(state.value.failure) : '')
let viewGeneration = 0
let handledAnchor = 0
let scrollFrame = 0
let resizeObserver: ResizeObserver | null = null
let disposed = false

function sourceState(): MarkdownSurfaceState {
  const reason = props.editable ? richMarkdownUnsupportedReason(props.text) : '此文件只读。'
  return reason ? { phase: 'readonly', reason } : { phase: 'initializing' }
}
function showNotice(message: string, failed = false): void { notice.value = { message, failed } }
function flushEdit(force = false): boolean {
  if (richEnabled.value) return rich.value?.flushEdit(force) ?? false
  return props.recovery === null
}
function getText(force = false): string | null {
  if (richEnabled.value) return rich.value?.getText(force) ?? null
  return props.recovery ? null : props.text
}
function getDraft(): RichMarkdownDraft | null { return rich.value?.getDraft() ?? props.recovery }
function onRichState(next: MarkdownSurfaceState): void {
  if (!disposed && richEnabled.value) state.value = next
}
function refreshSurface(): void {
  if (disposed) return
  const current = adapter.value
  toc.value = current?.getToc() ?? []
  format.value = richEnabled.value ? rich.value?.getFormatState() ?? { enabled: false, active: [] } : { enabled: false, active: [] }
  if (searchOpen.value) {
    // 富文本匹配由事务插件维护；重复派发搜索事务会形成更新循环。
    searchStatus.value = richEnabled.value ? current?.getSearchStatus() ?? EMPTY_MARKDOWN_SEARCH_STATUS : current?.setSearch(query.value) ?? EMPTY_MARKDOWN_SEARCH_STATUS
  }
  updateActiveHeading()
  handleAnchorRequest()
}
function onSurfaceUpdated(): void {
  const generation = viewGeneration
  void nextTick(() => { if (generation === viewGeneration) refreshSurface() })
}
function toggleToc(): void {
  showToc.value = !showToc.value
  if (showToc.value && narrow.value) void nextTick(() => shell.value?.querySelector<HTMLElement>('nav select')?.focus())
}
function closeToc(restoreFocus = true): void {
  showToc.value = false
  if (restoreFocus) void nextTick(() => page.value?.querySelector<HTMLElement>('[data-toc-toggle]')?.focus())
}
function jumpTo(id: string): boolean {
  if (!flushEdit()) return false
  if (!adapter.value?.navigateTo(id)) return false
  activeHeadingId.value = id
  if (narrow.value) closeToc(false)
  return true
}
function handleAnchorRequest(): void {
  const request = props.anchorRequest
  if (!props.active || !request || request.id === handledAnchor || !adapter.value?.getRoot()) return
  if (!flushEdit()) return
  if (!jumpTo(request.anchor)) showNotice('文档里没有对应的标题。', true)
  handledAnchor = request.id
  emit('anchorHandled', request.id)
}
function updateActiveHeading(): void {
  const root = adapter.value?.getRoot(); const container = scroller.value
  if (!root || !container || !props.active) return
  const threshold = container.getBoundingClientRect().top + 24
  let id = ''
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (!heading.getClientRects().length) continue
    if (heading.getBoundingClientRect().top > threshold) break
    id = heading.id
  }
  activeHeadingId.value = id
}
function onScroll(): void {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateActiveHeading() })
}
function openSearch(replace = false): void {
  if (!props.active || !searchAvailable.value || zoomed.value) return
  replaceOpen.value = canReplace.value && replace
  searchOpen.value = true
  searchStatus.value = adapter.value?.setSearch(query.value, true) ?? EMPTY_MARKDOWN_SEARCH_STATUS
  void nextTick(() => searchBar.value?.focus())
}
function closeSearch(restoreFocus = true): void {
  const wasOpen = searchOpen.value
  searchOpen.value = false; replaceOpen.value = false
  query.value = EMPTY_MARKDOWN_SEARCH; searchStatus.value = EMPTY_MARKDOWN_SEARCH_STATUS
  if (wasOpen) adapter.value?.clearSearch()
  if (restoreFocus && wasOpen) adapter.value?.focus()
}
function changeQuery(next: MarkdownSearchQuery): void {
  query.value = canReplace.value ? next : { ...EMPTY_MARKDOWN_SEARCH, query: next.query }
  searchStatus.value = adapter.value?.setSearch(query.value, true) ?? EMPTY_MARKDOWN_SEARCH_STATUS
}
function moveMatch(step: number): void { searchStatus.value = adapter.value?.moveMatch(step) ?? EMPTY_MARKDOWN_SEARCH_STATUS }
function replaceMatch(text: string, all: boolean): void {
  if (!canReplace.value || !rich.value?.replaceMatch(text, all)) showNotice('当前状态无法替换，原有内容仍被保留。', true)
  searchStatus.value = adapter.value?.getSearchStatus() ?? EMPTY_MARKDOWN_SEARCH_STATUS
}
function command(id: RichCommandId): void {
  if (!rich.value?.runCommand(id)) showNotice('当前选区无法执行这项格式操作。', true)
}
function onFindShortcut(event: KeyboardEvent): void {
  if (!props.active || zoomed.value || event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return
  event.preventDefault(); openSearch()
}
function onBlankPointerDown(event: PointerEvent): void {
  const target = event.target; const container = scroller.value
  if (!props.active || !canReplace.value || event.button !== 0 || !container || (target !== container && target !== body.value)) return
  if (event.clientX >= container.getBoundingClientRect().left + container.clientWidth) return
  event.preventDefault(); rich.value?.focusEnd()
}
function onDrawerKeydown(event: KeyboardEvent): void {
  if (!narrow.value || !showToc.value || event.key !== 'Tab' || !(event.target instanceof Element) || !event.target.closest('nav')) return
  const controls = Array.from(shell.value?.querySelectorAll<HTMLElement>('nav button:not(:disabled), nav select') ?? []).filter(element => element.getClientRects().length)
  const first = controls[0]; const last = controls.at(-1)
  if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus() }
}
async function reportCopy(text: string, label = '代码'): Promise<void> {
  const copied = await copyText(text)
  if (!disposed) showNotice(copied ? `${label}已复制。` : `无法复制${label}，请手动复制。`, !copied)
}
function openImage(target: Element): boolean {
  const image = target.closest('img')
  if (!image || !image.closest('.file-markdown-image-frame') || !flushEdit()) return false
  zoomed.value = { src: image.currentSrc || image.src, alt: image.alt }
  return true
}
function onDoubleClick(event: MouseEvent): void { if (richEnabled.value && event.target instanceof Element && openImage(event.target)) event.preventDefault() }
function onContentKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || richEnabled.value) return
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.matches('.file-markdown-image-frame.is-ready') && openImage(event.target.querySelector('img') ?? event.target)) event.preventDefault()
}
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target
  if (!(target instanceof Element)) return
  if (!richEnabled.value && openImage(target)) { event.preventDefault(); return }
  const control = target.closest<HTMLElement>('.markdown-heading-anchor, .markdown-code-copy, .markdown-link')
  if (!control || !body.value?.contains(control)) return
  if (control.classList.contains('markdown-code-copy')) {
    event.preventDefault(); await reportCopy(control.closest('.markdown-code-block')?.querySelector('pre code')?.textContent ?? ''); return
  }
  if (control.classList.contains('markdown-heading-anchor')) {
    event.preventDefault(); await reportCopy(`${props.path}${control.dataset.linkTarget ?? ''}`, '标题引用'); return
  }
  if (richEnabled.value && !event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  if (!flushEdit()) return
  const address = control.dataset.linkTarget ?? ''
  switch (control.dataset.linkKind) {
    case 'anchor': {
      let anchor = address.slice(1)
      try { anchor = decodeURIComponent(anchor) } catch { /* 无效编码按原文定位。 */ }
      if (!jumpTo(anchor)) showNotice('文档里没有对应的标题锚点。', true)
      return
    }
    case 'document': {
      const link = resolveDocumentLink(address, documents.value)
      if (!link) { showNotice(documents.value.truncated ? '索引尚未完整，无法确认文档目标。' : '文档不存在或名称有歧义，请使用完整项目相对路径。', true); return }
      let anchor = link.anchor
      if (anchor) { try { anchor = decodeURIComponent(anchor) } catch { /* 无效编码按原文处理。 */ } }
      tabs.openFileTab(link.path, 'preview', anchor ? headingSlug(anchor) : null, props.projectPath)
      return
    }
    case 'file': {
      const link = resolveFileMarkdownLink(address, props.path)
      if (!link) { showNotice('链接目标不在项目内，未打开。', true); return }
      if (!/\.(md|markdown)$/i.test(link.path)) { showNotice(`链接目标是 ${link.path}，可在文件树中打开。`, true); return }
      tabs.openFileTab(link.path, 'preview', link.anchor, props.projectPath)
      return
    }
    case 'external': {
      const result = await openExternalUrl(address)
      if (!result.ok && !disposed) showNotice(result.error.message, true)
      return
    }
    default: await reportCopy(address, '链接地址')
  }
}

watch(state, next => { emit('state', next); onSurfaceUpdated() }, { immediate: true })
watch(richEnabled, (enabled, previous) => {
  viewGeneration += 1
  // 先清旧视图状态，再让新适配器发布目录，不能在 nextTick 后无条件清空新目录。
  const old = previous ? rich.value : preview.value
  old?.clearSearch()
  toc.value = []; activeHeadingId.value = ''; format.value = { enabled: false, active: [] }
  if (!enabled) { replaceOpen.value = false; query.value = { ...EMPTY_MARKDOWN_SEARCH, query: query.value.query } }
  onSurfaceUpdated()
}, { flush: 'sync' })
watch([() => props.text, () => props.editable], () => {
  viewGeneration += 1
  if (!rich.value?.getDraft()) {
    const next = sourceState()
    if (state.value.phase === 'readonly' || next.phase === 'readonly') state.value = next
  }
  onSurfaceUpdated()
})
watch([() => props.path, () => props.projectPath], () => {
  viewGeneration += 1; handledAnchor = 0
  closeSearch(false); notice.value = null
  documents.value = { entries: [], loaded: false, truncated: false }
  state.value = sourceState(); toc.value = []; activeHeadingId.value = ''
})
watch(() => props.active, active => {
  if (active) onSurfaceUpdated()
  else { flushEdit(); closeSearch(false); zoomed.value = null }
})
watch(() => props.anchorRequest?.id, onSurfaceUpdated)
watch(() => props.fontSize, onSurfaceUpdated)
onMounted(() => {
  window.addEventListener('keydown', onFindShortcut)
  if (shell.value) {
    resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const previous = narrow.value
      narrow.value = entry.contentRect.width < 960
      if (narrow.value && !previous) closeToc(false)
    })
    narrow.value = shell.value.clientWidth < 960
    if (narrow.value) closeToc(false)
    resizeObserver.observe(shell.value)
  }
  onSurfaceUpdated()
})
onBeforeUnmount(() => {
  disposed = true; viewGeneration += 1
  flushEdit(true); closeSearch(false)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onFindShortcut)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})
const surface: FileDocumentSurface = { flushEdit, getText, getDraft }
defineExpose(surface)
</script>

<template>
  <div ref="page" class="file-markdown-workspace" :style="{ '--file-preview-font-size': `${fontSize}px` }">
    <FileMarkdownToolbar
      :active="active"
      :state="state"
      :source-editable="editable"
      :toc-open="showToc"
      :has-toc="toc.length > 0"
      :font-size="fontSize"
      :show-frontmatter="showFrontmatter"
      @toc="toggleToc"
      @font-size="emit('fontSize', $event)"
      @frontmatter="emit('frontmatter', $event)"
      @source="emit('source')"
    >
      <template v-if="state.phase === 'editable' || state.phase === 'blocked'" #format>
        <FileRichMarkdownToolbar :state="toolbarFormat" @command="command" />
      </template>
    </FileMarkdownToolbar>
    <div v-if="blockedMessage" class="file-markdown-status is-blocked" role="status">
      <span>{{ blockedMessage }}</span>
      <button type="button" class="file-reader-tool" @click="flushEdit()">重试同步</button>
    </div>
    <FileMarkdownSearchBar
      v-if="searchOpen"
      ref="searchBar"
      :query="query"
      :status="searchStatus"
      :can-replace="canReplace"
      :replace="replaceOpen"
      @query="changeQuery"
      @move="moveMatch"
      @replace="replaceMatch"
      @close="closeSearch()"
    />
    <div ref="shell" class="file-markdown" :class="{ 'is-editable': canReplace, 'is-narrow': narrow }" :aria-busy="state.phase === 'initializing'" @keydown="onDrawerKeydown">
      <button v-if="narrow && showToc && toc.length" type="button" class="file-markdown-toc-backdrop" aria-label="关闭目录" @click="closeToc()"></button>
      <FileMarkdownToc v-if="showToc && toc.length" :entries="toc" :active-id="activeHeadingId" @navigate="jumpTo" @close="closeToc()" />
      <div ref="scroller" class="file-markdown-scroll scroll-area" tabindex="-1" aria-label="文档正文" @pointerdown="onBlankPointerDown" @scroll.passive="onScroll">
        <div ref="body" class="file-rich-container" @click="onContentClick" @dblclick="onDoubleClick" @keydown="onContentKeydown" @toggle.capture="updateActiveHeading">
          <FileRichMarkdownEditor
            v-if="richEnabled"
            :key="`${projectPath}\n${path}`"
            ref="rich"
            :text="text"
            :path="path"
            :project-path="projectPath"
            :active="active"
            :show-frontmatter="showFrontmatter"
            :searching="searchOpen"
            :recovery="recovery"
            :report-asset-notice="reportAssetNotice"
            @draft="emit('draft', $event)"
            @documents="documents = $event"
            @edit="emit('edit', $event)"
            @pending-edit="emit('pendingEdit', $event)"
            @updated="onSurfaceUpdated"
            @error="showNotice($event, true)"
            @state="onRichState"
            @search-request="openSearch"
            @close-search="closeSearch(false)"
            @copy="reportCopy"
          />
          <FileMarkdownPreview
            v-else
            ref="preview"
            :text="text"
            :path="path"
            :project-path="projectPath"
            :active="active"
            :show-frontmatter="showFrontmatter"
            @updated="onSurfaceUpdated"
            @notice="showNotice($event, true)"
          />
        </div>
      </div>
    </div>
    <div v-if="notice" class="file-markdown-notice" :class="{ 'is-error': notice.failed }" role="status"><span>{{ notice.message }}</span><button type="button" aria-label="关闭提示" @click="notice = null">×</button></div>
    <FileMarkdownImageViewer :image="zoomed" @close="zoomed = null" />
  </div>
</template>
