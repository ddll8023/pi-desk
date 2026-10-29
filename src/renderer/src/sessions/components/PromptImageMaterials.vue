<!-- 提示词输入框外的图片资料区：导入、移除与独立标注；图片说明不进入提示词编辑器。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { emptyImageAnnotations, imageAnnotationError } from '../../../../shared/image-annotation'
import type { ImageAnnotationDocument } from '../../../../shared/image-annotation'
import type { PendingImage } from '../stores/session-view'
import AppButton from '../../ui/AppButton.vue'
import ImageAnnotationPanel from './ImageAnnotationPanel.vue'

const props = defineProps<{
  readonly images: readonly PendingImage[]
  readonly inputKey: string
  readonly active: boolean
  readonly disabled: boolean
  readonly attachDisabled: boolean
}>()
const emit = defineEmits<{
  add: [files: readonly File[]]
  remove: [objectUrl: string]
  change: [objectUrl: string, document: ImageAnnotationDocument]
}>()
const imageInput = ref<HTMLInputElement | null>(null)
const selectedUrl = ref<string | null>(null)
const selectedKey = ref<string | null>(null)
const dragging = ref(false)
const selected = computed(() => props.active && selectedKey.value === props.inputKey
  ? props.images.find(image => image.objectUrl === selectedUrl.value) ?? null : null)
const selectedDocument = computed(() => selected.value?.annotations ?? emptyImageAnnotations())
const error = computed(() => {
  for (const image of props.images) {
    const problem = imageAnnotationError(image.annotations)
    if (problem !== null) return `${image.file.name}：${problem}`
  }
  return null
})
function openPicker(): void { if (!props.attachDisabled) imageInput.value?.click() }
defineExpose({ openPicker })
function picked(event: Event): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!props.attachDisabled) emit('add', files)
}
function edit(image: PendingImage): void {
  if (props.disabled) return
  selectedKey.value = props.inputKey
  selectedUrl.value = image.objectUrl
}
function change(document: ImageAnnotationDocument): void {
  const image = selected.value
  if (image && !props.disabled) emit('change', image.objectUrl, document)
}
function paste(event: ClipboardEvent): void {
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'))
  if (files.length === 0) return
  event.preventDefault()
  if (!props.attachDisabled) emit('add', files)
}
function drag(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  if (!props.attachDisabled) dragging.value = true
}
function leave(event: DragEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(next)) return
  dragging.value = false
}
function drop(event: DragEvent): void {
  dragging.value = false
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  if (!props.attachDisabled) emit('add', [...event.dataTransfer.files].filter(file => file.type.startsWith('image/')))
}
watch(() => [props.inputKey, props.active] as const, () => { selectedUrl.value = null; dragging.value = false })
watch(selected, image => { if (image === null) selectedUrl.value = null })
</script>

<template>
  <section class="mb-3 rounded-desk-md border p-3" :class="dragging ? 'border-desk-accent bg-desk-accent-soft' : 'border-desk-line bg-desk-surface'"
    tabindex="0" aria-label="图片资料，可粘贴或拖入图片" @paste="paste" @dragenter="drag" @dragover="drag"
    @dragleave="leave" @drop="drop">
    <input ref="imageInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple class="sr-only"
      tabindex="-1" aria-label="选择图片资料" :disabled="attachDisabled" @change="picked" />
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2"><h3 class="text-xs font-medium">图片资料</h3><span class="text-2xs text-desk-muted">{{ images.length }} / 4</span></div>
      <AppButton variant="compact" :disabled="attachDisabled" @click="openPicker">添加图片</AppButton>
    </div>
    <p v-if="images.length === 0" class="mt-2 text-xs text-desk-muted">在这里添加、粘贴或拖入图片，标注与说明独立编辑，随提示词一起提交。</p>
    <ul v-else class="mt-2 grid gap-2 sm:grid-cols-2">
      <li v-for="image in images" :key="image.objectUrl" class="flex min-w-0 items-center gap-2 rounded-desk-sm border border-desk-line p-2">
        <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="disabled" :aria-label="`编辑图片标注：${image.file.name}`" @click="edit(image)">
          <img :src="image.objectUrl" :alt="image.file.name" class="h-12 w-14 shrink-0 rounded-desk-sm object-contain" />
          <span class="min-w-0"><span class="block truncate text-xs">{{ image.file.name }}</span>
            <span class="mt-1 block text-2xs text-desk-muted">{{ image.annotations?.annotations.length ?? 0 }} 处标注{{ image.annotations?.overview.trim() ? ' · 有整图说明' : '' }} · 点击编辑</span></span>
        </button>
        <AppButton variant="ghost" :disabled="disabled" :aria-label="`移除图片 ${image.file.name} 及标注`" @click="emit('remove', image.objectUrl)">移除</AppButton>
      </li>
    </ul>
    <p v-if="error" class="mt-2 text-xs text-desk-danger" role="status">{{ error }}</p>
  </section>
  <ImageAnnotationPanel v-if="selected" :open="true" :src="selected.objectUrl" :name="selected.file.name"
    :document="selectedDocument" :disabled="disabled" @change="change" @close="selectedUrl = null" />
</template>
