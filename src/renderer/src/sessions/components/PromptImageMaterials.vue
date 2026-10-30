<!-- 输入坞内图片附件展示与独立标注：缩略图与独立标注按钮均支持进入标注面板，在非破坏性操作期间保持可用，空状态不占位。 -->
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

const selected = computed(() => props.active && selectedKey.value === props.inputKey
  ? props.images.find(image => image.objectUrl === selectedUrl.value) ?? null : null)
const selectedDocument = computed(() => selected.value?.annotations ?? emptyImageAnnotations())

function openPicker(): void {
  if (!props.attachDisabled) imageInput.value?.click()
}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function itemError(image: PendingImage): string | null {
  return imageAnnotationError(image.annotations)
}

function hasAnnotations(image: PendingImage): boolean {
  const doc = image.annotations
  if (!doc) return false
  return doc.annotations.length > 0 || doc.overview.trim() !== ''
}

function annotationSummary(image: PendingImage): string {
  const doc = image.annotations
  if (!doc) return ''
  const parts: string[] = []
  if (doc.annotations.length > 0) parts.push(`${doc.annotations.length} 处标注`)
  if (doc.overview.trim() !== '') parts.push('有整图说明')
  return parts.length > 0 ? parts.join(' · ') : ''
}

watch(() => [props.inputKey, props.active] as const, () => {
  selectedUrl.value = null
})
watch(selected, image => {
  if (image === null) selectedUrl.value = null
})
</script>

<template>
  <input
    ref="imageInput"
    type="file"
    accept="image/png,image/jpeg,image/gif,image/webp"
    multiple
    class="sr-only"
    tabindex="-1"
    aria-label="选择图片附件"
    :disabled="attachDisabled"
    @change="picked"
  />

  <!-- 待发附件行：位于坞内输入框上方，无附件时不占位，有附件时横排展示并支持点击标注 -->
  <div v-if="images.length > 0" class="prompt-composer-attachments">
    <div
      v-for="image in images"
      :key="image.objectUrl"
      class="prompt-composer-attachment group transition-colors hover:border-desk-line-strong hover:bg-desk-surface"
      :class="itemError(image) !== null ? 'border-desk-danger/60' : ''"
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        :disabled="disabled"
        :aria-label="`编辑图片标注：${image.file.name}`"
        :title="`点击编辑图片标注：${image.file.name}`"
        @click="edit(image)"
      >
        <img :src="image.objectUrl" :alt="image.file.name" class="prompt-composer-attachment-thumb" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs text-desk-ink">{{ image.file.name }}</span>
          <span
            v-if="itemError(image) !== null"
            class="block truncate text-2xs text-desk-danger"
            role="status"
          >{{ itemError(image) }}</span>
          <span
            v-else-if="hasAnnotations(image)"
            class="block truncate text-2xs font-medium text-desk-accent"
          >{{ annotationSummary(image) }}</span>
          <span
            v-else
            class="block truncate text-2xs text-desk-muted group-hover:text-desk-muted-strong"
          >{{ formatBytes(image.file.size) }} · 点击标注</span>
        </span>
      </button>
      <AppButton
        variant="ghost"
        class="shrink-0 text-desk-muted hover:text-desk-accent px-1.5 py-0.5 text-2xs h-auto flex items-center gap-1"
        :disabled="disabled"
        :aria-label="`标注图片 ${image.file.name}`"
        :title="`打开标注面板：${image.file.name}`"
        @click="edit(image)"
      >
        <svg viewBox="0 0 16 16" class="h-3 w-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11.5 2.5l2 2-8 8H3.5v-2zM9.5 4.5l2 2" />
        </svg>
        <span>标注</span>
      </AppButton>
      <AppButton
        variant="ghost"
        class="shrink-0 text-desk-muted hover:text-desk-ink"
        :disabled="disabled"
        :aria-label="`移除图片 ${image.file.name}`"
        :title="`移除图片 ${image.file.name}`"
        @click="emit('remove', image.objectUrl)"
      >
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      </AppButton>
    </div>
  </div>

  <ImageAnnotationPanel
    v-if="selected"
    :open="true"
    :src="selected.objectUrl"
    :name="selected.file.name"
    :document="selectedDocument"
    :disabled="disabled"
    @change="change"
    @close="selectedUrl = null"
  />
</template>
