<!-- 文档预览组件：统一支持 PDF（Canvas 逐页渲染 + 文本选择层）、DOCX（高保真 DOM 纸张排版）与 DOC（旧版结构化文本提取），提供缩放、翻页、自适应视图与左侧大纲导航。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { renderAsync } from 'docx-preview'
import FileDocumentOutline, { type DocumentOutlineItem } from './FileDocumentOutline.vue'
import type {
  ProjectFileDocContent,
  ProjectFileDocxContent,
  ProjectFilePdfContent
} from '../../../../shared/project-file-api'

// 设置同源 PDF Worker 避免违反 CSP
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const props = defineProps<{
  readonly path: string
  readonly active: boolean
  readonly pdf?: ProjectFilePdfContent | null
  readonly docx?: ProjectFileDocxContent | null
  readonly doc?: ProjectFileDocContent | null
}>()

/** 判定当前展示的文档类型。 */
const docType = computed<'pdf' | 'docx' | 'doc' | null>(() => {
  if (props.pdf) return 'pdf'
  if (props.docx) return 'docx'
  if (props.doc) return 'doc'
  return null
})

// === 通用视口与缩放状态 ===
const viewportRef = shallowRef<HTMLElement | null>(null)
const zoomLevels = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const zoomIndex = ref(2) // 默认 1.0 (100%)
const fitWidth = ref(true) // 默认自适应容器宽度

// === 大纲侧边栏状态 ===
const showOutline = ref(true)
const outlineLoading = ref(false)
const outlineItems = shallowRef<readonly DocumentOutlineItem[]>([])
const activeOutlineId = ref('')

const currentScale = computed(() => zoomLevels[zoomIndex.value] ?? 1)
const zoomPercent = computed(() => `${Math.round(currentScale.value * 100)}%`)

function zoomIn(): void {
  fitWidth.value = false
  if (zoomIndex.value < zoomLevels.length - 1) zoomIndex.value += 1
}

function zoomOut(): void {
  fitWidth.value = false
  if (zoomIndex.value > 0) zoomIndex.value -= 1
}

function resetZoom(): void {
  fitWidth.value = false
  zoomIndex.value = 2 // 100%
}

function toggleFitWidth(): void {
  fitWidth.value = !fitWidth.value
}

// === PDF 相关状态与渲染 ===
const pdfDoc = shallowRef<PDFDocumentProxy | null>(null)
/** 加载任务：v6 只保留 `loadingTask.destroy()`，销毁文档与 worker 都走这里。 */
const pdfLoadingTask = shallowRef<PDFDocumentLoadingTask | null>(null)
const pdfCanvasRef = shallowRef<HTMLCanvasElement | null>(null)
const pdfTextLayerRef = shallowRef<HTMLDivElement | null>(null)
const pdfCurrentPage = ref(1)
const pdfTotalPages = ref(1)
const pdfLoading = ref(false)
const pdfError = ref('')
let activeRenderTask: RenderTask | null = null
let pdfRenderTicket = 0

// === DOCX 相关状态与渲染 ===
const docxContainerRef = shallowRef<HTMLDivElement | null>(null)
const docxLoading = ref(false)
const docxError = ref('')
let docxRenderTicket = 0

// === DOC 正文段落计算 ===
const docParagraphs = computed<readonly string[]>(() => {
  if (!props.doc?.body) return []
  return props.doc.body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
})

/** Base64 转为 ArrayBuffer。 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/** 解析 PDF destination 对应的页码（1 起始）。 */
async function resolvePdfPageNumber(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  if (!dest) return null
  try {
    let explicitDest: unknown = dest
    if (typeof dest === 'string') {
      explicitDest = await doc.getDestination(dest)
    }
    if (Array.isArray(explicitDest) && explicitDest.length > 0) {
      const pageRef = explicitDest[0]
      if (typeof pageRef === 'object' && pageRef !== null) {
        const pageIndex = await doc.getPageIndex(pageRef)
        return pageIndex + 1
      }
      if (typeof pageRef === 'number') {
        return pageRef + 1
      }
    }
  } catch {
    // 忽略异常目标解析
  }
  return null
}

