<!-- 图片与编号说明由坞内附件区独立管理；点击发送即固定提示词、图片及标注快照，说明由 SDK 独立资料消息承接。
     结果未确认时可补读同步，确认结束原运行后恢复输入，不自动重发。
     原位新建以独立草稿承接输入：旧实例结束期间可编辑但不发送，首次发送才建立新会话。
     Prompt 输入坞：处理输入法组合态、Enter 发送与 Shift+Enter 换行、焦点回归与重复提交、响应侧栏「新建」的聚焦请求并给出一次性提示，并在 Agent 运行期间原位提供停止入口；在 Agent 运行与流式响应期间草稿文本、图片附件与标注编辑保持可用，点击发送时才校验会话空闲；同时承接 Extension 的 set_editor_text 填充文本、图片附件的选择/文本框与活动视窗全局快捷粘贴（兼容系统截图提取）/拖拽入口、输入行按内容自动增高、＋ 菜单内的常用消息（短语取自界面偏好，可在设置里增删改与排序，点击即发送）、Pi 命令的斜杠模糊补全（Runtime 就绪后用运行中的命令清单，未就绪时用主进程预读的技能清单，按类型分组并按匹配优先级排序；另含 Desktop 层自己拦截的界面命令）与 `@` 项目文件引用（只写入相对路径文本，不传文件内容）；右侧文件树的行拖入坞内也走同一条相对路径引用规则。输入坞是单行结构：左侧 ＋ 菜单集中放置图片附件、模型选择、执行模式、专家与常用消息（菜单本身自上而下分五段，仅常用消息区内部滚动；执行模式两档互斥，专家一个会话只选一个、段内只占一行，点开二级列表再选具体专家，两者都只在新建会话时可选，已开始的会话只显示当前值不可改），中间是输入行，右侧是发送/停止键；坞上方是待办清单面板（仅标准模式提交清单后出现）、一行延续判定结论（宿主给出结论时才渲染）与一行专家失效提示（绑定的定义已不在清单里时才渲染）；坞下方一行是水平居中的信息行：异常与进行中的状态文本、被收起的 Extension 对话入口与会话用量指标（缓存命中率、上下文占用与平均速率，点击开明细；累计 token 与费用只在明细浮层展示）。Extension 的 setStatus 项不在输入区展示。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { PROJECT_FILE_QUERY_MAX_CHARS } from '../../../../shared/project-file-api'
import { cloneImageAnnotations, imageAnnotationError } from '../../../../shared/image-annotation'
import type { ImageAnnotationDocument } from '../../../../shared/image-annotation'
import { PROMPT_IMAGE_MAX_COUNT } from '../../../../shared/runtime-api'
import type { OutputRate, PiResourceEntry, PiResourceKind, PromptDisposition, PromptImageInput } from '../../../../shared/runtime-api'
import type { ExecutionMode } from '../../../../shared/preferences-api'
import type { SessionExpertView } from '../../../../shared/session-api'
import { useExtensionUiStore } from '../stores/extension-ui'
import { usePreferencesStore } from '../../preferences/stores/preferences'
import { useProjectFileStore } from '../../editor/stores/project-file'
import { useResourceStore } from '../../resources/stores/resource'
import { useProjectStore } from '../../projects/stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { isSavedInputKey, useSessionViewStore } from '../stores/session-view'
import type { PendingImage, SessionInput } from '../stores/session-view'
import { useWorkspaceTabsStore } from '../../workspace/stores/workspace-tabs'
import { parseDialogTitle } from '../extension-dialog-presentation'
import { cacheHitRate, formatTokens } from '../usage-format'
import AppButton from '../../ui/AppButton.vue'
import AppSelect from '../../ui/AppSelect.vue'
import ConfirmDialog from '../../ui/ConfirmDialog.vue'
import RuntimeModelSelect from '../../providers/components/RuntimeModelSelect.vue'
import UsageDetailDialog from './UsageDetailDialog.vue'
import PromptImageMaterials from './PromptImageMaterials.vue'
import TodoPanel from './TodoPanel.vue'
import { hasProjectEntryDragData, projectEntryReferenceText, readProjectEntryDragData } from '../../ui/project-entry-drag'

const runtimeStore = useRuntimeStore()
const extensionStore = useExtensionUiStore()
const projectStore = useProjectStore()
const resourceStore = useResourceStore()
const sessionStore = useSessionStore()
const preferencesStore = usePreferencesStore()
const sessionViewStore = useSessionViewStore()
const workspaceTabsStore = useWorkspaceTabsStore()
const { view: runtimeView, promptView, abortView, compactView, projectionSync, capabilitiesView, modelSwitchView,
  preparingPrompt, rewindView } = storeToRefs(runtimeStore)
const { editorText, editorTextVersion } = storeToRefs(extensionStore)

/** 侧栏新建入口的聚焦请求；父组件只传自增计数，不代表 SDK 已启动。 */
const props = defineProps<{ readonly focusToken: number; readonly active: boolean }>()

const draft = ref('')
/** 首次提交固定一份待发送输入；就绪后只补发该快照，后续编辑属于新草稿。 */
const startupRequested = ref(false)
let startupPromptId: number | null = null
let mounted = true
let startupProjectPath: string | null = null
let startupTabKey: string | null = null
const submitting = ref(false)
const pendingRecoveryId = ref<number | null>(null)
const pendingSyncPrompt = computed(() => {
  const pending = sessionViewStore.pendingPrompt
  return props.active && pending !== null && (pending.phase === 'accepted' || pending.phase === 'unconfirmed')
    ? pending : null
})
// 确认只属于弹出时的项目、标签与消息；切走后不能用旧确认结束别的会话。
watch(() => [workspaceTabsStore.activeTab, projectStore.currentProject?.path, props.active,
  sessionViewStore.pendingPrompt?.id] as const, () => { pendingRecoveryId.value = null })
/** 输入法组合态：此期间的 Enter 只确认候选词，不能当发送。 */
const composing = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)
/** 新建入口聚焦后的一次性提示：尚未绑定时，发送才准备执行会话。 */
const newSessionHint = ref(false)
let newSessionHintTimer: ReturnType<typeof setTimeout> | null = null
/** 界面命令无法执行时的一次性说明；文案由命令与原因决定，用户据此知道该等还是该重试。 */
const commandHint = ref<string | null>(null)
let commandHintTimer: ReturnType<typeof setTimeout> | null = null

function showCommandHint(text: string): void {
  commandHint.value = text
  if (commandHintTimer !== null) clearTimeout(commandHintTimer)
  commandHintTimer = setTimeout(() => {
    commandHint.value = null
    commandHintTimer = null
  }, 4_000)
}

/** 未就绪：压缩需要已有会话上下文，不是「发送后自动补发」的输入。 */
const COMPACT_HINT_UNBOUND = '压缩需要已有会话上下文；先发送一条消息启动 Pi，再使用 /compact。'
/** 请求没发出：命令仍在输入框里，会话空闲且消息同步后可以原样重试。 */
const COMPACT_HINT_BLOCKED = '当前会话不空闲或消息尚未同步，压缩未发起；等本轮结束后重试。'
/** `/new` 落在本来就是空的对话上：没有可结束的实例，也没有可重建的会话。 */
const NEW_CHAT_HINT_ALREADY = '当前已经是新对话。'
/** 生命周期动作尚未收敛时不执行新的原位替换，避免改变仍在处理的目标。 */
const NEW_CHAT_HINT_BUSY = '正在处理会话操作，稍后再新建。'

/** 聚焦请求只作用于当前活动对话，不改变会话启动策略。 */
watch(() => props.focusToken, () => {
  if (!props.active) return
  textarea.value?.focus()
  newSessionHint.value = true
  if (newSessionHintTimer !== null) clearTimeout(newSessionHintTimer)
  newSessionHintTimer = setTimeout(() => {
    newSessionHint.value = false
    newSessionHintTimer = null
  }, 4_000)
})

/** 待发送的图片附件；预览地址的创建与释放都经会话状态，见 sessions/stores/session-view.ts。 */
const pendingImages = ref<PendingImage[]>([])
const imageMaterials = ref<InstanceType<typeof PromptImageMaterials> | null>(null)
const incompleteImageAnnotations = computed(() => pendingImages.value.some(image => imageAnnotationError(image.annotations) !== null))

/**
 * 草稿与附件按会话或原位新建的输入身份保存，旧实例收尾不改变新草稿归属。
 * 启动期间保留后续编辑的草稿；本次提交由按标签固定的待发送快照承接，不从草稿重新取值。
 * 未提交的普通空闲与未绑定草稿仍不单独留底。
 */
function applySessionInput(nextKey: string, previousKey: string | null): void {
  if (startupRequested.value) return
  if (previousKey !== null && isSavedInputKey(previousKey)) {
    sessionViewStore.saveInput(previousKey, { draft: draft.value, images: pendingImages.value })
  }
  const restored = sessionViewStore.takeInput(nextKey)
  if (restored !== null) {
    // 没有归属的空闲附件不会进入留底，替换时由当前输入框释放。
    if (previousKey === null || !isSavedInputKey(previousKey)) sessionViewStore.releaseImages(pendingImages.value)
    draft.value = restored.draft
    pendingImages.value = restored.images
    return
  }
  // 会话与独立新草稿之间必须隔离；普通空闲与未绑定状态之间仍原样带走输入。
  if (previousKey !== null && isSavedInputKey(previousKey)) {
    draft.value = ''
    pendingImages.value = []
  }
}

/** 输入身份变化时切换草稿与附件归属，原位新草稿独立于旧执行会话。 */
watch(() => sessionViewStore.key, (next, previous) => applySessionInput(next, previous ?? null), { flush: 'pre' })

