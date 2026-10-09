<!-- 需要用户确认的操作对话框：运行中切换带 allowInterrupt 重试，信任决定重置由调用方执行对应动作，取消不做任何改动。 -->
<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId, watch } from 'vue'
import AppButton from './ui/AppButton.vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
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

// 打开时聚焦对话框并接管 Escape；关闭时立即移除，避免同一页面多个实例重复响应。
watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => {
        // 焦点落在对话框本身，键盘用户按 Tab 先到取消按钮，不用 Enter 直接确认。
        panel.value?.focus()
      })
    } else {
      window.removeEventListener('keydown', onKeydown)
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div
      v-if="props.open"
      class="dialog-overlay"
      @click.self="emit('cancel')"
    >
      <Transition name="dialog-panel-motion" appear>
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
        <p class="detail-note">{{ detail }}</p>
      </div>
      <div class="dialog-footer">
        <AppButton @click="emit('cancel')">取消</AppButton>
        <AppButton variant="danger" @click="emit('confirm')">
          {{ confirmLabel }}
        </AppButton>
      </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
