<!--
  文件标签的 Markdown 预览：渲染受限 HTML，再在 DOM 上补齐公式、标题锚点与目录、代码高亮与项目内图片。

  与聊天正文共用块级排版样式，但内容边界不同：这里允许项目内图片与可跳转链接，因此点击分四类处理
  ——锚点在文档内滚动、项目内 Markdown 打开新标签页、http(s) 交系统浏览器、其余只复制地址；
  代码块与表格沿用与聊天一致的结构，复制按钮仍在本地完成。

  渲染后的异步补全（图片、高亮）都带序号校验：正文一变就丢弃旧结果，避免迟到的读取覆盖新内容。
  目录条目在提取标题 id 时一并算出并上报父级，由父级决定是否显示目录栏。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FileMarkdownTocEntry } from '../file-markdown'
import { ensureHeadingIds, renderFileMarkdown, resolveProjectPath } from '../file-markdown'
import { clearMarkdownImageCache, loadMarkdownImage } from '../file-images'
import { highlightCodeBlocks } from '../file-code-highlight'
import { renderMathInto } from '../markdown-math'
import { copyText } from '../clipboard'
import { openExternalUrl } from '../services/external-url'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'

const props = defineProps<{
  /** 要渲染的 Markdown 文本；未保存的修改也走这里。 */
  readonly text: string
  /** 当前文件的项目内相对路径，用于解析图片与链接的相对地址。 */
  readonly path: string
  /** 项目根路径，只作为图片缓存键的一部分，不参与路径拼接。 */
  readonly projectPath: string
  /** 是否显示右侧目录栏；目录为空时无论该值如何都不显示。 */
  readonly showToc: boolean
}>()

const emit = defineEmits<{
  toc: [entries: readonly FileMarkdownTocEntry[]]
}>()

/** 单张图片的加载上限：文档里图片过多时只加载前若干张，其余保留占位说明。 */
const MAX_IMAGES = 40
/** 图片并发读取数：跨进程读取是 IO 密集操作，少量并发即可，避免一次占满主进程。 */
const IMAGE_CONCURRENCY = 4
/** 单次预览累计图片字符预算（base64 长度近似内存占用）；超出后不再继续读取。 */
const MAX_IMAGE_TOTAL_CHARS = 32 * 1024 * 1024

const workspaceTabsStore = useWorkspaceTabsStore()
const html = computed(() => renderFileMarkdown(props.text))
const body = ref<HTMLElement | null>(null)
const toc = ref<readonly FileMarkdownTocEntry[]>([])
const notice = ref('')
const noticeFailed = ref(false)
/** 渲染代数：正文更新或卸载后递增，异步补全据此放弃过期结果。 */
let revision = 0

watch(() => props.text, () => {
  revision += 1
  notice.value = ''
  noticeFailed.value = false
  clearMarkdownImageCache()
})

watch(() => props.path, () => {
  clearMarkdownImageCache()
})

onBeforeUnmount(() => {
  revision += 1
})

watch(html, () => { void decorate() }, { flush: 'post' })
onMounted(() => { void decorate() })

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

  void highlightCodeBlocks(root, () => current !== revision)
  await loadImages(root, current)
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
  return true
}

/** v-html 不会编译 Vue 指令；在当前内容根节点代理代码复制与链接点击。 */
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
    <div class="file-markdown-scroll scroll-area">
      <div
        v-if="html !== null"
        ref="body"
        class="markdown-content markdown-body file-markdown-body"
        @click="onContentClick"
        v-html="html"
      ></div>
      <p v-else class="markdown-fallback">{{ text }}</p>
      <p v-if="html === null" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
    </div>

    <nav v-if="showToc && toc.length > 0" class="file-markdown-toc scroll-area" aria-label="文档目录">
      <p class="file-markdown-toc-title">目录</p>
      <ul>
        <li v-for="entry in toc" :key="entry.id" :class="`is-level-${entry.level}`">
          <button type="button" class="file-markdown-toc-link" @click="jumpTo(entry.id)">
            {{ entry.label }}
          </button>
        </li>
      </ul>
    </nav>

    <p v-if="notice !== ''" role="status" class="file-markdown-notice" :class="{ 'is-error': noticeFailed }">
      {{ notice }}
    </p>
  </div>
</template>
