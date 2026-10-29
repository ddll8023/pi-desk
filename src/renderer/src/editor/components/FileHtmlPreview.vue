<!-- HTML 页面预览：以未保存的源文快照更新独立沙箱容器，不将文件脚本注入应用 DOM，也不启动开发服务。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { DidFailLoadEvent, WebviewTag } from 'electron'
import type { ProjectHtmlPreviewData } from '../../../../shared/project-file-api'
import { prepareProjectHtmlPreview, releaseProjectHtmlPreview } from '../services/project-file'
import AppButton from '../../ui/AppButton.vue'

const props = defineProps<{
  readonly projectPath: string
  readonly path: string
  readonly text: string
  readonly active: boolean
}>()
const webview = shallowRef<WebviewTag | null>(null)
const preview = shallowRef<ProjectHtmlPreviewData | null>(null)
const preparing = ref(false)
const pageLoading = ref(false)
const error = ref('')
const loading = computed(() => preparing.value || pageLoading.value)
let previewId: string | null = null
let renderedText: string | null = null
let requested = 0
let pending = false
let disposed = false

async function release(id: string): Promise<void> {
  const result = await releaseProjectHtmlPreview(id)
  if (!result.ok) console.error('[html-preview] 释放预览失败：', result.error.message)
}

/** 串行登记快照，后一次请求覆盖前一次展示意图；迟到的新身份仍须释放，不能遗留无主容器。 */
async function refresh(): Promise<void> {
  if (disposed || !props.active) return
  requested += 1
  pending = true
  if (preparing.value) return
  preparing.value = true
  try {
    while (pending && !disposed) {
      pending = false
      const version = requested
      const text = props.text
      const result = await prepareProjectHtmlPreview(props.projectPath, props.path, text, previewId)
      if (!result.ok) {
        if (!disposed && version === requested) {
          preview.value = null
          pageLoading.value = false
          error.value = result.error.message
        }
        continue
      }
      previewId = result.data.previewId
      if (disposed) {
        await release(result.data.previewId)
        return
      }
      if (version !== requested || !props.active) continue
      error.value = ''
      pageLoading.value = true
      preview.value = result.data
      renderedText = text
    }
  } finally { preparing.value = false }
}

function onLoadStarted(): void { pageLoading.value = true }
function onLoadStopped(): void { pageLoading.value = false }
function onLoadFailed(event: DidFailLoadEvent): void {
  if (!event.isMainFrame || event.errorCode === -3) return
  pageLoading.value = false
  error.value = `页面加载失败：${event.errorDescription}（${event.errorCode}）。可刷新重试，或切回源码查看。`
}

watch(webview, (current, previous) => {
  previous?.removeEventListener('did-start-loading', onLoadStarted)
  previous?.removeEventListener('did-stop-loading', onLoadStopped)
  previous?.removeEventListener('did-fail-load', onLoadFailed)
  current?.addEventListener('did-start-loading', onLoadStarted)
  current?.addEventListener('did-stop-loading', onLoadStopped)
  current?.addEventListener('did-fail-load', onLoadFailed)
}, { flush: 'post' })
watch([() => props.active, () => props.text], ([active]) => {
  // 切换工作区标签不重载已有页面；只有源文变化、首次打开或显式刷新才重建页面。
  if (active && (preview.value === null || renderedText !== props.text)) void refresh()
}, { immediate: true })

onBeforeUnmount(() => {
  disposed = true
  pending = false
  webview.value?.removeEventListener('did-start-loading', onLoadStarted)
  webview.value?.removeEventListener('did-stop-loading', onLoadStopped)
  webview.value?.removeEventListener('did-fail-load', onLoadFailed)
  if (previewId !== null) void release(previewId)
})
</script>

<template>
  <section class="html-preview" aria-label="HTML 页面预览" :aria-busy="loading">
    <div class="file-editor-source-tools html-preview-tools">
      <AppButton variant="compact" :disabled="preparing" @click="refresh">刷新页面</AppButton>
      <span class="html-preview-hint">文件预览不启动开发服务；需要构建的页面请通过服务地址打开。</span>
      <span v-if="loading" class="html-preview-hint" role="status">正在加载…</span>
    </div>
    <div v-if="error" class="file-editor-notice is-error" role="alert">
      <span>{{ error }}</span>
      <AppButton variant="compact" :disabled="preparing" @click="refresh">重试</AppButton>
    </div>
    <webview
      v-if="preview"
      :key="preview.url"
      ref="webview"
      class="html-preview-page"
      :src="preview.url"
      :partition="preview.partition"
      :inert="!active"
      :aria-hidden="!active"
      title="HTML 文件页面"
    />
  </section>
</template>

<style scoped>
.html-preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.html-preview-tools {
  flex-wrap: wrap;
  gap: 8px;
}
.html-preview-hint {
  color: var(--color-desk-muted);
  font-size: 11px;
}
.html-preview-page {
  display: flex;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  border: 0;
  background: #fff;
}
</style>