/** 回退交回的输入无法填入时的一次性说明；不常驻信息行。 */
const refillHint = ref<string | null>(null)
let refillHintTimer: ReturnType<typeof setTimeout> | null = null

function showRefillHint(text: string): void {
  refillHint.value = text
  if (refillHintTimer !== null) clearTimeout(refillHintTimer)
  refillHintTimer = setTimeout(() => {
    refillHint.value = null
    refillHintTimer = null
  }, 6_000)
}

/**
 * 回退与修改重试交回的输入：草稿与附件都为空时填入并聚焦，用户已输入内容时保留其输入并说明原因。
 * 交回内容来自原消息（文本与可还原的附件），用户可直接修改后发送。
 */
function applyRequestedInput(): void {
  const restored = sessionViewStore.consumeRequestedInput()
  if (restored === null) return
  if (workspaceTabsStore.isChatNewDraft) {
    // 原位新建已放弃旧会话的回填，不能把迟到的回退结果填进新草稿。
    sessionViewStore.releaseImages(restored.images)
    return
  }
  if (draft.value.trim() !== '' || pendingImages.value.length > 0) {
    // 不覆盖用户正在写的内容；交回内容里没人接管的附件预览在这里释放。
    sessionViewStore.releaseImages(restored.images)
    showRefillHint('回退已完成；输入框已有内容，原消息文本未填入。')
    return
  }
  draft.value = restored.draft
  pendingImages.value = restored.images
  textarea.value?.focus()
}

watch(() => sessionViewStore.requestedInput, applyRequestedInput)

/** 常用消息候选：与草稿内容无关，选中即用该短语发起一次提交；短语来自界面偏好，可在设置里编辑。 */
const quickSendMessages = computed(() => preferencesStore.quickSendMessages)
/** 菜单开关；菜单把图片附件、模型、执行模式与常用消息收在一处，输入行本身只留触发键与发送/停止。 */
const plusMenuOpen = ref(false)
/** 菜单外层引用：判断一次点击是否落在触发键或菜单之内。 */
const plusRoot = ref<HTMLElement | null>(null)
const plusMenu = ref<HTMLElement | null>(null)
/**
 * 模式放在 ＋ 菜单里：它不是每次发送都要动的控件，收进菜单后坞内只留 ＋、输入框与发送键。
 * 模式是会话属性，已提交过对话的会话保持原能力集，只显示当前值不再可改。
 */
const modeOptions: readonly { readonly value: ExecutionMode; readonly label: string }[] = [
  { value: 'fast', label: '快速' },
  { value: 'standard', label: '标准' }
]
const currentMode = computed(() => preferencesStore.executionMode)
/** 已有对话或正在绑定时锁定：此时改模式不会影响当前会话的能力集。 */
const modeLocked = computed(() => runtimeStore.messages.length > 0 || workspaceTabsStore.isChatBinding)
/** 专家的一行提示：先讲清为什么可能不完整，都没问题时返回 null，由调用方回退到简介。 */
function expertFlags(expert: SessionExpertView): string | null {
  const notes: string[] = []
  if (expert.unavailableSkillIds.length > 0) notes.push('部分技能不可用')
  if (expert.truncated) notes.push('正文过长已截断')
  return notes.length > 0 ? notes.join(' · ') : null
}
/** 二级列表的候选项：结构与 AppSelect 约定的选项同形，不另开一套选择器契约。 */
interface ExpertGroupOption {
  readonly value: string
  readonly label: string
  readonly description?: string | undefined
  readonly tag?: string | undefined
}
interface ExpertGroup {
  readonly label?: string
  readonly options: readonly ExpertGroupOption[]
}
/**
 * 专家二级列表：第一项固定为「不使用专家」，其上是全部专家；绑定失效时补一组，
 * 否则触发器会因找不到选中值而显示成未选，把「已经失效」误读成「从未选过」。
 */
const expertGroups = computed<readonly ExpertGroup[]>(() => {
  const groups: ExpertGroup[] = [{
    options: [{ value: '', label: '不使用专家', description: '按通用助手回答' }]
  }]
  const experts = sessionStore.expertCatalog.experts
  if (experts.length > 0) {
    groups.push({
      label: '专家',
      options: experts.map(expert => ({
        value: expert.id,
        label: expert.displayName,
        description: expertFlags(expert) ?? expert.summary,
        tag: expert.source === 'builtin' ? '内置' : '自定义'
      }))
    })
  }
  if (sessionStore.expertBindingInvalid && sessionStore.selectedExpertId !== null) {
    groups.push({
      label: '已失效',
      options: [{
        value: sessionStore.selectedExpertId,
        label: `已失效：${sessionStore.selectedExpertId}`,
        description: '定义已不存在，本会话不再注入专家角色'
      }]
    })
  }
  return groups
})
/** 二级列表回传：空串表示不使用专家，其余按标识选中。 */
function onExpertSelect(value: string): void {
  selectExpert(value === '' ? null : value)
}
/** 延续判定只展示结论与命中信号；用户可以直接在对话里纠正，界面不提供改判按钮。 */
const continuationText = computed(() => {
  const judgement = runtimeStore.activity?.continuation ?? null
  if (judgement === null) return null
  const verdict = judgement.verdict === 'continuation' ? '延续上一个任务' : '新任务'
  const signal = judgement.signal === 'wording' ? '命中措辞' : '命中上一轮改动文件'
  return `判定：${verdict}（${signal}）；判定有误直接说明。`
})
/** 常用消息的提交门禁：不满足时整组置灰，避免点了没有反应。 */
const quickSendDisabled = computed(() => (
  !canSubmit.value || sessionViewStore.pendingPrompt !== null || incompleteImageAnnotations.value
    || (pendingImages.value.length > 0 && imageSupported.value === false)
))
/** 拖拽计数：dragenter/dragleave 会在子元素间反复触发，用计数而不是布尔避免高亮抖动。 */
const dragDepth = ref(0)
const dragging = computed(() => dragDepth.value > 0)

/** 当前模型的图片输入能力；未知（null）时不限制，明确不支持时提示。 */
const imageSupported = computed(() => {
  if (workspaceTabsStore.isChatNewDraft) return null
  if (capabilitiesView.value.phase !== 'ready') return null
  const current = capabilitiesView.value.data.models.find((model) => {
    const info = runtimeInfo.value
    return info?.modelProvider === model.provider && info?.modelId === model.id
  })
  return current?.imageInput ?? null
})

