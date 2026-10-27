<!--
  内置浏览器面板：工具栏、空白起始页、受限 webview，以及与网页共用视口的固定画面批注浮层。
  编排截图、元素选择及切走／导航时的取消；批注交付意图由工作区接线到目标对话。

  面板与对话/终端/文件视图混排在同一工作区面板层，保持挂载以避免切换时页面 DOM 和 JavaScript 状态丢失。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { BLANK_PAGE_URL, normalizeBrowserUrl } from '../../../../shared/browser-api'
import { useBrowserStore } from '../stores/browser'
import { useBrowserAnnotationsStore } from '../stores/browser-annotations'
import { cancelBrowserElementPick, captureBrowser, pickBrowserElement } from '../services/capture'
import type { BrowserAnnotationDocument } from '../stores/browser-annotations'
import BrowserAnnotationPanel from './BrowserAnnotationPanel.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import { openExternalUrl } from '../../editor/services/external-url'
import BrowserToolbar from './BrowserToolbar.vue'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly tabKey: string
  readonly active: boolean
  readonly targets: readonly { readonly id: string; readonly title: string }[]
  readonly deliveryError: string | null
}>()
const emit = defineEmits<{ deliver: [source: string, target: string, text: string, file: File] }>()

const annotations = useBrowserAnnotationsStore()
const annotationDocument = computed(() => annotations.documents[props.tabKey])
const capturing = ref(false)
const captureError = ref<string | null>(null)
const confirmCapture = ref(false)
const confirmElementPick = ref(false)
const pickingElement = ref(false)
let pickSequence = 0
let pickingWebContentsId: number | null = null
let pickPrevious: BrowserAnnotationDocument | undefined
let pickPreviousVisible = false

const browserStore = useBrowserStore()
const toolbarRef = ref<InstanceType<typeof BrowserToolbar> | null>(null)
const webviewRef = ref<any>(null)

/** 当前标签状态；若缺失由 store 立即初始化。 */
const tabState = computed(() => {
  return browserStore.tabs[props.tabKey] ?? browserStore.ensureTab(props.tabKey, '')
})

const isBlank = computed(() => {
  return !tabState.value.url || tabState.value.url === BLANK_PAGE_URL
})

async function takeScreenshot(): Promise<void> {
  if (capturing.value || !props.active) return
  if (isBlank.value || tabState.value.loading) {
    captureError.value = '请先打开并加载网页，再截图。'
    return
  }
  capturing.value = true
  captureError.value = null
  const previous = annotationDocument.value
  if (previous) previous.visible = false
  await nextTick()
  const webview = webviewRef.value
  const url = tabState.value.url
  try {
    if (!webview || typeof webview.getWebContentsId !== 'function') throw new Error('网页尚未准备好。')
    const result = await captureBrowser(webview.getWebContentsId())
    if (!result.ok) throw new Error(result.error)
    if (!props.active || webview !== webviewRef.value || tabState.value.url !== url) throw new Error('截图期间页面发生变化，请重试。')
    annotations.replace(props.tabKey, result.dataUrl, url)
  } catch (error) {
    if (previous) previous.visible = true
    captureError.value = error instanceof Error ? error.message : String(error)
  } finally {
    capturing.value = false
  }
}

function onAnnotate(): void {
  if (pickingElement.value) cancelElementPick()
  if (annotationDocument.value) annotationDocument.value.visible = true
  else void takeScreenshot()
}

function onRecapture(): void {
  if (annotations.hasUnsubmitted(props.tabKey)) confirmCapture.value = true
  else void takeScreenshot()
}

function restorePreviousAnnotation(): void {
  if (pickPrevious && annotationDocument.value === pickPrevious) pickPrevious.visible = pickPreviousVisible
  pickPrevious = undefined
}

function cancelElementPick(): void {
  pickSequence++
  pickingElement.value = false
  const id = pickingWebContentsId
  pickingWebContentsId = null
  restorePreviousAnnotation()
  if (id !== null) void cancelBrowserElementPick(id).catch(error => {
    if (props.active) captureError.value = `取消元素选择失败：${error instanceof Error ? error.message : String(error)}`
  })
}

