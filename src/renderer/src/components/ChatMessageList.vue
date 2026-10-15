<!-- 消息区：按投影渲染、粘底与大纲导航；承接用户消息回退确认与修改提交，回退会新建会话（列表折叠为一条），项目文件不回退。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createChatViewCache } from '../chat-view'
import type { ChatMessageView } from '../chat-view'
import type { RuntimeRewindRequest } from '../../../shared/runtime-api'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import { isSessionKey, useSessionViewStore } from '../stores/session-view'
import type { SessionReading } from '../stores/session-view'
import ChatMessageItem from './ChatMessageItem.vue'
import ChatOutline from './ChatOutline.vue'
import AppButton from './ui/AppButton.vue'
import ConfirmDialog from './ConfirmDialog.vue'

/** 距底部多少像素内仍视为"停在底部"，避免流式更新时与用户上滚互相争夺。 */
const STICK_THRESHOLD_PX = 24
/** 大纲预留整个展开区域，而非只判断刻度是否放得下，避免浮层盖住正文。 */
const OUTLINE_MIN_WIDTH_PX = 160
const OUTLINE_MAX_WIDTH_PX = 200
const OUTLINE_GAP_PX = 8
const OUTLINE_EDGE_PX = 8
const OUTLINE_MIN_HEIGHT_PX = 128
const OUTLINE_SUMMARY_CHARS = 160
const READING_OFFSET_PX = 20

const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const sessionViewStore = useSessionViewStore()
const { view: runtimeView, messages, tools, projectionSync, projectionTruncated, droppedMessages, droppedTools,
  promptView, preparingPrompt, modelSwitchView, rewindView } = storeToRefs(runtimeStore)
/** 会话视图的稳定键：宿主被回收（挂起）时仍指向同一会话，消息组件不重建。 */
const conversationKey = computed(() => runtimeStore.conversationKey)

const viewport = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
const activeOutlineId = ref<string | null>(null)
const outlineLayout = ref<{ left: number; width: number } | null>(null)
/** 大纲跳转保持阅读位置，不被程序滚动或内容收缩产生的 scroll 事件重新开启粘底。 */
let outlineTargetId: string | null = null
let lastScrollTop = 0
/** 待恢复的滚动位置：投影分批到达时反复应用，同步完成后再结束恢复。 */
let pendingRestore: number | null = null
let scrollFrame: number | null = null
let outlineFrame: number | null = null
let resizeObserver: ResizeObserver | null = null
/** 投影映射缓存：流式期间每个批次只重建真正变化的条目，见 chat-view.ts。 */
const viewCache = createChatViewCache()

const chatMessages = computed(() => viewCache.toMessages(messages.value, tools.value))
const outlineEntries = computed(() => chatMessages.value
  .filter(message => message.role === 'user')
  .map(message => ({ id: message.id, label: outlineLabel(message) })))
const outlineStyle = computed(() => ({
  left: `${outlineLayout.value?.left ?? 0}px`,
  width: `${outlineLayout.value?.width ?? 0}px`
}))
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
/** 压缩进行中：运行提示改成压缩文案，但不改变粘底与停止键的行为。 */
const compacting = computed(() => runtimeInfo.value?.isCompacting === true)
const pendingRewind = ref<{ request: RuntimeRewindRequest } | null>(null)
const pendingEdit = ref<{ messageId: string; text: string } | null>(null)
const canRewind = computed(() => runtimeView.value.phase === 'ready' && runtimeInfo.value?.sessionId != null
  && !streaming.value && projectionSync.value === 'synced' && !preparingPrompt.value
  && promptView.value.phase !== 'sending' && modelSwitchView.value.phase !== 'switching'
  && rewindView.value.phase !== 'requesting' && !(rewindView.value.phase === 'error' && rewindView.value.blocked)
  && !sessionStore.opening && !sessionStore.awaitingTrust && !sessionStore.awaitingInterrupt)
const rewindDetail = computed(() => '回退会新建一条会话继续，原会话保留在本机但不再单独列出。仅回退对话，不撤销项目文件改动。')

/** 发起确认时固定目标（运行实例、代际与会话）；用户确认前不会改变历史。 */
function requestRewind(messageId: string): void {
  if (!canRewind.value || runtimeView.value.phase !== 'ready') return
  const runId = runtimeView.value.snapshot.runId
  const runtimeId = runtimeView.value.snapshot.runtimeId
  const sessionId = runtimeInfo.value?.sessionId
  if (runId === null || runtimeId === null || sessionId == null) return
  pendingRewind.value = { request: { runId, runtimeId, sessionId, messageId } }
}

