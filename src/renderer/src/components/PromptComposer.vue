<!-- Prompt 输入坞：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交，并在 Agent 运行期间原位提供停止入口；同时承接 Extension 的 set_editor_text 填充文本、图片附件的选择/粘贴/拖拽三种入口、输入行按内容自动增高、快捷发送下拉、Pi 命令的斜杠补全与 `@` 项目文件引用（只写入相对路径文本，不传文件内容）。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PROJECT_FILE_QUERY_MAX_CHARS } from '../../../shared/project-file-api'
import type { PiResourceEntry, PromptDisposition, PromptImageInput } from '../../../shared/runtime-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import { useProjectFileStore } from '../stores/project-file'
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

/** 快捷发送候选：与草稿内容无关，选中即用该短语发起一次提交。 */
const QUICK_SEND_MESSAGES: readonly string[] = ['继续', '确认', '提交']
const quickSendOpen = ref(false)
const quickSendIndex = ref(0)
/** 下拉外层引用：用于判断一次点击是否落在下拉之外。 */
const quickSend = ref<HTMLElement | null>(null)
/** 拖拽计数：dragenter/dragleave 会在子元素间反复触发，用计数而不是布尔避免高亮抖动。 */
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)

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
const canSubmit = computed(() => {
  if (sending.value || sessionStore.opening
    || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt) return false
  if (runtimeReady.value) {
    return projectionSync.value === 'synced' && !streaming.value
  }
  return canStartRuntime.value && projectStore.currentProject !== null
})
/** 提交还要求草稿非空；快捷发送直接用预设短语，因此不看这一条。 */
const canSend = computed(() => draft.value.trim() !== '' && canSubmit.value)
/** 图片入口（选择、粘贴、拖拽）共用同一套禁用条件，避免三条路径行为不一致。 */
const attachDisabled = computed(() => (
  !canSubmit.value || imageSupported.value === false || pendingImages.value.length >= MAX_IMAGE_COUNT
))

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
/** 输入行自动增高的静态上限；实际上限再取窗口高度的 40%。与 .prompt-composer-input 的 max-height 保持一致。 */
const MAX_INPUT_HEIGHT = 200

/** 选择图片：只接受白名单类型，超出条数上限时截断并提示。 */
function onPickImages(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  addImageFiles(files)
}

/** 粘贴与拖拽图片：只提取白名单内的图片文件，文本粘贴仍走浏览器默认行为。 */
function pickImageFiles(files: readonly File[]): readonly File[] {
  return files.filter((file) => IMAGE_MIME_TYPES.includes(file.type))
}

