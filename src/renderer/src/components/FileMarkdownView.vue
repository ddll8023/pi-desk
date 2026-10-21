<!-- 文件 Markdown 的统一阅读外壳：安全文档直接富文本编辑；其余保留只读排版，目录、查找和图片查看共用。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { applyCallouts, canPreviewFileMarkdown, ensureHeadingIds, renderFileMarkdown, resolveFileMarkdownLink } from '../file-markdown'
import type { FileMarkdownTocEntry } from '../file-markdown'
import { richMarkdownUnsupportedReason } from '../file-rich-markdown'
import { applyHighlights, clearHighlights, collectMatches, scrollRangeIntoView } from '../file-markdown-search'
import { clearMarkdownImageCache, loadMarkdownImage } from '../file-images'
import { highlightCodeBlocks } from '../file-code-highlight'
import { renderMathInto } from '../markdown-math'
import { copyText } from '../clipboard'
import { openExternalUrl } from '../services/external-url'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import FileRichMarkdownEditor from './FileRichMarkdownEditor.vue'
import type { RichMarkdownDraft } from '../file-rich-markdown-draft'
import { resolveDocumentLink } from '../file-rich-markdown-doc-link'
import type { DocumentCatalog } from '../file-rich-markdown-doc-link'
import { headingSlug } from '../file-markdown'
import FileMarkdownToc from './FileMarkdownToc.vue'
import FileMarkdownImageViewer from './FileMarkdownImageViewer.vue'

const props = defineProps<{
  readonly text: string; readonly path: string; readonly projectPath: string
  readonly showToc: boolean; readonly fontSize: number; readonly showFrontmatter: boolean
  readonly active: boolean; readonly editable: boolean
  readonly recovery?: RichMarkdownDraft | null
  readonly reportAssetNotice?: ((message: string) => void) | null
  readonly anchorRequest?: { readonly id: number; readonly anchor: string } | null
}>()
const emit = defineEmits<{
  toc: [entries: readonly FileMarkdownTocEntry[]]
  closeToc: [restoreFocus?: boolean]
  pendingEdit: [pending: boolean]
  draft: [snapshot: RichMarkdownDraft | null]
  anchorHandled: [requestId: number]
  edit: [text: string]
  editingStatus: [reason: string | null]
}>()
const tabs = useWorkspaceTabsStore()
const documents = ref<DocumentCatalog>({ entries: [], loaded: false, truncated: false })
const shell = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const readonlyBody = ref<HTMLElement | null>(null)
const rich = ref<InstanceType<typeof FileRichMarkdownEditor> | null>(null)
const renderText = ref(props.text)
const unsupported = computed(() => props.editable ? richMarkdownUnsupportedReason(renderText.value) : '此文件只读。')
const runtimeFailure = ref('')
const richReady = ref(false)
const richEnabled = computed(() => props.editable && unsupported.value === null && runtimeFailure.value === '')
const toc = ref<readonly FileMarkdownTocEntry[]>([])
const activeHeadingId = ref('')
const narrow = ref(false)
const renderFailed = ref(false)
const notice = ref('')
const noticeFailed = ref(false)
const zoomed = ref<{ readonly src: string; readonly alt: string } | null>(null)
const searchOpen = ref(false)
const searchQuery = ref('')
const searchMatches = ref<readonly Range[]>([])
const searchTruncated = ref(false)
const searchActive = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)
let revision = 0
let scrollFrame = 0
let searchTimer: number | null = null
let resizeObserver: ResizeObserver | null = null
let needsMount = true
const searchStatus = computed(() => !searchQuery.value.trim() ? '' : !searchMatches.value.length ? '无结果' : `${searchActive.value + 1}/${searchMatches.value.length}${searchTruncated.value ? ' +' : ''}`)

