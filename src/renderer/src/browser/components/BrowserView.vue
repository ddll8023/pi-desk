<!--
  内置浏览器面板：包含顶部控制工具栏、纯净空白起始页及 Chromium Webview 网页渲染视图。

  面板与对话/终端/文件视图混排在同一工作区面板层，保持挂载以避免切换时页面 DOM 和 JavaScript 状态丢失。
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { BLANK_PAGE_URL, normalizeBrowserUrl } from '../../../../shared/browser-api'
import { useBrowserStore } from '../stores/browser'
import { openExternalUrl } from '../../editor/services/external-url'
import BrowserToolbar from './BrowserToolbar.vue'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly tabKey: string
  readonly active: boolean
}>()

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
      @back="onBack"
      @forward="onForward"
      @reload="onReload"
      @stop="onStop"
      @navigate="onNavigate"
      @open-dev-tools="onOpenDevTools"
      @open-external="onOpenExternal"
      @input-change="onInputChange"
    />

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

    <!-- 纯净空白起始页视图 -->
    <div
      v-if="isBlank"
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
      class="w-full flex-1 border-none"
      :src="tabState.url"
      partition="persist:desktop-browser"
    />
  </div>
</template>