/** 直接回退：仅权威成功才刷新会话列表。 */
async function confirmRewind(): Promise<void> {
  const pending = pendingRewind.value
  pendingRewind.value = null
  if (pending === null || !canRewind.value) return
  if (await runtimeStore.rewind(pending.request)) await sessionStore.refresh()
}

/** 修改提交：回退成功后立即发送修改文本，再刷新会话列表。 */
async function handleSubmitEdit(messageId: string, text: string): Promise<void> {
  if (!canRewind.value || runtimeView.value.phase !== 'ready') return
  const runId = runtimeView.value.snapshot.runId
  const runtimeId = runtimeView.value.snapshot.runtimeId
  const sessionId = runtimeInfo.value?.sessionId
  if (runId === null || runtimeId === null || sessionId == null) return
  const request: RuntimeRewindRequest = { runId, runtimeId, sessionId, messageId }
  pendingEdit.value = { messageId, text }
  const success = await runtimeStore.rewind(request)
  if (!success) {
    // 回退失败，保持编辑态，用户可再次尝试
    pendingEdit.value = null
    return
  }
  // 回退成功，发送修改文本
  await runtimeStore.send(text, [])
  await sessionStore.refresh()
  pendingEdit.value = null
}
/** 消息 ID 只在单个运行实例内唯一；实例或会话切换后不能复用旧消息组件的手动开合状态。 */
const syncNotice = computed(() => {
  if (projectionSync.value === 'synced') return null
  return projectionSync.value === 'stale'
    ? '消息已失去同步，正在重新取得快照。'
    : '正在与主进程同步消息，暂不显示增量内容。'
})
const truncationNotice = computed(() => {
  if (!projectionTruncated.value && droppedTools.value === 0) return null
  const parts: string[] = []
  if (projectionTruncated.value) parts.push(`省略较早消息 ${droppedMessages.value} 条，超长内容已标记截断`)
  if (droppedTools.value > 0) parts.push(`省略较早工具记录 ${droppedTools.value} 条`)
  return `投影已截断：${parts.join('，')}。`
})

/**
 * 空状态只表达当前可用动作，不替主进程判断会话是否真的存在。
 * Runtime 异常退出时给出常规重试入口：恢复路径就在出错的第一现场，不需要用户再去设置页找。
 */
const emptyState = computed(() => {
  if (projectStore.currentProject === null) {
    return { title: '先选择一个项目', description: '项目决定 Pi 的工作目录；在左侧项目列表选择或添加项目后即可开始。', action: null }
  }
  const current = runtimeView.value
  if (current.phase === 'starting') {
    return { title: '正在启动 Pi', description: '正在以当前项目启动 Runtime 并准备会话。', action: null }
  }
  if (current.phase === 'stopping') {
    return { title: '正在关闭 Runtime', description: '关闭完成后可以打开或新建会话。', action: null }
  }
  if (current.phase === 'failed') {
    return {
      title: 'Runtime 异常退出',
      description: `${current.error.message}；可再次点击发送重试启动；若怀疑是某个 Extension 导致启动失败，请先停用该扩展。`,
      action: 'new-session' as const
    }
  }
  if (current.phase === 'ready') {
    return { title: '可以开始对话', description: '在下方输入内容并发送；Enter 发送，Shift+Enter 换行。', action: null }
  }
  // 挂起（宿主已回收）与关闭中不同：发送会先恢复原会话，不是重新开始。
  if (runtimeStore.suspendedSessionId !== null) {
    return {
      title: '会话已回收',
      description: '空闲后已释放执行环境以节省资源；发送新内容会先恢复这个会话。',
      action: null
    }
  }
  // idle 与 closed 是同一份提示；放在最后作为兜底返回，计算式不会返回 undefined。
  return {
    title: '准备开始对话',
    description: '输入内容并发送后才会启动 Pi；首次启动期间会保留输入。',
    action: null
  }
})