function contentRoot(): HTMLElement | null { return body.value?.querySelector<HTMLElement>('.file-rich-body') ?? readonlyBody.value }
/** 委托富文本刷新并透传 force；只读分支无待提交输入，直接返回 true，不放宽安全校验。 */
function flushEdit(force = false): boolean { return rich.value?.flushEdit(force) ?? true }
/** 返回刷新后的文档全文；富文本同步受阻时返回 null，由调用方停止本次保存或主动视图切换。 */
function getText(force = false): string | null { return flushEdit(force) ? renderText.value : null }
function showNotice(text: string, failed = false): void { notice.value = text; noticeFailed.value = failed }
function onRichEdit(text: string): void { renderText.value = text; emit('edit', text) }
function onRichUpdated(): void {
  void nextTick(() => { refreshToc(); updateActiveHeading(); handleAnchorRequest(); if (searchOpen.value) runSearch(false) })
}
function onRichReady(ready: boolean): void {
  richReady.value = ready
  if (ready) onRichUpdated()
  else { runtimeFailure.value = notice.value || '富文本编辑器不可用，已保留只读排版。'; needsMount = true; void nextTick(mountReadonly) }
}
watch([unsupported, runtimeFailure], () => emit('editingStatus', runtimeFailure.value || unsupported.value), { immediate: true })
watch(() => props.text, text => {
  if (text === renderText.value) return
  renderText.value = text
  if (runtimeFailure.value) { runtimeFailure.value = ''; richReady.value = false }
  resetSearch()
  clearMarkdownImageCache()
  activeHeadingId.value = ''
  revision += 1
  needsMount = true
  if (props.active && !richEnabled.value) void nextTick(mountReadonly)
})
watch(() => props.path, () => {
  flushEdit(true)
  runtimeFailure.value = ''
  richReady.value = false
  resetSearch()
  clearMarkdownImageCache()
  revision += 1
  needsMount = true
  if (props.active && !richEnabled.value) void nextTick(mountReadonly)
})
watch(richEnabled, enabled => { if (!enabled) { needsMount = true; if (props.active) void nextTick(mountReadonly) } })
watch(() => props.active, active => {
  if (active) {
    if (!richEnabled.value && needsMount) void nextTick(mountReadonly)
    else onRichUpdated()
  } else {
    flushEdit()
    revision += 1
    if (!richEnabled.value) needsMount = true
    resetSearch()
    zoomed.value = null
  }
})
watch(() => props.anchorRequest?.id, () => void nextTick(handleAnchorRequest))
watch(() => props.showFrontmatter, () => { if (searchOpen.value) void nextTick(() => runSearch(false)) })
watch(() => props.fontSize, () => { if (props.active) void nextTick(updateActiveHeading) })
watch(() => props.showToc, show => { if (show && narrow.value) void nextTick(() => shell.value?.querySelector<HTMLElement>('nav select')?.focus()) })

onMounted(() => {
  window.addEventListener('keydown', onFindShortcut)
  if (shell.value) {
    resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const previous = narrow.value
      narrow.value = entry.contentRect.width < 960
      if (narrow.value && !previous) emit('closeToc', false)
    })
    narrow.value = shell.value.clientWidth < 960
    if (narrow.value) emit('closeToc', false)
    resizeObserver.observe(shell.value)
  }
  if (props.active && !richEnabled.value) mountReadonly()
})
onBeforeUnmount(() => {
  flushEdit(true)
  revision += 1
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onFindShortcut)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  resetSearch()
})

