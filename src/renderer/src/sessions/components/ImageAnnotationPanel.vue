<!-- 独立图片批注面板：编号与说明双向定位，编辑即时留在原图片资料中，不操作提示词。 -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue'
import { IMAGE_ANNOTATION_MAX_COUNT, IMAGE_ANNOTATION_OVERVIEW_MAX_CHARS,
  IMAGE_ANNOTATION_TEXT_MAX_CHARS, imageAnnotationError } from '../../../../shared/image-annotation'
import type { ImageAnnotation, ImageAnnotationDocument } from '../../../../shared/image-annotation'
import AppButton from '../../ui/AppButton.vue'
import ImageAnnotationCanvas from './ImageAnnotationCanvas.vue'

const props = defineProps<{
  readonly open: boolean
  readonly src: string
  readonly name: string
  readonly document: ImageAnnotationDocument
  readonly disabled: boolean
}>()
const emit = defineEmits<{ close: []; change: [document: ImageAnnotationDocument] }>()
const panel = ref<HTMLElement | null>(null)
const notes = ref<HTMLElement | null>(null)
const canvas = ref<InstanceType<typeof ImageAnnotationCanvas> | null>(null)
const mode = ref<'point' | 'rect'>('point')
const selectedId = ref<number | null>(null)
const titleId = useId()
let previousFocus: HTMLElement | null = null
const error = computed(() => imageAnnotationError(props.document))
const full = computed(() => props.document.annotations.length >= IMAGE_ANNOTATION_MAX_COUNT)

