<!-- 单条消息：按 contentIndex 顺序渲染内容块，用户消息靠右、Assistant 消息在左侧，用户消息的图片附件渲染为缩略图，Thinking 可折叠，失败按错误提示内联展示。 -->
<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import type { ChatMessageView } from '../chat-view'
import ToolCard from './ToolCard.vue'

const props = defineProps<{
  readonly message: ChatMessageView
  /** 该消息是否属于正在运行的一轮；用于让 Thinking 在流式期间自动展开。 */
  readonly streaming: boolean
}>()

/** 已在流式期间展开过的 Thinking 块；本轮结束后不再自动收起，交给用户决定。 */
const expandedThinking = reactive(new Set<string>())

const roleLabel = computed(() => (props.message.role === 'user' ? '你' : 'Assistant'))
const isUser = computed(() => props.message.role === 'user')

// 只记录流式期间首次出现的块；用户手动开合不会被后续更新覆盖（`open` 值不变时不会重设 DOM 属性）。
watch(
  () => props.message.blocks.map((block) => (block.kind === 'thinking' ? block.key : '')),
  (keys) => {
    if (!props.streaming) return
    for (const key of keys) {
      if (key !== '') expandedThinking.add(key)
    }
  },
  { immediate: true }
)
</script>

<template>
  <article class="flex flex-col gap-2">
    <header class="flex flex-wrap items-baseline gap-2 text-xs text-desk-muted">
      <span class="font-medium">{{ roleLabel }}</span>
      <span v-if="message.time">{{ message.time }}</span>
    </header>

    <template v-for="block in message.blocks" :key="block.key">
      <!-- 图片附件：只来自用户消息的本地附件，data URL 经 CSP 的 img-src data: 放行。 -->
      <img
        v-if="block.kind === 'text' && block.image !== null"
        :src="block.image.dataUrl"
        :alt="`附件图片（${block.image.mimeType}）`"
        class="max-h-48 self-end rounded-md border border-desk-line object-contain"
      />
      <p
        v-if="block.kind === 'text' && (block.text !== '' || block.image === null)"
        class="chat-bubble"
        :class="isUser ? 'self-end bg-desk-accent text-white' : 'self-start border border-desk-line bg-desk-surface-raised'"
      >
        {{ block.text }}
      </p>

      <!-- 流式期间自动展开，之后保持展开状态；用户手动收起后不再自动打开。 -->
      <details
        v-else-if="block.kind === 'thinking'"
        :open="expandedThinking.has(block.key)"
        class="self-start rounded-md border border-desk-line bg-desk-canvas-sunken px-3 py-2"
      >
        <summary class="text-xs text-desk-muted">Thinking</summary>
        <p class="mt-2 whitespace-pre-wrap break-words text-sm">{{ block.text }}</p>
        <p v-if="block.truncated" class="mt-1 text-xs text-desk-muted">此内容超出展示上限，已截断。</p>
      </details>

      <ToolCard v-else-if="block.kind === 'toolcall'" :block="block" class="self-start w-full" />
    </template>

    <p v-if="message.failure" role="alert" class="self-start text-sm text-desk-danger">
      {{ message.failure }}
    </p>
  </article>
</template>