const runtimeReady = computed(() => !workspaceTabsStore.isChatNewDraft && runtimeView.value.phase === 'ready')
const canStartRuntime = computed(() => (
  (workspaceTabsStore.isChatNewDraft && !workspaceTabsStore.isChatResetting && !workspaceTabsStore.isChatBinding)
  || runtimeView.value.phase === 'idle'
  || runtimeView.value.phase === 'closed'
  || runtimeView.value.phase === 'failed'
))
const runtimeInfo = computed(() => (
  runtimeReady.value && runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
const sending = computed(() => !workspaceTabsStore.isChatNewDraft && promptView.value.phase === 'sending')
const stopVisible = computed(() => (
  runtimeReady.value && (streaming.value || abortView.value.phase === 'requesting')
))
/** 就绪后仅在 Agent 空闲、投影同步且无提交、压缩或模型/会话切换时允许发送；未就绪时仅允许有项目且没有并发启动的首次启动请求。 */
const canSubmit = computed(() => {
  // 交互条件比“可见”严：内容可以先展示，向尚未确认的目标提交则不行。
  if (!props.active || !workspaceTabsStore.isChatInteractive) return false
  if (submitting.value || sessionViewStore.pendingPrompt?.phase === 'recovering'
    || sessionStore.opening || sessionStore.awaitingTrust || sessionStore.awaitingInterrupt) return false
  if (workspaceTabsStore.isChatNewDraft) return canStartRuntime.value && projectStore.currentProject !== null
  if (sending.value || preparingPrompt.value || modelSwitchView.value.phase === 'switching'
    || rewindView.value.phase === 'requesting' || compactView.value.phase === 'requesting'
    || (rewindView.value.phase === 'error' && rewindView.value.blocked)) return false
  if (runtimeReady.value) {
    return projectionSync.value === 'synced' && !streaming.value
  }
  return canStartRuntime.value && projectStore.currentProject !== null
})
/** 提交要求文本与附件至少有一项：只发图片不带文字也是合法输入；快捷发送直接用偏好里的短语，因此不看这一条。 */
const canSend = computed(() => (
  (draft.value.trim() !== '' || pendingImages.value.length > 0) && canSubmit.value
    && !incompleteImageAnnotations.value && (pendingImages.value.length === 0 || imageSupported.value !== false)
    && sessionViewStore.pendingPrompt === null
))
/**
 * 附件草稿与标注编辑的禁用条件：与发送动作（canSubmit）解耦。
 * 在 Agent 流式输出或执行工具期间仍允许用户上传、粘贴和标注图片草稿；
 * 仅在破坏性生命周期操作（回退、压缩、切换模型、正在准备提交等）或项目未就绪时禁用。
 */
const imageMaterialDisabled = computed(() => {
  if (!props.active || projectStore.currentProject === null) return true
  if (sessionViewStore.pendingPrompt?.phase === 'recovering' || preparingPrompt.value) return true
  if (modelSwitchView.value.phase === 'switching' || rewindView.value.phase === 'requesting'
    || compactView.value.phase === 'requesting' || (rewindView.value.phase === 'error' && rewindView.value.blocked)) {
    return true
  }
  return false
})

/** 图片入口（选择、粘贴、拖拽）共用同一套禁用条件：在 material 禁用的基础上加上模型支持和张数限制。 */
const attachDisabled = computed(() => (
  imageMaterialDisabled.value || imageSupported.value === false || pendingImages.value.length >= MAX_IMAGE_COUNT
))

/** 官方拒绝（上下文太小、刚压缩过、被取消）的真实原因由聊天里的压缩记录表达，只有传输级失败才占用信息行。 */
const compactErrorText = computed(() => {
  const current = compactView.value
  if (current.phase !== 'error') return null
  return current.error.code === 'RUNTIME_COMMAND_REJECTED' ? null : `压缩未完成：${current.error.message}`
})

const status = computed<{ readonly kind: 'info' | 'error'; readonly text: string } | null>(() => {
  if (pendingImages.value.length > 0 && imageSupported.value === false) {
    return { kind: 'error', text: '当前模型不支持图片，请切换支持图片的模型或移除图片资料。' }
  }
  if (workspaceTabsStore.newChatError !== null) {
    return { kind: 'error', text: `${workspaceTabsStore.newChatError} 原会话已保留，新草稿会在重试 /new 时恢复。` }
  }
  if (workspaceTabsStore.isChatResetting) {
    return { kind: 'info', text: '正在结束上一段对话；可以先编辑草稿，结束后再发送。' }
  }
  if (workspaceTabsStore.isChatNewDraft) {
    if (sessionStore.awaitingTrust) return { kind: 'info', text: '请先完成项目信任确认；新草稿会保留。' }
    if (sessionStore.awaitingInterrupt) return { kind: 'info', text: '请先处理操作确认；新草稿会保留。' }
    if (sessionStore.opening || workspaceTabsStore.isChatBinding || startupRequested.value) {
      return { kind: 'info', text: '正在准备新会话；待发送消息已固定，可以继续编辑下一条。' }
    }
    return { kind: 'info', text: commandHint.value ?? '发送后开始新会话。' }
  }
  if (rewindView.value.phase === 'requesting') return { kind: 'info', text: '正在回退对话；完成后原消息文本会回到输入框。' }
  if (rewindView.value.phase === 'error' && rewindView.value.blocked) return { kind: 'error', text: rewindView.value.error.message }
  if (preparingPrompt.value) return { kind: 'info', text: '正在读取附件并提交输入。' }
  if (abortView.value.phase === 'error') {
    return { kind: 'error', text: abortView.value.error.message }
  }
  if (compactErrorText.value !== null) {
    return { kind: 'error', text: compactErrorText.value }
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
    // 排队与已处理只表达受理分类；任务启动口令也返回 handled，不能据此断言没有执行。
    return promptView.value.disposition === 'started'
      ? null
      : { kind: 'info', text: acceptedText(promptView.value.disposition) }
  }
  if (sessionStore.awaitingInterrupt) {
    return { kind: 'info', text: '请先处理当前操作；输入会保留。' }
  }
  if (!runtimeReady.value) {
    if (commandHint.value !== null) {
      return { kind: 'info', text: commandHint.value }
    }
    if (runtimeView.value.phase === 'failed') {
      return { kind: 'error', text: `${runtimeView.value.error.message}；可再次点击发送重试启动。` }
    }
    if (runtimeView.value.phase === 'starting') {
      return { kind: 'info', text: '正在启动 Pi；待发送消息已固定，可以继续编辑下一条。' }
    }
    // 侧栏「新建」只聚焦输入框：用一次性提示说明要发送才会开始会话。
    if (newSessionHint.value && canStartRuntime.value) return { kind: 'info', text: '发送后开始新会话。' }
    // 宿主已被空闲回收（挂起）：发送会先恢复原会话，不是新建，也不是关闭中。
    if (runtimeStore.suspendedSessionId !== null) {
      return { kind: 'info', text: '会话已回收以释放资源；发送会先恢复它，历史与草稿都保留。' }
    }
    // 未选项目与首次启动属于纯引导，按钮的禁用态已经表达，不再占信息行。
    if (canStartRuntime.value || projectStore.currentProject === null) return null
    return { kind: 'info', text: 'Runtime 正在关闭；输入会保留。' }
  }
  // 压缩进行中：isStreaming 为 true（会话不空闲），但文案要说明当前在做压缩而不是普通回答。
  if (compactView.value.phase === 'requesting' || runtimeInfo.value?.isCompacting === true) {
    return { kind: 'info', text: '正在压缩上下文；需要中断时在下方停止。' }
  }
  // 命令被拦下的一次性说明：运行中不占常驻信息行，只有用户刚按过 Enter 时才解释原因。
  if (commandHint.value !== null) return { kind: 'info', text: commandHint.value }
  // 回退交回的输入没能填入时的一次性说明。
  if (refillHint.value !== null) return { kind: 'info', text: refillHint.value }
  // 跨项目拖动被拒绝时的一次性说明。
  if (dropHint.value !== null) return { kind: 'info', text: dropHint.value }
  // 运行中不再占信息行：Agent 是否在跑由右下角的停止按钮表达。
  if (projectionSync.value !== 'synced') {
    return { kind: 'info', text: '消息仍在同步，稍后才能提交输入。' }
  }
  return null
})

/** 仅说明受理结果；是否实际执行由会话运行指示和任务投影表达。 */
function acceptedText(disposition: PromptDisposition): string {
  return disposition === 'queued'
    ? 'Pi 已将本次输入排队。'
    : '本次输入已处理。'
}

/** 本会话累计用量；主进程未取到统计时为 null。 */
const usage = computed(() => runtimeInfo.value?.usage ?? null)
/** 输出速率；未结算到有效值时 average 为 null。 */
const rate = computed<OutputRate>(() => runtimeInfo.value?.rate ?? { average: null })
const usageOpen = ref(false)

/** 原位新建继续使用同一个输入框，但旧会话的浮层与文件补全请求不能跨输入身份保留。 */
watch(() => workspaceTabsStore.newChatInputKey, (key, previous) => {
  if (key === null || key === previous) return
  usageOpen.value = false
  plusMenuOpen.value = false
  cancelFileSearch()
  void nextTick(() => { if (props.active) textarea.value?.focus() })
}, { flush: 'post' })

/** 用量行的分项；`key` 稳定，供渲染复用，文案本身会随数值变化。 */
interface UsagePart {
  readonly key: string
  readonly text: string
  readonly tone: string
  readonly title: string
}

/** 用量行分项：缓存命中率、上下文占用与平均速率；未取到统计时为空。 */
const usageParts = computed<readonly UsagePart[]>(() => {
  const current = usage.value
  if (current === null) return []
  const context = current.context
  const percent = context?.percent ?? null
  const contextTone = percent === null
    ? ''
    : percent >= 90 ? 'text-desk-danger' : percent >= 70 ? 'text-desk-warning' : ''
  const hit = cacheHitRate(current)
  const parts: UsagePart[] = [
    {
      key: 'cache-hit',
      text: `缓存 ${hit === null ? '—' : `${(hit * 100).toFixed(1)}%`}`,
      // 低于 70% 说明上一段上下文被大量重算，用警示色提示；其余档位不强调。
      tone: hit !== null && hit < 0.7 ? 'text-desk-warning' : '',
      title: '缓存命中率：缓存读 /（输入 + 缓存读 + 缓存写），本会话累计'
    },
    {
      key: 'context',
      text: `上下文 ${percent === null ? '?' : `${percent.toFixed(1)}%`}/${formatTokens(context?.contextWindow ?? null)}`,
      tone: contextTone,
      title: '当前上下文占用与窗口大小'
    }
  ]
  // 速率常驻：没有结算结果时显示占位，避免指标随运行状态忽隐忽现。
  parts.push({
    key: 'rate-average',
    text: `平均 ${rate.value.average === null ? '—' : `${rate.value.average.toFixed(1)} t/s`}`,
    tone: rate.value.average === null ? '' : 'text-desk-accent',
    title: '上一轮模型调用的平均速率：按模型上报的输出 token 与生成时长计算'
  })
  return parts
})

/** 被收起的队首 Extension 对话：只在收起时占据信息行，点击恢复到弹窗。 */
const pendingDialog = computed(() => {
  if (workspaceTabsStore.isChatNewDraft) return null
  const first = extensionStore.dialogs[0] ?? null
  if (first === null || extensionStore.minimizedDialogId !== first.id) return null
  return first
})

/** 状态行的展示字段；`statusText` 为空表示当前没有需要占位的状态。 */
const statusText = computed(() => status.value?.text ?? null)
const statusRole = computed(() => (status.value?.kind === 'error' ? 'alert' : 'status'))
const statusTone = computed(() => (status.value?.kind === 'error' ? 'text-desk-danger' : 'text-desk-muted'))
/** 被收起对话的标题：只取问题正文首行，避免预览块与作答说明挤进信息行。 */
const pendingTitle = computed(() => {
  const current = pendingDialog.value
  if (current === null) return null
  const { header, question } = parseDialogTitle(current.title)
  const label = question.split('\n')[0]?.trim() ?? ''
  if (label === '') return header ?? current.title
  return header === null ? label : `[${header}] ${label}`
})

/** 与主进程一致的图片 MIME 白名单；选择器另加 accept，双保险。 */
const IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_COUNT = PROMPT_IMAGE_MAX_COUNT
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 在目标输入区就绪后原子合并；任何校验失败均不改动现有草稿。 */
function mergeBrowserAnnotation(projectPath: string, tabKey: string, identity: string, inputKey: string, text: string, file: File): string | null {
  if (!props.active || projectStore.currentProject?.path !== projectPath
    || !sessionViewStore.annotationTargetMatches(projectPath, tabKey, identity, inputKey)) return '目标对话已变化，批注未交付。'
  if (startupRequested.value || !canSubmit.value) return '目标对话暂不可编辑，请稍后重试。'
  if (imageSupported.value === false) return '当前模型不支持图片附件。'
  if (file.type !== 'image/png' || file.size > MAX_IMAGE_BYTES) return '批注截图超过图片附件大小上限（5 MiB）。'
  if (pendingImages.value.length >= MAX_IMAGE_COUNT) return `目标对话最多携带 ${MAX_IMAGE_COUNT} 张图片。`
  const entry = sessionViewStore.createImage(file)
  draft.value = [draft.value, text].filter(Boolean).join('\n\n')
  pendingImages.value = [...pendingImages.value, entry]
  return null
}
defineExpose({ mergeBrowserAnnotation })

/** 输入行自动增高的静态上限；实际上限再取窗口高度的 40%。与 .prompt-composer-input 的 max-height 保持一致。 */
const MAX_INPUT_HEIGHT = 200

/** 标注只更新所属图片资料；提示词草稿保持原样，迟到的弹层更新不能创建附件。 */
function updateImageAnnotations(objectUrl: string, annotations: ImageAnnotationDocument): void {
  if (imageMaterialDisabled.value) return
  pendingImages.value = pendingImages.value.map(image => image.objectUrl === objectUrl
    ? { ...image, annotations: cloneImageAnnotations(annotations) } : image)
}

/** 粘贴与拖拽图片：只提取白名单内的图片文件，文本粘贴仍走浏览器默认行为。 */
function pickImageFiles(files: readonly File[]): readonly File[] {
  return files.filter((file) => IMAGE_MIME_TYPES.includes(file.type))
}

/**
 * 从剪贴板提取图片文件，兼容 items 与 files 两种途径。
 * 截图软件或内存位图常存在于 DataTransferItem，且可能无明确文件名。
 */
function extractClipboardImages(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return []
  const files: File[] = []
  const items = clipboardData.items
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      // 下标受长度约束，但严格模式下仍视为可能缺失；跳过而非中途报错。
      if (item === undefined) continue
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file && IMAGE_MIME_TYPES.includes(file.type)) {
          const ext = file.type.split('/')[1] || 'png'
          const name = file.name && file.name.trim() !== '' && file.name !== 'image.png'
            ? file.name
            : `screenshot-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}.${ext}`
          const normalizedFile = file.name === name ? file : new File([file], name, { type: file.type })
          files.push(normalizedFile)
        }
      }
    }
  }
  if (files.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    const fromFiles = pickImageFiles([...clipboardData.files])
    files.push(...fromFiles)
  }
  return files
}

