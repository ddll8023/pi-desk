<!--
  文件标签的 Markdown 预览：渲染受限 HTML，再在 DOM 上补齐公式、标题锚点与目录、代码高亮与项目内图片。

  与聊天正文共用块级排版样式，但内容边界不同：这里允许项目内图片与可跳转链接，因此点击分五类处理
  ——锚点在文档内滚动、标题锚点复制「路径#id」、项目内 Markdown 打开新标签页、http(s) 交系统浏览器、
  其余只复制地址；代码块与表格沿用与聊天一致的结构，复制按钮仍在本地完成。

  渲染后的异步补全（图片、高亮）都带序号校验：正文一变就丢弃旧结果，避免迟到的读取覆盖新内容。
  目录在左侧，条目在提取标题 id 时一并算出并上报父级，由父级决定是否显示目录栏；当前标题按滚动位置
  计算后交给目录面板高亮，面板不自己监听滚动。

  预览内查找在正文文本节点上做匹配，用 CSS Custom Highlight API 着色；快捷键只在预览可见时生效，
  关闭查找、切换文件与卸载都会清掉高亮，避免旧 Range 留在新内容上。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FileMarkdownTocEntry } from '../file-markdown'
import { ensureHeadingIds, renderFileMarkdown, resolveProjectPath } from '../file-markdown'
import { applyHighlights, clearHighlights, collectMatches, scrollRangeIntoView } from '../file-markdown-search'
import { clearMarkdownImageCache, loadMarkdownImage } from '../file-images'
import { highlightCodeBlocks } from '../file-code-highlight'
import { renderMathInto } from '../markdown-math'
import { copyText } from '../clipboard'
import { openExternalUrl } from '../services/external-url'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import FileMarkdownToc from './FileMarkdownToc.vue'

const props = defineProps<{
  /** 要渲染的 Markdown 文本；未保存的修改也走这里。 */
  readonly text: string
  /** 当前文件的项目内相对路径，用于解析图片与链接的相对地址。 */
  readonly path: string
  /** 项目根路径，只作为图片缓存键的一部分，不参与路径拼接。 */
  readonly projectPath: string
  /** 是否显示左侧目录栏；目录为空时无论该值如何都不显示。 */
  readonly showToc: boolean
  /** 正文字号（px）；标题与行内元素按 em 联动。 */
  readonly fontSize: number
  /** 是否显示 Front Matter 折叠块；关闭后只隐藏展示，不改变文件内容。 */
  readonly showFrontmatter: boolean
  /** 预览当前可见（标签活动且处于预览模式）：查找快捷键只在这时生效。 */
  readonly active: boolean
}>()

const emit = defineEmits<{
  toc: [entries: readonly FileMarkdownTocEntry[]]
  closeToc: []
}>()

/** 单张图片的加载上限：文档里图片过多时只加载前若干张，其余保留占位说明。 */
const MAX_IMAGES = 40
/** 图片并发读取数：跨进程读取是 IO 密集操作，少量并发即可，避免一次占满主进程。 */
const IMAGE_CONCURRENCY = 4
/** 单次预览累计图片字符预算（base64 长度近似内存占用）；超出后不再继续读取。 */
const MAX_IMAGE_TOTAL_CHARS = 32 * 1024 * 1024
/** 输入到重新查找的防抖间隔：连续输入时只扫最后一份内容。 */
const SEARCH_DEBOUNCE_MS = 120
/** 目录高亮的判定线：标题越过滚动容器顶部这段距离后才算「当前」。 */
const HEADING_THRESHOLD_PX = 24

const workspaceTabsStore = useWorkspaceTabsStore()
const html = computed(() => renderFileMarkdown(props.text))
const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const toc = ref<readonly FileMarkdownTocEntry[]>([])
const activeHeadingId = ref('')
const notice = ref('')
const noticeFailed = ref(false)
/** 渲染代数：正文更新或卸载后递增，异步补全据此放弃过期结果。 */
let revision = 0
/** 目录高亮的滚动节流句柄。 */
let scrollFrame = 0
/** 查找防抖句柄。 */
let searchTimer: number | null = null

const searchOpen = ref(false)
const searchQuery = ref('')
const searchMatches = ref<readonly Range[]>([])
const searchTruncated = ref(false)
const searchActive = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)

