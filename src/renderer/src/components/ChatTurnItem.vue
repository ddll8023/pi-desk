<!-- 一轮对话：用户消息始终可见，其后的 AI 回答与压缩记录整体折叠成一行摘要（条数、本轮响应耗时、最后一次调用的 token），点摘要行展开或收起。
     折叠状态不在这里持有：开合由消息列表按会话写入 session-view，本组件只渲染给定状态并发出开合意图，因此定位与状态隔离都在同一处处理。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { HistoryChunk } from '../../../shared/runtime-api'
import type { HistoryTurnState } from '../stores/runtime'
import HistoryLoadSentinel from './HistoryLoadSentinel.vue'
import type { ChatMessageView, ChatTurnView } from '../chat-view'
import { formatDuration, useTickingNow } from '../clock'
import { formatTokens } from '../usage-format'
import ChatMessageItem from './ChatMessageItem.vue'

const props = defineProps<{
  readonly turn: ChatTurnView
  /** 该轮 AI 内容是否展开；用户消息与摘要行始终渲染。 */
  readonly expanded: boolean
  /** 是否为当前轮（最后一轮）：当前轮展开时不显示摘要行，不给回答正文多加一层标题。 */
  readonly current: boolean
  readonly running?: boolean
  readonly actionsDisabled?: boolean
  /** 动作栏不可用的原因；禁用时替换默认 tooltip。 */
  readonly disabledReason?: string | null
  readonly detail?: HistoryTurnState | undefined
  readonly historyAvailable?: boolean
  readonly ownerKey: string
}>()

const emit = defineEmits<{
  toggle: []
  loadDetail: [more: boolean]
  visibility: [visible: boolean, ownerKey: string]
  loadChunk: [chunk: HistoryChunk]
  rewind: [messageId: string]
  submitEdit: [messageId: string, editedText: string]
}>()

/** 会话开头没有用户消息的前置轮：摘要文案要区分，不把历史残片说成某一轮回答。 */
const isLead = computed(() => props.turn.user === null)
const hasResponses = computed(() => props.turn.responseCount > 0)
/**
 * 摘要行同时是收起与展开的入口：历史轮始终显示；当前轮展开时隐藏，
 * 否则会在回答正文上方多出一层无意义的标题。
 */
const recoverable = computed(() => props.turn.historyId !== null
  && (props.turn.user?.recoverable || props.turn.responses.some(message => message.recoverable)))
const showSummary = computed(() => (hasResponses.value || recoverable.value) && (!props.current || !props.expanded))
const userIncomplete = computed(() => props.turn.user?.blocks.some(block => block.kind === 'text' && block.truncated) === true)
const live = computed(() => props.current && (props.turn.turn !== null || props.running === true))
const canLoadHistory = computed(() => props.historyAvailable === true && !live.value)
const needsInitialDetails = computed(() => canLoadHistory.value && recoverable.value && !props.detail?.loaded
  && (props.expanded || userIncomplete.value))
/** 工具结果的来源条目与助手消息不同，按调用身份送回原工具卡片。 */
function chunksOf(message: ChatMessageView): readonly HistoryChunk[] {
  if (live.value) return []
  const calls = new Set(message.blocks.flatMap(block => block.kind === 'toolcall' && block.toolCallId ? [block.toolCallId] : []))
  return (props.detail?.chunks ?? []).filter(chunk => chunk.entryId === message.entryId
    || (chunk.toolCallId !== undefined && calls.has(chunk.toolCallId)))
}
const root = ref<HTMLElement | null>(null)
let visible = false
let observer: IntersectionObserver | null = null
let readFrame: number | null = null
let initialRequested = false
/** 初次补齐直接由轮的可见性触发，正常加载不插入文字或占位行。 */
function scheduleInitialDetails(): void {
  if (readFrame !== null) cancelAnimationFrame(readFrame)
  readFrame = requestAnimationFrame(() => {
    readFrame = null
    if (!visible || !needsInitialDetails.value || initialRequested || props.detail?.loading || props.detail?.error) return
    initialRequested = true
    emit('loadDetail', false)
  })
}
watch(() => [props.turn.historyId, props.ownerKey, props.detail, needsInitialDetails.value,
  props.detail?.loading, props.detail?.error] as const, (next, previous) => {
  if (next[0] !== previous[0] || next[1] !== previous[1] || next[2] !== previous[2]) initialRequested = false
  emit('visibility', visible, props.ownerKey)
  scheduleInitialDetails()
}, { flush: 'post' })
onMounted(() => {
  observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting)
    emit('visibility', visible, props.ownerKey)
    scheduleInitialDetails()
  }, { rootMargin: '100px' })
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (readFrame !== null) cancelAnimationFrame(readFrame)
  emit('visibility', false, props.ownerKey)
})

