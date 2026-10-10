<!-- Prompt 输入区：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交，并在 Agent 运行期间原位提供停止入口；同时承接 Extension 的 set_editor_text 填充文本、图片附件选择与 Pi 命令的斜杠补全。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { PiResourceEntry, PromptDisposition, PromptImageInput } from '../../../shared/runtime-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import { useResourceStore } from '../stores/resource'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'

const runtimeStore = useRuntimeStore()
const extensionStore = useExtensionUiStore()
const projectStore = useProjectStore()
const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const { view: runtimeView, promptView, abortView, projectionSync, capabilitiesView } = storeToRefs(runtimeStore)
const { editorText, editorTextVersion } = storeToRefs(extensionStore)

const draft = ref('')
/** 首次提交只启动 Runtime；就绪后提示用户再次显式发送，不自动重放。 */
const startupRequested = ref(false)
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
const canStartRuntime = computed(() => (
  runtimeView.value.phase === 'idle'
  || runtimeView.value.phase === 'closed'
  || runtimeView.value.phase === 'failed'
))
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
const sending = computed(() => promptView.value.phase === 'sending')
const stopVisible = computed(() => (
  runtimeReady.value && (streaming.value || abortView.value.phase === 'requesting')
))
/** 运行中按 Pi 就绪条件提交；未就绪时仅允许有项目且没有并发启动的首次启动请求。 */
const canSend = computed(() => {
  if (draft.value.trim() === '' || sending.value || sessionStore.opening
    || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt) return false
  if (runtimeReady.value) {
    return projectionSync.value === 'synced' && !streaming.value
  }
  return canStartRuntime.value && projectStore.currentProject !== null
})

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
  if (sessionStore.awaitingTrust) {
    return { kind: 'info' as const, text: '请先完成项目 Trust 决定；输入会保留，Runtime 就绪后需再次点击发送。' }
  }
  if (sessionStore.awaitingInterrupt) {
    return { kind: 'info' as const, text: '请先处理当前操作；输入会保留。' }
  }
  if (runtimeReady.value && startupRequested.value && projectionSync.value === 'synced') {
    return { kind: 'info' as const, text: 'Runtime 已就绪；输入仍保留，请再次点击发送提交。' }
  }
  if (promptView.value.phase === 'accepted') {
    return { kind: 'info' as const, text: acceptedText(promptView.value.disposition) }
  }
  if (!runtimeReady.value) {
    if (projectStore.currentProject === null) {
      return { kind: 'info' as const, text: '请先选择项目；输入内容会保留。' }
    }
    if (runtimeView.value.phase === 'failed') {
      return { kind: 'error' as const, text: `${runtimeView.value.error.message}；可再次点击发送重试启动。` }
    }
    if (canStartRuntime.value) {
      return { kind: 'info' as const, text: '首次点击发送会启动 Pi 并保留输入；Runtime 就绪后再次点击发送。' }
    }
    return { kind: 'info' as const, text: 'Runtime 正在启动或关闭；输入会保留。' }
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
  // 输入法组合态下方向键与确认键属于候选词操作，不参与补全也不发送。
  if (composing.value || event.isComposing || event.keyCode === 229) return

  if (visibleSuggestions.value.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSuggestion(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSuggestion(-1)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      acceptSuggestion(visibleSuggestions.value[suggestionIndex.value])
      return
    }
    if (event.key === 'Escape') {
      suggestionsDismissed.value = true
      return
    }
  }

  if (event.key !== 'Enter' || event.shiftKey) return
  // Enter 始终是发送：补全只用 Tab 或点击确认，避免改变既有发送手感。
  event.preventDefault()
  void submit()
}

