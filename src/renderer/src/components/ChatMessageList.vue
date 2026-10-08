<!-- 消息区：按投影顺序渲染消息，表达同步与截断状态，处理粘底滚动、回到底部与空状态；不自行拼装历史或请求消息内容。 -->
<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { createChatViewCache } from '../chat-view'
import { useProjectStore } from '../stores/project'
import { useRuntimeStore } from '../stores/runtime'
import { useSessionStore } from '../stores/session'
import ChatMessageItem from './ChatMessageItem.vue'

/** 距底部多少像素内仍视为"停在底部"，避免流式更新时与用户上滚互相争夺。 */
const STICK_THRESHOLD_PX = 24

const projectStore = useProjectStore()
const runtimeStore = useRuntimeStore()
const sessionStore = useSessionStore()
const { view: runtimeView, messages, tools, projectionSync, projectionTruncated, droppedMessages, droppedTools } = storeToRefs(runtimeStore)

const scroller = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
/** 投影映射缓存：流式期间每个批次只重建真正变化的条目，见 chat-view.ts。 */
const viewCache = createChatViewCache()

const chatMessages = computed(() => viewCache.toMessages(messages.value, tools.value))
const runtimeInfo = computed(() => (
  runtimeView.value.phase === 'ready' ? runtimeView.value.snapshot.info : null
))
const streaming = computed(() => runtimeInfo.value?.isStreaming === true)
const streamingMessageId = computed(() => (
  streaming.value ? chatMessages.value.at(-1)?.id ?? null : null
))
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

/** 空状态只表达当前可用动作，不替主进程判断会话是否真的存在。 */
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
    return { title: 'Runtime 异常退出', description: current.error.message, action: 'new-session' as const }
  }
  if (current.phase === 'ready') {
    return { title: '可以开始对话', description: '在下方输入内容并发送；Enter 发送，Shift+Enter 换行。', action: null }
  }
  return { title: '还没有打开会话', description: '打开或新建一个会话后即可开始对话。', action: 'new-session' as const }
})

/** 内容指纹：只在消息或工具内容变化时重新粘底，避免每次渲染都改滚动位置。 */
const contentRevision = computed(() => {
  let characters = 0
  for (const message of chatMessages.value) {
    for (const block of message.blocks) {
      if (block.kind !== 'toolcall') characters += block.text.length
    }
  }
  return `${chatMessages.value.length}:${tools.value.length}:${characters}`
})

function onScroll(): void {
  const element = scroller.value
  if (element === null) return
  stickToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element === null) return
  element.scrollTop = element.scrollHeight
}

function jumpToBottom(): void {
  stickToBottom.value = true
  void scrollToBottom()
}

function startNewSession(): void {
  void sessionStore.open(null, false)
}

watch(contentRevision, () => {
  if (stickToBottom.value) void scrollToBottom()
})

onMounted(() => {
  void scrollToBottom()
})
</script>

<template>
  <section class="relative flex min-h-0 flex-1 flex-col bg-desk-canvas-sunken">
    <div
      ref="scroller"
      class="scroll-area min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"
      @scroll.passive="onScroll"
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <p v-if="syncNotice" role="status" class="text-sm text-desk-muted">{{ syncNotice }}</p>
        <p v-if="truncationNotice" role="status" class="text-sm text-desk-muted">{{ truncationNotice }}</p>

        <ChatMessageItem
          v-for="message in chatMessages"
          :key="message.id"
          :message="message"
          :streaming="message.id === streamingMessageId"
        />

        <div v-if="chatMessages.length === 0" class="empty-output">
          <h2 class="mb-1 text-sm font-medium">{{ emptyState.title }}</h2>
          <p class="text-sm text-desk-muted">{{ emptyState.description }}</p>
          <button
            v-if="emptyState.action === 'new-session'"
            type="button"
            class="control-button mt-3"
            :disabled="sessionStore.opening"
            @click="startNewSession"
          >
            新建会话
          </button>
        </div>

        <p v-if="streaming" role="status" class="flex items-center gap-2 text-sm text-desk-muted">
          <span class="status-dot animate-pulse bg-desk-accent motion-reduce:animate-none"></span>
          Agent 正在运行；需要中断时在下方停止。
        </p>
      </div>
    </div>

    <div v-if="!stickToBottom" class="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <button type="button" class="control-button pointer-events-auto shadow-sm" @click="jumpToBottom">
        回到底部
      </button>
    </div>
  </section>
</template>
