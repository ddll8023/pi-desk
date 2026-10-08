<!-- 运行中切换的确认对话框：只有用户确认后才由调用方带 allowInterrupt 重试，取消不做任何改动，也不中断正在运行的操作。 -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, useId } from 'vue'

defineProps<{
  readonly title: string
  readonly description: string
  readonly detail: string
  readonly confirmLabel: string
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('cancel')
}

onMounted(() => {
  // 焦点落在对话框本身，键盘用户按 Tab 先到取消按钮，不用 Enter 直接确认。
  panel.value?.focus()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-desk-ink/40 p-4"
    @click.self="emit('cancel')"
  >
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      class="panel w-full max-w-md shadow-lg"
    >
      <h2 :id="titleId" class="section-heading mb-2">{{ title }}</h2>
      <p class="mb-2 text-sm">{{ description }}</p>
      <p class="mb-5 break-words font-mono text-xs text-desk-muted">{{ detail }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="control-button" @click="emit('cancel')">取消</button>
        <button type="button" class="control-button-danger" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
