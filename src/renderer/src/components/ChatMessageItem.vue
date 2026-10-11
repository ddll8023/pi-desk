<!-- 单条消息：Assistant 卡片展示独立生成耗时，按 contentIndex 承载正文、Thinking 与工具块；Thinking 默认折叠且仅手动开合，保留用户内容、截断与失败提示。 -->
<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { ChatMessageView } from '../chat-view'
import { formatDuration, useTickingNow } from '../clock'
import MarkdownContent from './MarkdownContent.vue'
import ToolCard from './ToolCard.vue'

const props = defineProps<{
  readonly message: ChatMessageView
}>()

/** 手动选择只保留在当前消息组件中；重新进入聊天或切换会话后恢复初始折叠。 */
const thinkingOverrides = reactive(new Map<string, boolean>())

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'Assistant'))
const isUser = computed(() => props.message.role === 'user')
const generation = computed(() => props.message.generation)
/** 仅生成中的 AI 消息订阅共享刻度，结束后使用主进程给出的固定时刻。 */
const now = useTickingNow(() => generation.value?.phase === 'running')

const generationText = computed(() => {
  const current = generation.value
  if (current === null) return '耗时未记录'
  const duration = formatDuration((current.endedAt ?? now.value) - current.startedAt)
  if (current.phase === 'running') return `生成中 ${duration}`
  return current.phase === 'interrupted' ? `已中断 · ${duration}` : `生成耗时 ${duration}`
})

/** 未手动调整的块一律折叠；流式更新不改变单个块的手动选择。 */
function isThinkingExpanded(key: string): boolean {
  return thinkingOverrides.get(key) ?? false
}

/** 由 summary 的点击统一控制开合，键盘激活同样生效。 */
function toggleThinking(key: string): void {
  thinkingOverrides.set(key, !isThinkingExpanded(key))
}
</script>

<template>
  <article class="chat-message" :class="isUser ? 'chat-message-user' : 'chat-message-assistant'">
    <header class="chat-meta">
      <span v-if="!isUser" class="chat-role-mark" aria-hidden="true">π</span>
      <span class="chat-role">{{ roleLabel }}</span>
      <span v-if="message.time || !isUser" class="chat-time inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        <span v-if="message.time">{{ message.time }}</span>
        <span
          v-if="!isUser"
          class="font-mono"
          title="按客户端事件计时；生成中更新，消息结束、事件配对中断或 Agent 收敛时固定；历史无记录不推算。"
        >{{ generationText }}</span>
      </span>
    </header>

    <template v-for="block in message.blocks" :key="block.key">
      <template v-if="block.kind === 'text'">
        <!-- 图片附件仍只来自用户消息的本地附件，不交给 Markdown 解析。 -->
        <img
          v-if="block.image !== null"
          :src="block.image.dataUrl"
          :alt="`附件图片（${block.image.mimeType}）`"
          class="max-h-48 self-end rounded-desk-md border border-desk-line object-contain"
        />
        <div
          v-if="block.text !== '' || block.image === null"
          :class="isUser ? 'chat-bubble chat-bubble-user self-end' : 'chat-assistant-content'"
        >
          <p v-if="isUser">{{ block.text }}</p>
          <MarkdownContent v-else :text="block.text" />
          <p v-if="block.truncated" class="chat-truncation-note">此内容超出展示上限，已截断。</p>
        </div>
      </template>

      <!-- 历史与流式内容均初始折叠；手动开合只影响当前块。 -->
      <details
        v-else-if="block.kind === 'thinking'"
        :open="isThinkingExpanded(block.key)"
        class="chat-thinking self-start w-full"
      >
        <summary @click.prevent="toggleThinking(block.key)">
          <span class="disclosure"></span>
          <span>Thinking</span>
          <span class="chat-thinking-hint">思考过程</span>
        </summary>
        <div class="chat-thinking-body">
          <MarkdownContent :text="block.text" />
          <p v-if="block.truncated" class="tool-note">此内容超出展示上限，已截断。</p>
        </div>
      </details>

      <ToolCard v-else-if="block.kind === 'toolcall'" :block="block" class="self-start w-full" />
    </template>

    <p v-if="message.failure" role="alert" class="status-notice status-notice-error self-start">
      {{ message.failure }}
    </p>
  </article>
</template>
