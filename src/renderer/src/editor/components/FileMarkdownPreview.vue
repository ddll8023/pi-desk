<!-- 文件 Markdown 的只读渲染适配器：管理安全 DOM 与资源，查找和目录界面由工作台统一提供。 -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { applyCallouts, ensureHeadingIds, readHeadingEntries } from '../file-markdown-dom'
import { canPreviewFileMarkdown, renderFileMarkdown } from '../file-markdown'
import { applyHighlights, clearHighlights, collectMatches, scrollRangeIntoView } from '../file-markdown-search'
import { EMPTY_MARKDOWN_SEARCH, EMPTY_MARKDOWN_SEARCH_STATUS } from '../file-markdown-view'
import type { MarkdownReadingView, MarkdownSearchQuery, MarkdownSearchStatus } from '../file-markdown-view'
import { clearMarkdownImageCache, loadMarkdownImage } from '../file-images'
import { highlightCodeBlocks } from '../file-code-highlight'
import { renderMathInto } from '../../ui/markdown-math'

const props = defineProps<{
  readonly text: string
  readonly path: string
  readonly projectPath: string
  readonly active: boolean
  readonly showFrontmatter: boolean
}>()
const emit = defineEmits<{ updated: []; notice: [message: string] }>()
const root = ref<HTMLElement | null>(null)
const renderFailed = ref(false)
const highlightOwner = Symbol('markdown-preview')
let revision = 0
let needsMount = true
let query: MarkdownSearchQuery = EMPTY_MARKDOWN_SEARCH
let matches: readonly Range[] = []
let truncated = false
let active = 0

function getSearchStatus(): MarkdownSearchStatus { return { total: matches.length, active, truncated } }
function clearMatches(): void {
  matches = []; active = 0; truncated = false
  clearHighlights(highlightOwner)
}
function clearSearch(): void { query = EMPTY_MARKDOWN_SEARCH; clearMatches() }
function runSearch(reset: boolean, reveal: boolean): MarkdownSearchStatus {
  const element = root.value
  if (!props.active || needsMount || !element || !query.query.trim()) {
    clearMatches()
    return EMPTY_MARKDOWN_SEARCH_STATUS
  }
  const result = collectMatches(element, query.query)
  matches = result.ranges; truncated = result.truncated
  active = reset ? 0 : Math.max(0, Math.min(active, matches.length - 1))
  applyHighlights(highlightOwner, matches, active)
  const match = matches[active]
  const container = element.closest<HTMLElement>('.file-markdown-scroll')
  if (reveal && match && container) scrollRangeIntoView(match, container)
  return getSearchStatus()
}
function setSearch(next: MarkdownSearchQuery, reveal = false): MarkdownSearchStatus {
  const changed = next.query !== query.query
  query = next
  return runSearch(changed, reveal)
}
function moveMatch(step: number): MarkdownSearchStatus {
  if (!matches.length || !props.active) return getSearchStatus()
  active = (active + step + matches.length) % matches.length
  applyHighlights(highlightOwner, matches, active)
  const match = matches[active]
  const container = root.value?.closest<HTMLElement>('.file-markdown-scroll')
  if (match && container) scrollRangeIntoView(match, container)
  return getSearchStatus()
}
function focus(): void { root.value?.closest<HTMLElement>('.file-markdown-scroll')?.focus({ preventScroll: true }) }
function navigateTo(id: string): boolean {
  const element = root.value
  if (needsMount || !element) return false
  const target = element.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (!target) return false
  for (let parent = target.parentElement; parent && parent !== element; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true
  }
  target.tabIndex = -1
  target.focus({ preventScroll: true })
  const current = revision
  void nextTick(() => {
    if (current === revision && props.active && target.isConnected) target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  })
  return true
}
function onToggle(): void {
  if (needsMount) return
  runSearch(false, false)
  emit('updated')
}
function mountReadonly(): void {
  if (!props.active || !canPreviewFileMarkdown(props.text) || !root.value) return
  const element = root.value
  const current = ++revision
  clearMatches()
  const rendered = renderFileMarkdown(props.text)
  needsMount = false
  renderFailed.value = rendered === null
  if (!rendered) {
    element.textContent = props.text
    emit('updated')
    return
  }
  try {
    element.innerHTML = rendered.html
    renderMathInto(element)
    applyCallouts(element)
    ensureHeadingIds(element)
  } catch {
    renderFailed.value = true
    element.textContent = props.text
    emit('updated')
    return
  }
  runSearch(false, false)
  emit('updated')
  void highlightCodeBlocks(element, () => current !== revision || !props.active).then(() => {
    if (current === revision && props.active) { runSearch(false, false); emit('updated') }
  }).catch(() => {
    if (current === revision && props.active) emit('notice', '代码高亮暂不可用，文档内容未改变。')
  })
  void loadImages(element, current)
}
async function loadImages(element: HTMLElement, current: number): Promise<void> {
  const frames = Array.from(element.querySelectorAll<HTMLElement>('.file-markdown-image-frame'))
  let chars = 0
  for (const frame of frames.slice(40)) frame.textContent = '图片过多，未加载'
  const queue = frames.slice(0, 40)
  for (let start = 0; start < queue.length; start += 4) {
    if (current !== revision || !props.active) return
    await Promise.all(queue.slice(start, start + 4).map(async frame => {
      const label = frame.dataset.imageLabel ?? '图片'
      const source = await loadMarkdownImage(props.projectPath, props.path, frame.dataset.imagePath ?? '')
      if (current !== revision || !props.active || !frame.isConnected) return
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
    if (current === revision && props.active) emit('updated')
  }
}
function invalidate(): void {
  clearMatches(); clearMarkdownImageCache(); revision += 1; needsMount = true
  if (props.active) void nextTick(mountReadonly)
}
watch([() => props.text, () => props.path, () => props.projectPath], invalidate)
watch(() => props.active, value => {
  if (value && needsMount) void nextTick(mountReadonly)
  else if (!value) { revision += 1; needsMount = true; clearSearch() }
})
watch(() => props.showFrontmatter, () => void nextTick(() => { runSearch(false, false); emit('updated') }))
onMounted(() => { if (props.active) mountReadonly() })
onBeforeUnmount(() => { revision += 1; clearSearch() })

const adapter: MarkdownReadingView = {
  getRoot: () => needsMount ? null : root.value,
  getToc: () => root.value && !needsMount && !renderFailed.value ? readHeadingEntries(root.value) : [],
  focus, navigateTo, setSearch, moveMatch, clearSearch, getSearchStatus
}
defineExpose(adapter)
</script>

<template>
  <div class="file-markdown-preview">
    <p v-if="!text.trim()" class="file-markdown-empty">文档为空。</p>
    <div ref="root" class="markdown-content markdown-body file-markdown-body" :class="{ 'is-hide-frontmatter': !showFrontmatter, 'is-raw': renderFailed }" @toggle.capture="onToggle"></div>
    <p v-if="renderFailed" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
  </div>
</template>
