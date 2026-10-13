<!-- Prompt 输入坞：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交、响应侧栏「新建」的聚焦请求并给出一次性提示，并在 Agent 运行期间原位提供停止入口；同时承接 Extension 的 set_editor_text 填充文本、图片附件的选择/粘贴/拖拽三种入口、输入行按内容自动增高、快捷发送下拉（短语取自界面偏好，可在设置里增删改与排序）、Pi 命令的斜杠模糊补全（Runtime 就绪后用运行中的命令清单，未就绪时用主进程预读的技能清单，按类型分组并按匹配优先级排序）与 `@` 项目文件引用（只写入相对路径文本，不传文件内容）。底部工具条左侧是信息行：异常与进行中的状态文本、被收起的 Extension 对话入口、Extension status 项与会话用量（点击开明细）；右侧是附件、快捷发送与发送/停止按钮。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PROJECT_FILE_QUERY_MAX_CHARS } from '../../../shared/project-file-api'
import type { OutputRate, PiResourceEntry, PiResourceKind, PromptDisposition, PromptImageInput } from '../../../shared/runtime-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import { usePreferencesStore } from '../stores/preferences'
import { useProjectFileStore } from '../stores/project-file'
import { useResourceStore } from '../stores/resource'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import AppButton from './ui/AppButton.vue'
import UsageDetailDialog from './UsageDetailDialog.vue'

const runtimeStore = useRuntimeStore()
const extensionStore = useExtensionUiStore()
const projectStore = useProjectStore()
const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const preferencesStore = usePreferencesStore()
const { view: runtimeView, promptView, abortView, projectionSync, capabilitiesView, modelSwitchView,
  preparingPrompt, rewindView } = storeToRefs(runtimeStore)
const { editorText, editorTextVersion } = storeToRefs(extensionStore)

/** 侧栏「新建」在闲置态的聚焦请求；父组件只传这个自增计数。 */
const props = defineProps<{ readonly focusToken: number }>()

const draft = ref('')
/** 首次提交只启动 Runtime；就绪且投影同步后自动补发输入，启动期间用户仍可继续编辑。 */
const startupRequested = ref(false)
let startupProjectPath: string | null = null
const submitting = ref(false)
/** 输入法组合态：此期间的 Enter 只确认候选词，不能当发送。 */
const composing = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)
/** 闲置态点击「新建」后的一次性提示：说明会话由首次发送创建。 */
const newSessionHint = ref(false)
let newSessionHintTimer: ReturnType<typeof setTimeout> | null = null

/** 聚焦请求只在闲置态发出：聚焦输入框并短暂提示，不改动启动语义。 */
watch(() => props.focusToken, () => {
  textarea.value?.focus()
  newSessionHint.value = true
  if (newSessionHintTimer !== null) clearTimeout(newSessionHintTimer)
  newSessionHintTimer = setTimeout(() => {
    newSessionHint.value = false
    newSessionHintTimer = null
  }, 4_000)
})

/** 待发送的图片附件：objectUrl 仅用于本地预览，发送时读取 base64 并释放。 */
interface PendingImage {
  readonly file: File
  readonly objectUrl: string
}
const pendingImages = ref<PendingImage[]>([])
const imageInput = ref<HTMLInputElement | null>(null)

/** 快捷发送候选：与草稿内容无关，选中即用该短语发起一次提交；短语来自界面偏好，可在设置里编辑。 */
const quickSendMessages = computed(() => preferencesStore.quickSendMessages)
const quickSendOpen = ref(false)
const quickSendIndex = ref(0)
/** 触发按钮上显示的当前短语；列表为空时为 undefined，此时按钮也是禁用的。 */
const quickSendCurrent = computed(() => quickSendMessages.value[quickSendIndex.value])
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
/** 就绪后仅在 Agent 空闲、投影同步且无提交或模型/会话切换时允许发送；未就绪时仅允许有项目且没有并发启动的首次启动请求。 */
const canSubmit = computed(() => {
  if (sending.value || submitting.value || preparingPrompt.value || modelSwitchView.value.phase === 'switching' || sessionStore.opening
    || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt || rewindView.value.phase === 'requesting'
    || (rewindView.value.phase === 'error' && rewindView.value.blocked)) return false
  if (runtimeReady.value) {
    return projectionSync.value === 'synced' && !streaming.value
  }
  return canStartRuntime.value && projectStore.currentProject !== null
})
/** 提交要求文本与附件至少有一项：只发图片不带文字也是合法输入；快捷发送直接用偏好里的短语，因此不看这一条。 */
const canSend = computed(() => (
  (draft.value.trim() !== '' || pendingImages.value.length > 0) && canSubmit.value
))
/** 图片入口（选择、粘贴、拖拽）共用同一套禁用条件，避免三条路径行为不一致。 */
const attachDisabled = computed(() => (
  !canSubmit.value || imageSupported.value === false || pendingImages.value.length >= MAX_IMAGE_COUNT
))

