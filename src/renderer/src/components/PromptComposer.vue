<!-- Prompt 输入区：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交，并在 Agent 运行期间原位提供停止入口；同时承接 Extension 的 set_editor_text 填充文本与图片附件选择。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PromptDisposition, PromptImageInput } from '../../../shared/runtime-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import { useRuntimeStore } from '../stores/runtime'

const runtimeStore = useRuntimeStore()
const extensionStore = useExtensionUiStore()
const { view: runtimeView, promptView, abortView, projectionSync, capabilitiesView } = storeToRefs(runtimeStore)
const { editorText, editorTextVersion } = storeToRefs(extensionStore)

const draft = ref('')
/** 输入法组合态：此期间的 Enter 只确认候选词，不能当发送。 */
const composing = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)

/** 待发送的图片附件：objectUrl 仅用于本地预览，发送时读取 base64 并释放。 */
interface PendingImage {
  readonly file: File
  readonly objectUrl: string
}
const pendingImages = ref<PendingImage[]>([])
const imageInput = ref<HTMLInputElement | null>(null)

/** 当前模型的图片输入能力；未知（null）时不限制，明确不支持时提示。 */
const imageSupported = computed(() => {
  if (capabilitiesView.value.phase !== 'ready') return null
  const current = capabilitiesView.value.data.models.find((model) => {
    const info = runtimeInfo.value
    return info?.modelProvider === model.provider && info?.modelId === model.id
  })
  return current?.imageInput ?? null
})

const runtimeReady = computed(() => runtimeView.value.phase === 'ready')
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
const sending = computed(() => promptView.value.phase === 'sending')
const stopVisible = computed(() => (
  runtimeReady.value && (streaming.value || abortView.value.phase === 'requesting')
))
/** 与主进程的拒绝条件一致：未就绪、发送中、投影未同步或已有运行中的操作都不提交。 */
const canSend = computed(() => runtimeReady.value
  && draft.value.trim() !== ''
  && !sending.value
  && projectionSync.value === 'synced'
  && !streaming.value)

const status = computed(() => {
  if (abortView.value.phase === 'error') {
    return { kind: 'error' as const, text: abortView.value.error.message }
  }
  if (abortView.value.phase === 'requesting') {
    return { kind: 'info' as const, text: '正在停止当前操作，等待本轮结束。' }
  }
  if (promptView.value.phase === 'error') {
    return { kind: 'error' as const, text: promptView.value.error.message }
  }
  if (sending.value) return { kind: 'info' as const, text: '正在提交 Prompt，等待 Pi 回应。' }
  if (promptView.value.phase === 'accepted') {
    return { kind: 'info' as const, text: acceptedText(promptView.value.disposition) }
  }
  if (!runtimeReady.value) {
    return { kind: 'info' as const, text: '没有已就绪的 Runtime；先在左侧打开或新建会话。' }
  }
  if (streaming.value) {
    return { kind: 'info' as const, text: 'Agent 正在运行，本轮结束前不能提交新输入。' }
  }
  if (projectionSync.value !== 'synced') {
    return { kind: 'info' as const, text: '消息仍在同步，稍后才能提交输入。' }
  }
  return { kind: 'info' as const, text: 'Enter 发送，Shift+Enter 换行。' }
})

function acceptedText(disposition: PromptDisposition): string {
  if (disposition === 'started') return 'Pi 已接受并开始执行。'
  if (disposition === 'queued') return 'Pi 已将本次输入排队。'
  return '本次输入已被处理，未发起新的 Agent run。'
}

/** 与主进程一致的图片 MIME 白名单；选择器另加 accept，双保险。 */
const IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_COUNT = 4
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/** 选择图片：只接受白名单类型，超出条数上限时截断并提示。 */
function onPickImages(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  for (const file of files) {
    if (!IMAGE_MIME_TYPES.includes(file.type)) {
      promptView.value = { phase: 'error', error: { code: 'INVALID_REQUEST', message: `不支持的图片类型：${file.name}` } }
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      promptView.value = { phase: 'error', error: { code: 'INVALID_REQUEST', message: `图片「${file.name}」超过大小上限。` } }
      continue
    }
    if (pendingImages.value.length >= MAX_IMAGE_COUNT) {
      promptView.value = { phase: 'error', error: { code: 'INVALID_REQUEST', message: `最多携带 ${MAX_IMAGE_COUNT} 张图片。` } }
      break
    }
    pendingImages.value = [...pendingImages.value, { file, objectUrl: URL.createObjectURL(file) }]
  }
}