/** 匹配状态文案：空查询不显示；命中为 0 时说明无结果，触顶时用「+」标注还有更多。 */
const searchStatus = computed(() => {
  if (searchQuery.value.trim() === '') return ''
  if (searchMatches.value.length === 0) return '无结果'
  const suffix = searchTruncated.value ? ' +' : ''
  return `${searchActive.value + 1}/${searchMatches.value.length}${suffix}`
})

watch(() => props.text, () => {
  revision += 1
  notice.value = ''
  noticeFailed.value = false
  activeHeadingId.value = ''
  resetSearch()
  clearMarkdownImageCache()
})

watch(() => props.path, () => {
  clearMarkdownImageCache()
  activeHeadingId.value = ''
  resetSearch()
})

// 预览被隐藏（切回源码或换标签）时收起查找并清高亮，避免快捷键与高亮残留在看不见的层里。
watch(() => props.active, (active) => {
  if (!active) closeSearch()
})

onBeforeUnmount(() => {
  revision += 1
  window.removeEventListener('keydown', onFindShortcut)
  if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame)
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  clearHighlights()
})

watch(html, () => { void decorate() }, { flush: 'post' })
onMounted(() => {
  window.addEventListener('keydown', onFindShortcut)
  void decorate()
})

/** 渲染后的补全：公式、标题 id 与目录、代码高亮、项目内图片；每一步都校验代数。 */
async function decorate(): Promise<void> {
  const root = body.value
  // 渲染失败时没有 DOM 可补全；目录也要清空，不能停在上一份文档的条目上。
  if (root === null) {
    toc.value = []
    emit('toc', [])
    return
  }
  const current = revision

  renderMathInto(root)
  toc.value = ensureHeadingIds(root)
  emit('toc', toc.value)
  updateActiveHeading()

  // 代码高亮会重写代码块里的文本节点，查找必须等它结束再扫，否则代码块内的 Range 会立即失效；
  // 图片读取与高亮互不依赖，同时开始，避免有大代码块时预览图片被拖后。
  const images = loadImages(root, current)
  await highlightCodeBlocks(root, () => current !== revision)
  if (current === revision && searchOpen.value) runSearch()
  await images
  // 图片撑开高度后当前标题可能变化，补一次测量。
  if (current === revision) updateActiveHeading()
}

/** 逐批读取项目内图片；失败时把占位说明替换成可展示的原因，不留下破图。 */
async function loadImages(root: HTMLElement, current: number): Promise<void> {
  const frames = Array.from(root.querySelectorAll<HTMLElement>('.file-markdown-image-frame'))
  if (frames.length === 0) return

  const queue = frames.slice(0, MAX_IMAGES)
  for (const frame of frames.slice(MAX_IMAGES)) markUnloaded(frame, '图片过多，未加载')

  let loadedChars = 0
  for (let start = 0; start < queue.length; start += IMAGE_CONCURRENCY) {
    // 预算用尽就停下：一次预览不把整篇图片都搬进内存。
    if (loadedChars > MAX_IMAGE_TOTAL_CHARS) {
      for (const frame of queue.slice(start)) markUnloaded(frame, '图片总量超出预览上限，未加载')
      return
    }

    const batch = queue.slice(start, start + IMAGE_CONCURRENCY)
    await Promise.all(batch.map(async (frame) => {
      const reference = frame.dataset.imagePath ?? ''
      const label = frame.dataset.imageLabel ?? '图片'
      const source = await loadMarkdownImage(props.projectPath, props.path, reference)
      if (current !== revision || !frame.isConnected) return
      if (source.url === null) {
        markUnloaded(frame, source.error ?? '未加载')
        return
      }
      loadedChars += source.url.length
      const image = document.createElement('img')
      image.src = source.url
      image.alt = label
      image.loading = 'lazy'
      image.decoding = 'async'
      frame.replaceChildren(image)
      frame.classList.add('is-ready')
    }))
  }
}

/** 把占位框换成「未加载」说明；失败原因要可见，不能停在「加载中」。 */
function markUnloaded(frame: HTMLElement, reason: string): void {
  const label = frame.dataset.imageLabel ?? '图片'
  frame.textContent = `${label}（${reason}）`
  frame.classList.remove('is-ready')
  frame.classList.add('is-error')
}

/** 目录跳转：滚动到标题并聚焦，便于键盘用户继续阅读；目标不存在时返回 false。 */
function jumpTo(id: string): boolean {
  const target = body.value?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)
  if (target === null || target === undefined) return false
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
  target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
  activeHeadingId.value = id
  return true
}

