<!--
  文件标签的 Markdown 预览：渲染受限 HTML，再在 DOM 上补齐公式、标题锚点与目录、代码高亮与项目内图片。

  与聊天正文共用块级排版样式，但内容边界不同：这里允许项目内图片与可跳转链接，因此点击分五类处理
  ——锚点在文档内滚动、标题锚点复制「路径#id」、项目内 Markdown 打开新标签页、http(s) 交系统浏览器、
  其余只复制地址；代码块与表格沿用与聊天一致的结构，复制按钮仍在本地完成。

  预览本身可编辑，修改结果按原文区间上报父级写回编辑器文档（父级是唯一真源，保存与撤销仍走编辑器）：
  段落、标题、列表条目、引用段直接改渲染结果，提交时用 `markdown-inline-serialize` 还原成 Markdown；
  代码块、表格、公式、图片、front matter 以及带嵌套结构的条目改成等宽源码框，避免渲染层丢失结构。
  提交后只重绘被改的那一个顶层块，其余 DOM 不动，因此图片不重读、代码不重新高亮、滚动位置不跳。
  提交前与进入编辑时的序列化基线比较：内容没真变（例如只点了一下就看别处）就只还原 DOM，
  不写回编辑器，也不会把标点改成转义写法。

  渲染后的异步补全（图片、高亮）都带序号校验：正文一变就丢弃旧结果，避免迟到的读取覆盖新内容。
  目录在左侧，条目在提取标题 id 时一并算出并上报父级，由父级决定是否显示目录栏；当前标题按滚动位置
  计算后交给目录面板高亮，面板不自己监听滚动。

  预览内查找在正文文本节点上做匹配，用 CSS Custom Highlight API 着色；快捷键只在预览可见时生效，
  关闭查找、切换文件与卸载都会清掉高亮，避免旧 Range 留在新内容上。

  三处与正文渲染器无关的阅读增强都在这里落地：引用首行的 `[!NOTE]` 一类标记由 `applyCallouts` 换成
  带语义色的标题行；超过阈值的长文档进入大文档模式，跳过代码高亮与多余图片读取，也不提供就地编辑；
  项目内图片可点击放大，浮层复用的是正文里已加载的同一份地址，不再读盘。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FileMarkdownBlock, FileMarkdownTocEntry } from '../file-markdown'
import {
  applyCallouts,
  ensureHeadingIds,
  lexFileMarkdown,
  renderFileMarkdown,
  renderFileMarkdownBlock,
  resolveProjectPath
} from '../file-markdown'
import { applyHighlights, clearHighlights, collectMatches, scrollRangeIntoView } from '../file-markdown-search'
import { clearMarkdownImageCache, loadMarkdownImage } from '../file-images'
import { highlightCodeBlocks } from '../file-code-highlight'
import { serializeInlineMarkdown } from '../markdown-inline-serialize'
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
  /** 是否允许在预览里就地编辑；只读大文件为 false，此时只有阅读能力。 */
  readonly editable: boolean
}>()