/** 摘要只取用户已有的文本，不解析 Markdown；技能调用、纯图片与没有可展示文本的消息分别标明。 */
function outlineLabel(message: ChatMessageView): string {
  const parts: string[] = []
  const skillNames: string[] = []
  let hasImage = false
  for (const block of message.blocks) {
    if (block.kind !== 'text') continue
    if (block.image !== null) {
      hasImage = true
      continue
    }
    // 投影生成的附件说明不是用户输入；它出现说明这条消息带了图片，按图片消息处理。
    if (block.notice) {
      hasImage = true
      continue
    }
    // 技能消息的 `text` 只含用户追加文本，技能调用本身只用名称占位，不把正文当摘要。
    if (block.skill !== null) skillNames.push(block.skill.name)
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  const text = parts.join(' ').replace(/\s+/g, ' ')
  if (text === '') {
    if (skillNames.length > 0) return `技能：${skillNames.join('、')}`
    return hasImage ? '图片消息' : '用户消息'
  }
  return text.length > OUTLINE_SUMMARY_CHARS ? `${text.slice(0, OUTLINE_SUMMARY_CHARS)}…` : text
}

/** 判断滚动位置距底部是否在粘底阈值内。 */
function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
}

/** 当前会话的阅读状态：粘底时位置无关紧要，离开底部时按最后一次滚动位置恢复。 */
function currentReading(): SessionReading {
  return { stickToBottom: stickToBottom.value, scrollTop: lastScrollTop }
}

/**
 * 阅读位置按会话保存：离开会话时存回，切回时取走。空闲与未绑定实例没有独立历史，状态原样带走。
 * 调用点必须在视图换成新会话之前执行：晚读会把新会话的滚动位置当成旧会话的位置。
 */
function applySessionReading(nextKey: string, previousKey: string | null): void {
  if (previousKey !== null && isSessionKey(previousKey)) {
    sessionViewStore.saveReading(previousKey, currentReading())
  }
  const restored = isSessionKey(nextKey) ? sessionViewStore.takeReading(nextKey) : null
  if (restored !== null) {
    stickToBottom.value = restored.stickToBottom
    pendingRestore = restored.stickToBottom ? null : restored.scrollTop
    return
  }
  // 会话之间必须隔离：目标会话没有留底时按默认贴底处理，不沿用上一个会话的位置。
  if (previousKey !== null && isSessionKey(previousKey)) {
    stickToBottom.value = true
    pendingRestore = null
  }
}

/** 会话切换：先存回原会话的阅读位置，再取走目标会话的位置。 */
watch(() => sessionViewStore.key, (next, previous) => applySessionReading(next, previous ?? null), { flush: 'pre' })

/** 恢复中的滚动位置：内容还在长高时反复应用，投影同步后确认位置并结束恢复。 */
function applyPendingRestore(): void {
  if (pendingRestore === null) return
  const element = scroller.value
  if (element === null) return
  element.scrollTop = pendingRestore
  lastScrollTop = element.scrollTop
  if (projectionSync.value === 'synced') pendingRestore = null
}

/** 内容变高造成底部距离增加，不等于用户上滚；只有实际向上移动才暂停跟随。 */
function onScroll(): void {
  const element = scroller.value
  if (element === null) return
  // 恢复期间的位置由目标值决定：不让中间态改写粘底判定，也不让被裁剪的位置覆盖目标。
  if (pendingRestore === null) {
    if (outlineTargetId === null) {
      if (isNearBottom(element)) stickToBottom.value = true
      else if (element.scrollTop < lastScrollTop) stickToBottom.value = false
    }
    lastScrollTop = element.scrollTop
  }
  scheduleOutlineUpdate()
}

/** 每帧最多粘底一次；写入前再检查上滚，避免排队中的布局回调抢走用户位置。 */
function scheduleScrollToBottom(): void {
  if (!stickToBottom.value || scrollFrame !== null) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null
    const element = scroller.value
    if (element === null || !stickToBottom.value) return
    if (element.scrollTop < lastScrollTop && !isNearBottom(element)) {
      stickToBottom.value = false
      lastScrollTop = element.scrollTop
      return
    }
    element.scrollTop = element.scrollHeight
    // 记录程序滚动后的实际位置，不让随后的 scroll 事件把内容增长误判成离开底部。
    lastScrollTop = element.scrollTop
    scheduleOutlineUpdate()
  })
}

function jumpToBottom(): void {
  outlineTargetId = null
  pendingRestore = null
  stickToBottom.value = true
  lastScrollTop = scroller.value?.scrollTop ?? 0
  scheduleScrollToBottom()
}