/**
 * 按滚动位置算出当前标题：取最后一个已经越过判定线的标题。
 * 标题按文档顺序排列，遇到第一个未越线的就停，不必每次遍历整篇。
 */
function updateActiveHeading(): void {
  const root = body.value
  const container = scroller.value
  if (root === null || container === null) return
  const threshold = container.getBoundingClientRect().top + HEADING_THRESHOLD_PX
  let current = ''
  for (const heading of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (heading.getBoundingClientRect().top > threshold) break
    current = heading.id
  }
  activeHeadingId.value = current
}

/** 滚动只按帧计算一次当前标题，避免长文档滚动时每个事件都做一次布局读取。 */
function onScroll(): void {
  if (scrollFrame !== 0) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updateActiveHeading()
  })
}

/** Cmd/Ctrl+F：只在预览可见时接管，打开查找并选中已有查询词。 */
function onFindShortcut(event: KeyboardEvent): void {
  if (!props.active || event.defaultPrevented || event.isComposing) return
  if (event.key.toLowerCase() !== 'f' || event.altKey || event.shiftKey) return
  if (!event.metaKey && !event.ctrlKey) return
  event.preventDefault()
  openSearch()
}

function openSearch(): void {
  searchOpen.value = true
  void nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
    if (searchQuery.value.trim() !== '') runSearch()
  })
}

/** 收起查找：清空查询与高亮，焦点还给正文滚动区，键盘用户不会掉回页面顶部。 */
function closeSearch(): void {
  const wasOpen = searchOpen.value
  resetSearch()
  if (!wasOpen) return
  void nextTick(() => scroller.value?.focus({ preventScroll: true }))
}

/** 清掉查找状态与高亮；文本重建与切换文件也走这里。 */
function resetSearch(): void {
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
  searchOpen.value = false
  searchQuery.value = ''
  searchMatches.value = []
  searchTruncated.value = false
  searchActive.value = 0
  clearHighlights()
}

/** 查询变化后防抖重扫；命中为空时也要清掉上一次的高亮。 */
function onSearchInput(event: Event): void {
  const target = event.target
  searchQuery.value = target instanceof HTMLInputElement ? target.value : ''
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    runSearch()
  }, SEARCH_DEBOUNCE_MS)
}

/** 在当前正文上重新匹配，并把第一个命中滚到视口中间。 */
function runSearch(): void {
  const root = body.value
  if (root === null || searchQuery.value.trim() === '') {
    searchMatches.value = []
    searchTruncated.value = false
    searchActive.value = 0
    clearHighlights()
    return
  }
  const result = collectMatches(root, searchQuery.value)
  searchMatches.value = result.ranges
  searchTruncated.value = result.truncated
  searchActive.value = 0
  applyHighlights(result.ranges, 0)
  const first = result.ranges[0]
  if (first !== undefined && scroller.value !== null) scrollRangeIntoView(first, scroller.value)
}

/** 上一个/下一个命中：循环移动，同时更新高亮与滚动位置。 */
function moveMatch(step: number): void {
  const total = searchMatches.value.length
  if (total === 0) return
  const next = (searchActive.value + step + total) % total
  searchActive.value = next
  applyHighlights(searchMatches.value, next)
  const range = searchMatches.value[next]
  if (range !== undefined && scroller.value !== null) scrollRangeIntoView(range, scroller.value)
}

