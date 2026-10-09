<!-- 需要用户确认的操作对话框：运行中切换带 allowInterrupt 重试，信任决定重置由调用方执行对应动作，取消不做任何改动。 -->
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
    class="dialog-overlay"
    @click.self="emit('cancel')"
  >
    <div
      ref="panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      tabindex="-1"
      class="dialog-panel max-w-md"
    >
      <div class="dialog-header">
        <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
      </div>
      <div class="dialog-body">
        <p class="text-sm">{{ description }}</p>
        <p class="break-words font-mono text-xs text-desk-muted">{{ detail }}</p>
      </div>
      <div class="dialog-footer">
        <button type="button" class="control-button" @click="emit('cancel')">取消</button>
        <button type="button" class="control-button-danger" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
