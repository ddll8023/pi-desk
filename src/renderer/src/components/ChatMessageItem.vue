<!-- 单条消息：Assistant 以整条轻卡片承载正文、Thinking 与工具块，按 contentIndex 保持顺序；Thinking 遵循默认偏好与本次展示的手动开合，保留用户内容、截断与失败提示。 -->
<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { ChatMessageView } from '../chat-view'
import { usePreferencesStore } from '../stores/preferences'
import MarkdownContent from './MarkdownContent.vue'
import ToolCard from './ToolCard.vue'

const props = defineProps<{
  readonly message: ChatMessageView
}>()

const preferencesStore = usePreferencesStore()
/** 手动选择只保留在当前消息组件中；重新进入聊天后按已保存的默认值恢复。 */
const thinkingOverrides = reactive(new Map<string, boolean>())

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'Assistant'))
const isUser = computed(() => props.message.role === 'user')

/** 未手动调整的块跟随默认值；流式更新不改变单个块的手动选择。 */
function isThinkingExpanded(key: string): boolean {
  return thinkingOverrides.get(key) ?? preferencesStore.thinkingDefaultExpanded
}

/** 由 summary 的点击统一控制开合，键盘激活同样生效，避免默认展开被误记成手动操作。 */
function toggleThinking(key: string): void {
  thinkingOverrides.set(key, !isThinkingExpanded(key))
}
</script>

<template>
  <article class="chat-message" :class="isUser ? 'chat-message-user' : 'chat-message-assistant'">
    <header class="chat-meta">
      <span v-if="!isUser" class="chat-role-mark" aria-hidden="true">π</span>
      <span class="chat-role">{{ roleLabel }}</span>
      <span v-if="message.time" class="chat-time">{{ message.time }}</span>
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

      <!-- 默认状态对历史与流式内容一致生效；手动开合只覆盖当前块。 -->
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