function focusNote(id: number): void {
  selectedId.value = id
  void nextTick(() => {
    const target = notes.value?.querySelector<HTMLTextAreaElement>(`[data-annotation="${id}"]`)
    target?.focus()
  })
}
function focusMarker(id: number): void {
  selectedId.value = id
  canvas.value?.focus()
}
function add(area: Pick<ImageAnnotation, 'kind' | 'x' | 'y' | 'width' | 'height'>): void {
  if (props.disabled || full.value) return
  const id = props.document.nextId
  emit('change', { ...props.document, nextId: id + 1,
    annotations: [...props.document.annotations, { id, ...area, text: '' }] })
  focusNote(id)
}
function update(item: ImageAnnotation): void {
  if (props.disabled) return
  emit('change', { ...props.document,
    annotations: props.document.annotations.map(current => current.id === item.id ? item : current) })
}
function updateText(item: ImageAnnotation, event: Event): void {
  const target = event.target
  if (target instanceof HTMLTextAreaElement) update({ ...item, text: target.value })
}
function overview(event: Event): void {
  const target = event.target
  if (!props.disabled && target instanceof HTMLTextAreaElement) emit('change', { ...props.document, overview: target.value })
}
function remove(id: number): void {
  if (props.disabled) return
  const annotations = props.document.annotations.filter(item => item.id !== id)
  emit('change', { ...props.document, annotations })
  if (selectedId.value === id) selectedId.value = annotations[0]?.id ?? null
}
function keydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !panel.value) return
  const controls = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0)
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); panel.value.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) {
    event.preventDefault(); first.focus()
  }
}
watch(() => [props.open, props.src] as const, ([open]) => {
  if (open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    selectedId.value = props.document.annotations[0]?.id ?? null
    void nextTick(() => panel.value?.focus())
  } else previousFocus?.focus()
}, { immediate: true })
onUnmounted(() => { if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-overlay" @keydown="keydown" @click.self="emit('close')">
      <section ref="panel" class="dialog-panel" style="max-width: 72rem; height: min(46rem, 90vh); max-height: 90vh"
        role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
        <header class="dialog-header">
          <div class="min-w-0"><h2 :id="titleId" class="dialog-title">图片标注</h2><p class="dialog-subtitle truncate">{{ name }}</p></div>
          <AppButton aria-label="关闭图片标注" @click="emit('close')">关闭</AppButton>
        </header>
        <div class="image-annotation-layout min-h-0 flex-1">
          <div class="flex min-h-0 min-w-0 flex-col bg-desk-canvas-sunken p-4">
            <div class="mb-3 flex shrink-0 flex-wrap items-center gap-2" role="toolbar" aria-label="图片标注工具">
              <AppButton :variant="mode === 'point' ? 'primary' : 'default'" :aria-pressed="mode === 'point'" :disabled="disabled" @click="mode = 'point'">点标注</AppButton>
              <AppButton :variant="mode === 'rect' ? 'primary' : 'default'" :aria-pressed="mode === 'rect'" :disabled="disabled" @click="mode = 'rect'">框选</AppButton>
              <span class="text-xs text-desk-muted">{{ document.annotations.length }} / {{ IMAGE_ANNOTATION_MAX_COUNT }}{{ full ? ' · 已达标注数量上限' : '' }}</span>
            </div>
            <div class="scroll-area flex min-h-0 flex-1 items-center justify-center overflow-auto">
              <ImageAnnotationCanvas ref="canvas" :src="src" :alt="name" :document="document" :selected-id="selectedId" :readonly="false"
                :disabled="disabled" :mode="mode" max-height="min(52vh, 30rem)"
                @create="add" @select="focusNote" @change="update" />
            </div>
            <p class="mt-3 text-xs leading-5 text-desk-muted">点击或框选添加标记；选择“调整位置”后用方向键微调，Shift 加方向键调整框选大小。删除标注不改变其他编号。</p>
          </div>
          <aside ref="notes" class="scroll-area min-h-0 min-w-0 space-y-4 overflow-y-auto border-l border-desk-line p-4" aria-label="图片标注说明">
            <div><label :for="`${titleId}-overview`" class="mb-1.5 block text-xs font-medium">整图说明</label>
              <textarea :id="`${titleId}-overview`" :value="document.overview" :disabled="disabled" rows="3"
                :maxlength="IMAGE_ANNOTATION_OVERVIEW_MAX_CHARS" class="text-control w-full resize-y text-xs"
                placeholder="对整张图片的说明或问题（可选）" @input="overview" /></div>
            <p v-if="document.annotations.length === 0" class="text-xs leading-5 text-desk-muted">在左侧图片上添加标记，这里会出现对应编号的说明。</p>
            <section v-for="item in document.annotations" :key="item.id" class="rounded-desk-md border p-3"
              :class="selectedId === item.id ? 'border-desk-accent bg-desk-accent-soft' : 'border-desk-line'">
              <div class="mb-2 flex items-center justify-between gap-2">
                <label :for="`${titleId}-${item.id}`" class="text-xs font-semibold">{{ item.id }} · {{ item.kind === 'point' ? '点标注' : '区域标注' }}</label>
                <div class="flex items-center gap-1">
                  <AppButton variant="compact" :disabled="disabled" :aria-label="`调整标注 ${item.id} 的位置`" @click="focusMarker(item.id)">调整位置</AppButton>
                  <AppButton variant="quiet-danger" :disabled="disabled" :aria-label="`删除标注 ${item.id} 及说明`" @click="remove(item.id)">删除</AppButton>
                </div>
              </div>
              <textarea :id="`${titleId}-${item.id}`" :data-annotation="item.id" :value="item.text" :disabled="disabled"
                :maxlength="IMAGE_ANNOTATION_TEXT_MAX_CHARS" rows="4" class="text-control w-full resize-y text-xs"
                placeholder="填写这里发生的事情、需要注意的问题或希望修改的内容"
                @focus="selectedId = item.id" @input="updateText(item, $event)" />
            </section>
          </aside>
        </div>
        <footer class="dialog-footer items-center">
          <p class="mr-auto text-xs" :class="error ? 'text-desk-danger' : 'text-desk-muted'" role="status">{{ error ?? '修改已留在当前图片资料中，将随提示词一起提交。' }}</p>
          <AppButton variant="primary" @click="emit('close')">完成标注</AppButton>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.image-annotation-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 23rem); overflow: hidden; }
@media (max-width: 760px) {
  .image-annotation-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
  .image-annotation-layout > aside { border-left: 0; border-top: 1px solid var(--color-desk-line); }
}
</style>