/** 图片入口的唯一校验点：选择、粘贴、拖拽三条路径共用。 */
function addImageFiles(files: readonly File[]): void {
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

function onPaste(event: ClipboardEvent): void {
  const files = pickImageFiles([...(event.clipboardData?.files ?? [])])
  if (files.length === 0 || attachDisabled.value) return
  // 命中图片时必须拦下默认行为，否则剪贴板里的文件名会被当文本插进草稿。
  event.preventDefault()
  addImageFiles(files)
}

/** 数据里带文件才认作附件拖拽，普通文本拖拽仍交给浏览器处理。 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return types !== undefined && types.includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!carriesFiles(event) || attachDisabled.value) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (!carriesFiles(event) || attachDisabled.value) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(event: DragEvent): void {
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth.value = 0
  if (attachDisabled.value) return
  addImageFiles(pickImageFiles([...(event.dataTransfer?.files ?? [])]))
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

/** 输入行按内容自动增高：未到上限不出现滚动条，上限同时受窗口高度约束，矮窗口下不吃掉消息区。 */
function autoGrow(): void {
  const element = textarea.value
  if (element === null) return
  element.style.height = 'auto'
  const maxHeight = Math.min(MAX_INPUT_HEIGHT, window.innerHeight * 0.4)
  const wanted = element.scrollHeight
  element.style.height = `${Math.min(wanted, maxHeight)}px`
  element.style.overflowY = wanted > maxHeight ? 'auto' : 'hidden'
}

/** 展开或收起快捷发送下拉。 */
function toggleQuickSend(): void {
  quickSendOpen.value = !quickSendOpen.value
}

function moveQuickSend(step: number): void {
  const count = QUICK_SEND_MESSAGES.length
  quickSendIndex.value = (quickSendIndex.value + step + count) % count
}

/** 快捷发送：把预设短语写进草稿后走与手动发送同一条提交路径，不改发送契约。 */
function sendQuickMessage(index: number): void {
  const message = QUICK_SEND_MESSAGES[index]
  if (message === undefined) return
  quickSendIndex.value = index
  quickSendOpen.value = false
  if (!canSubmit.value) return
  draft.value = message
  textarea.value?.focus()
  void submit()
}

/** 点击下拉与触发键之外的位置即收起；在文档层监听，避免遮罩挡在输入区前面。 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!quickSendOpen.value) return
  const target = event.target
  if (target instanceof Node && quickSend.value?.contains(target)) return
  quickSendOpen.value = false
}

onUnmounted(() => {
  cancelFileSearch()
  for (const entry of pendingImages.value) URL.revokeObjectURL(entry.objectUrl)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})

/** 草稿的每一次写入都重算高度与 `@` 引用：用户输入、Extension 填充、补全写入与命令清空都经这里。 */
watch(draft, () => {
  quickSendOpen.value = false
  // 延到 DOM 更新之后：自动增高与 `@` 词元都要读更新后的文本与光标位置。
  void nextTick(() => {
    autoGrow()
    refreshFileToken()
  })
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

  // 文件引用补全：Enter 与 Tab 都接受候选；Esc 只收起弹层，之后 Enter 恢复发送。
  if (fileToken.value !== null) {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && visibleFileEntries.value.length > 0) {
      event.preventDefault()
      moveFileSuggestion(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Tab') {
      // 引用没写完时不让 Tab 把焦点带走；没有候选就只吞掉按键。
      event.preventDefault()
      acceptFileSuggestion(visibleFileEntries.value[fileActiveIndex.value])
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && fileCompletionActive.value) {
      // 补全占着 Enter 期间宁可吞掉按键，也不把半截路径发出去。
      event.preventDefault()
      acceptFileSuggestion(visibleFileEntries.value[fileActiveIndex.value])
      return
    }
    if (event.key === 'Escape') {
      filesDismissed.value = true
      return
    }
  }

  // 快捷发送下拉已展开时，方向键与 Enter 归它，避免 Enter 误发草稿。
  if (quickSendOpen.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveQuickSend(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveQuickSend(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      sendQuickMessage(quickSendIndex.value)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      quickSendOpen.value = false
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

/** `@` 文件引用：候选来自主进程按当前项目建的文件索引；插入的是相对路径文本，不传文件内容。 */
const MAX_FILE_SUGGESTIONS = 8
const FILE_QUERY_DEBOUNCE_MS = 120
const projectFileStore = useProjectFileStore()

/** 光标处的 `@` 引用：`start` 是 `@` 在草稿里的下标，`text` 是 `@` 到光标之间的查询串。 */
interface FileToken {
  readonly start: number
  readonly text: string
}
const fileToken = ref<FileToken | null>(null)
const fileActiveIndex = ref(0)
const filesDismissed = ref(false)
/** 防抖待发标志：这段时间里候选还是上一轮的，Enter 必须等结果而不是发送半截路径。 */
const fileSearchScheduled = ref(false)
let fileSearchTimer = 0

/** 从光标前的文本取 `@` 引用：`@` 必须在行首或空白之后，查询串不含空白且不超长度上限。 */
function readFileToken(): FileToken | null {
  const element = textarea.value
  if (element === null) return null

  const before = element.value.slice(0, element.selectionStart ?? element.value.length)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null

  const text = before.slice(at + 1)
  if (text.length > PROJECT_FILE_QUERY_MAX_CHARS) return null
  if (/\s/.test(text)) return null
  return { start: at, text }
}

/** 光标或草稿变化后重算引用；查询串没变时不动计时器，避免连续 keyup 把检索无限推迟。 */
function refreshFileToken(): void {
  const token = readFileToken()
  if (token === null) {
    cancelFileSearch()
    fileToken.value = null
    return
  }

  const current = fileToken.value
  if (current !== null && current.start === token.start && current.text === token.text) return

  fileToken.value = token
  cancelFileSearch()
  fileSearchScheduled.value = true
  fileSearchTimer = window.setTimeout(() => {
    fileSearchTimer = 0
    fileSearchScheduled.value = false
    void projectFileStore.search(token.text)
  }, FILE_QUERY_DEBOUNCE_MS)
}

function cancelFileSearch(): void {
  if (fileSearchTimer === 0) return
  window.clearTimeout(fileSearchTimer)
  fileSearchTimer = 0
  fileSearchScheduled.value = false
}

/** 查询串一变就回到第一条候选，并撤销上一次的 Esc 收起。 */
const fileQueryText = computed(() => fileToken.value?.text ?? null)
watch(fileQueryText, () => {
  fileActiveIndex.value = 0
  filesDismissed.value = false
})

/** 可见候选：引用消失、被 Esc 收起或候选为空时都不显示。 */
const visibleFileEntries = computed<readonly string[]>(() => {
  if (fileToken.value === null || filesDismissed.value) return []
  return projectFileStore.entries.slice(0, MAX_FILE_SUGGESTIONS)
})

/** 补全是否占着 Enter：防抖待发与请求进行中同样算占用，否则快速回车会把半截路径发出去。 */
const fileCompletionActive = computed(() => (
  fileToken.value !== null
  && !filesDismissed.value
  && (fileSearchScheduled.value || projectFileStore.pending || visibleFileEntries.value.length > 0)
))

/** 弹层归属：两个列表互斥出现，`aria-controls` 指向当前真正显示的那个。 */
const activeListId = computed(() => {
  if (visibleFileEntries.value.length > 0) return 'prompt-file-list'
  return visibleSuggestions.value.length > 0 ? 'prompt-command-list' : null
})
const activeListOpen = computed(() => (
  visibleFileEntries.value.length > 0 || visibleSuggestions.value.length > 0
))

function moveFileSuggestion(step: number): void {
  const count = visibleFileEntries.value.length
  if (count === 0) return
  fileActiveIndex.value = (fileActiveIndex.value + step + count) % count
}

/** 候选行的两列：文件名与所在目录；根目录下的文件没有第二列。 */
function fileName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

function fileDirectory(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(0, slash) : ''
}

/** 接受候选：把 `@查询串` 换成项目相对路径并补一个空格，光标停在空格之后。 */
function acceptFileSuggestion(path: string | undefined): void {
  const element = textarea.value
  const token = fileToken.value
  if (element === null || token === null || path === undefined) return

  // 含空白的路径用双引号包起来；含引号的路径（Windows 文件名不允许）原样写入，不删改任何字符。
  const inserted = /\s/.test(path) && !path.includes('"') ? `"${path}"` : path
  const caret = element.selectionStart ?? element.value.length
  draft.value = `${draft.value.slice(0, token.start)}${inserted} ${draft.value.slice(caret)}`
  fileToken.value = null
  filesDismissed.value = false
  cancelFileSearch()
  element.focus()

  void nextTick(() => {
    const next = token.start + inserted.length + 1
    element.setSelectionRange(next, next)
    autoGrow()
  })
}

onMounted(() => {
  textarea.value?.focus()
  autoGrow()
  document.addEventListener('pointerdown', onDocumentPointerDown)
})
</script>

<template>
  <!-- 与消息区同色，输入坞靠描边与阴影浮起；不再用顶部分隔线切开两块。 -->
  <section class="bg-desk-canvas-sunken px-4 py-3 sm:px-6">
    <div class="mx-auto max-w-3xl">
      <label for="prompt-input" class="sr-only">输入要发送给 Pi 的内容</label>
      <div
        class="prompt-composer-shell"
        :class="dragging ? 'is-dragging' : ''"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
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
              class="list-item prompt-composer-option"
              :class="index === suggestionIndex ? 'list-item-active' : ''"
              @mousedown.prevent="acceptSuggestion(entry)"
            >
              <span class="font-mono text-xs">/{{ entry.name }}</span>
              <span v-if="entry.description !== null" class="prompt-composer-option-detail">{{ entry.description }}</span>
            </AppButton>
          </li>
        </ul>

        <!-- 文件引用补全：候选是当前项目的相对路径，Enter 与 Tab 都接受候选，插入的只是路径文本，不读取文件内容。 -->
        <ul
          v-if="visibleFileEntries.length > 0"
          id="prompt-file-list"
          role="listbox"
          aria-label="项目文件"
          class="dialog-popover scroll-area bottom-full mb-1.5 max-h-64 w-full overflow-y-auto p-1"
        >
          <li v-for="(path, index) in visibleFileEntries" :key="path" role="presentation">
            <AppButton
              variant="unstyled"
              role="option"
              :aria-selected="index === fileActiveIndex"
              class="list-item prompt-composer-option prompt-composer-option-file"
              :class="index === fileActiveIndex ? 'list-item-active' : ''"
              @mousedown.prevent="acceptFileSuggestion(path)"
            >
              <span class="block truncate font-mono text-xs">{{ fileName(path) }}</span>
              <span v-if="fileDirectory(path) !== ''" class="prompt-composer-option-detail">{{ fileDirectory(path) }}</span>
            </AppButton>
          </li>
        </ul>

        <!-- 附件预览行：缩略图经 blob: URL 展示，可逐个移除。 -->
        <div v-if="pendingImages.length > 0" class="prompt-composer-attachments">
          <div v-for="entry in pendingImages" :key="entry.objectUrl" class="prompt-composer-attachment">
            <img :src="entry.objectUrl" :alt="entry.file.name" class="prompt-composer-attachment-thumb" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs text-desk-ink">{{ entry.file.name }}</span>
              <span class="block text-2xs text-desk-muted">{{ formatBytes(entry.file.size) }}</span>
            </span>
            <AppButton
              variant="ghost"
              class="shrink-0"
              :aria-label="`移除图片 ${entry.file.name}`"
              :title="`移除图片 ${entry.file.name}`"
              @click="removeImage(entry.objectUrl)"
            >
              <!-- 图标：纯图形按钮，语义靠按钮的 aria-label 表达。 -->
              <svg viewBox="0 0 16 16" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </AppButton>
          </div>
        </div>

        <textarea
          id="prompt-input"
          ref="textarea"
          v-model="draft"
          rows="1"
          class="text-control prompt-composer-input resize-none"
          placeholder="输入要发送给 Pi 的内容（可粘贴或拖入图片）"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="prompt-status"
          aria-autocomplete="list"
          :aria-controls="activeListId"
          :aria-expanded="activeListOpen"
          @keydown="onKeydown"
          @keyup="refreshFileToken"
          @click="refreshFileToken"
          @paste="onPaste"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        ></textarea>

        <div class="prompt-composer-toolbar">
          <p
            id="prompt-status"
            :role="status.kind === 'error' ? 'alert' : 'status'"
            class="prompt-composer-meta"
            :class="status.kind === 'error' ? 'text-desk-danger' : 'text-desk-muted'"
          >
            {{ status.text }}
          </p>
          <div class="flex flex-none items-center gap-1.5">
            <!-- 图片选择：与粘贴、拖拽共用同一套禁用条件；当前模型明确不支持时同样禁用。 -->
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
              variant="icon"
              :disabled="attachDisabled"
              aria-label="添加图片"
              title="添加图片（也可粘贴或拖入）"
              @click="imageInput?.click()"
            >
              <svg viewBox="0 0 16 16" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
            </AppButton>

            <!-- 快捷发送：按钮上直接显示当前选中短语，点一下就用它提交。 -->
            <div ref="quickSend" class="relative">
              <AppButton
                variant="icon"
                class="w-auto gap-1 px-2.5"
                :disabled="!canSubmit"
                aria-haspopup="listbox"
                :aria-expanded="quickSendOpen"
                aria-controls="prompt-quick-send"
                title="选择并直接发送常用消息"
                @click="toggleQuickSend"
              >
                <span class="text-xs">{{ QUICK_SEND_MESSAGES[quickSendIndex] }}</span>
                <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4.5 6.5 8 10l3.5-3.5" />
                </svg>
              </AppButton>
              <div v-if="quickSendOpen" id="prompt-quick-send" role="listbox" aria-label="常用消息" class="prompt-composer-menu">
                <AppButton
                  v-for="(message, index) in QUICK_SEND_MESSAGES"
                  :key="message"
                  variant="unstyled"
                  role="option"
                  :aria-selected="index === quickSendIndex"
                  class="list-item"
                  :class="index === quickSendIndex ? 'list-item-active' : ''"
                  @click="sendQuickMessage(index)"
                >
                  {{ message }}
                </AppButton>
              </div>
            </div>

            <!-- 发送与停止共用同一位置与同一档强调色，运行中靠图标形状区分。 -->
            <AppButton
              v-if="stopVisible"
              variant="icon-primary"
              :disabled="abortView.phase === 'requesting'"
              aria-label="停止当前操作"
              title="停止当前操作"
              @click="stop"
            >
              <svg viewBox="0 0 16 16" class="h-4 w-4" aria-hidden="true">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" />
              </svg>
            </AppButton>
            <AppButton
              v-else
              variant="icon-primary"
              :disabled="!canSend"
              aria-label="发送"
              title="发送（Enter 发送，Shift+Enter 换行）"
              @click="submit"
            >
              <svg viewBox="0 0 16 16" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 13V3.5M4.2 7.3 8 3.5l3.8 3.8" />
              </svg>
            </AppButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