const emit = defineEmits<{
  toc: [entries: readonly FileMarkdownTocEntry[]]
  closeToc: []
  /** 就地编辑的结果：把原文 [start, end) 换成 text，由父级写回编辑器文档。 */
  edit: [change: { readonly start: number; readonly end: number; readonly text: string }]
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
/** 源码框最多铺开的行数；更长的块在框内滚动，避免一屏被一个代码块占满。 */
const SOURCE_MAX_ROWS = 40
/** 进入大文档模式的字符数：超过后跳过重活，只保留阅读必要的那部分补全。 */
const LARGE_DOCUMENT_CHARS = 300_000
/** 大文档模式下最多加载的图片张数：其余只保留占位说明。 */
const LARGE_DOCUMENT_MAX_IMAGES = 8
/** 进入就地编辑时要跳过的子结构：这些块改渲染会丢内容，渲染器已把它们标成源码编辑。 */
const STRUCTURED_SELECTOR = [
  '.markdown-code-block',
  '.markdown-table-scroll',
  '.file-markdown-image-frame',
  '.markdown-math-inline',
  '.markdown-math-block',
  '.file-markdown-frontmatter',
  'ul',
  'ol'
].join(', ')

/** 正在编辑的块：提交或取消时按这里记录的区间与现场处理。 */
interface EditingState {
  readonly kind: 'text' | 'source'
  readonly tokenIndex: number
  readonly start: number
  readonly end: number
  /** 承载输入的元素：text 是块元素本身，source 是等宽源码框。 */
  readonly target: HTMLElement
  /**
   * 进入编辑时序列化出的文本：提交时与它比较，判「有没有真改过」。
   * 不能拿它和原文切片比：行内序列化会给 Markdown 标点加反斜杠，永远和原文对不上，
   * 那样即使只是点了一下再走开也会写回文件。
   */
  readonly baseline: string
  /** 退出编辑时把 DOM 恢复成进入前的样子。 */
  readonly restore: () => void
}

const workspaceTabsStore = useWorkspaceTabsStore()
const scroller = ref<HTMLElement | null>(null)
const body = ref<HTMLElement | null>(null)
const toc = ref<readonly FileMarkdownTocEntry[]>([])
const activeHeadingId = ref('')
const notice = ref('')
const noticeFailed = ref(false)
/** 当前用于渲染的文本：本地编辑先落地到这里，父级写回编辑器后由 `text` 追平。 */
const renderText = ref(props.text)
/** 渲染失败时正文区退化为原文展示。 */
const renderFailed = ref(false)
/** 当前 DOM 对应的块描述；提交编辑时用它判断结构是否变化。 */
let blocks: readonly FileMarkdownBlock[] = []
const editing = ref<EditingState | null>(null)
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
/** 正在放大查看的图片；只存已加载的项目内图片地址与替代文本。 */
const zoomed = ref<{ readonly src: string; readonly alt: string } | null>(null)
const zoomDialog = ref<HTMLElement | null>(null)

/** 正文是否超出大文档阈值：渲染与补全都按它降级，阈值只看字符数，不额外做统计。 */
const largeDocument = computed(() => renderText.value.length > LARGE_DOCUMENT_CHARS)

/** 匹配状态文案：空查询不显示；命中为 0 时说明无结果，触顶时用「+」标注还有更多。 */
const searchStatus = computed(() => {
  if (searchQuery.value.trim() === '') return ''
  if (searchMatches.value.length === 0) return '无结果'
  const suffix = searchTruncated.value ? ' +' : ''
  return `${searchActive.value + 1}/${searchMatches.value.length}${suffix}`
})

// 外部文本替换（切文件、磁盘重新载入、源码模式改完再切回来）：整篇重建，图片缓存一并清掉。
watch(() => props.text, (text) => {
  if (text === renderText.value) return
  cancelEdit()
  renderText.value = text
  notice.value = ''
  noticeFailed.value = false
  activeHeadingId.value = ''
  resetSearch()
  clearMarkdownImageCache()
  mountDocument()
})

// 相对路径变了，图片与链接的基准目录也变了：必须重新渲染，不能只清缓存。
watch(() => props.path, () => {
  cancelEdit()
  activeHeadingId.value = ''
  resetSearch()
  clearMarkdownImageCache()
  mountDocument()
})

// 可编辑性变化（大文件只读）时重新标注块：复选框与编辑入口都要跟着变。
watch(() => props.editable, () => {
  cancelEdit()
  if (body.value !== null) applyBlockRanges(body.value)
})

// 预览被隐藏（切回源码或换标签）时收起查找、放大图并清高亮，避免快捷键与高亮残留在看不见的层里。
watch(() => props.active, (active) => {
  if (active) return
  closeSearch()
  closeZoom()
})

onBeforeUnmount(() => {
  editing.value = null
  revision += 1
  window.removeEventListener('keydown', onFindShortcut)
  window.removeEventListener('keydown', onZoomEscape)
  if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame)
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  clearHighlights()
})

onMounted(() => {
  window.addEventListener('keydown', onFindShortcut)
  window.addEventListener('keydown', onZoomEscape)
  mountDocument()
})

/** 整篇重建：写入 HTML、标注块区间，再补全公式、标题 id、代码高亮与图片。 */
function mountDocument(): void {
  const root = body.value
  if (root === null) return
  revision += 1
  const doc = renderFileMarkdown(renderText.value)
  if (doc === null) {
    renderFailed.value = true
    blocks = []
    root.replaceChildren()
    root.textContent = renderText.value
    toc.value = []
    emit('toc', [])
    return
  }

  renderFailed.value = false
  root.innerHTML = doc.html
  blocks = doc.blocks
  applyBlockRanges(root)
  void decorate()
}