interface RawPdfOutlineItem {
  title: string
  dest?: unknown
  items?: RawPdfOutlineItem[]
}

/** 递归将 PDF 原生 outline 树转换为组件标准 DocumentOutlineItem 树。 */
function transformPdfOutline(rawItems: RawPdfOutlineItem[], prefix = 'pdf-outline'): DocumentOutlineItem[] {
  return rawItems.map((item, index) => {
    const id = `${prefix}-${index}`
    const base = { id, label: item.title?.trim() || '未命目标题', level: 1 }
    // `exactOptionalPropertyTypes` 下不能显式写 `children: undefined`，空子树直接略去该字段。
    const children = item.items && item.items.length > 0 ? transformPdfOutline(item.items, id) : null
    return item.dest === undefined
      ? (children === null ? base : { ...base, children })
      : (children === null ? { ...base, dest: item.dest } : { ...base, dest: item.dest, children })
  })
}

/** 异步为 PDF 大纲节点预解析页码。 */
async function resolveOutlinePages(doc: PDFDocumentProxy, items: DocumentOutlineItem[]): Promise<void> {
  for (const item of items) {
    if (item.dest && !item.pageNumber) {
      const page = await resolvePdfPageNumber(doc, item.dest)
      if (page) item.pageNumber = page
    }
    if (item.children) {
      void resolveOutlinePages(doc, item.children as DocumentOutlineItem[])
    }
  }
}

/** 根据当前 PDF 页码自动同步大纲激活项。 */
function syncActiveOutlineWithPage(page: number): void {
  if (docType.value !== 'pdf') return
  const findMatch = (items: readonly DocumentOutlineItem[]): string | null => {
    for (const item of items) {
      if (item.pageNumber === page) return item.id
      if (item.children) {
        const childMatch = findMatch(item.children)
        if (childMatch) return childMatch
      }
    }
    return null
  }
  const matchId = findMatch(outlineItems.value)
  if (matchId) activeOutlineId.value = matchId
}

watch(pdfCurrentPage, (page) => {
  syncActiveOutlineWithPage(page)
})