const status = computed<{ readonly kind: 'info' | 'error'; readonly text: string } | null>(() => {
  if (rewindView.value.phase === 'requesting') return { kind: 'info', text: '正在回退对话；草稿保留，完成后才能发送。' }
  if (rewindView.value.phase === 'error' && rewindView.value.blocked) return { kind: 'error', text: rewindView.value.error.message }
  if (preparingPrompt.value) return { kind: 'info', text: '正在读取附件并提交输入。' }
  if (abortView.value.phase === 'error') {
    return { kind: 'error', text: abortView.value.error.message }
  }
  if (abortView.value.phase === 'requesting') {
    return { kind: 'info', text: '正在停止当前操作，等待本轮结束。' }
  }
  if (promptView.value.phase === 'error') {
    return { kind: 'error', text: promptView.value.error.message }
  }
  if (modelSwitchView.value.phase === 'switching') {
    return { kind: 'info', text: '正在切换模型；草稿和附件会保留，完成后可发送。' }
  }
  if (sending.value) return { kind: 'info', text: '正在提交 Prompt，等待 Pi 回应。' }
  if (sessionStore.awaitingTrust) {
    return { kind: 'info', text: '请先完成项目 Trust 决定；输入会保留，Runtime 就绪后自动发送。' }
  }
  if (promptView.value.phase === 'accepted') {
    // 「已开始执行」由消息列表与运行中的停止键表达，不在这里重复播报；
    // 排队与「已处理但未发起 run」需要解释为什么没开始或没反应，保留文案。
    return promptView.value.disposition === 'started'
      ? null
      : { kind: 'info', text: acceptedText(promptView.value.disposition) }
  }
  if (sessionStore.awaitingInterrupt) {
    return { kind: 'info', text: '请先处理当前操作；输入会保留。' }
  }
  if (!runtimeReady.value) {
    if (runtimeView.value.phase === 'failed') {
      return { kind: 'error', text: `${runtimeView.value.error.message}；可再次点击发送重试启动。` }
    }
    if (runtimeView.value.phase === 'starting') {
      return { kind: 'info', text: '正在启动 Pi；输入已保留，就绪后自动发送。' }
    }
    // 侧栏「新建」只聚焦输入框：用一次性提示说明要发送才会开始会话。
    if (newSessionHint.value && canStartRuntime.value) return { kind: 'info', text: '发送后开始新会话。' }
    // 未选项目与首次启动属于纯引导，按钮的禁用态已经表达，不再占信息行。
    if (canStartRuntime.value || projectStore.currentProject === null) return null
    return { kind: 'info', text: 'Runtime 正在关闭；输入会保留。' }
  }
  if (streaming.value) {
    return { kind: 'info', text: 'Agent 正在运行，本轮结束前不能提交新输入。' }
  }
  if (projectionSync.value !== 'synced') {
    return { kind: 'info', text: '消息仍在同步，稍后才能提交输入。' }
  }
  return null
})

/** 排队与「已处理但未发起 run」的结果文案；已开始执行不在信息行重复播报。 */
function acceptedText(disposition: PromptDisposition): string {
  return disposition === 'queued'
    ? 'Pi 已将本次输入排队。'
    : '本次输入已被处理，未发起新的 Agent run。'
}

/** 本会话累计用量；主进程未取到统计时为 null。 */
const usage = computed(() => runtimeInfo.value?.usage ?? null)
/** 输出速率；未采样到有效值时两个字段各为 null。 */
const rate = computed<OutputRate>(() => runtimeInfo.value?.rate ?? { live: null, average: null })
const usageOpen = ref(false)