/** 摘要标题直接表达当前状态，收起时不用再看三角猜内容去哪了。 */
const summaryTitle = computed(() => {
  const subject = isLead.value ? '较早的 AI 回答' : 'AI 回答'
  return props.expanded ? subject : `${subject}已折叠`
})

/** 多条 AI 消息（工具往返）时说明条数，单条不显示冗余的「1 条」。 */
const countText = computed(() => (props.turn.responseCount > 1 ? `${props.turn.responseCount} 条` : null))

/**
 * 本轮响应耗时：与消息头部同一口径，取自用户消息上的本轮计时。
 * 收起态仍可能在生成中，所以计时器只在结束时刻缺失时走刻度。
 */
const now = useTickingNow(() => props.turn.turn?.endedAt === null)
const durationText = computed(() => {
  const timing = props.turn.turn
  if (timing === null) return null
  const duration = formatDuration((timing.endedAt ?? now.value) - timing.startedAt)
  return timing.endedAt === null ? `响应中 ${duration}` : duration
})

/** 最后一次调用的用量；缺失时整段不渲染，不编造 token。 */
const usageText = computed(() => {
  const usage = props.turn.usage
  return usage === null ? null : `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}`
})

/** 摘要行右侧的次要信息：耗时与用量，都缺失时整段为空。 */
const metaText = computed(() => [durationText.value, usageText.value].filter(part => part !== null).join(' · '))
</script>

<template>
  <div ref="root" class="chat-turn" :data-turn-key="turn.key" :aria-busy="detail?.loading === true">
    <ChatMessageItem
      v-if="turn.user !== null"
      :message="turn.user"
      :actions-disabled="actionsDisabled || userIncomplete"
      :disabled-reason="userIncomplete ? '正在加载完整消息内容，暂不能回退或修改重试。' : disabledReason"
      :data-message-id="turn.user.id"
      :history-chunks="chunksOf(turn.user)"
      :chunk-states="detail?.chunkStates"
      :history-enabled="canLoadHistory"
      :history-busy="detail?.loading"
      :history-more="detail?.next"
      :history-error="detail?.error"
      @load-more="emit('loadDetail', true)"
      @load-chunk="emit('loadChunk', $event)"
      @rewind="emit('rewind', $event)"
      @submit-edit="(messageId, text) => emit('submitEdit', messageId, text)"
    />

    <HistoryLoadSentinel
      v-if="needsInitialDetails && detail?.error"
      :cursor="turn.historyId ?? turn.key"
      :enabled="canLoadHistory"
      :loading="detail?.loading ?? false"
      :error="detail?.error"
      @load="emit('loadDetail', false)"
    />

    <button
      v-if="showSummary"
      type="button"
      class="chat-turn-summary"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <span class="disclosure" :class="{ 'is-open': expanded }" aria-hidden="true"></span>
      <span class="chat-turn-summary-title">{{ summaryTitle }}</span>
      <span v-if="countText !== null" class="chat-turn-summary-count">{{ countText }}</span>
      <span v-if="metaText !== ''" class="chat-turn-summary-meta">{{ metaText }}</span>
    </button>

    <template v-if="expanded">
      <ChatMessageItem
        v-for="(message, responseIndex) in turn.responses"
        :key="message.id"
        :message="message"
        :compact-header="responseIndex > 0"
        :actions-disabled="actionsDisabled"
        :disabled-reason="disabledReason"
        :history-chunks="chunksOf(message)"
        :chunk-states="detail?.chunkStates"
        :history-enabled="canLoadHistory"
        :history-busy="detail?.loading"
        :history-more="detail?.next"
        :history-error="detail?.error"
        @load-more="emit('loadDetail', true)"
        @load-chunk="emit('loadChunk', $event)"
        @rewind="emit('rewind', $event)"
        @submit-edit="(messageId, text) => emit('submitEdit', messageId, text)"
      />
      <HistoryLoadSentinel
        v-if="detail?.next && !live"
        :cursor="`${turn.historyId}:${detail.next}`"
        :enabled="canLoadHistory"
        :loading="detail.loading"
        :error="detail.error"
        @load="emit('loadDetail', true)"
      />
    </template>
  </div>
</template>