/** 文件选择、粘贴与拖拽的共用图片校验；浏览器批注由合并入口单独核对目标及附件限制。 */
function addImageFiles(files: readonly File[]): void {
  if (attachDisabled.value) return
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
    pendingImages.value = [...pendingImages.value, sessionViewStore.createImage(file)]
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = extractClipboardImages(event.clipboardData)
  if (files.length === 0 || attachDisabled.value) return
  // 命中图片时必须拦下默认行为，否则剪贴板里的文件名会被当文本插进草稿。
  event.preventDefault()
  addImageFiles(files)
}

/**
 * 视窗全局快捷粘贴：当当前对话激活且焦点未在其他输入控件时，捕获粘贴的图片并自动聚焦输入坞。
 */
function onGlobalPaste(event: ClipboardEvent): void {
  if (!props.active || attachDisabled.value) return
  const target = event.target
  if (target === textarea.value) return
  if (target instanceof HTMLInputElement || (target instanceof HTMLTextAreaElement && target !== textarea.value)
    || (target instanceof HTMLElement && target.isContentEditable)) {
    return
  }
  const files = extractClipboardImages(event.clipboardData)
  if (files.length === 0) return
  event.preventDefault()
  addImageFiles(files)
  textarea.value?.focus()
}

/** 数据里带文件才认作附件拖拽，普通文本拖拽仍交给浏览器处理。 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return types !== undefined && types.includes('Files')
}

/**
 * 文件树拖入的落点状态：与图片拖拽分开，因为两条路径的合法性条件不同——
 * 条目拖入只写路径文本，不读文件内容，因此不受图片类型、条数与大小限制。
 */
const entryDragging = ref(false)
/** 跨项目拖动被拒绝时的一次性说明；与状态行共用位置，不常驻。 */
const dropHint = ref<string | null>(null)
let dropHintTimer: ReturnType<typeof setTimeout> | null = null

function showDropHint(text: string): void {
  dropHint.value = text
  if (dropHintTimer !== null) clearTimeout(dropHintTimer)
  dropHintTimer = setTimeout(() => {
    dropHint.value = null
    dropHintTimer = null
  }, 4_000)
}

function onDragEnter(event: DragEvent): void {
  // 右侧文件树的行拖入：与图片拖拽共用同一块高亮，但落点只插入相对路径文本。
  if (hasProjectEntryDragData(event)) {
    event.preventDefault()
    entryDragging.value = true
    return
  }
  if (!carriesFiles(event) || attachDisabled.value) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (hasProjectEntryDragData(event)) {
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    return
  }
  if (!carriesFiles(event) || attachDisabled.value) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (!entryDragging.value) return
  // 在坞内的子元素之间移动也会触发 dragleave，因此只在真正离开坞时收起高亮。
  const next = event.relatedTarget
  if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return
  entryDragging.value = false
}

function onDrop(event: DragEvent): void {
  if (hasProjectEntryDragData(event)) {
    event.preventDefault()
    entryDragging.value = false
    const payload = readProjectEntryDragData(event)
    if (payload === null) return
    // 相对引用必须属于目标对话的工作区；同一项目的不同任务也不能互相解释路径。
    if (payload.projectPath !== (projectStore.currentProject?.path ?? null) || payload.workspaceId !== workspaceTabsStore.activeWorkspace?.id) {
      showDropHint('只能插入当前对话所属工作区的文件。')
      return
    }
    insertEntryReference(payload.path)
    return
  }
  if (!carriesFiles(event)) return
  event.preventDefault()
  dragDepth.value = 0
  if (attachDisabled.value) return
  addImageFiles(pickImageFiles([...(event.dataTransfer?.files ?? [])]))
}

/** 在光标处写入相对路径并补一个空格；选中了文字时替换选区，光标停在插入文本之后。 */
function insertEntryReference(path: string): void {
  const element = textarea.value
  if (element === null) return
  const inserted = projectEntryReferenceText(path)
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? start
  draft.value = `${draft.value.slice(0, start)}${inserted}${draft.value.slice(end)}`
  element.focus()
  void nextTick(() => {
    const caret = start + inserted.length
    element.setSelectionRange(caret, caret)
    autoGrow()
  })
}