/** 累计数值短格式：1234 → 1.2K、1234567 → 1.2M；未知值保持 `?`。 */
function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '?'
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

/** 用量行分项：累计用量与费用、上下文占用、实时与平均速率；未取到统计时为空。 */
const usageParts = computed<readonly { readonly text: string; readonly tone: string; readonly title: string }[]>(() => {
  const current = usage.value
  if (current === null) return []
  const context = current.context
  const percent = context?.percent ?? null
  const contextTone = percent === null
    ? ''
    : percent >= 90 ? 'text-desk-danger' : percent >= 70 ? 'text-desk-warning' : ''
  const parts: { text: string; tone: string; title: string }[] = [
    {
      text: `↑${formatTokens(current.input)} ↓${formatTokens(current.output)} R${formatTokens(current.cacheRead)} W${formatTokens(current.cacheWrite)} $${current.cost.toFixed(3)}`,
      tone: '',
      title: '本会话累计用量与费用'
    },
    {
      text: `上下文 ${percent === null ? '?' : `${percent.toFixed(1)}%`}/${formatTokens(context?.contextWindow ?? null)}`,
      tone: contextTone,
      title: '当前上下文占用与窗口大小'
    }
  ]
  if (rate.value.live !== null) {
    parts.push({ text: `实 ${rate.value.live.toFixed(1)} t/s`, tone: 'text-desk-accent', title: '实时输出速率（2 秒窗口）' })
  }
  if (rate.value.average !== null) {
    parts.push({ text: `均 ${rate.value.average.toFixed(1)} t/s`, tone: 'text-desk-accent', title: '上一轮模型调用的平均速率' })
  }
  return parts
})

/** 被收起的队首 Extension 对话：只在收起时占据信息行，点击恢复到弹窗。 */
const pendingDialog = computed(() => {
  const first = extensionStore.dialogs[0] ?? null
  if (first === null || extensionStore.minimizedDialogId !== first.id) return null
  return first
})

/** 状态行的展示字段；`statusText` 为空表示当前没有需要占位的状态。 */
const statusText = computed(() => status.value?.text ?? null)
const statusRole = computed(() => (status.value?.kind === 'error' ? 'alert' : 'status'))
const statusTone = computed(() => (status.value?.kind === 'error' ? 'text-desk-danger' : 'text-desk-muted'))
/** 被收起对话的标题；没有收起态时为空。 */
const pendingTitle = computed(() => pendingDialog.value?.title ?? null)

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
  const count = quickSendMessages.value.length
  if (count === 0) return
  quickSendIndex.value = (quickSendIndex.value + step + count) % count
}

/** 快捷发送：把候选短语写进草稿后走与手动发送同一条提交路径，不改发送契约。 */
function sendQuickMessage(index: number): void {
  const message = quickSendMessages.value[index]
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
  if (newSessionHintTimer !== null) clearTimeout(newSessionHintTimer)
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

/** 短语在设置里被增删改后，当前选中项可能越界；夹取到合法范围，按钮不会渲染出空文本。 */
watch(quickSendMessages, (messages) => {
  if (quickSendIndex.value >= messages.length) quickSendIndex.value = 0
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
    // 首次发送只触发 Runtime 启动；保留文字与附件，就绪且同步完成后由下方 watch 自动补发。
    startupProjectPath = projectStore.currentProject?.path ?? null
    startupRequested.value = true
    await sessionStore.open(null, false)
    if (sessionStore.actionError !== null) startupRequested.value = false
    return
  }

  if (runtimeView.value.phase !== 'ready') return
  const target = runtimeView.value.snapshot
  const message = draft.value
  const attachments = [...pendingImages.value]
  submitting.value = true
  preparingPrompt.value = true
  try {
    const images: PromptImageInput[] = []
    for (const entry of attachments) {
      images.push({ name: entry.file.name, mimeType: entry.file.type, data: await readAsBase64(entry.file) })
    }
    // 附件读取期间允许继续编辑草稿，但不允许把旧提交送入已切换的会话。
    if (runtimeView.value.phase !== 'ready' || runtimeView.value.snapshot.runtimeId !== target.runtimeId
      || runtimeView.value.snapshot.info?.sessionId !== target.info?.sessionId || sessionStore.opening) return
    const before = promptView.value
    await runtimeStore.send(message, images)
    if (promptView.value === before || promptView.value.phase !== 'accepted') return

    startupRequested.value = false
    if (draft.value === message) draft.value = ''
    const sent = new Set(attachments.map(entry => entry.objectUrl))
    for (const entry of attachments) URL.revokeObjectURL(entry.objectUrl)
    pendingImages.value = pendingImages.value.filter(entry => !sent.has(entry.objectUrl))
    textarea.value?.focus()
  } catch (error) {
    if (runtimeView.value.phase === 'ready' && runtimeView.value.snapshot.runtimeId === target.runtimeId
      && runtimeView.value.snapshot.info?.sessionId === target.info?.sessionId) {
      promptView.value = { phase: 'error', error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : '读取图片失败；草稿和附件已保留。' } }
    }
  } finally {
    submitting.value = false
    preparingPrompt.value = false
  }
}

