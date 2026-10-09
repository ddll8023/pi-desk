<!-- Extension notify 通知条：展示最近的通知（info/warning/error），可关闭；纯文本插值。 -->
<script setup lang="ts">
import { useExtensionUiStore } from '../stores/extension-ui'
import AppButton from './ui/AppButton.vue'

const extensionStore = useExtensionUiStore()

/** 通知类型的样式与可访问性等级；error 用 alert 语义。 */
function toneClass(notifyType: string): string {
  if (notifyType === 'error') return 'status-notice-error'
  if (notifyType === 'warning') return 'status-notice-warn'
  return 'status-notice-info'
}
</script>

<template>
  <div
    v-if="extensionStore.notifications.length > 0"
    class="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-4 pt-3 sm:px-6"
  >
    <TransitionGroup name="pop-motion">
      <div
        v-for="entry in extensionStore.notifications"
        :key="entry.id"
        :role="entry.notifyType === 'error' ? 'alert' : 'status'"
        class="status-notice flex items-start justify-between gap-2"
        :class="toneClass(entry.notifyType)"
      >
        <span class="whitespace-pre-wrap break-words">{{ entry.message }}</span>
        <AppButton
          variant="ghost"
          class="-mr-1 shrink-0 px-1"
          aria-label="关闭通知"
          @click="extensionStore.dismissNotification(entry.id)"
        >
          ×
        </AppButton>
      </div>
    </TransitionGroup>
  </div>
</template>