function removeImage(objectUrl: string): void {
  const target = pendingImages.value.find((entry) => entry.objectUrl === objectUrl)
  if (target === undefined) return
  sessionViewStore.releaseImages([target])
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

/** 检查运行环境是否原生支持 field-sizing（Chromium 123+ 原生支持，免除每次输入的脚本布局测量）。 */
const supportsFieldSizing = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('field-sizing', 'content')

/**
 * 输入行按内容自动增高：
 * 原生支持 field-sizing 时直接跳过脚本测量，彻底消除打字时的强制同步重排（Layout Thrashing）；
 * 降级环境仅在内容溢出或高度需缩小时测量，未到上限不出现滚动条。
 */
function autoGrow(): void {
  if (supportsFieldSizing) return
  const element = textarea.value
  if (element === null) return
  const maxHeight = Math.min(MAX_INPUT_HEIGHT, window.innerHeight * 0.4)
  if (element.scrollHeight > element.clientHeight) {
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden'
    return
  }
  element.style.height = 'auto'
  const wanted = element.scrollHeight
  element.style.height = `${Math.min(wanted, maxHeight)}px`
  element.style.overflowY = wanted > maxHeight ? 'auto' : 'hidden'
}

/** 切换只写界面偏好，不重建当前会话；锁定后菜单项置灰，不会走到这里。 */
async function selectMode(mode: ExecutionMode): Promise<void> {
  if (mode === currentMode.value) return
  await preferencesStore.saveExecutionMode(mode)
}

/** ＋ 菜单：本身不改焦点位置，鼠标点开后可直接点项；键盘用户的下方向键由触发键处理。 */
function togglePlusMenu(): void {
  if (plusMenuOpen.value) closePlusMenu()
  else {
    plusMenuOpen.value = true
    // 专家目录可能刚被改过：每次打开都重读一次，不在应用启动时就缓存住。
    void sessionStore.loadExperts()
  }
}

/**
 * 选择本会话使用的专家；`null` 表示不使用。已开始对话的会话菜单项置灰，换专家需要新会话。
 */
function selectExpert(expertId: string | null): void {
  sessionStore.selectExpert(expertId)
  closePlusMenu()
}

/** 常用消息超出可见高度时才给列表挂上下渐隐，条数少时不挂，免得首行被无意义地淡掉。 */
function refreshPlusListMask(): void {
  const list = plusMenu.value?.querySelector<HTMLElement>('.prompt-composer-plus-list')
  if (!list) return
  list.classList.toggle('can-scroll', list.scrollHeight - list.clientHeight > 2)
}

// 菜单每次展开后重算一次：常用消息条数来自界面偏好，展开前节点还不存在。
watch(plusMenuOpen, (open) => {
  if (open) void nextTick(refreshPlusListMask)
})

function closePlusMenu(restoreFocus = false): void {
  if (!plusMenuOpen.value) return
  plusMenuOpen.value = false
  if (restoreFocus) void nextTick(() => { plusRoot.value?.querySelector('button')?.focus() })
}

/** 菜单内的可操作行：跳过禁用项，打开时的落点与行间移动都按同一份顺序取。 */
function plusMenuRows(): HTMLButtonElement[] {
  return [...(plusMenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
}

/** 聚焦菜单内第 index 行；越界时收到最近的一端。 */
function focusPlusRow(index: number): void {
  const rows = plusMenuRows()
  if (rows.length === 0) return
  rows[Math.min(Math.max(index, 0), rows.length - 1)]?.focus()
}

/** 上下键在菜单各行之间移动焦点；焦点不在菜单内时落到首行或末行。 */
function movePlusRowFocus(event: KeyboardEvent): void {
  const rows = plusMenuRows()
  if (rows.length === 0) return
  event.preventDefault()
  const current = rows.findIndex((row) => row === document.activeElement)
  const step = event.key === 'ArrowDown' ? 1 : -1
  const next = current < 0
    ? (step === 1 ? 0 : rows.length - 1)
    : (current + step + rows.length) % rows.length
  rows[next]?.focus()
}

/** 触发键上的方向键是键盘用户的展开入口；回车与空格仍由按钮原生点击处理。 */
function onPlusTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && plusMenuOpen.value) {
    event.preventDefault()
    closePlusMenu(true)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  plusMenuOpen.value = true
  // 向下键从首行进入，向上键从末行进入；-1 按 focusPlusRow 的收边规则落到最后一行。
  void nextTick(() => { focusPlusRow(event.key === 'ArrowDown' ? 0 : -1) })
}

/** 菜单内的键盘：上下键在菜单各行间移动焦点，Esc 收起并把焦点还给触发键。 */
function onPlusMenuKeydown(event: KeyboardEvent): void {
  // 模型选择器自己吃掉的方向键（展开候选）不再兼作行间移动。
  if (event.defaultPrevented) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    movePlusRowFocus(event)
    return
  }
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closePlusMenu(true)
}

/**
 * 把列表里高亮的那一条带进可视范围。
 * 键盘导航只改高亮、不接管焦点，列表本身不会自己滚；条数超出容器高度后高亮项会跑出视野。
 * 行已可见时 scrollIntoView 不产生位移，因此可以每次高亮变化都调。
 */
function scrollActiveOptionIntoView(container: HTMLElement | null): void {
  void nextTick(() => {
    container?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}

/** 斜杠开头的常用消息按命令排版，与命令补全列表用等宽字体的约定一致。 */
function isCommandMessage(message: string): boolean {
  return message.trimStart().startsWith('/')
}

/** 常用消息：把短语写进草稿后走与手动发送同一条提交路径，不改发送契约；不可提交时该项在菜单里已置灰。 */
function sendQuickMessage(message: string): void {
  closePlusMenu()
  draft.value = message
  textarea.value?.focus()
  void submit()
}

/** 菜单里的图片入口与原先的 ＋ 键同一个行为：先收起菜单再打开选择器，说明仍由附件区独立标注。 */
function pickImageFromMenu(): void {
  closePlusMenu()
  imageMaterials.value?.openPicker()
}

/** 点击触发键、菜单与模型选项浮层之外的位置即收起；在文档层监听，避免遮罩挡在输入区前面。 */
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (!(target instanceof Node)) return
  if (!plusMenuOpen.value) return
  if (plusRoot.value?.contains(target) === true) return
  // 模型选择器的选项浮层 Teleport 到 body，落在它里面不算离开菜单；否则浮层会在 click 之前被卸载。
  if (target instanceof Element && target.closest('[data-app-select-popup]') !== null) return
  plusMenuOpen.value = false
}

onUnmounted(() => {
  cancelStartup(true)
  mounted = false
  cancelFileSearch()
  if (newSessionHintTimer !== null) clearTimeout(newSessionHintTimer)
  if (commandHintTimer !== null) clearTimeout(commandHintTimer)
  if (refillHintTimer !== null) clearTimeout(refillHintTimer)
  if (dropHintTimer !== null) clearTimeout(dropHintTimer)
  // 会话与原位新建的输入分别留底；其他空闲输入没有归属，卸载时释放附件。
  if (isSavedInputKey(sessionViewStore.key)) {
    sessionViewStore.saveInput(sessionViewStore.key, { draft: draft.value, images: pendingImages.value })
  } else {
    sessionViewStore.releaseImages(pendingImages.value)
  }
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('paste', onGlobalPaste)
})

/** 草稿的每一次写入都重算高度与 `@` 引用：用户输入、Extension 填充、补全写入与命令清空都经这里。 */
watch(draft, () => {
  plusMenuOpen.value = false
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

  if (event.key !== 'Enter' || event.shiftKey) return
  // Enter 始终是发送：补全只用 Tab 或点击确认，避免改变既有发送手感。
  event.preventDefault()
  void submit()
}

/**
 * 在途提交先拦住界面命令并保留草稿；无在途提交时，`/compact`、`/new` 在启动分支与普通发送门禁之前处理。
 * 命令被拦下时说明原因；未就绪的压缩只保留草稿、不启动 Runtime。
 * 其余输入点击即移交待发送展示，Runtime 未就绪时先启动，就绪后提交固定快照；失败交回输入。
 */
async function submit(): Promise<void> {
  if (submitting.value || sessionViewStore.pendingPrompt !== null) {
    if (draft.value.trim() === '/new' || draft.value === '/compact' || draft.value.startsWith('/compact ')) {
      showCommandHint('消息正在提交，稍后再执行界面命令；当前草稿已保留。')
    }
    return
  }
  // 新建对话由 Desktop 发起：在当前标签内就地替换，结束原实例并清空它的会话身份。
  // 判定用 trim：斜杠补全写入的候选带一个尾随空格，命令文本不能因此被当成普通输入发给模型。
  if (draft.value.trim() === '/new') {
    const projectPath = projectStore.currentProject?.path ?? null
    const tabKey = workspaceTabsStore.activeTab
    draft.value = ''
    // 新建不继承任何旧的自动发送意图。
    cancelStartup()
    // 新建只收敛原标签；不在旧实例结束后补开会话，首次发送时才创建执行目标。
    const { outcome } = await workspaceTabsStore.startNewChatInTab()
    if (projectPath !== (projectStore.currentProject?.path ?? null) || tabKey !== workspaceTabsStore.activeTab) return
    // 本来就空、以及打开其他会话期间都只是没替换，用一次性说明交代原因；
    // 结束原实例未确认时不在这里重复文案，顶部已有结束失败的提示条。
    if (outcome === 'already-new') showCommandHint(NEW_CHAT_HINT_ALREADY)
    if (outcome === 'busy') showCommandHint(NEW_CHAT_HINT_BUSY)
    return
  }

  // 手动压缩由 Desktop 发起：Pi 的 prompt 不解释内置斜杠命令，直接发送只会把命令文本当成用户输入。
  if (draft.value === '/compact' || draft.value.startsWith('/compact ')) {
    // 未就绪时保留草稿：压缩需要已有会话上下文，不是“发送后自动补发”的输入。
    if (!runtimeReady.value) {
      showCommandHint(COMPACT_HINT_UNBOUND)
      return
    }
    // 会话不空闲或投影未同步时请求根本不会发出：保留命令并说明原因，而不是按了 Enter 毫无反应。
    if (!canSubmit.value) {
      showCommandHint(COMPACT_HINT_BLOCKED)
      return
    }
    const instructions = draft.value.slice('/compact'.length).trim()
    const message = draft.value
    // 命令在发出时即从输入框移除：压缩含一次摘要调用，可达数十秒，期间把命令留在框里会与后续输入混在一起。
    draft.value = ''
    const outcome = await runtimeStore.compact(instructions === '' ? null : instructions)
    // 请求根本没发出（会话忙、目标已变）时把命令还回输入框，便于稍后重试；用户已输入新内容时不覆盖。
    if (outcome === 'refused' && draft.value === '') {
      draft.value = message
      showCommandHint(COMPACT_HINT_BLOCKED)
    }
    return
  }

  if (!canSend.value) return

  const projectPath = projectStore.currentProject?.path ?? null
  const tabKey = workspaceTabsStore.activeTab
  if (projectPath === null || tabKey === null) return
  const pending = sessionViewStore.beginPendingPrompt(projectPath, tabKey, sessionViewStore.key,
    { draft: draft.value, images: [...pendingImages.value] })
  if (pending === null) return
  draft.value = ''
  pendingImages.value = []

  if (!runtimeReady.value) {
    // 原位新草稿不从旧挂起身份恢复；启动完成后只补发上面固定的快照。
    startupProjectPath = projectPath
    startupTabKey = tabKey
    startupPromptId = pending.id
    startupRequested.value = true
    try {
      await sessionStore.open(workspaceTabsStore.isChatNewDraft ? null : runtimeStore.suspendedSessionId,
        false, projectPath, tabKey)
      if (startupPromptId === pending.id && sessionStore.actionError !== null) cancelStartup()
    } catch (error) {
      if (startupPromptId === pending.id) {
        cancelStartup()
        showCommandHint(error instanceof Error ? error.message : '启动失败，输入已恢复。')
      }
    }
    return
  }
  await dispatchPendingPrompt(pending.id)
}

/** 恢复时合并后续草稿；离开原标签后的迟到失败只能写回原输入身份。 */
function restorePendingPrompt(id: number): void {
  const pending = sessionViewStore.takePendingPrompt(id)
  if (pending === null) return
  if (!workspaceTabsStore.hasChatTabKey(pending.projectPath, pending.tabKey)) {
    sessionViewStore.releaseImages(pending.input.images)
    return
  }
  if (mounted && workspaceTabsStore.activeTab === pending.tabKey
    && projectStore.currentProject?.path === pending.projectPath
    && (pending.phase === 'starting' || pending.phase === 'cancelled' || sessionViewStore.key === pending.inputKey)) {
    draft.value = [pending.input.draft, draft.value].filter(Boolean).join('\n')
    pendingImages.value = [...pending.input.images, ...pendingImages.value]
  } else {
    const sessionId = workspaceTabsStore.sessionIdForTab(pending.projectPath, pending.tabKey)
    sessionViewStore.restoreInput(sessionId === null ? pending.inputKey : `session:${sessionId}`, pending.input)
  }
}

function cancelStartup(beforeInputSwitch = false): void {
  const id = startupPromptId
  startupPromptId = null
  startupRequested.value = false
  if (id === null) return
  const pending = sessionViewStore.getPendingPrompt(id)
  if (pending === null) return
  if (beforeInputSwitch) {
    // 首次绑定之前可能只有 idle/run 身份，不能把恢复内容留在公共输入框里带进另一标签。
    // 连同启动期间的新草稿一起留在原标签，回来后再交回输入；不再自动发送。
    sessionViewStore.updatePendingPrompt(id, { phase: 'cancelled', input: {
      draft: [pending.input.draft, draft.value].filter(Boolean).join('\n'),
      images: [...pending.input.images, ...pendingImages.value]
    } })
    draft.value = ''
    pendingImages.value = []
  } else restorePendingPrompt(id)
}

/** 提交固定输入，不重新读取草稿；受理结果与展示身份分开，切走后也能收敛原消息。 */
async function dispatchPendingPrompt(id: number): Promise<void> {
  const pending = sessionViewStore.pendingPrompt
  if (pending?.id !== id || runtimeView.value.phase !== 'ready') {
    restorePendingPrompt(id)
    return
  }
  if (pending.input.images.length > 0 && imageSupported.value === false) {
    restorePendingPrompt(id)
    showCommandHint('当前模型不支持图片，提示词和图片资料已保留。')
    return
  }
  const target = runtimeView.value.snapshot
  const originKey = sessionViewStore.key
  sessionViewStore.updatePendingPrompt(id, { phase: 'sending', inputKey: originKey,
    target: target.runId === null ? null : { runId: target.runId, runtimeId: target.runtimeId },
    sessionId: target.info?.sessionId ?? null,
    previousUserIds: runtimeStore.messages.filter(message => message.role === 'user').map(message => message.id) })
  submitting.value = true
  preparingPrompt.value = true
  // 在切走前记住权威消息已经到达，迟到的失败不能把已发送输入恢复成可重复发送的草稿。
  let projected = false
  const stopProjectionWatch = watch(() => {
    const current = sessionViewStore.getPendingPrompt(id)
    return current !== null && sessionViewStore.hasPendingMessage(current)
  }, present => { projected ||= present }, { immediate: true, flush: 'sync' })
  try {
    const images: PromptImageInput[] = []
    for (const entry of pending.input.images) {
      images.push({ name: entry.file.name, mimeType: entry.file.type, data: await readAsBase64(entry.file),
        ...(entry.annotations === undefined ? {} : { annotations: cloneImageAnnotations(entry.annotations) }) })
    }
    // 附件读取期间切走、关闭标签或卸载，不再发出请求，输入回到原归属。
    if (!mounted || runtimeView.value.phase !== 'ready' || runtimeView.value.snapshot.runId !== target.runId
      || runtimeView.value.snapshot.runtimeId !== target.runtimeId
      || runtimeView.value.snapshot.info?.sessionId !== target.info?.sessionId
      || sessionViewStore.key !== originKey || workspaceTabsStore.activeTab !== pending.tabKey
      || !props.active || sessionStore.opening) {
      restorePendingPrompt(id)
      return
    }
    const result = await runtimeStore.send(pending.input.draft, images)
    if (result?.ok) {
      if (result.data.disposition === 'handled' && pending.input.images.length > 0) {
        // 命令已消费提示词，但没有启动本轮；图片资料不因此被清空或成为命令参数。
        const retained = sessionViewStore.takePendingPrompt(id)
        if (retained !== null) await restoreFollowingInput(retained.projectPath, retained.tabKey,
          retained.inputKey, { draft: '', images: retained.input.images })
      } else if (result.data.disposition === 'started' && !projected) sessionViewStore.updatePendingPrompt(id, { phase: 'accepted' })
      else sessionViewStore.finishPendingPrompt(id)
    } else {
      if (projected) sessionViewStore.finishPendingPrompt(id)
      else restorePendingPrompt(id)
    }
    if (mounted && props.active && workspaceTabsStore.activeTab === pending.tabKey) textarea.value?.focus()
  } catch (error) {
    if (projected) sessionViewStore.finishPendingPrompt(id)
    else restorePendingPrompt(id)
    if (mounted && runtimeView.value.phase === 'ready' && runtimeView.value.snapshot.runId === target.runId
      && runtimeView.value.snapshot.runtimeId === target.runtimeId
      && runtimeView.value.snapshot.info?.sessionId === target.info?.sessionId) {
      promptView.value = { phase: 'error', error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : '读取图片失败；输入已恢复。' } }
    }
  } finally {
    stopProjectionWatch()
    submitting.value = false
    if (runtimeView.value.phase === 'ready' && runtimeView.value.snapshot.runId === target.runId
      && runtimeView.value.snapshot.runtimeId === target.runtimeId) preparingPrompt.value = false
  }
}

/** 恢复失败时只交回期间留底的后续草稿，不把结果未知的原输入当成未发送。 */
async function restoreFollowingInput(projectPath: string, tabKey: string, inputKey: string, input: SessionInput): Promise<void> {
  // 原位新建会改变输入身份，先让现有的输入留底 watch 完成，避免回填又被清空。
  await nextTick()
  if (!workspaceTabsStore.hasChatTabKey(projectPath, tabKey)) {
    sessionViewStore.releaseImages(input.images)
  } else if (mounted && workspaceTabsStore.activeTab === tabKey && projectStore.currentProject?.path === projectPath) {
    draft.value = [input.draft, draft.value].filter(Boolean).join('\n')
    pendingImages.value = [...input.images, ...pendingImages.value]
  } else {
    const sessionId = workspaceTabsStore.sessionIdForTab(projectPath, tabKey)
    sessionViewStore.restoreInput(sessionId === null ? inputKey : `session:${sessionId}`, input)
  }
}

/** 用户确认后先核对同步，再结束原运行；关闭未确认时不恢复原输入，更不自动重发。 */
async function confirmPendingRecovery(): Promise<void> {
  const id = pendingRecoveryId.value
  pendingRecoveryId.value = null
  if (id === null || !mounted || !props.active || submitting.value || sessionStore.opening) return
  const selected = sessionViewStore.pendingPrompt
  if (selected?.id !== id || selected.phase !== 'unconfirmed' || selected.checking) return
  await sessionViewStore.checkPendingPrompt(id)
  const pending = sessionViewStore.getPendingPrompt(id)
  if (pending === null || pending.phase !== 'unconfirmed' || pending.checking || pending.target === null
    || !mounted || !props.active || sessionStore.opening || workspaceTabsStore.activeTab !== pending.tabKey
    || projectStore.currentProject?.path !== pending.projectPath) return

  const following: SessionInput = { draft: draft.value, images: [...pendingImages.value] }
  const originKey = sessionViewStore.key
  draft.value = ''
  pendingImages.value = []
  sessionViewStore.updatePendingPrompt(id, { phase: 'recovering', notice: null })
  let followingOwned = true
  const returnFollowing = async (): Promise<void> => {
    if (!followingOwned) return
    followingOwned = false
    await restoreFollowingInput(pending.projectPath, pending.tabKey, originKey, following)
  }
  // 结束动作会清空旧投影；同步记住关闭期间到达的正式消息，不能据清空后的视图恢复同一输入。
  const stopProjectionWatch = watch(() => {
    const current = sessionViewStore.getPendingPrompt(id)
    return current !== null && sessionViewStore.hasPendingMessage(current)
  }, present => {
    const current = sessionViewStore.getPendingPrompt(id)
    if (present && current !== null && !current.projected) sessionViewStore.updatePendingPrompt(id, { projected: true })
  }, { immediate: true, flush: 'sync' })
  try {
    if (sessionViewStore.hasPendingMessage(sessionViewStore.getPendingPrompt(id) ?? pending)) {
      sessionViewStore.finishPendingPrompt(id)
      await returnFollowing()
      return
    }
    const { outcome } = await workspaceTabsStore.startNewChatInTab({
      projectPath: pending.projectPath, tabKey: pending.tabKey, runId: pending.target.runId,
      runtimeId: pending.target.runtimeId, sessionId: pending.sessionId
    })
    const current = sessionViewStore.getPendingPrompt(id)
    if (current === null) {
      sessionViewStore.releaseImages(following.images)
      followingOwned = false
      return
    }
    if (outcome === 'started' || outcome === 'already-new') {
      const projected = sessionViewStore.hasPendingMessage(current)
      if (projected) sessionViewStore.releaseImages(current.input.images)
      followingOwned = false
      sessionViewStore.updatePendingPrompt(id, { phase: 'cancelled', checking: false, projected: false,
        input: projected ? following : {
          draft: [current.input.draft, following.draft].filter(Boolean).join('\n'),
          images: [...current.input.images, ...following.images]
        } })
      // 复用按原标签恢复的通道；切走或卸载时保留到下次进入，不跨标签回填。
      return
    }
    await returnFollowing()
    const remaining = sessionViewStore.getPendingPrompt(id)
    if (remaining !== null) {
      if (sessionViewStore.hasPendingMessage(remaining)) sessionViewStore.finishPendingPrompt(id)
      else sessionViewStore.updatePendingPrompt(id, { phase: 'unconfirmed', notice: outcome === 'refused'
        ? '结束原运行未确认；原输入已保留，未自动重发。'
        : '原目标已变化或正在处理会话操作；原输入已保留，请重新核对。' })
    }
  } catch (error) {
    await returnFollowing()
    const remaining = sessionViewStore.getPendingPrompt(id)
    if (remaining !== null) {
      if (sessionViewStore.hasPendingMessage(remaining)) sessionViewStore.finishPendingPrompt(id)
      else sessionViewStore.updatePendingPrompt(id, { phase: 'unconfirmed',
        notice: `恢复输入未完成：${error instanceof Error ? error.message : String(error)}；原输入已保留。` })
    }
  } finally {
    stopProjectionWatch()
  }
}

function stop(): void {
  void runtimeStore.stopOperation()
}

/** 全部发送条件满足才消费首次提交意图；若草稿挑选了临时模型，首次发送前先切换为目标模型再提交，并清空草稿记录；不能在会话还处于 opening 时提前丢弃。 */
watch(
  () => startupRequested.value && runtimeReady.value && projectionSync.value === 'synced'
    && !sessionStore.opening && !sessionStore.awaitingTrust && !sessionStore.awaitingInterrupt
    && props.active && workspaceTabsStore.activeTab === startupTabKey
    && canSubmit.value,
  async (pending) => {
    if (!pending || startupPromptId === null) return
    const id = startupPromptId
    startupPromptId = null
    startupRequested.value = false
    const pendingPrompt = sessionViewStore.getPendingPrompt(id)
    const draftModel = pendingPrompt ? sessionViewStore.getDraftModel(pendingPrompt.inputKey) : null
    if (draftModel !== null) {
      const info = runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
      if (info && (info.modelProvider !== draftModel.provider || info.modelId !== draftModel.modelId)) {
        await runtimeStore.switchModel(draftModel.provider, draftModel.modelId)
      }
      if (pendingPrompt) sessionViewStore.clearDraftModel(pendingPrompt.inputKey)
    }
    void dispatchPendingPrompt(id)
  }
)

/** 换项目、启动失败或取消信任确认时作废自动发送意图，不让它泄漏到其他会话。 */
watch(() => [projectStore.currentProject?.path ?? null, workspaceTabsStore.activeTab] as const, ([path, key]) => {
  if (path !== startupProjectPath || key !== startupTabKey) cancelStartup(true)
}, { flush: 'sync' })
watch(() => runtimeView.value.phase, (phase) => {
  // 新草稿不接受旧实例的关闭状态；新会话启动失败由打开请求的实际结果收敛。
  if (workspaceTabsStore.isChatNewDraft) return
  if (phase === 'failed' || phase === 'closed' || phase === 'stopping') cancelStartup()
})
watch(() => sessionStore.awaitingTrust || sessionStore.awaitingInterrupt, (awaiting, previous) => {
  if (previous && !awaiting && !sessionStore.opening && !runtimeReady.value) cancelStartup()
})

/** 启动取消或显式恢复后的快照只交回原标签，合并后续草稿，不自动发送。 */
watch(() => sessionViewStore.pendingPrompt, pending => {
  if (pending?.phase === 'cancelled') restorePendingPrompt(pending.id)
}, { flush: 'post' })

/** Extension 填充文本到达时写入：只在用户未输入时覆盖，否则保留用户内容并提示。 */
watch(editorTextVersion, () => {
  const text = editorText.value
  if (text === null) return
  extensionStore.markEditorTextConsumed()
  if (workspaceTabsStore.isChatNewDraft) return
  if (draft.value.trim() === '') {
    draft.value = text
    textarea.value?.focus()
  }
})

/**
 * 补全候选：Pi 资源，或 Desktop 层自己拦截的界面命令。
 * 界面命令不在宿主资源清单里（那三类只对应扩展命令、模板与技能），因此由页面本地提供。
 */
type ComposerSuggestionKind = PiResourceKind | 'desktop'

interface DesktopCommandEntry {
  readonly kind: 'desktop'
  readonly name: string
  readonly description: string
}

type ComposerSuggestion = PiResourceEntry | DesktopCommandEntry

/** Desktop 层拦截的命令：`/compact` 走手动压缩，`/new` 在当前标签内就地新建对话；恢复已回收的会话由侧栏打开会话，或在发送时自动恢复。 */
const DESKTOP_COMMANDS: readonly DesktopCommandEntry[] = [
  { kind: 'desktop', name: 'compact', description: '压缩当前会话上下文（可跟摘要说明）' },
  { kind: 'desktop', name: 'new', description: '新建对话（结束当前对话）' }
]

/** 分组顺序与标题：界面命令置前，其次是技能，保证输入 `/` 时本应用支持的入口一定在候选里。 */
const SUGGESTION_GROUPS: readonly { readonly kind: ComposerSuggestionKind; readonly label: string }[] = [
  { kind: 'desktop', label: '界面命令' },
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
const commandList = ref<HTMLElement | null>(null)

/** 候选分组：`index` 是该条在扁平列表中的位置，键盘导航与选中态都按它对应。 */
interface SuggestionGroup {
  readonly kind: ComposerSuggestionKind
  readonly label: string
  readonly items: readonly { readonly entry: ComposerSuggestion; readonly index: number }[]
}

/** 名称完全匹配 > 前缀 > 包含 > 按顺序的非连续字符 > 描述包含；显式 `skill:` 只搜索技能。 */
function commandMatchRank(entry: ComposerSuggestion, query: string): number | null {
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
 * 候选来源：界面命令始终在列；其余在 Runtime 就绪时用当前会话已加载的资源，未就绪时用主进程一次性预读的技能清单。
 * 两份数据不合并、不去重：就绪后预读结果立即作废，运行中的清单是唯一权威。
 */
const candidateEntries = computed<readonly ComposerSuggestion[]>(() => [
  ...DESKTOP_COMMANDS,
  ...(runtimeReady.value ? resourceStore.entries : resourceStore.previewSkills)
])

/** 按类型分组后，各组先按匹配优先级排序再限量，同级保持资源清单的原始顺序。 */
const matchedGroups = computed<readonly SuggestionGroup[]>(() => {
  const query = slashQuery.value
  if (query === null) return []

  const groups: SuggestionGroup[] = []
  let index = 0
  for (const group of SUGGESTION_GROUPS) {
    const ranked: { entry: ComposerSuggestion; rank: number }[] = []
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
const matchedSuggestions = computed<readonly ComposerSuggestion[]>(() => (
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
function acceptSuggestion(entry: ComposerSuggestion | undefined): void {
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
const fileList = ref<HTMLElement | null>(null)

// 两个列表各自在键盘移动时跟随滚动；条数超限时高亮项不会被留在视野之外。
watch(suggestionIndex, () => scrollActiveOptionIntoView(commandList.value))
watch(fileActiveIndex, () => scrollActiveOptionIntoView(fileList.value))
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

  // 与文件树拖入共用同一条路径引用规则：含空白的路径加双引号，末尾补一个空格。
  const inserted = projectEntryReferenceText(path)
  const caret = element.selectionStart ?? element.value.length
  draft.value = `${draft.value.slice(0, token.start)}${inserted}${draft.value.slice(caret)}`
  fileToken.value = null
  filesDismissed.value = false
  cancelFileSearch()
  element.focus()

  void nextTick(() => {
    const next = token.start + inserted.length
    element.setSelectionRange(next, next)
    autoGrow()
  })
}

onMounted(() => {
  // 视图重建时取回当前输入身份的留底，也能通过实际绑定身份取回原位新草稿。
  const restored = sessionViewStore.takeInput(sessionViewStore.key)
  if (restored !== null) {
    draft.value = restored.draft
    pendingImages.value = restored.images
  }
  const pending = sessionViewStore.pendingPrompt
  if (pending?.phase === 'cancelled') restorePendingPrompt(pending.id)
  if (props.active) textarea.value?.focus()
  autoGrow()
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('paste', onGlobalPaste)
})
</script>

<template>
  <!-- 与消息区同色，输入坞靠描边与阴影浮起；不再用顶部分隔线切开两块。上下内距与消息列底部留白同节奏。 -->
  <section class="bg-desk-canvas-sunken px-4 pt-3 pb-4 sm:px-6">
    <div class="chat-column mx-auto">
      <div v-if="pendingSyncPrompt !== null" class="mb-2 flex flex-wrap items-center gap-2">
        <p v-if="pendingSyncPrompt.phase === 'unconfirmed'" class="text-xs text-desk-muted" role="status">提交结果未确认，文字和附件已保留。</p>
        <AppButton variant="compact" :disabled="pendingSyncPrompt.checking || submitting || sessionStore.opening"
          @click="sessionViewStore.checkPendingPrompt(pendingSyncPrompt.id)">
          {{ pendingSyncPrompt.checking ? '正在核对…' : '重新同步' }}
        </AppButton>
        <AppButton v-if="pendingSyncPrompt.phase === 'unconfirmed'" variant="compact"
          :disabled="pendingSyncPrompt.checking || submitting || sessionStore.opening"
          @click="pendingRecoveryId = pendingSyncPrompt.id">
          结束原运行并恢复输入
        </AppButton>
      </div>
      <label for="prompt-input" class="sr-only">输入要发送给 Pi 的提示词</label>
      <div
        class="prompt-composer-shell"
        :class="dragging || entryDragging ? 'is-dragging' : ''"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- 命令补全：候选在 Runtime 就绪时来自运行中的命令清单、未就绪时来自主进程预读的技能清单，按类型分组展示；Enter 仍然是发送，Tab 或点击接受候选。 -->
        <ul
          v-if="visibleSuggestionGroups.length > 0"
          id="prompt-command-list"
          ref="commandList"
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
                <span class="block min-w-0 truncate font-mono text-xs">/{{ item.entry.name }}</span>
                <span v-if="item.entry.description !== null" class="prompt-composer-option-detail">{{ item.entry.description }}</span>
              </AppButton>
            </li>
          </template>
        </ul>

        <!-- 文件引用补全：候选是当前项目的相对路径，Enter 与 Tab 都接受候选，插入的只是路径文本，不读取文件内容。 -->
        <ul
          v-if="visibleFileEntries.length > 0"
          id="prompt-file-list"
          ref="fileList"
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

        <!-- 图片附件行：位于坞内输入框上方，支持点击图片弹出独立标注，无附件时不占位。 -->
        <PromptImageMaterials
          ref="imageMaterials"
          :images="pendingImages"
          :input-key="sessionViewStore.key"
          :active="props.active"
          :disabled="imageMaterialDisabled"
          :attach-disabled="attachDisabled"
          @add="addImageFiles"
          @remove="removeImage"
          @change="updateImageAnnotations"
        />

        <!-- 待办清单：标准模式提交后贴在输入坞上方；快速模式没有这个工具，永远不会出现。 -->
        <TodoPanel :todos="runtimeStore.activity?.todos ?? null" />

        <!-- 延续判定：宿主本轮算出的结论，只用于让用户发现误判；没有结论时不占位。 -->
        <p v-if="continuationText !== null" class="prompt-continuation" role="status">{{ continuationText }}</p>

        <!-- 专家失效：选中的定义已不在清单里。只如实说明，不自动清绑定——重建同名专家即可恢复。 -->
        <p v-if="sessionStore.expertBindingInvalid" class="prompt-expert-stale" role="status">
          专家「{{ sessionStore.selectedExpertId }}」的定义已不存在，本会话不再注入专家角色；换专家需新建会话。
        </p>

        <!-- 输入行：左侧 ＋ 菜单、中间输入框、右侧发送/停止，三者在底边对齐，多行时按钮跟随下沿。 -->
        <div class="prompt-composer-row">
          <div ref="plusRoot" class="prompt-composer-plus">
            <AppButton
              variant="icon"
              class="prompt-composer-char"
              :class="{ 'is-open': plusMenuOpen }"
              :aria-expanded="plusMenuOpen"
              aria-controls="prompt-plus-menu"
              aria-label="输入选项"
              title="输入选项（添加图片、模型、常用消息）"
              @click="togglePlusMenu"
              @keydown="onPlusTriggerKeydown"
            >
              ＋
            </AppButton>
            <!-- 进场从触发键所在的左下角生长，五段依次落位；退场交给同名 leave 过渡，比进场更快。
                 菜单是单列五段：图片、模型、执行模式、专家与常用消息自上而下排列，只有常用消息区内部滚动。 -->
            <Transition name="plus-menu-motion">
              <div
                v-if="plusMenuOpen"
                id="prompt-plus-menu"
                ref="plusMenu"
                class="dialog-popover prompt-composer-plus-menu"
                role="group"
                aria-label="输入选项"
                @keydown="onPlusMenuKeydown"
              >
                <div class="prompt-composer-plus-section">
                  <p class="prompt-composer-plus-section-title">图片</p>
                  <!-- 触发图片附件选择；图片说明由附件区独立标注，不进入提示词。 -->
                  <AppButton
                    variant="unstyled"
                    class="prompt-composer-plus-row"
                    :disabled="attachDisabled"
                    @click="pickImageFromMenu"
                  >
                    <span>添加图片</span>
                    <span class="prompt-composer-plus-row-note">也可粘贴或拖入</span>
                  </AppButton>
                </div>
                <div class="prompt-composer-plus-section">
                  <p class="prompt-composer-plus-section-title">模型</p>
                  <!-- 未绑定或原位新草稿选择草稿模型；实际绑定后才切当前会话模型，另设全局默认走次级动作。 -->
                  <RuntimeModelSelect
                    variant="menu"
                    :new-conversation="workspaceTabsStore.isChatNewDraft"
                    :resetting="workspaceTabsStore.isChatResetting || workspaceTabsStore.isChatBinding"
                  />
                </div>
                <div class="prompt-composer-plus-section">
                  <p class="prompt-composer-plus-section-title">执行模式</p>
                  <!-- 两档互斥；已开始对话的会话保持原能力集，只显示当前值。 -->
                  <AppButton
                    v-for="option in modeOptions"
                    :key="option.value"
                    variant="unstyled"
                    class="prompt-composer-plus-row"
                    :class="currentMode === option.value ? 'is-selected' : ''"
                    :aria-pressed="currentMode === option.value"
                    :disabled="modeLocked"
                    :title="modeLocked ? '本会话已开始，模式只在新建会话时生效' : undefined"
                    @click="selectMode(option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <span class="prompt-composer-plus-row-note">{{ option.value === 'fast' ? '不注入记忆，需求确认后给清单' : '读记忆，需求确认后先给方案' }}</span>
                  </AppButton>
                </div>
                <div class="prompt-composer-plus-section">
                  <p class="prompt-composer-plus-section-title">专家</p>
                  <!-- 一个会话只用一个专家：开始对话后锁定，换专家需要新会话。
                       一级行只显示当前选择，点开才是二级列表，专家再多也不撑高菜单。 -->
                  <AppSelect
                    id="prompt-expert"
                    class="prompt-expert-row"
                    label="专家"
                    :groups="expertGroups"
                    :model-value="sessionStore.selectedExpertId ?? ''"
                    empty-label="不使用专家"
                    :disabled="modeLocked"
                    @update:model-value="onExpertSelect"
                  />
                  <!-- 失效绑定：定义被删或改名后仍被会话持有，只能新会话换专家，所以这里只说明不提供改绑。 -->
                  <p v-if="sessionStore.expertBindingInvalid" class="prompt-composer-plus-row-note">
                    已失效：{{ sessionStore.selectedExpertId }}（定义已不存在，本会话不再注入专家角色）
                  </p>
                  <p v-if="sessionStore.expertError !== null" class="prompt-composer-plus-row-note">
                    {{ sessionStore.expertError.message }}
                  </p>
                </div>
                <div class="prompt-composer-plus-section is-grow">
                  <p class="prompt-composer-plus-section-title">常用消息</p>
                  <!-- 消息多时只有本区滚动，顶部两段留在原位；滚动时重算上下渐隐。 -->
                  <div class="prompt-composer-plus-list scroll-area" @scroll.passive="refreshPlusListMask">
                    <AppButton
                      v-for="(message, index) in quickSendMessages"
                      :key="`${message}-${index}`"
                      variant="unstyled"
                      class="prompt-composer-plus-row"
                      :class="isCommandMessage(message) ? 'is-command' : ''"
                      :disabled="quickSendDisabled"
                      :title="message"
                      @click="sendQuickMessage(message)"
                    >
                      <span class="min-w-0 truncate">{{ message }}</span>
                    </AppButton>
                    <p v-if="quickSendMessages.length === 0" class="prompt-composer-plus-row-note px-2 py-1">尚未配置常用消息，可在设置里添加。</p>
                  </div>
                </div>
              </div>
            </Transition>
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
            :aria-describedby="statusText !== null ? 'prompt-status' : undefined"
            aria-autocomplete="list"
            :aria-controls="activeListId"
            :aria-expanded="activeListOpen"
            @keydown="onKeydown"
            @click="refreshFileToken"
            @paste="onPaste"
            @compositionstart="composing = true"
            @compositionend="composing = false"
          ></textarea>

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

      <!-- 信息行在输入坞之外、同一列宽内：状态、被收起的插件请求与会话用量，不挤占输入行。 -->
      <div class="prompt-composer-meta">
        <!-- 状态文本只在异常与进行中出现；正常态让位给用量指标。 -->
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
        <!-- 会话用量指标：点击开明细浮层；统计未取到时显示占位。Extension 的 setStatus 项不在输入区展示。 -->
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
              :key="part.key"
              class="prompt-metric"
              :class="part.tone"
              :title="part.title"
            >{{ part.text }}</span>
          </template>
          <span v-else class="prompt-metric">用量 —</span>
        </button>
      </div>
    </div>

    <!-- 用量明细与其它弹层一致：Teleport 到 body，不受输入坞的层叠上下文限制。 -->
    <Teleport to="body">
      <ConfirmDialog
        :open="props.active && pendingRecoveryId !== null"
        title="结束原运行并恢复输入？"
        description="只结束这条消息所属的运行，保留会话历史；结束成功后恢复文字和附件，并保留后续草稿。"
        detail="当前提交结果未确认。会先重新核对消息同步；已观察到正式消息时不重复恢复原输入，恢复后也不会自动发送。"
        confirm-label="结束并恢复输入"
        @confirm="confirmPendingRecovery"
        @cancel="pendingRecoveryId = null"
      />
      <UsageDetailDialog
        :open="usageOpen"
        :usage="usage"
        :rate="rate"
        @close="usageOpen = false"
      />
    </Teleport>
  </section>
</template>