function stop(): void {
  void runtimeStore.stopOperation()
}

/** 全部发送条件满足才消费首次提交意图；不能在会话还处于 opening 时提前丢弃。 */
watch(
  () => startupRequested.value && runtimeReady.value && projectionSync.value === 'synced'
    && !sessionStore.opening && !sessionStore.awaitingTrust && !sessionStore.awaitingInterrupt
    && (draft.value.trim() === '' || canSend.value),
  (pending) => {
    if (!pending) return
    startupRequested.value = false
    void submit()
  }
)

/** 换项目、启动失败或取消信任确认时作废自动发送意图，不让它泄漏到其他会话。 */
watch(() => projectStore.currentProject?.path ?? null, (path) => {
  if (path !== startupProjectPath) startupRequested.value = false
})
watch(() => runtimeView.value.phase, (phase) => {
  if (phase === 'failed' || phase === 'closed' || phase === 'stopping') startupRequested.value = false
})
watch(() => sessionStore.awaitingTrust || sessionStore.awaitingInterrupt, (awaiting, previous) => {
  if (previous && !awaiting && !sessionStore.opening && !runtimeReady.value) startupRequested.value = false
})

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

/** 分组顺序与标题：技能置前，保证输入 `/` 时技能一定出现在候选里，不被其他类型整体挤出。 */
const SUGGESTION_GROUPS: readonly { readonly kind: PiResourceKind; readonly label: string }[] = [
  { kind: 'skill', label: '技能' },
  { kind: 'prompt', label: '模板' },
  { kind: 'extension', label: '扩展命令' }
]
/** 每组各自的条数上限；不用全局上限截断，否则排在后面的技能永远进不了候选。 */
const MAX_SUGGESTIONS_PER_KIND = 8
/** 斜杠补全只在输入以 `/` 开头且尚未输入空白字符（即仍在命令名内）时生效。 */
const slashQuery = computed(() => {
  const text = draft.value
  if (!text.startsWith('/') || /\s/.test(text)) return null
  return text.slice(1).toLowerCase()
})
const suggestionsDismissed = ref(false)
const suggestionIndex = ref(0)

/** 候选分组：`index` 是该条在扁平列表中的位置，键盘导航与选中态都按它对应。 */
interface SuggestionGroup {
  readonly kind: PiResourceKind
  readonly label: string
  readonly items: readonly { readonly entry: PiResourceEntry; readonly index: number }[]
}

/** 名称完全匹配 > 前缀 > 包含 > 按顺序的非连续字符 > 描述包含；显式 `skill:` 只搜索技能。 */
function commandMatchRank(entry: PiResourceEntry, query: string): number | null {
  const skillOnly = query.startsWith('skill:')
  if (skillOnly && entry.kind !== 'skill') return null
  const needle = skillOnly ? query.slice('skill:'.length) : query
  // 空查询保留资源清单的原始顺序；`/skill:` 则列举技能。
  if (needle === '') return 0

  const name = entry.name.toLowerCase()
  const skillName = entry.kind === 'skill' && name.startsWith('skill:')
    ? name.slice('skill:'.length)
    : name
  const names = skillOnly ? [skillName] : [skillName, name]
  if (names.some((candidate) => candidate === needle)) return 0
  if (names.some((candidate) => candidate.startsWith(needle))) return 1
  if (names.some((candidate) => candidate.includes(needle))) return 2

  for (const candidate of names) {
    let position = 0
    let matched = true
    for (const character of needle) {
      const found = candidate.indexOf(character, position)
      if (found < 0) {
        matched = false
        break
      }
      position = found + character.length
    }
    if (matched) return 3
  }
  return entry.description?.toLowerCase().includes(needle) ? 4 : null
}