/** 渲染后的补全：公式、提示块、标题 id 与目录、代码高亮、项目内图片；每一步都校验代数。 */
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
  // 提示块把引用首行的标记换成标题行，必须在提取目录与计算块区间之前完成，
  // 否则标题文本与可编辑区间都会带上已被剥离的标记。
  applyCallouts(root)
  toc.value = ensureHeadingIds(root)
  emit('toc', toc.value)
  updateActiveHeading()

  // 大文档只保留阅读必需的补全：代码高亮与其余图片逐张读取会拖慢整篇的首次呈现。
  const images = loadImages(root, current)
  if (largeDocument.value) {
    if (searchOpen.value) runSearch()
    await images
    if (current === revision) updateActiveHeading()
    return
  }

  // 代码高亮会重写代码块里的文本节点，查找必须等它结束再扫，否则代码块内的 Range 会立即失效；
  // 图片读取与高亮互不依赖，同时开始，避免有大代码块时预览图片被拖后。
  await highlightCodeBlocks(root, () => current !== revision)
  if (current === revision && searchOpen.value) runSearch()
  await images
  // 图片撑开高度后当前标题可能变化，补一次测量。
  if (current === revision) updateActiveHeading()
}

/**
 * 把块区间写到 DOM 上：顶层元素按 token 顺序一一对应，再沿 `path` 找到可编辑元素。
 * 元素数与分组数不一致说明渲染结构与解析结果对不上，此时不给任何元素标注，整篇保持只读。
 */
function applyBlockRanges(root: HTMLElement): void {
  // 大文档不提供就地编辑：块区间标注会扫完整篇 DOM，而长文档的就地提交也只能整篇重建。
  if (!props.editable || largeDocument.value) return
  const groups = groupByToken(blocks)
  const elements = Array.from(root.children)
  if (elements.length !== groups.length) return

  groups.forEach((group, index) => {
    const top = elements[index]
    const tokenIndex = group[0]?.tokenIndex
    if (top === undefined || tokenIndex === undefined) return
    if (!(top instanceof HTMLElement)) return
    top.dataset.mdToken = String(tokenIndex)

    for (const block of group) {
      if (block.kind === 'skip') continue
      const element = resolveElement(top, block.path)
      if (element === null) continue
      // 行内混了图片、公式或嵌套结构的块改渲染会丢内容，退化成源码编辑。
      if (block.kind === 'text' && element.querySelector(STRUCTURED_SELECTOR) === null) markText(element, block)
      else markSource(element, block)
    }
  })
}

/** 按 tokenIndex 归并块：一个顶层 token 可能给出多条块（列表按条目、引用按段落）。 */
function groupByToken(list: readonly FileMarkdownBlock[]): readonly (readonly FileMarkdownBlock[])[] {
  const groups: FileMarkdownBlock[][] = []
  for (const block of list) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last[0]?.tokenIndex === block.tokenIndex) last.push(block)
    else groups.push([block])
  }
  // 空白 token 不产生元素，不占顶层元素位。
  return groups.filter((group) => group.some((block) => block.kind !== 'skip'))
}

/** 沿子元素路径定位可编辑元素；路径与实际 DOM 不符时返回 null，由调用方跳过。 */
function resolveElement(top: Element, path: readonly number[]): HTMLElement | null {
  let node: Element | null = top
  for (const index of path) {
    node = node.children[index] ?? null
    if (node === null) return null
  }
  return node instanceof HTMLElement ? node : null
}

/** 标注「直接编辑渲染结果」的块；带任务复选框时把偏移挂到复选框上，并解除只读。 */
function markText(element: HTMLElement, block: FileMarkdownBlock): void {
  element.dataset.mdKind = 'text'
  element.dataset.mdStart = String(block.start)
  element.dataset.mdEnd = String(block.end)
  element.dataset.mdToken = String(block.tokenIndex)
  if (block.checkbox < 0) return
  const input = element.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (input === null) return
  input.dataset.mdCheck = String(block.checkbox)
  input.disabled = false
}

/** 标注「用源码框编辑」的块；区间覆盖整块源码。 */
function markSource(element: HTMLElement, block: FileMarkdownBlock): void {
  element.dataset.mdKind = 'source'
  element.dataset.mdStart = String(block.start)
  element.dataset.mdEnd = String(block.end)
  element.dataset.mdToken = String(block.tokenIndex)
}

