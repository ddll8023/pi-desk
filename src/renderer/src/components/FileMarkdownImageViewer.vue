<!-- 文件阅读的大图查看器：原生模态对话框负责背景隔离与焦点边界，只展示正文已加载的项目内图片。 -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  readonly image: { readonly src: string; readonly alt: string } | null
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let returnFocus: HTMLElement | null = null

watch(() => props.image, async () => {
  await nextTick()
  const element = dialog.value
  const image = props.image
  if (element === null || !element.isConnected) return
  if (image !== null && !element.open) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.showModal()
    element.querySelector<HTMLButtonElement>('button')?.focus()
  } else if (image === null && element.open) {
    element.close()
  }
}, { immediate: true })

function restoreFocus(): void {
  if (dialog.value?.open) return
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
  returnFocus = null
  emit('close')
}

/** 只有点到对话框外的原生遮罩才关闭，不把图片周边的滚动操作当成关闭。 */
function onBackdrop(event: MouseEvent): void {
  if (event.target !== dialog.value || dialog.value === null) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close')
}

onBeforeUnmount(() => {
  dialog.value?.close()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="file-markdown-image-viewer"
      :aria-label="image?.alt ? `图片：${image.alt}` : '图片查看器'"
      @cancel.prevent="emit('close')"
      @close="restoreFocus"
      @click="onBackdrop"
    >
      <header class="file-markdown-image-viewer-header">
        <span>{{ image?.alt || '图片' }}</span>
        <button type="button" aria-label="关闭图片" title="关闭（Esc）" @click="emit('close')">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div class="file-markdown-image-viewer-body">
        <img v-if="image !== null" :src="image.src" :alt="image.alt">
      </div>
    </dialog>
  </Teleport>
</template>