/**
 * 候选来源：Runtime 就绪时用当前会话已加载的资源，未就绪时用主进程一次性预读的技能清单。
 * 两份数据不合并、不去重：就绪后预读结果立即作废，运行中的清单是唯一权威。
 */
const candidateEntries = computed<readonly PiResourceEntry[]>(() => (
  runtimeReady.value ? resourceStore.entries : resourceStore.previewSkills
))

/** 按类型分组后，各组先按匹配优先级排序再限量，同级保持资源清单的原始顺序。 */
const matchedGroups = computed<readonly SuggestionGroup[]>(() => {
  const query = slashQuery.value
  if (query === null) return []

  const groups: SuggestionGroup[] = []
  let index = 0
  for (const group of SUGGESTION_GROUPS) {
    const ranked: { entry: PiResourceEntry; rank: number }[] = []
    for (const entry of candidateEntries.value) {
      if (entry.kind !== group.kind) continue
      const rank = commandMatchRank(entry, query)
      if (rank !== null) ranked.push({ entry, rank })
    }
    ranked.sort((left, right) => left.rank - right.rank)
    const items = ranked.slice(0, MAX_SUGGESTIONS_PER_KIND).map(({ entry }) => ({ entry, index: index++ }))
    if (items.length > 0) groups.push({ kind: group.kind, label: group.label, items })
  }
  return groups
})

/** 扁平候选：键盘导航与 `activeListId` 判断仍按它工作，顺序与分组渲染一致。 */
const matchedSuggestions = computed<readonly PiResourceEntry[]>(() => (
  matchedGroups.value.flatMap((group) => group.items.map((item) => item.entry))
))
const visibleSuggestions = computed(() => (suggestionsDismissed.value ? [] : matchedSuggestions.value))
const visibleSuggestionGroups = computed<readonly SuggestionGroup[]>(() => (
  suggestionsDismissed.value ? [] : matchedGroups.value
))

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