/** 只有只读降级分支允许直接挂载/装饰 HTML，不能触碰富文本管理的 DOM。 */
function mountReadonly(): void {
  if (!props.active || richEnabled.value) return
  const root = readonlyBody.value
  if (!root || !canPreviewFileMarkdown(renderText.value)) return
  const current = ++revision
  needsMount = false
  const document = renderFileMarkdown(renderText.value)
  renderFailed.value = document === null
  if (!document) { root.textContent = renderText.value; toc.value = []; emit('toc', []); return }
  root.innerHTML = document.html
  renderMathInto(root)
  applyCallouts(root)
  refreshToc()
  updateActiveHeading()
  handleAnchorRequest()
  void highlightCodeBlocks(root, () => current !== revision || !props.active).then(() => { if (current === revision && searchOpen.value) runSearch(false) })
  void loadImages(root, current)
}
async function loadImages(root: HTMLElement, current: number): Promise<void> {
  const frames = Array.from(root.querySelectorAll<HTMLElement>('.file-markdown-image-frame'))
  let chars = 0
  for (const frame of frames.slice(40)) frame.textContent = '图片过多，未加载'
  const queue = frames.slice(0, 40)
  for (let start = 0; start < queue.length; start += 4) {
    if (current !== revision || !props.active) return
    await Promise.all(queue.slice(start, start + 4).map(async frame => {
      const label = frame.dataset.imageLabel ?? '图片'
      const source = await loadMarkdownImage(props.projectPath, props.path, frame.dataset.imagePath ?? '')
      if (current !== revision || !frame.isConnected) return
      if (!source.url || chars + source.url.length > 32 * 1024 * 1024) {
        frame.textContent = `${label}（${source.error ?? '图片总量超出上限'}）`
        frame.classList.add('is-error')
        return
      }
      chars += source.url.length
      const image = document.createElement('img')
      image.src = source.url; image.alt = label; image.loading = 'lazy'; image.decoding = 'async'
      frame.replaceChildren(image)
      frame.classList.add('is-ready')
      frame.tabIndex = 0
      frame.setAttribute('role', 'button')
      frame.setAttribute('aria-label', `放大图片：${label}`)
    }))
  }
  if (current === revision) updateActiveHeading()
}
function refreshToc(): void {
  const root = contentRoot()
  if (!root) return
  if (richEnabled.value) {
    toc.value = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).flatMap(heading => {
      const copy = heading.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.markdown-heading-anchor').forEach(anchor => anchor.remove())
      const label = copy.textContent?.trim() ?? ''
      return label && heading.id ? [{ id: heading.id, label, level: Number(heading.tagName.slice(1)) }] : []
    })
  } else toc.value = ensureHeadingIds(root)
  emit('toc', toc.value)
}
function jumpTo(id: string): boolean {
  if (!flushEdit()) return false
  const target = contentRoot()?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (!target) return false
  if (richEnabled.value) rich.value?.navigateTo(id)
  else {
    for (let parent = target.parentElement; parent && parent !== body.value; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  void nextTick(() => target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }))
  activeHeadingId.value = id
  if (narrow.value) emit('closeToc', false)
  return true
}
function handleAnchorRequest(): void {
  const request = props.anchorRequest
  if (!props.active || !request || !contentRoot() || (richEnabled.value && !richReady.value) || (!richEnabled.value && needsMount)) return
  if (!jumpTo(request.anchor)) showNotice('文档里没有对应的标题。', true)
  emit('anchorHandled', request.id)
}
function updateActiveHeading(): void {
  const root = contentRoot(); const container = scroller.value
  if (!root || !container) return
  const threshold = container.getBoundingClientRect().top + 24
  let id = ''
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    if (!heading.getClientRects().length) continue
    if (heading.getBoundingClientRect().top > threshold) break
    id = heading.id
  }
  activeHeadingId.value = id
}
/** 正文下方留白也能开始编辑，但不能拦截滚动条、目录、工具按钮或正文拖选。 */
function onBlankPointerDown(event: PointerEvent): void {
  const target = event.target; const container = scroller.value
  if (!props.active || !richEnabled.value || event.button !== 0 || !container || (target !== container && target !== body.value)) return
  const rect = container.getBoundingClientRect()
  if (event.clientX >= rect.left + container.clientWidth) return
  event.preventDefault(); rich.value?.focusEnd()
}
function onScroll(): void {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateActiveHeading() })
}
function onFindShortcut(event: KeyboardEvent): void {
  if (!props.active || zoomed.value || event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return
  event.preventDefault(); openSearch()
}
function openSearch(): void {
  if (!props.active) return
  if (richEnabled.value && rich.value) { rich.value.openSearch(); return }
  if (!flushEdit()) return
  searchOpen.value = true
  void nextTick(() => { searchInput.value?.focus(); searchInput.value?.select(); runSearch() })
}
function resetSearch(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = null
  if (searchOpen.value) clearHighlights()
  searchOpen.value = false; searchQuery.value = ''; searchMatches.value = []; searchActive.value = 0; searchTruncated.value = false
}
function closeSearch(): void { resetSearch(); richEnabled.value ? rich.value?.focus() : scroller.value?.focus({ preventScroll: true }) }
function runSearch(reset = true): void {
  const root = contentRoot()
  if (!root || !searchQuery.value.trim()) { searchMatches.value = []; searchTruncated.value = false; clearHighlights(); return }
  const result = collectMatches(root, searchQuery.value)
  searchMatches.value = result.ranges
  searchTruncated.value = result.truncated
  searchActive.value = reset ? 0 : Math.max(0, Math.min(searchActive.value, result.ranges.length - 1))
  applyHighlights(result.ranges, searchActive.value)
  const first = result.ranges[searchActive.value]
  if (reset && first && scroller.value) scrollRangeIntoView(first, scroller.value)
}
function onSearchInput(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) return
  searchQuery.value = event.target.value
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => { searchTimer = null; runSearch() }, 120)
}
function moveMatch(step: number): void {
  const total = searchMatches.value.length
  if (!total) return
  searchActive.value = (searchActive.value + step + total) % total
  applyHighlights(searchMatches.value, searchActive.value)
  const range = searchMatches.value[searchActive.value]
  if (range && scroller.value) scrollRangeIntoView(range, scroller.value)
}
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch() }
}
async function reportCopy(text: string, label = '代码'): Promise<void> {
  const copied = await copyText(text)
  showNotice(copied ? `${label}已复制。` : `无法复制${label}，请手动复制。`, !copied)
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
  // 富文本普通点击用于落光标；显式修饰键点击才导航，避免编辑链接文字时打开页面。
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
      if (!result.ok) showNotice(result.error.message, true)
      return
    }
    default: await reportCopy(address, '链接地址')
  }
}
defineExpose({ flushEdit, getText, openSearch })
</script>

