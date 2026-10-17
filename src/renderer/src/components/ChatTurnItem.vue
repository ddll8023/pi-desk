<!-- 一轮对话：用户消息始终可见，其后的 AI 回答与压缩记录整体折叠成一行摘要（条数、本轮响应耗时、最后一次调用的 token），点摘要行展开或收起。
     折叠状态不在这里持有：开合由消息列表按会话写入 session-view，本组件只渲染给定状态并发出开合意图，因此定位与状态隔离都在同一处处理。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ChatTurnView } from '../chat-view'
import { formatDuration, useTickingNow } from '../clock'
import { formatTokens } from '../usage-format'
import ChatMessageItem from './ChatMessageItem.vue'

const props = defineProps<{
  readonly turn: ChatTurnView
  /** 该轮 AI 内容是否展开；用户消息与摘要行始终渲染。 */
  readonly expanded: boolean
  /** 是否为当前轮（最后一轮）：当前轮展开时不显示摘要行，不给回答正文多加一层标题。 */
  readonly current: boolean
  readonly actionsDisabled?: boolean
  /** 动作栏不可用的原因；禁用时替换默认 tooltip。 */
  readonly disabledReason?: string | null
}>()

const emit = defineEmits<{
  toggle: []
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
const showSummary = computed(() => hasResponses.value && (!props.current || !props.expanded))

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
  <div class="chat-turn" :data-turn-key="turn.key">
    <ChatMessageItem
      v-if="turn.user !== null"
      :message="turn.user"
      :actions-disabled="actionsDisabled"
      :disabled-reason="disabledReason"
      :data-message-id="turn.user.id"
      @rewind="emit('rewind', $event)"
      @submit-edit="(messageId, text) => emit('submitEdit', messageId, text)"
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
        @rewind="emit('rewind', $event)"
        @submit-edit="(messageId, text) => emit('submitEdit', messageId, text)"
      />
    </template>
  </div>
</template>