/** 弹层归属：两个列表互斥出现，`aria-controls` 指向当前真正显示的那个；都没有打开时没有可指向的元素。 */
const activeListId = computed(() => {
  if (visibleFileEntries.value.length > 0) return 'prompt-file-list'
  return visibleSuggestions.value.length > 0 ? 'prompt-command-list' : undefined
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
        <!-- 命令补全：候选在 Runtime 就绪时来自运行中的命令清单、未就绪时来自主进程预读的技能清单，按类型分组展示；Enter 仍然是发送，Tab 或点击接受候选。 -->
        <ul
          v-if="visibleSuggestionGroups.length > 0"
          id="prompt-command-list"
          role="listbox"
          aria-label="可用命令"
          class="dialog-popover scroll-area bottom-full mb-1.5 max-h-64 w-full overflow-y-auto p-1"
        >
          <template v-for="group in visibleSuggestionGroups" :key="group.kind">
            <li role="presentation" class="prompt-composer-group-label">{{ group.label }}</li>
            <li v-for="item in group.items" :key="`${item.entry.kind}-${item.entry.name}`" role="presentation">
              <AppButton
                variant="unstyled"
                role="option"
                :aria-selected="item.index === suggestionIndex"
                class="list-item prompt-composer-option"
                :class="item.index === suggestionIndex ? 'list-item-active' : ''"
                @mousedown.prevent="acceptSuggestion(item.entry)"
              >
                <span class="font-mono text-xs">/{{ item.entry.name }}</span>
                <span v-if="item.entry.description !== null" class="prompt-composer-option-detail">{{ item.entry.description }}</span>
              </AppButton>
            </li>
          </template>
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
          aria-describedby="statusText !== null ? 'prompt-status' : undefined"
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
          <div class="prompt-composer-meta">
            <!-- 状态文本只在异常与进行中出现；正常态让位给用量与插件状态。 -->
            <p
              v-if="statusText !== null"
              id="prompt-status"
              :role="statusRole"
              class="prompt-composer-status"
              :class="statusTone"
            >
              {{ statusText }}
            </p>
            <!-- 被收起的插件请求：点击恢复到对话弹窗，不代替用户取消。 -->
            <button
              v-if="pendingTitle !== null"
              type="button"
              class="prompt-pending"
              title="展开被收起的插件请求"
              @click="extensionStore.restoreDialog()"
            >
              <span aria-hidden="true">❓</span>
              <span class="prompt-pending-text">{{ pendingTitle }}</span>
            </button>
            <!-- Extension setStatus 项：纯文本展示，过长时截断。 -->
            <span
              v-for="entry in extensionStore.statuses"
              :key="entry.key"
              class="prompt-status-entry"
              :title="entry.text"
            >{{ entry.text }}</span>
            <!-- 会话用量：点击开明细浮层；统计未取到时显示占位。 -->
            <button
              type="button"
              class="prompt-usage"
              aria-haspopup="dialog"
              :aria-expanded="usageOpen"
              title="点击查看本会话用量明细"
              @click="usageOpen = true"
            >
              <template v-if="usageParts.length > 0">
                <span
                  v-for="part in usageParts"
                  :key="part.text"
                  :class="part.tone"
                  :title="part.title"
                >{{ part.text }}</span>
              </template>
              <span v-else>用量 —</span>
            </button>
          </div>
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
              class="prompt-composer-char"
              :disabled="attachDisabled"
              aria-label="添加图片"
              title="添加图片（也可粘贴或拖入）"
              @click="imageInput?.click()"
            >
              ＋
            </AppButton>

            <!-- 快捷发送：按钮上直接显示当前选中短语，点一下就用它提交。 -->
            <div ref="quickSend" class="relative">
              <AppButton
                variant="icon"
                class="w-auto max-w-[min(12rem,40vw)] gap-1 px-2.5"
                :disabled="!canSubmit || quickSendMessages.length === 0"
                aria-haspopup="listbox"
                :aria-expanded="quickSendOpen"
                aria-controls="prompt-quick-send"
                :title="quickSendCurrent === undefined
                  ? '选择并直接发送常用消息'
                  : `当前：${quickSendCurrent}；点击选择并直接发送`"
                @click="toggleQuickSend"
              >
                <span class="min-w-0 truncate text-xs">{{ quickSendCurrent }}</span>
                <span aria-hidden="true">▾</span>
              </AppButton>
              <div v-if="quickSendOpen" id="prompt-quick-send" role="listbox" aria-label="常用消息" class="prompt-composer-menu">
                <AppButton
                  v-for="(message, index) in quickSendMessages"
                  :key="index"
                  variant="unstyled"
                  role="option"
                  :aria-selected="index === quickSendIndex"
                  class="list-item truncate"
                  :class="index === quickSendIndex ? 'list-item-active' : ''"
                  :title="message"
                  @click="sendQuickMessage(index)"
                >
                  {{ message }}
                </AppButton>
              </div>
            </div>

            <!-- 发送与停止共用一个位置与一档强调色，运行中靠字符形状区分。 -->
            <AppButton
              v-if="stopVisible"
              variant="icon-primary"
              class="prompt-composer-send"
              :disabled="abortView.phase === 'requesting'"
              aria-label="停止当前操作"
              title="停止当前操作"
              @click="stop"
            >
              ■
            </AppButton>
            <AppButton
              v-else
              variant="icon-primary"
              class="prompt-composer-send"
              :disabled="!canSend"
              aria-label="发送"
              title="发送（Enter 发送，Shift+Enter 换行）"
              @click="submit"
            >
              ↑
            </AppButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 用量明细与其它弹层一致：Teleport 到 body，不受输入坞的层叠上下文限制。 -->
    <Teleport to="body">
      <UsageDetailDialog
        :open="usageOpen"
        :usage="usage"
        :rate="rate"
        @close="usageOpen = false"
      />
    </Teleport>
  </section>
</template>