async function startElementPick(): Promise<void> {
  if (capturing.value || pickingElement.value || !props.active || isBlank.value || tabState.value.loading) return
  captureError.value = null
  pickingElement.value = true
  const sequence = ++pickSequence
  pickPrevious = annotationDocument.value
  pickPreviousVisible = pickPrevious?.visible ?? false
  if (pickPrevious) pickPrevious.visible = false
  await nextTick()
  if (sequence !== pickSequence || !props.active) {
    if (sequence === pickSequence) cancelElementPick()
    return
  }
  const webview = webviewRef.value
  const url = tabState.value.url
  try {
    if (!webview || typeof webview.getWebContentsId !== 'function') throw new Error('网页尚未准备好。')
    const id = webview.getWebContentsId() as number
    pickingWebContentsId = id
    const result = await pickBrowserElement(id)
    if (sequence !== pickSequence) return
    if (!result.ok) {
      if (!result.cancelled) captureError.value = result.error
      restorePreviousAnnotation()
      return
    }
    if (!props.active || webview !== webviewRef.value || tabState.value.url !== url) throw new Error('选择期间页面发生变化，请重试。')
    annotations.replace(props.tabKey, result.dataUrl, url, result.element)
    pickPrevious = undefined
  } catch (error) {
    if (sequence === pickSequence) {
      restorePreviousAnnotation()
      captureError.value = error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (sequence === pickSequence) {
      pickingElement.value = false
      pickingWebContentsId = null
    }
  }
}

function onPickElement(): void {
  if (pickingElement.value) { cancelElementPick(); return }
  if (annotations.hasUnsubmitted(props.tabKey)) confirmElementPick.value = true
  else void startElementPick()
}

watch(() => props.active, active => { if (!active && pickingElement.value) cancelElementPick() })
onUnmounted(() => { if (pickingElement.value) cancelElementPick() })

/** 快捷常用开发服务地址。 */
const quickDevUrls = [
  { label: 'Vite / 5173', url: 'http://localhost:5173' },
  { label: 'React / 3000', url: 'http://localhost:3000' },
  { label: 'Vue CLI / 8080', url: 'http://localhost:8080' },
  { label: 'Python / 8000', url: 'http://localhost:8000' }
]

function onNavigate(targetUrl: string): void {
  const normalized = normalizeBrowserUrl(targetUrl)
  browserStore.navigate(props.tabKey, normalized)
  if (normalized !== BLANK_PAGE_URL) {
    void nextTick(() => {
      const webview = webviewRef.value
      if (webview && typeof webview.loadURL === 'function') {
        webview.loadURL(normalized)
      }
    })
  }
}

function onBack(): void {
  const webview = webviewRef.value
  if (webview && typeof webview.goBack === 'function' && webview.canGoBack()) {
    webview.goBack()
  }
}

function onForward(): void {
  const webview = webviewRef.value
  if (webview && typeof webview.goForward === 'function' && webview.canGoForward()) {
    webview.goForward()
  }
}

function onReload(): void {
  const webview = webviewRef.value
  if (webview && typeof webview.reload === 'function') {
    webview.reload()
  }
}

function onStop(): void {
  const webview = webviewRef.value
  if (webview && typeof webview.stop === 'function') {
    webview.stop()
  }
}

function onOpenDevTools(): void {
  const webview = webviewRef.value
  if (!webview) return
  if (typeof webview.isDevToolsOpened === 'function' && webview.isDevToolsOpened()) {
    webview.closeDevTools()
  } else if (typeof webview.openDevTools === 'function') {
    webview.openDevTools()
  }
}

async function onOpenExternal(): Promise<void> {
  const currentUrl = tabState.value.url
  if (!currentUrl || currentUrl === BLANK_PAGE_URL) return
  await openExternalUrl(currentUrl)
}

function onInputChange(val: string): void {
  browserStore.setInputUrl(props.tabKey, val)
}

/** 绑定 webview 事件并同步到 store。 */
function bindWebviewEvents(webview: any): void {
  if (!webview || typeof webview.addEventListener !== 'function') return

  webview.addEventListener('did-start-loading', () => {
    if (pickingElement.value) cancelElementPick()
    browserStore.updateNavigationState(props.tabKey, { loading: true, error: null })
  })

  webview.addEventListener('did-stop-loading', () => {
    const canGoBack = typeof webview.canGoBack === 'function' ? webview.canGoBack() : false
    const canGoForward = typeof webview.canGoForward === 'function' ? webview.canGoForward() : false
    browserStore.updateNavigationState(props.tabKey, { loading: false, canGoBack, canGoForward })
  })

  webview.addEventListener('did-navigate', (event: any) => {
    browserStore.updateNavigationState(props.tabKey, { url: event.url, error: null })
  })

  webview.addEventListener('did-navigate-in-page', (event: any) => {
    if (pickingElement.value) cancelElementPick()
    browserStore.updateNavigationState(props.tabKey, { url: event.url })
  })

  webview.addEventListener('page-title-updated', (event: any) => {
    browserStore.updateNavigationState(props.tabKey, { title: event.title })
  })

  webview.addEventListener('did-fail-load', (event: any) => {
    // 忽略主动中断请求的取消错误 (-3: ERR_ABORTED)
    if (event.errorCode === -3) return
    browserStore.updateNavigationState(props.tabKey, {
      loading: false,
      error: `加载失败：${event.errorDescription} (${event.errorCode})`
    })
  })

  webview.addEventListener('new-window', (event: any) => {
    event.preventDefault()
    if (typeof webview.loadURL === 'function' && event.url) {
      webview.loadURL(event.url)
    }
  })
}

watch(webviewRef, (el) => {
  if (el) bindWebviewEvents(el)
})

onMounted(() => {
  if (webviewRef.value) {
    bindWebviewEvents(webviewRef.value)
  }
})
</script>

<template>
  <div class="browser-view flex flex-col w-full h-full bg-[var(--color-desk-canvas)] overflow-hidden">
    <!-- 顶部工具栏 -->
    <BrowserToolbar
      ref="toolbarRef"
      :tab-key="props.tabKey"
      :url="tabState.url"
      :input-url="tabState.inputUrl"
      :loading="tabState.loading"
      :can-go-back="tabState.canGoBack"
      :can-go-forward="tabState.canGoForward"
      :active="props.active"
      :has-annotation="!!annotationDocument"
      :picking-element="pickingElement"
      @pick-element="onPickElement"
      @back="onBack"
      @forward="onForward"
      @reload="onReload"
      @stop="onStop"
      @navigate="onNavigate"
      @open-dev-tools="onOpenDevTools"
      @open-external="onOpenExternal"
      @input-change="onInputChange"
      @annotate="onAnnotate"
    />
    <p v-if="captureError" class="p-2 text-xs text-red-500" role="alert">{{ captureError }}</p>
    <p v-if="pickingElement" class="p-2 text-xs" role="status">悬停高亮网页元素，点击选择；按 Esc 或点击取消退出。</p>

    <!-- 加载出错提示条 -->
    <div
      v-if="tabState.error"
      class="bg-amber-500/10 border-b border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs px-4 py-2 flex items-center justify-between"
      role="alert"
    >
      <div class="flex items-center gap-2 min-w-0">
        <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span class="truncate">{{ tabState.error }}</span>
      </div>
      <AppButton variant="default" class="text-xs shrink-0 ml-3 py-0.5 px-2" @click="onReload">
        重试
      </AppButton>
    </div>

    <!-- 网页与批注共享同一尺寸；浮层不参与网页的宽高分配。 -->
    <div class="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
    <!-- 纯净空白起始页视图 -->
    <div
      v-if="isBlank"
      v-show="!annotationDocument?.visible"
      class="flex-1 flex flex-col items-center justify-center p-6 text-center select-none"
    >
      <div class="w-12 h-12 rounded-2xl bg-[var(--color-desk-panel)] border border-[var(--color-desk-border)] flex items-center justify-center text-[var(--color-desk-ink-muted)] mb-4">
        <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
      </div>
      <h3 class="text-sm font-medium text-[var(--color-desk-ink)] mb-1">内置浏览器</h3>
      <p class="text-xs text-[var(--color-desk-ink-muted)] max-w-sm mb-6">
        在上方地址栏输入网址或本地开发端口（如 localhost:5173）并按回车以访问。
      </p>

      <!-- 常用本地服务快捷卡片 -->
      <div class="flex flex-wrap items-center justify-center gap-2 max-w-md">
        <AppButton
          v-for="item in quickDevUrls"
          :key="item.url"
          variant="default"
          class="text-xs px-3 py-1.5"
          @click="onNavigate(item.url)"
        >
          {{ item.label }}
        </AppButton>
      </div>
    </div>

    <!-- Chromium Webview 容器 -->
    <webview
      v-else
      ref="webviewRef"
      class="w-full h-full flex-1 border-none"
      :class="{ invisible: annotationDocument?.visible }"
      :inert="annotationDocument?.visible"
      :aria-hidden="annotationDocument?.visible"
      :src="tabState.url"
      partition="persist:desktop-browser"
    />
    <BrowserAnnotationPanel v-if="annotationDocument?.visible" :document="annotationDocument" :targets="props.targets" :error="props.deliveryError" @close="annotationDocument.visible = false" @recapture="onRecapture" @deliver="(target, text, file) => emit('deliver', props.tabKey, target, text, file)" />
    </div>
    <ConfirmDialog :open="confirmCapture" title="重新截图会丢弃现有批注" description="当前截图的批注尚未交付，重新截图后不可恢复。" detail="" confirm-label="丢弃并截图" @cancel="confirmCapture = false" @confirm="confirmCapture = false; takeScreenshot()" />
    <ConfirmDialog :open="confirmElementPick" title="选择元素会替换现有批注" description="只有成功选取并截图后才替换；取消或失败会保留现有批注。" detail="" confirm-label="继续选择" @cancel="confirmElementPick = false" @confirm="confirmElementPick = false; startElementPick()" />
  </div>
</template>