/** 从 DOCX 渲染后的 DOM 与样式元数据中提取标题构建大纲树。 */
function extractDocxOutline(doc?: any): void {
  if (!docxContainerRef.value) return

  // 1. 从 docx-preview 的 stylesPart 解析出真正的标题样式与类名映射
  const headingClassMap = new Map<string, number>()
  if (doc && doc.stylesPart && Array.isArray(doc.stylesPart.styles)) {
    for (const style of doc.stylesPart.styles) {
      const name = String(style.name || '').toLowerCase()
      const id = String(style.id || '').toLowerCase()
      let level = 0
      const headingMatch = name.match(/heading\s*(\d+)/i) || id.match(/heading\s*(\d+)/i) || name.match(/标题\s*(\d+)/)
      if (headingMatch) {
        const digits = headingMatch[1]
        if (digits !== undefined) level = parseInt(digits, 10)
      } else if (name === 'title' || id === 'title') {
        level = 1
      } else if (name === 'subtitle' || id === 'subtitle') {
        level = 2
      }
      if (level > 0 && style.id) {
        // docx-preview 使用 escapeClassName(style.id) 作为 class 后缀
        const escaped = String(style.id).replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()
        headingClassMap.set(`docx_${escaped}`, level)
        headingClassMap.set(`docx_${String(style.id).toLowerCase()}`, level)
      }
    }
  }

  // 2. 遍历容器内的所有段落 <p>
  const paragraphs = docxContainerRef.value.querySelectorAll<HTMLElement>('p')
  const flatItems: DocumentOutlineItem[] = []
  let index = 0

  paragraphs.forEach((p) => {
    const text = p.textContent?.trim()
    if (!text) return

    let matchedLevel = 0

    // 优先通过 Word 标题样式类名命中
    for (const cls of Array.from(p.classList)) {
      const lvl = headingClassMap.get(cls.toLowerCase())
      if (lvl) {
        matchedLevel = lvl
        break
      }
    }

    // 兜底：启发式识别（针对未应用样式、纯手工大号字或粗体编排的段落）
    if (!matchedLevel && text.length <= 60 && !text.includes('\n')) {
      const computedStyle = window.getComputedStyle(p)
      const fontSize = parseFloat(computedStyle.fontSize) || 14
      const fontWeight = parseInt(computedStyle.fontWeight, 10) || 400
      const isBold = fontWeight >= 600 || computedStyle.fontWeight === 'bold'

      if (fontSize >= 19 && isBold) {
        matchedLevel = 1
      } else if (fontSize >= 16 && isBold) {
        matchedLevel = 2
      } else if (isBold && /^(第[一二三四五六七八九十0-9]+[章节卷篇部分]|[\d一二三四五六七八九十]+[、.．\s])/.test(text)) {
        matchedLevel = 2
      }
    }

    if (matchedLevel > 0) {
      const domId = `docx-heading-${index++}`
      p.id = domId
      flatItems.push({
        id: domId,
        label: text,
        level: matchedLevel,
        domId
      })
    }
  })

  // 3. 将扁平列表转换为多级树状结构，支持层级折叠展开
  if (flatItems.length === 0) {
    outlineItems.value = []
    return
  }

  const rootItems: DocumentOutlineItem[] = []
  const stack: { item: DocumentOutlineItem; children: DocumentOutlineItem[] }[] = []

  for (const flat of flatItems) {
    const node: DocumentOutlineItem = {
      ...flat,
      children: []
    }
    const childrenArr = node.children as DocumentOutlineItem[]

    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top === undefined || top.item.level < node.level) break
      stack.pop()
    }

    const parent = stack[stack.length - 1]
    if (parent === undefined) {
      rootItems.push(node)
    } else {
      parent.children.push(node)
    }

    stack.push({ item: node, children: childrenArr })
  }

  const sanitizeTree = (items: DocumentOutlineItem[]): DocumentOutlineItem[] => {
    return items.map(item => {
      const children = item.children === undefined ? [] : sanitizeTree([...item.children])
      // 空子树不写 `children`：`exactOptionalPropertyTypes` 不接受显式 undefined。
      const base = {
        id: item.id,
        label: item.label,
        level: item.level,
        ...(item.pageNumber === undefined ? {} : { pageNumber: item.pageNumber }),
        ...(item.dest === undefined ? {} : { dest: item.dest }),
        ...(item.domId === undefined ? {} : { domId: item.domId })
      }
      return children.length === 0 ? base : { ...base, children }
    })
  }

  outlineItems.value = sanitizeTree(rootItems)
}

/** 从 DOC 旧版提取段落中提取章节标题大纲。 */
function extractDocOutline(): void {
  if (!docParagraphs.value || docParagraphs.value.length === 0) {
    outlineItems.value = []
    return
  }
  const items: DocumentOutlineItem[] = []
  docParagraphs.value.forEach((text, index) => {
    if (text.length <= 40 && (/^(第[一二三四五六七八九十0-9]+[章节卷篇部分]|[\d一二三四五六七八九十]+[、.．\s])/.test(text) || index === 0)) {
      items.push({
        id: `doc-p-${index}`,
        label: text,
        level: 1,
        domId: `doc-p-${index}`
      })
    }
  })
  outlineItems.value = items
}

/** 处理大纲项点击导航。 */
async function onNavigateOutline(item: DocumentOutlineItem): Promise<void> {
  activeOutlineId.value = item.id
  if (docType.value === 'pdf' && pdfDoc.value) {
    let targetPage = item.pageNumber
    if (!targetPage && item.dest) {
      targetPage = (await resolvePdfPageNumber(pdfDoc.value, item.dest)) ?? undefined
      if (targetPage) item.pageNumber = targetPage
    }
    if (targetPage && targetPage >= 1 && targetPage <= pdfTotalPages.value) {
      pdfCurrentPage.value = targetPage
      await renderPdfPage()
      if (viewportRef.value) {
        viewportRef.value.scrollTop = 0
      }
    }
  } else if ((docType.value === 'docx' || docType.value === 'doc') && item.domId) {
    const el = document.getElementById(item.domId)
    const viewport = viewportRef.value
    if (el && viewport) {
      const viewportRect = viewport.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const targetScrollTop = viewport.scrollTop + (elRect.top - viewportRect.top) - 16
      viewport.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
    }
  }
}