/** Runtime 未就绪时只启动并保留输入；就绪后提交，只有请求被接受时才清空且不覆盖新输入。 */
async function submit(): Promise<void> {
  if (!canSend.value) return

  // Desktop 层拦截的界面命令：Pi RPC 模式没有这两个命令，不能发给模型。
  if (draft.value === '/resume') {
    draft.value = ''
    sessionStore.openSessionPicker()
    return
  }
  if (draft.value === '/new') {
    draft.value = ''
    // 闲置时空白聊天已经可用；只有已有 Runtime 时才切换到实际 Pi 会话。
    if (runtimeReady.value) void sessionStore.open(null, false)
    return
  }

  if (!runtimeReady.value) {
    // 首次发送只触发 Runtime 启动；保留文字与附件，避免启动期间丢失或隐式重放。
    startupRequested.value = true
    await sessionStore.open(null, false)
    return
  }

  const message = draft.value
  const images: PromptImageInput[] = []
  for (const entry of pendingImages.value) {
    images.push({ name: entry.file.name, mimeType: entry.file.type, data: await readAsBase64(entry.file) })
  }
  const before = promptView.value
  await runtimeStore.send(message, images)
  if (promptView.value === before || promptView.value.phase !== 'accepted') return

  startupRequested.value = false
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

/** 斜杠补全只在输入以 `/` 开头且尚未输入空格（即仍在命令名内）时生效。 */
const MAX_SUGGESTIONS = 8
const slashQuery = computed(() => {
  const text = draft.value
  if (!text.startsWith('/') || text.includes(' ')) return null
  return text.slice(1).toLowerCase()
})
const suggestionsDismissed = ref(false)
const suggestionIndex = ref(0)

/**
 * 候选来自当前 Runtime 已加载的命令清单（与 Pi 的 `/` 命令同一来源）。
 * 名称前缀匹配；另外允许用去掉 `skill:` 后的名称前缀找到技能，与 Pi 的调用习惯一致。
 */
const matchedSuggestions = computed<readonly PiResourceEntry[]>(() => {
  const query = slashQuery.value
  if (query === null) return []
  return resourceStore.entries.filter((entry) => {
    const name = entry.name.toLowerCase()
    if (name.startsWith(query)) return true
    const skillName = name.startsWith('skill:') ? name.slice('skill:'.length) : null
    return skillName !== null && !query.startsWith('skill:') && skillName.startsWith(query)
  }).slice(0, MAX_SUGGESTIONS)
})
const visibleSuggestions = computed(() => (suggestionsDismissed.value ? [] : matchedSuggestions.value))

watch(matchedSuggestions, () => {
  suggestionIndex.value = 0
})

watch(slashQuery, () => {
  suggestionsDismissed.value = false
})

function moveSuggestion(step: number): void {
  const count = visibleSuggestions.value.length
  if (count === 0) return
  suggestionIndex.value = (suggestionIndex.value + step + count) % count
}

/** 接受候选：写入完整命令并保留一个尾随空格供追加参数，不自动发送。 */
function acceptSuggestion(entry: PiResourceEntry | undefined): void {
  if (entry === undefined) return
  draft.value = `/${entry.name} `
  textarea.value?.focus()
}

onMounted(() => {
  textarea.value?.focus()
})
</script>

<template>
  <section class="border-t border-desk-line bg-desk-surface px-4 py-3 sm:px-6">
    <div class="mx-auto max-w-3xl">
      <!-- 附件预览条：缩略图经 blob: URL 展示，可逐个移除。 -->
      <div v-if="pendingImages.length > 0" class="mb-2 flex flex-wrap gap-2">
        <div
          v-for="entry in pendingImages"
          :key="entry.objectUrl"
          class="overflow-hidden rounded-desk-sm border border-desk-line bg-desk-surface-subtle"
        >
          <img :src="entry.objectUrl" :alt="entry.file.name" class="h-16 w-16 object-cover" />
          <div class="flex items-center justify-between gap-1 px-1 py-0.5">
            <p class="max-w-16 truncate text-2xs text-desk-muted">{{ formatBytes(entry.file.size) }}</p>
            <AppButton
              variant="ghost"
              class="shrink-0 px-1"
              :aria-label="`移除图片 ${entry.file.name}`"
              @click="removeImage(entry.objectUrl)"
            >
              ×
            </AppButton>
          </div>
        </div>
      </div>

      <label for="prompt-input" class="sr-only">输入要发送给 Pi 的内容</label>
      <div class="prompt-composer-shell">
        <div class="relative">
          <!-- 命令补全：候选来自 Pi 已加载的资源清单；Enter 仍然是发送，Tab 或点击接受候选。 -->
          <ul
            v-if="visibleSuggestions.length > 0"
            id="prompt-command-list"
            role="listbox"
            aria-label="可用命令"
            class="dialog-popover scroll-area bottom-full mb-1.5 max-h-64 w-full overflow-y-auto p-1"
          >
            <li v-for="(entry, index) in visibleSuggestions" :key="`${entry.kind}-${entry.name}`" role="presentation">
              <AppButton
                variant="unstyled"
                role="option"
                :aria-selected="index === suggestionIndex"
                class="list-item"
                :class="index === suggestionIndex ? 'list-item-active' : ''"
                @mousedown.prevent="acceptSuggestion(entry)"
              >
                <span class="font-mono text-xs">/{{ entry.name }}</span>
                <span v-if="entry.description !== null" class="mt-0.5 block text-2xs text-desk-muted">
                  {{ entry.description }}
                </span>
              </AppButton>
            </li>
          </ul>

          <textarea
            id="prompt-input"
            ref="textarea"
            v-model="draft"
            rows="3"
            class="text-control prompt-composer-input resize-none"
            placeholder="输入要发送给 Pi 的内容"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="prompt-status"
            aria-autocomplete="list"
            aria-controls="prompt-command-list"
            :aria-expanded="visibleSuggestions.length > 0"
            @keydown="onKeydown"
            @compositionstart="composing = true"
            @compositionend="composing = false"
          ></textarea>
        </div>

        <div class="prompt-composer-toolbar">
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
            <AppButton
              :disabled="(!runtimeReady && (!canStartRuntime || projectStore.currentProject === null))
                || sending || sessionStore.opening || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt
                || imageSupported === false || pendingImages.length >= 4"
              @click="imageInput?.click()"
            >
              图片
            </AppButton>
            <AppButton
              v-if="stopVisible"
              :disabled="abortView.phase === 'requesting'"
              @click="stop"
            >
              {{ abortView.phase === 'requesting' ? '正在停止…' : '停止' }}
            </AppButton>
            <AppButton
              v-else
              variant="primary"
              :disabled="!canSend"
              @click="submit"
            >
              发送
            </AppButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