/** 只有明确的手动滚动意图解除跳转保护与待恢复位置；单纯布局变化不代表用户要回到底部。 */
function releaseOutlineJump(): void {
  outlineTargetId = null
  pendingRestore = null
}

function onWheel(event: WheelEvent): void {
  if (event.deltaY !== 0) releaseOutlineJump()
}

function onScrollerPointerDown(event: PointerEvent): void {
  // 原生滚动条的指针事件落在滚动容器；点击正文或复制按钮不解除阅读保护。
  if (event.target === event.currentTarget) releaseOutlineJump()
}

function onReadingKey(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) releaseOutlineJump()
}

/** 定位当前投影里的用户消息；先取消待执行的粘底，再立即跳转，不让平滑滚动与流式更新争夺位置。 */
function jumpToMessage(messageId: string): void {
  const element = scroller.value
  const target = content.value?.querySelector<HTMLElement>(`.chat-message-user[data-message-id="${CSS.escape(messageId)}"]`)
  if (element === null || target === null || target === undefined) return
  if (!outlineEntries.value.some(entry => entry.id === messageId)) return

  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  scrollFrame = null
  outlineTargetId = messageId
  pendingRestore = null
  stickToBottom.value = false
  activeOutlineId.value = messageId
  const top = element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - READING_OFFSET_PX
  element.scrollTop = Math.max(0, top)
  lastScrollTop = element.scrollTop
  scheduleOutlineUpdate()
}

/** 按实际正文右边界计算留白，扣除滚动条与安全间距；不挤占正文或输入区。 */
function updateOutlineLayout(): void {
  const host = viewport.value
  const element = scroller.value
  const body = content.value
  if (host === null || element === null || body === null || outlineEntries.value.length === 0) {
    outlineLayout.value = null
    return
  }

  const hostRect = host.getBoundingClientRect()
  const scrollRect = element.getBoundingClientRect()
  const usableRight = scrollRect.left + element.clientWidth
  const available = usableRight - body.getBoundingClientRect().right
  const width = Math.min(OUTLINE_MAX_WIDTH_PX, available - OUTLINE_GAP_PX - OUTLINE_EDGE_PX)
  outlineLayout.value = width >= OUTLINE_MIN_WIDTH_PX && hostRect.height >= OUTLINE_MIN_HEIGHT_PX
    ? { left: usableRight - OUTLINE_EDGE_PX - width - hostRect.left, width }
    : null
}

/** 正常阅读按视口顶部所属的用户输入定位；贴底时标记最新输入，跳转受限时仍保留点击目标。 */
function updateActiveOutline(): void {
  const entries = outlineEntries.value
  if (outlineTargetId !== null && !entries.some(entry => entry.id === outlineTargetId)) outlineTargetId = null
  if (outlineLayout.value === null || entries.length === 0) {
    activeOutlineId.value = null
    return
  }
  if (outlineTargetId !== null) {
    activeOutlineId.value = outlineTargetId
    return
  }
  if (stickToBottom.value) {
    activeOutlineId.value = entries[entries.length - 1]?.id ?? null
    return
  }

  const element = scroller.value
  const body = content.value
  if (element === null || body === null) return
  const readingTop = element.getBoundingClientRect().top + READING_OFFSET_PX + 1
  let activeId = entries[0]?.id ?? null
  for (const anchor of body.querySelectorAll<HTMLElement>('.chat-message-user[data-message-id]')) {
    if (anchor.getBoundingClientRect().top > readingTop) break
    activeId = anchor.dataset.messageId ?? activeId
  }
  activeOutlineId.value = activeId
}

/** 几何读取与当前位置更新每帧合并一次，避免在每个流式增量或 scroll 事件里重复读布局。 */
function scheduleOutlineUpdate(): void {
  if (outlineFrame !== null) return
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = null
    updateOutlineLayout()
    updateActiveOutline()
  })
}

function onLayoutChange(): void {
  applyPendingRestore()
  scheduleScrollToBottom()
  scheduleOutlineUpdate()
}

function startNewSession(): void {
  // 闲置时空白聊天已经可用，不因点击新建会话启动 Pi；异常退出时保留显式重试入口。
  if (runtimeView.value.phase === 'idle' || runtimeView.value.phase === 'closed') return
  void sessionStore.open(null, false)
}

