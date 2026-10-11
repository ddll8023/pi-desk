<!-- 消息区：按投影顺序渲染并持续粘底，主动上滚或大纲跳转时暂停；仅在右侧留白足够时展示用户输入刻度导航，切换会话重置滚动与消息组件；不自行拼装历史或请求消息内容。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createChatViewCache } from '../chat-view'
import type { ChatMessageView } from '../chat-view'
import { useProjectStore } from '../stores/project'
import { useResourceStore } from '../stores/resource'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import ChatMessageItem from './ChatMessageItem.vue'
import ChatOutline from './ChatOutline.vue'
import AppButton from './ui/AppButton.vue'

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
const resourceStore = useResourceStore()
const { view: runtimeView, messages, tools, projectionSync, projectionTruncated, droppedMessages, droppedTools } = storeToRefs(runtimeStore)
const { safeStart } = storeToRefs(resourceStore)

const viewport = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
const activeOutlineId = ref<string | null>(null)
const outlineLayout = ref<{ left: number; width: number } | null>(null)
/** 大纲跳转保持阅读位置，不被程序滚动或内容收缩产生的 scroll 事件重新开启粘底。 */
let outlineTargetId: string | null = null
let lastScrollTop = 0
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
/** 消息 ID 只在单个 Runtime 内唯一；会话切换后不能复用旧消息组件的手动开合状态。 */
const conversationKey = computed(() => {
  const runtimeId = runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.runtimeId : null
  return `${projectStore.currentProject?.id ?? 'none'}:${runtimeId ?? 'none'}:${runtimeInfo.value?.sessionId ?? 'none'}`
})
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
 * Runtime 异常退出时同时给出常规重试与安全模式逃生入口：两种恢复路径都在出错的第一现场，
 * 不需要用户再去设置页找。
 */
const emptyState = computed(() => {
  if (projectStore.currentProject === null) {
    return { title: '先选择一个项目', description: '项目决定 Pi 的工作目录；在顶栏选择或新建项目后即可开始。', action: null }
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
      description: `${current.error.message}；可重试启动，或用安全模式启动以排除坏 Extension。`,
      action: 'new-session' as const
    }
  }
  if (current.phase === 'ready') {
    return { title: '可以开始对话', description: '在下方输入内容并发送；Enter 发送，Shift+Enter 换行。', action: null }
  }
  // idle 与 closed 是同一份提示；放在最后作为兜底返回，计算式不会返回 undefined。
  return {
    title: '准备开始对话',
    description: '输入内容并发送后才会启动 Pi；首次启动期间会保留输入。',
    action: null
  }
})

/** 摘要只取用户已有的文本，不解析 Markdown；纯图片与没有可展示文本的消息分别标明。 */
function outlineLabel(message: ChatMessageView): string {
  const parts: string[] = []
  let hasImage = false
  for (const block of message.blocks) {
    if (block.kind !== 'text') continue
    if (block.image !== null) {
      hasImage = true
      continue
    }
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  const text = parts.join(' ').replace(/\s+/g, ' ')
  if (text === '') return hasImage ? '图片消息' : '用户消息'
  return text.length > OUTLINE_SUMMARY_CHARS ? `${text.slice(0, OUTLINE_SUMMARY_CHARS)}…` : text
}

/** 判断滚动位置距底部是否在粘底阈值内。 */
function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
}

/** 内容变高造成底部距离增加，不等于用户上滚；只有实际向上移动才暂停跟随。 */
function onScroll(): void {
  const element = scroller.value
  if (element === null) return
  if (outlineTargetId === null) {
    if (isNearBottom(element)) stickToBottom.value = true
    else if (element.scrollTop < lastScrollTop) stickToBottom.value = false
  }
  lastScrollTop = element.scrollTop
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
  stickToBottom.value = true
  lastScrollTop = scroller.value?.scrollTop ?? 0
  scheduleScrollToBottom()
}

/** 只有明确的手动滚动意图解除跳转保护；单纯布局变化不代表用户要回到底部。 */
function releaseOutlineJump(): void {
  outlineTargetId = null
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
  scheduleScrollToBottom()
  scheduleOutlineUpdate()
}

function startNewSession(): void {
  // 闲置时空白聊天已经可用，不因点击新建会话启动 Pi；异常退出时保留显式重试入口。
  if (runtimeView.value.phase === 'idle' || runtimeView.value.phase === 'closed') return
  void sessionStore.open(null, false)
}

/** 安全模式启动：不加载 Extension，仅本次生效；目标由主进程用最近一次启动意图决定。 */
function startSafely(): void {
  void resourceStore.startSafely()
}

/** DOM 更新与实际尺寸变化都同步粘底及大纲；会话切换清除上一次阅读目标。 */
watch([chatMessages, streaming, syncNotice, truncationNotice], onLayoutChange, { flush: 'post' })
watch(conversationKey, () => {
  activeOutlineId.value = null
  jumpToBottom()
  scheduleOutlineUpdate()
}, { flush: 'post' })

onMounted(() => {
  resizeObserver = new ResizeObserver(onLayoutChange)
  if (scroller.value !== null) resizeObserver.observe(scroller.value)
  if (content.value !== null) resizeObserver.observe(content.value)
  onLayoutChange()
})

onBeforeUnmount(() => {
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
      <div ref="content" class="mx-auto flex max-w-3xl flex-col gap-5">
        <p v-if="syncNotice" role="status" class="status-notice status-notice-info">{{ syncNotice }}</p>
        <p v-if="truncationNotice" role="status" class="status-notice">{{ truncationNotice }}</p>

        <ChatMessageItem
          v-for="message in chatMessages"
          :key="`${conversationKey}:${message.id}`"
          :message="message"
          :data-message-id="message.id"
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
            <AppButton
              :disabled="safeStart.phase === 'starting'"
              @click="startSafely"
            >
              {{ safeStart.phase === 'starting' ? '正在启动…' : '以禁用扩展启动（仅本次）' }}
            </AppButton>
          </div>
          <p v-if="safeStart.phase === 'error'" role="alert" class="mt-1 text-xs text-desk-danger">
            {{ safeStart.error.message }}
          </p>
        </div>

        <p v-if="streaming" role="status" class="status-notice status-notice-info flex items-center gap-2">
          <span class="status-dot animate-pulse bg-desk-accent motion-reduce:animate-none"></span>
          <span>Agent 正在运行；需要中断时在下方停止。</span>
        </p>
      </div>
    </div>

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