/** 加载并解析 PDF 文档对象。 */
async function loadPdfDocument(): Promise<void> {
  if (!props.pdf) return
  pdfLoading.value = true
  pdfError.value = ''
  pdfCurrentPage.value = 1
  pdfTotalPages.value = 1
  outlineItems.value = []
  try {
    const arrayBuffer = base64ToArrayBuffer(props.pdf.base64)
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer)
    })
    pdfLoadingTask.value = loadingTask
    const doc = await loadingTask.promise
    pdfDoc.value = doc
    pdfTotalPages.value = doc.numPages
    await renderPdfPage()

    // 异步提取书签大纲
    outlineLoading.value = true
    try {
      const outline = await doc.getOutline()
      if (outline && outline.length > 0) {
        const transformed = transformPdfOutline(outline as RawPdfOutlineItem[])
        outlineItems.value = transformed
        void resolveOutlinePages(doc, transformed)
      } else {
        outlineItems.value = []
      }
    } catch {
      outlineItems.value = []
    } finally {
      outlineLoading.value = false
    }
  } catch (err) {
    pdfError.value = err instanceof Error ? err.message : 'PDF 文档解析失败。'
  } finally {
    pdfLoading.value = false
  }
}

/** 渲染当前页 PDF 到 Canvas 并附带 TextLayer。 */
async function renderPdfPage(): Promise<void> {
  const doc = pdfDoc.value
  if (!doc || !pdfCanvasRef.value) return

  const ticket = ++pdfRenderTicket
  if (activeRenderTask) {
    activeRenderTask.cancel()
    activeRenderTask = null
  }

  try {
    const page = await doc.getPage(pdfCurrentPage.value)
    if (ticket !== pdfRenderTicket) return

    const unscaledViewport = page.getViewport({ scale: 1 })
    let computedScale = currentScale.value
    if (fitWidth.value && viewportRef.value) {
      const containerWidth = viewportRef.value.clientWidth - 64 // 预留内边距
      if (containerWidth > 0 && unscaledViewport.width > 0) {
        computedScale = Math.max(0.3, Math.min(3.0, containerWidth / unscaledViewport.width))
      }
    }

    const viewport = page.getViewport({ scale: computedScale })
    const canvas = pdfCanvasRef.value
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return

    const outputScale = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`

    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined

    const task = page.render({
      canvas,
      transform,
      viewport
    })
    activeRenderTask = task
    await task.promise
    if (ticket !== pdfRenderTicket) return

    // 叠加文字层以支持复制
    if (pdfTextLayerRef.value) {
      pdfTextLayerRef.value.innerHTML = ''
      pdfTextLayerRef.value.style.width = `${Math.floor(viewport.width)}px`
      pdfTextLayerRef.value.style.height = `${Math.floor(viewport.height)}px`
      const textContent = await page.getTextContent()
      if (ticket !== pdfRenderTicket) return

      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: pdfTextLayerRef.value,
        viewport
      })
      await textLayer.render()
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'RenderingCancelledException') return
    pdfError.value = err instanceof Error ? err.message : '页面渲染中断。'
  }
}

function prevPdfPage(): void {
  if (pdfCurrentPage.value > 1) {
    pdfCurrentPage.value -= 1
    void renderPdfPage()
  }
}

function nextPdfPage(): void {
  if (pdfCurrentPage.value < pdfTotalPages.value) {
    pdfCurrentPage.value += 1
    void renderPdfPage()
  }
}

function onPageInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const value = parseInt(target.value, 10)
  if (!Number.isNaN(value) && value >= 1 && value <= pdfTotalPages.value) {
    pdfCurrentPage.value = value
    void renderPdfPage()
  } else {
    target.value = String(pdfCurrentPage.value)
  }
}

/** 渲染 DOCX 文档。 */
async function renderDocx(): Promise<void> {
  if (!props.docx) return
  await nextTick()
  if (!docxContainerRef.value) {
    await new Promise(resolve => setTimeout(resolve, 60))
    if (!docxContainerRef.value) return
  }

  const ticket = ++docxRenderTicket
  docxLoading.value = true
  docxError.value = ''

  try {
    const arrayBuffer = base64ToArrayBuffer(props.docx.base64)
    docxContainerRef.value.innerHTML = ''
    const docxResult = await renderAsync(arrayBuffer, docxContainerRef.value, undefined, {
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true
    })
    if (ticket !== docxRenderTicket) return
    extractDocxOutline(docxResult)
  } catch (err) {
    if (ticket !== docxRenderTicket) return
    docxError.value = err instanceof Error ? err.message : 'DOCX 渲染失败。'
  } finally {
    if (ticket === docxRenderTicket) docxLoading.value = false
  }
}

// 挂载时立即渲染当前活动文档
onMounted(() => {
  if (props.active) {
    if (props.docx) void renderDocx()
    else if (props.pdf) void loadPdfDocument()
    else if (props.doc) extractDocOutline()
  }
})

// 监听活动状态与属性变化
watch([() => props.active, () => props.pdf], ([active, pdf]) => {
  if (active && pdf) void loadPdfDocument()
})

watch([() => props.active, () => props.docx], ([active, docx]) => {
  if (active && docx) void renderDocx()
})

watch([() => props.active, () => props.doc], ([active, doc]) => {
  if (active && doc) extractDocOutline()
})

watch([currentScale, fitWidth], () => {
  if (docType.value === 'pdf') void renderPdfPage()
})

onBeforeUnmount(() => {
  if (activeRenderTask) {
    activeRenderTask.cancel()
    activeRenderTask = null
  }
  if (pdfLoadingTask.value) {
    void pdfLoadingTask.value.destroy()
    pdfLoadingTask.value = null
  }
  pdfDoc.value = null
})
</script>

<template>
  <div class="file-document-preview">
    <!-- 统一文档顶部控制栏 -->
    <header class="file-document-toolbar">
      <div class="file-document-meta">
        <!-- 大纲侧边栏展开/收起切换按钮 -->
        <button
          type="button"
          class="file-document-btn"
          :class="{ 'is-active': showOutline }"
          :title="showOutline ? '收起大纲' : '展开大纲'"
          :aria-label="showOutline ? '收起大纲' : '展开大纲'"
          @click="showOutline = !showOutline"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" class="w-3.5 h-3.5 mr-1" aria-hidden="true">
            <path d="M2 3.75A.75.75 0 0 1 2.75 3h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 3.75zm0 4.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8zm0 4.25a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1-.75-.75z"/>
          </svg>
          <span>大纲</span>
        </button>

        <span class="file-document-badge is-type" role="status">
          <span v-if="docType === 'pdf'">PDF 文档</span>
          <span v-else-if="docType === 'docx'">Word (DOCX)</span>
          <span v-else-if="docType === 'doc'">Word (DOC 旧版)</span>
        </span>
        <span v-if="docType === 'pdf'" class="file-document-badge">
          共 {{ pdfTotalPages }} 页
        </span>
      </div>

      <!-- PDF 分页控制器 -->
      <div v-if="docType === 'pdf' && pdfTotalPages > 1" class="file-document-pagination">
        <button
          type="button"
          class="file-document-btn"
          :disabled="pdfCurrentPage <= 1"
          aria-label="上一页"
          @click="prevPdfPage"
        >
          ‹
        </button>
        <span class="file-document-page-indicator">
          第
          <input
            type="number"
            class="file-document-page-input"
            :value="pdfCurrentPage"
            min="1"
            :max="pdfTotalPages"
            aria-label="输入页码"
            @change="onPageInput"
          />
          / {{ pdfTotalPages }} 页
        </span>
        <button
          type="button"
          class="file-document-btn"
          :disabled="pdfCurrentPage >= pdfTotalPages"
          aria-label="下一页"
          @click="nextPdfPage"
        >
          ›
        </button>
      </div>

      <!-- 缩放与视图控制栏 -->
      <div class="file-document-zoom-controls">
        <button
          v-if="docType === 'pdf'"
          type="button"
          class="file-document-btn"
          :class="{ 'is-active': fitWidth }"
          title="适应视口宽度"
          @click="toggleFitWidth"
        >
          适应宽度
        </button>
        <button
          type="button"
          class="file-document-btn"
          :disabled="zoomIndex <= 0"
          title="缩小"
          @click="zoomOut"
        >
          −
        </button>
        <button
          type="button"
          class="file-document-btn file-document-zoom-val"
          title="重置缩放 (100%)"
          @click="resetZoom"
        >
          {{ fitWidth && docType === 'pdf' ? '自适应' : zoomPercent }}
        </button>
        <button
          type="button"
          class="file-document-btn"
          :disabled="zoomIndex >= zoomLevels.length - 1"
          title="放大"
          @click="zoomIn"
        >
          +
        </button>
      </div>
    </header>

    <!-- 主展示分栏：左侧大纲侧边栏 + 右侧视口渲染舞台 -->
    <div class="file-document-main">
      <FileDocumentOutline
        v-if="showOutline"
        :entries="outlineItems"
        :active-id="activeOutlineId"
        :doc-type="docType"
        :loading="outlineLoading"
        @navigate="onNavigateOutline"
        @close="showOutline = false"
      />

      <!-- 滚动渲染舞台区 -->
      <div
        ref="viewportRef"
        class="file-document-viewport scroll-area"
        tabindex="0"
        role="region"
        aria-label="文档预览区域，可滚动查看"
      >
        <!-- 加载提示浮层 -->
        <div v-if="pdfLoading || docxLoading" class="file-document-feedback">
          <p>正在解析并排版文档内容…</p>
        </div>

        <!-- 错误提示 -->
        <div v-if="pdfError || docxError" class="file-document-feedback is-error" role="alert">
          <p>{{ pdfError || docxError }}</p>
        </div>

        <!-- 1. PDF 舞台：常驻容器，避免条件切换丢失 DOM 句柄 -->
        <div v-show="docType === 'pdf' && !pdfError" class="file-document-pdf-stage">
          <div class="file-document-pdf-canvas-wrap">
            <canvas ref="pdfCanvasRef" class="file-document-pdf-canvas"></canvas>
            <div ref="pdfTextLayerRef" class="file-document-text-layer textLayer"></div>
          </div>
        </div>

        <!-- 2. DOCX 舞台：常驻容器，确保 renderAsync 能向实际挂载的 DOM 节点写入内容 -->
        <div
          v-show="docType === 'docx' && !docxError"
          class="file-document-docx-stage"
          :style="{ transform: `scale(${currentScale})`, transformOrigin: 'top center' }"
        >
          <div ref="docxContainerRef" class="file-document-docx-container"></div>
        </div>

        <!-- 3. DOC 提取文本舞台 -->
        <div
          v-if="docType === 'doc'"
          class="file-document-doc-stage"
          :style="{ transform: `scale(${currentScale})`, transformOrigin: 'top center' }"
        >
          <div class="file-document-notice-banner" role="status">
            <svg viewBox="0 0 16 16" fill="currentColor" class="w-4 h-4 shrink-0" aria-hidden="true">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4.5zm0 7a.875.875 0 1 1 0-1.75.875.875 0 0 1 0 1.75z"/>
            </svg>
            <span>.doc 属于旧版 Word 二进制格式，已提取正文与文本结构展示；如需查看完整版式、字体与复杂排版，建议另存为 .docx 或 .pdf。</span>
          </div>

          <article class="file-document-paper">
            <header v-if="props.doc?.headers" class="file-document-paper-header">
              {{ props.doc.headers }}
            </header>

            <main class="file-document-paper-body">
              <p
                v-for="(p, idx) in docParagraphs"
                :id="`doc-p-${idx}`"
                :key="idx"
                class="file-document-p"
              >
                {{ p }}
              </p>
            </main>

            <footer v-if="props.doc?.footers" class="file-document-paper-footer">
              {{ props.doc.footers }}
            </footer>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>