function removeImage(objectUrl: string): void {
  const target = pendingImages.value.find((entry) => entry.objectUrl === objectUrl)
  if (target === undefined) return
  URL.revokeObjectURL(objectUrl)
  pendingImages.value = pendingImages.value.filter((entry) => entry.objectUrl !== objectUrl)
}

/** 读取文件为 base64（不含 data: 前缀）；发送前调用。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

onUnmounted(() => {
  for (const entry of pendingImages.value) URL.revokeObjectURL(entry.objectUrl)
})

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return
  // keyCode 229 是部分输入法在组合态下上报的值，一并排除。
  if (composing.value || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void submit()
}

/** 提交当前输入与附件；只有本次请求被接受时清空，且不覆盖发送期间新输入的文字。 */
async function submit(): Promise<void> {
  if (!canSend.value) return

  const message = draft.value
  const images: PromptImageInput[] = []
  for (const entry of pendingImages.value) {
    images.push({ name: entry.file.name, mimeType: entry.file.type, data: await readAsBase64(entry.file) })
  }
  const before = promptView.value
  await runtimeStore.send(message, images)
  if (promptView.value === before || promptView.value.phase !== 'accepted') return

  if (draft.value === message) draft.value = ''
  for (const entry of pendingImages.value) URL.revokeObjectURL(entry.objectUrl)
  pendingImages.value = []
  textarea.value?.focus()
}

function stop(): void {
  void runtimeStore.stopOperation()
}

/** Extension 填充文本到达时写入：只在用户未输入时覆盖，否则保留用户内容并提示。 */
watch(editorTextVersion, () => {
  const text = editorText.value
  if (text === null) return
  extensionStore.markEditorTextConsumed()
  if (draft.value.trim() === '') {
    draft.value = text
    textarea.value?.focus()
  }
})

onMounted(() => {
  textarea.value?.focus()
})
</script>

<template>
  <section class="border-t border-desk-line bg-desk-surface px-4 py-3 sm:px-8">
    <div class="mx-auto max-w-3xl">
      <!-- 附件预览条：缩略图经 blob: URL 展示，可逐个移除。 -->
      <div v-if="pendingImages.length > 0" class="mb-2 flex flex-wrap gap-2">
        <div
          v-for="entry in pendingImages"
          :key="entry.objectUrl"
          class="relative overflow-hidden rounded border border-desk-line"
        >
          <img :src="entry.objectUrl" :alt="entry.file.name" class="h-16 w-16 object-cover" />
          <button
            type="button"
            class="absolute right-0 top-0 rounded-bl bg-desk-ink/60 px-1 text-xs text-white"
            aria-label="`移除图片 ${entry.file.name}`"
            @click="removeImage(entry.objectUrl)"
          >
            ×
          </button>
          <p class="max-w-16 truncate px-1 text-[10px] text-desk-muted">{{ formatBytes(entry.file.size) }}</p>
        </div>
      </div>

      <label for="prompt-input" class="sr-only">输入要发送给 Pi 的内容</label>
      <textarea
        id="prompt-input"
        ref="textarea"
        v-model="draft"
        rows="3"
        class="text-control resize-none"
        placeholder="输入要发送给 Pi 的内容"
        autocomplete="off"
        spellcheck="false"
        aria-describedby="prompt-status"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      ></textarea>

      <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
        <p
          id="prompt-status"
          :role="status.kind === 'error' ? 'alert' : 'status'"
          class="text-xs"
          :class="status.kind === 'error' ? 'text-desk-danger' : 'text-desk-muted'"
        >
          {{ status.text }}
        </p>
        <div class="flex items-center gap-2">
          <!-- 图片选择：运行中禁用与发送按钮一致；当前模型明确不支持时同样禁用并提示。 -->
          <input
            ref="imageInput"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="sr-only"
            aria-label="选择图片附件"
            @change="onPickImages"
          />
          <button
            type="button"
            class="control-button"
            :disabled="!runtimeReady || sending || imageSupported === false || pendingImages.length >= 4"
            @click="imageInput?.click()"
          >
            图片
          </button>
          <button
            v-if="stopVisible"
            type="button"
            class="control-button"
            :disabled="abortView.phase === 'requesting'"
            @click="stop"
          >
            {{ abortView.phase === 'requesting' ? '正在停止…' : '停止' }}
          </button>
          <button v-else type="button" class="control-button" :disabled="!canSend" @click="submit">
            发送
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