/** DOM 更新与实际尺寸变化都同步粘底及大纲；会话切换清除上一次阅读目标。 */
watch([chatMessages, streaming, syncNotice, truncationNotice], onLayoutChange, { flush: 'post' })
watch(conversationKey, () => {
  pendingRewind.value = null
  activeOutlineId.value = null
  // 同一会话重绑（Runtime 代际变化）没有可恢复的位置：继续贴底，不停在历史开头。
  if (!stickToBottom.value && pendingRestore === null) jumpToBottom()
  scheduleOutlineUpdate()
}, { flush: 'post' })

onMounted(() => {
  // 视图重建（例如从设置页返回）时取回当前会话的阅读位置；没有留底时保持默认贴底。
  applySessionReading(sessionViewStore.key, null)
  resizeObserver = new ResizeObserver(onLayoutChange)
  if (scroller.value !== null) resizeObserver.observe(scroller.value)
  if (content.value !== null) resizeObserver.observe(content.value)
  onLayoutChange()
})

onBeforeUnmount(() => {
  // 视图卸载（例如切到设置页）时按会话留底；这里已读不到 DOM，用最后一次已知的滚动位置。
  if (isSessionKey(sessionViewStore.key)) sessionViewStore.saveReading(sessionViewStore.key, currentReading())
  resizeObserver?.disconnect()
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
  if (outlineFrame !== null) cancelAnimationFrame(outlineFrame)
})
</script>

<template>
  <section ref="viewport" class="relative flex min-h-0 flex-1 flex-col bg-desk-canvas-sunken">
    <div
      ref="scroller"
      class="scroll-area min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 [overflow-anchor:none]"
      @scroll.passive="onScroll"
      @wheel.passive="onWheel"
      @pointerdown="onScrollerPointerDown"
      @touchmove.passive="releaseOutlineJump"
      @keydown="onReadingKey"
    >
      <div ref="content" class="chat-column mx-auto flex flex-col gap-5">
        <p v-if="syncNotice" role="status" class="status-notice status-notice-info">{{ syncNotice }}</p>
        <p v-if="truncationNotice" role="status" class="status-notice">{{ truncationNotice }}</p>
        <p v-if="rewindView.phase === 'requesting'" role="status" class="status-notice status-notice-info">正在回退对话并同步历史…</p>
        <p v-else-if="rewindView.phase === 'error'" role="alert" class="status-notice status-notice-error">{{ rewindView.error.message }}</p>
        <p v-else-if="rewindView.phase === 'done' && rewindView.cancelled" role="status" class="status-notice">Pi 扩展取消了回退；草稿未被替换。</p>

        <ChatMessageItem
          v-for="message in chatMessages"
          :key="`${conversationKey}:${message.id}`"
          :message="message"
          :actions-disabled="!canRewind"
          :data-message-id="message.id"
          @rewind="requestRewind"
          @submit-edit="handleSubmitEdit"
        />

        <div v-if="chatMessages.length === 0" class="empty-state">
          <p class="empty-state-title">{{ emptyState.title }}</p>
          <p class="empty-state-text">{{ emptyState.description }}</p>
          <div v-if="emptyState.action === 'new-session'" class="mt-2 flex flex-wrap items-center justify-center gap-2">
            <AppButton
              variant="primary"
              :disabled="sessionStore.opening"
              @click="startNewSession"
            >
              新建会话
            </AppButton>
          </div>
        </div>

        <p v-if="streaming" role="status" class="status-notice status-notice-info flex items-center gap-2">
          <span class="status-dots text-desk-accent" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>{{ compacting ? '正在压缩上下文；需要中断时在下方停止。' : 'Agent 正在运行；需要中断时在下方停止。' }}</span>
        </p>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingRewind !== null"
      title="回退到这条消息之前？"
      description="当前对话将回到这条用户消息发送之前；该消息及后续内容不再显示在新分支中。"
      :detail="rewindDetail"
      confirm-label="确认回退"
      @confirm="confirmRewind"
      @cancel="pendingRewind = null"
    />

    <ChatOutline
      v-if="outlineLayout !== null && outlineEntries.length > 0"
      :key="conversationKey"
      :entries="outlineEntries"
      :active-id="activeOutlineId"
      :style="outlineStyle"
      @navigate="jumpToMessage"
    />

    <div v-if="!stickToBottom" class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <AppButton variant="compact" class="pointer-events-auto" @click="jumpToBottom">
        回到底部
      </AppButton>
    </div>
  </section>
</template>