/** 输入框内的键盘操作：Enter 下一个、Shift+Enter 上一个、Esc 关闭。 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    moveMatch(event.shiftKey ? -1 : 1)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSearch()
  }
}

/** v-html 不会编译 Vue 指令；在当前内容根节点代理代码复制、标题锚点与链接点击。 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target
  const root = event.currentTarget
  if (!(target instanceof Element) || !(root instanceof HTMLElement)) return
  const button = target.closest('button')
  if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return

  if (button.classList.contains('markdown-code-copy')) {
    const code = button.closest('.markdown-code-block')?.querySelector('pre > code')
    if (code === null || code === undefined) return
    event.preventDefault()
    await reportCopy(code.textContent ?? '', '代码')
    return
  }

  if (button.classList.contains('markdown-heading-anchor')) {
    event.preventDefault()
    const id = (button.dataset.linkTarget ?? '').replace(/^#/, '')
    if (id === '') return
    await reportCopy(`${props.path}#${id}`, '标题引用')
    return
  }

  if (!button.classList.contains('markdown-link')) return
  event.preventDefault()
  const address = button.dataset.linkTarget ?? ''
  if (address === '') return

  switch (button.dataset.linkKind) {
    case 'anchor':
      if (!jumpTo(safeDecode(address.replace(/^#/, '')))) {
        showNotice('文档里没有对应的标题锚点。', true)
      }
      return
    case 'file':
      openProjectFile(address)
      return
    case 'external':
      await openInBrowser(address)
      return
    default:
      await reportCopy(address, '链接地址')
  }
}

/** 项目内链接：只有能解析成项目内路径的 Markdown 文件才打开新标签页，其余只提示。 */
function openProjectFile(address: string): void {
  const path = resolveLinkPath(address)
  if (path === null) {
    showNotice('链接目标不在项目内，未打开。', true)
    return
  }
  if (!/\.(md|markdown)$/i.test(path)) {
    showNotice(`链接目标是 ${path}，不是 Markdown 文件；可在文件树中打开。`, true)
    return
  }
  workspaceTabsStore.openFileTab(path)
}

/** 外部链接：地址与协议由主进程再校验一次，拒绝原因就地展示。 */
async function openInBrowser(address: string): Promise<void> {
  const result = await openExternalUrl(address)
  if (!result.ok) showNotice(result.error.message, true)
}

/** 复制到剪贴板并就地反馈；失败必须可见，不能停在「复制」。 */
async function reportCopy(text: string, label: string): Promise<void> {
  if (text === '') {
    showNotice(`${label}为空，没有可复制的内容。`, true)
    return
  }
  const copied = await copyText(text)
  showNotice(copied ? `${label}已复制。` : `无法复制${label}，请手动选择文本复制。`, !copied)
}

function showNotice(text: string, failed: boolean): void {
  notice.value = text
  noticeFailed.value = failed
}

/** 链接地址里可能有百分号编码；解不开时按原文处理，不阻断跳转。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 链接解析复用渲染阶段的同一套规则：相对当前文件目录，越界返回 null。 */
function resolveLinkPath(address: string): string | null {
  return resolveProjectPath(address, props.path)
}
</script>

<template>
  <div class="file-markdown">
    <FileMarkdownToc
      v-if="showToc && toc.length > 0"
      :entries="toc"
      :active-id="activeHeadingId"
      @navigate="jumpTo"
      @close="emit('closeToc')"
    />

    <div
      ref="scroller"
      class="file-markdown-scroll scroll-area"
      tabindex="-1"
      aria-label="文档正文"
      @scroll.passive="onScroll"
    >
      <div v-if="searchOpen" class="file-markdown-search" role="search" aria-label="在预览中查找">
        <input
          ref="searchInput"
          :value="searchQuery"
          type="text"
          class="file-markdown-search-input"
          placeholder="在预览中查找"
          aria-label="在 Markdown 预览中查找"
          autocomplete="off"
          spellcheck="false"
          @input="onSearchInput"
          @keydown="onSearchKeydown"
        >
        <p class="file-markdown-search-status" role="status">{{ searchStatus }}</p>
        <button
          type="button"
          class="file-markdown-search-button"
          :disabled="searchMatches.length === 0"
          aria-label="上一个匹配"
          title="上一个匹配"
          @click="moveMatch(-1)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 10l4-4 4 4" /></svg>
        </button>
        <button
          type="button"
          class="file-markdown-search-button"
          :disabled="searchMatches.length === 0"
          aria-label="下一个匹配"
          title="下一个匹配"
          @click="moveMatch(1)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4" /></svg>
        </button>
        <span class="file-markdown-search-divider" aria-hidden="true"></span>
        <button
          type="button"
          class="file-markdown-search-button"
          aria-label="关闭查找"
          title="关闭查找"
          @click="closeSearch"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      <div
        v-if="html !== null"
        ref="body"
        class="markdown-content markdown-body file-markdown-body"
        :class="{ 'is-hide-frontmatter': !showFrontmatter }"
        :style="{ '--file-preview-font-size': `${fontSize}px` }"
        @click="onContentClick"
        v-html="html"
      ></div>
      <p v-else class="markdown-fallback">{{ text }}</p>
      <p v-if="html === null" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
    </div>

    <p v-if="notice !== ''" role="status" class="file-markdown-notice" :class="{ 'is-error': noticeFailed }">
      {{ notice }}
    </p>
  </div>
</template>
