<!-- Extension notify 通知条：展示最近的通知（info/warning/error），可关闭；纯文本插值。 -->
<script setup lang="ts">
import { useExtensionUiStore } from '../stores/extension-ui'

const extensionStore = useExtensionUiStore()

/** 通知类型的样式与可访问性等级；error 用 alert 语义。 */
function toneClass(notifyType: string): string {
  if (notifyType === 'error') return 'border-desk-danger text-desk-danger'
  if (notifyType === 'warning') return 'border-desk-warning text-desk-warning'
  return 'border-desk-line text-desk-muted'
}
</script>

<template>
  <div v-if="extensionStore.notifications.length > 0" class="space-y-1 px-4 sm:px-8">
    <div
      v-for="entry in extensionStore.notifications"
      :key="entry.id"
      :role="entry.notifyType === 'error' ? 'alert' : 'status'"
      class="flex items-start justify-between gap-2 rounded border px-2 py-1 text-xs"
      :class="toneClass(entry.notifyType)"
    >
      <span class="whitespace-pre-wrap break-words">{{ entry.message }}</span>
      <button
        type="button"
        class="shrink-0 text-desk-muted hover:text-desk-ink"
        aria-label="关闭通知"
        @click="extensionStore.dismissNotification(entry.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>