<template>
  <div ref="shell" class="file-markdown" :class="{ 'is-editable': richEnabled, 'is-narrow': narrow }">
    <button v-if="narrow && showToc && toc.length" type="button" class="file-markdown-toc-backdrop" aria-label="关闭目录" @click="emit('closeToc')"></button>
    <FileMarkdownToc v-if="showToc && toc.length" :entries="toc" :active-id="activeHeadingId" @navigate="jumpTo" @close="emit('closeToc')" />
    <div ref="scroller" class="file-markdown-scroll scroll-area" tabindex="-1" aria-label="文档正文" @pointerdown="onBlankPointerDown" @scroll.passive="onScroll">
      <div v-if="searchOpen" class="file-markdown-search" role="search" aria-label="在文档中查找">
        <input ref="searchInput" :value="searchQuery" type="text" class="file-markdown-search-input" placeholder="在文档中查找" aria-label="在 Markdown 文档中查找" autocomplete="off" spellcheck="false" @input="onSearchInput" @keydown="onSearchKeydown">
        <p class="file-markdown-search-status" role="status">{{ searchStatus }}</p>
        <button type="button" class="file-markdown-search-button" :disabled="!searchMatches.length" aria-label="上一个匹配" @click="moveMatch(-1)">↑</button>
        <button type="button" class="file-markdown-search-button" :disabled="!searchMatches.length" aria-label="下一个匹配" @click="moveMatch(1)">↓</button>
        <button type="button" class="file-markdown-search-button" aria-label="关闭查找" @click="closeSearch">×</button>
      </div>
      <p v-if="!richEnabled && !renderText.trim()" class="file-markdown-empty">文档为空。</p>
      <div ref="body" class="file-rich-container" :style="{ '--file-preview-font-size': `${fontSize}px` }" @click="onContentClick" @dblclick="onDoubleClick" @keydown="onContentKeydown" @toggle.capture="updateActiveHeading(); searchOpen && runSearch(false)">
        <FileRichMarkdownEditor v-if="richEnabled" :key="`${projectPath}\n${path}`" ref="rich" :text="renderText" :path="path" :project-path="projectPath" :active="active" :show-frontmatter="showFrontmatter" :recovery="recovery ?? null" :report-asset-notice="reportAssetNotice ?? null" @notice="showNotice($event)" @draft="emit('draft', $event)" @documents="documents = $event" @edit="onRichEdit" @pending-edit="emit('pendingEdit', $event)" @updated="onRichUpdated" @error="showNotice($event, true)" @ready="onRichReady" @copy="reportCopy" />
        <div v-else ref="readonlyBody" class="markdown-content markdown-body file-markdown-body" :class="{ 'is-hide-frontmatter': !showFrontmatter, 'is-raw': renderFailed }"></div>
      </div>
      <p v-if="renderFailed" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
      <p v-if="!richEnabled && (runtimeFailure || unsupported)" class="file-reader-limit" role="status">{{ runtimeFailure || unsupported }}</p>
    </div>
    <p v-if="notice" role="status" class="file-markdown-notice" :class="{ 'is-error': noticeFailed }">{{ notice }}</p>
    <FileMarkdownImageViewer :image="zoomed" @close="zoomed = null" />
  </div>
</template>