/** 逐批读取项目内图片；失败时把占位说明替换成可展示的原因，不留下破图。 */
async function loadImages(root: HTMLElement, current: number): Promise<void> {
  const frames = Array.from(root.querySelectorAll<HTMLElement>('.file-markdown-image-frame'))
  if (frames.length === 0) return

  const limit = largeDocument.value ? LARGE_DOCUMENT_MAX_IMAGES : MAX_IMAGES
  const queue = frames.slice(0, limit)
  for (const frame of frames.slice(limit)) markUnloaded(frame, '图片过多，未加载')

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

/**
 * 就地编辑提交：先本地替换文本并只重绘被改的顶层块，再上报父级写回编辑器。
 * 块数变了说明编辑改变了文档结构（例如多出一个空行），此时只能整篇重建。
 */
function applyLocalEdit(tokenIndex: number, start: number, end: number, insert: string): void {
  const root = body.value
  const next = renderText.value.slice(0, start) + insert + renderText.value.slice(end)
  const nextBlocks = lexFileMarkdown(next)
  const sameShape = nextBlocks.length === blocks.length
  const top = sameShape ? findTokenElement(root, tokenIndex) : null
  const html = sameShape ? renderFileMarkdownBlock(next, tokenIndex) : null
  const replacement = html === null ? null : toElement(html)

  if (root === null || top === null || replacement === null) {
    renderText.value = next
    mountDocument()
    return
  }

  top.replaceWith(replacement)
  renderText.value = next
  blocks = nextBlocks
  applyBlockRanges(root)
  // 只补全被改的这一块：图片缓存仍在，代码高亮只重跑这一块。
  const current = revision
  renderMathInto(replacement)
  applyCallouts(replacement)
  void highlightCodeBlocks(replacement, () => current !== revision)
  void loadImages(replacement, current)
  refreshToc()
  if (searchOpen.value) runSearch()
}

/** 顶层元素 → 块：`tokenIndex` 标注在顶层元素上，因此只在直接子元素里找。 */
function findTokenElement(root: HTMLElement | null, tokenIndex: number): HTMLElement | null {
  if (root === null) return null
  for (const child of root.children) {
    if (child instanceof HTMLElement && child.dataset.mdToken === String(tokenIndex)) return child
  }
  return null
}

/** 单块 HTML 包一层容器取首个子元素；渲染结果为空时返回 null。 */
function toElement(html: string): HTMLElement | null {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const element = holder.firstElementChild
  return element instanceof HTMLElement ? element : null
}

/** 标题可能刚被改过：重算 id 与目录，并更新当前标题高亮。 */
function refreshToc(): void {
  const root = body.value
  if (root === null) return
  toc.value = ensureHeadingIds(root)
  emit('toc', toc.value)
  updateActiveHeading()
}

/** 目录跳转：滚动到标题并聚焦，便于键盘用户继续阅读；目标不存在时返回 false。 */
function jumpTo(id: string): boolean {
  commitEdit()
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

/**
 * 按下鼠标：先结束上一处编辑，再在命中的块上进入编辑。
 * 放在 mousedown 而不是 click，是因为可编辑元素要在浏览器决定插入点之前就位，光标才能落在点击处；
 * 提交只替换被改的那一块，点击目标本身不会被销毁，一次点击即可换块继续编辑。
 */
function onContentMouseDown(event: MouseEvent): void {
  if (!props.editable || event.button !== 0) return
  const target = event.target
  if (!(target instanceof Element)) return

  const current = editing.value
  // 点在正在编辑的块内部：交给浏览器处理插入点，不打断输入。
  if (current !== null && current.target.contains(target)) return
  // 图片自己的点击是放大查看，不是进入编辑；先收尾再放行。
  if (target.closest('.file-markdown-image-frame') !== null) {
    commitEdit()
    return
  }
  // 复选框、链接、复制按钮自己处理点击，先收尾再放行。
  if (target.closest('button, input, textarea, summary, a') !== null) {
    commitEdit()
    return
  }
  if (current !== null) {
    commitEdit()
    // 提交替换掉了整块元素时，原点击目标已离开文档，只能放弃这一次进入编辑。
    if (!target.isConnected) return
  }

  const host = target.closest<HTMLElement>('[data-md-kind]')
  if (host === null) return
  startEdit(host)
}

/** 进入编辑：文本块直接在渲染结果上改，结构块换成等宽源码框。 */
function startEdit(host: HTMLElement): void {
  const rawStart = host.dataset.mdStart
  const rawEnd = host.dataset.mdEnd
  const start = Number(rawStart)
  const end = Number(rawEnd)
  const tokenIndex = Number(host.dataset.mdToken)
  if (rawStart === undefined || rawEnd === undefined) return
  if (!Number.isInteger(start) || !Number.isInteger(end) || !Number.isInteger(tokenIndex)) return

  if (host.dataset.mdKind !== 'source') {
    const originalHtml = host.innerHTML
    host.setAttribute('contenteditable', 'plaintext-only')
    host.classList.add('is-editing')
    host.spellcheck = false
    editing.value = {
      kind: 'text',
      tokenIndex,
      start,
      end,
      target: host,
      baseline: textBlockMarkdown(host),
      restore: () => {
        host.innerHTML = originalHtml
        host.removeAttribute('contenteditable')
        host.classList.remove('is-editing')
      }
    }
    return
  }

  const parent = host.parentElement
  if (parent === null) return
  const textarea = document.createElement('textarea')
  textarea.className = 'file-md-source'
  textarea.spellcheck = false
  textarea.value = renderText.value.slice(start, end)
  autoSizeSource(textarea)
  // 高度跟着输入长；监听器随元素一起销毁，不用单独解绑。
  textarea.addEventListener('input', () => autoSizeSource(textarea))
  parent.replaceChild(textarea, host)
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  editing.value = {
    kind: 'source',
    tokenIndex,
    start,
    end,
    target: textarea,
    baseline: textarea.value,
    restore: () => { parent.replaceChild(host, textarea) }
  }
}

/** 源码框高度跟着内容走，最多铺开固定行数，再长就在框内滚动。 */
function autoSizeSource(textarea: HTMLTextAreaElement): void {
  textarea.rows = Math.min(Math.max(textarea.value.split('\n').length, 2), SOURCE_MAX_ROWS)
}

/**
 * 提交当前编辑：文本块按行内序列化还原 Markdown，源码框直接用框里的内容。
 * 与进入编辑时的基线一致说明没真改过（例如只点了一下再看别处）：原地还原 DOM，不写回编辑器。
 */
function commitEdit(): void {
  const state = editing.value
  if (state === null) return
  // 先清状态：接下来的 DOM 替换会触发 focusout，不能让它再提交一次。
  editing.value = null

  const next = state.kind === 'text'
    ? textBlockMarkdown(state.target)
    : (state.target as HTMLTextAreaElement).value
  // 与进入编辑时的基线一致，或改回与原文完全相同，都不必写回编辑器。
  if (next === state.baseline || next === renderText.value.slice(state.start, state.end)) {
    state.restore()
    return
  }
  applyLocalEdit(state.tokenIndex, state.start, state.end, next)
  emit('edit', { start: state.start, end: state.end, text: next })
}

/**
 * 文本块序列化：行内 DOM 还原成 Markdown 后去掉首尾空白。
 * 任务条目的复选框后面跟一个分隔空格，它属于标记层而不是文字，不能随编辑一起写回原文。
 * 位于列表条目里时额外保护行首的 `[ ]`/`[x]`：它会被重新解析成任务标记。
 */
function textBlockMarkdown(element: HTMLElement): string {
  // 条目文字的元素是 `li` 本身或它里面的段落，往上找列表就能判断是否属于列表条目。
  return serializeInlineMarkdown(element, { inListItem: element.closest('ul, ol') !== null }).trim()
}

/** 放弃当前编辑，把 DOM 恢复成进入编辑前的样子。 */
function cancelEdit(): void {
  const state = editing.value
  if (state === null) return
  editing.value = null
  state.restore()
}

/** 编辑态的键盘操作：Esc 放弃，Enter 提交文本块，源码框用 Cmd/Ctrl+Enter 提交（Enter 留给换行）。 */
function onContentKeydown(event: KeyboardEvent): void {
  const state = editing.value
  if (state === null) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
    return
  }
  if (event.key !== 'Enter') return
  if (state.kind === 'source') {
    // 源码框里 Enter 是换行，提交走 Cmd/Ctrl+Enter。
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    commitEdit()
    return
  }
  if (event.shiftKey) return
  event.preventDefault()
  commitEdit()
}

/** 焦点离开编辑元素时提交：键盘 Tab 走开也要落地，不能留下看不见的未提交内容。 */
function onContentFocusOut(event: FocusEvent): void {
  const state = editing.value
  if (state === null) return
  const next = event.relatedTarget
  if (next instanceof Node && state.target.contains(next)) return
  commitEdit()
}

/** 正文是脚本挂载的 HTML，不会经过 Vue 编译；点击统一在内容根节点代理，
 * 处理代码复制、标题锚点、复选框与链接。 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target
  const root = event.currentTarget
  if (!(target instanceof Element) || !(root instanceof HTMLElement)) return
  // 正在编辑的块里不触发链接与复制，避免打断输入。
  const editingState = editing.value
  if (editingState !== null && editingState.target.contains(target)) return

  const checkbox = target.closest<HTMLInputElement>('input[type="checkbox"]')
  if (checkbox !== null) {
    // 复选框的勾选状态由重渲染决定，先挡住原生切换。
    event.preventDefault()
    if (props.editable) toggleTask(checkbox)
    return
  }

  // 图片放大：只对已加载的项目内图片生效，浮层里复用的是同一份 data URL，不再读盘。
  const image = target.closest('img')
  if (image !== null && image.closest('.file-markdown-image-frame') !== null) {
    event.preventDefault()
    openZoom(image.currentSrc || image.src, image.alt)
    return
  }

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

/** 勾选/取消任务：只替换方括号里那一个字符，其余内容与标记原样保留。 */
function toggleTask(checkbox: HTMLInputElement): void {
  const raw = checkbox.dataset.mdCheck
  const tokenIndex = Number(checkbox.closest<HTMLElement>('[data-md-token]')?.dataset.mdToken)
  if (raw === undefined || !Number.isInteger(tokenIndex)) return
  const offset = Number(raw)
  if (!Number.isInteger(offset)) return
  const next = renderText.value[offset] === ' ' ? 'x' : ' '
  applyLocalEdit(tokenIndex, offset, offset + 1, next)
  emit('edit', { start: offset, end: offset + 1, text: next })
}

/** 打开大图浮层：只接受已加载的图片地址，空地址直接忽略；打开后焦点进关闭键。 */
function openZoom(src: string, alt: string): void {
  if (src === '') return
  zoomed.value = { src, alt }
  void nextTick(() => zoomDialog.value?.querySelector<HTMLButtonElement>('button')?.focus())
}

/** 关闭大图浮层：焦点还给正文滚动区，键盘操作不掉到页面顶部。 */
function closeZoom(): void {
  if (zoomed.value === null) return
  zoomed.value = null
  void nextTick(() => scroller.value?.focus({ preventScroll: true }))
}

/** 大图浮层的 Esc：只在浮层打开时接管，不干扰预览里的其他快捷键。 */
function onZoomEscape(event: KeyboardEvent): void {
  if (zoomed.value === null || event.key !== 'Escape' || event.isComposing) return
  event.preventDefault()
  closeZoom()
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

      <!-- 大文档降级提示：告诉用户少了什么、去哪看全文，不把它当成错误。 -->
      <p v-if="largeDocument" class="file-markdown-large-notice" role="status">
        文档较大（{{ renderText.length.toLocaleString() }} 个字符），已进入大文档模式：不提供预览内的就地编辑，代码高亮与超出上限的图片暂不加载。需要完整内容时请切到源码视图。
      </p>

      <!-- 正文由脚本挂载：块区间、局部重绘与编辑态都直接操作 DOM，v-html 会整篇覆盖这些改动。 -->
      <div
        ref="body"
        class="markdown-content markdown-body file-markdown-body"
        :class="{ 'is-hide-frontmatter': !showFrontmatter, 'is-raw': renderFailed }"
        :style="{ '--file-preview-font-size': `${fontSize}px` }"
        @click="onContentClick"
        @mousedown="onContentMouseDown"
        @keydown="onContentKeydown"
        @focusout="onContentFocusOut"
      ></div>
      <p v-if="renderFailed" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
    </div>

    <p v-if="notice !== ''" role="status" class="file-markdown-notice" :class="{ 'is-error': noticeFailed }">
      {{ notice }}
    </p>

    <!-- 图片放大浮层：复用的是正文里已加载的 data URL，点击遮罩或 Esc 关闭。 -->
    <div
      v-if="zoomed !== null"
      ref="zoomDialog"
      class="file-markdown-zoom"
      role="dialog"
      aria-modal="true"
      :aria-label="zoomed.alt === '' ? '图片预览' : `图片预览：${zoomed.alt}`"
      @click="closeZoom"
    >
      <button
        type="button"
        class="file-markdown-zoom-close"
        aria-label="关闭图片预览"
        title="关闭图片预览（Esc）"
        @click.stop="closeZoom"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      <img :src="zoomed.src" :alt="zoomed.alt" @click.stop />
      <p v-if="zoomed.alt !== ''" class="file-markdown-zoom-caption">{{ zoomed.alt }}</p>
    </div>
  </div>
</template>
