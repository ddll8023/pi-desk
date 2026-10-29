<!-- 图片批注画面：在原图上叠加编号和选区，编辑与只读展示共用坐标系，不改写图片像素。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ImageAnnotation, ImageAnnotationDocument } from '../../../../shared/image-annotation'

const props = withDefaults(defineProps<{
  readonly src: string
  readonly alt: string
  readonly document?: ImageAnnotationDocument
  readonly selectedId?: number | null
  readonly readonly?: boolean
  readonly disabled?: boolean
  readonly mode?: 'point' | 'rect'
  readonly maxHeight?: string
}>(), { selectedId: null, readonly: true, disabled: false, mode: 'point', maxHeight: '55vh' })
const emit = defineEmits<{
  select: [id: number]
  create: [area: Pick<ImageAnnotation, 'kind' | 'x' | 'y' | 'width' | 'height'>]
  change: [annotation: ImageAnnotation]
}>()
const stage = ref<HTMLElement | null>(null)
defineExpose({ focus: () => stage.value?.focus() })
const loaded = ref(false)
const failed = ref(false)
const naturalSize = ref({ width: 1, height: 1 })
const start = ref<{ x: number; y: number } | null>(null)
const cursor = ref<{ x: number; y: number } | null>(null)
const editable = computed(() => !props.readonly && !props.disabled && loaded.value && !failed.value)
const items = computed(() => props.document?.annotations ?? [])
const dragRect = computed(() => {
  if (!start.value || !cursor.value || props.mode !== 'rect') return null
  return { x: Math.min(start.value.x, cursor.value.x), y: Math.min(start.value.y, cursor.value.y),
    width: Math.abs(cursor.value.x - start.value.x), height: Math.abs(cursor.value.y - start.value.y) }
})
watch(() => props.src, () => { loaded.value = false; failed.value = false; start.value = null; cursor.value = null })
watch(() => [props.disabled, props.readonly, props.mode] as const, () => { start.value = null; cursor.value = null })

function onLoad(event: Event): void {
  const image = event.target
  if (!(image instanceof HTMLImageElement)) return
  naturalSize.value = { width: Math.max(1, image.naturalWidth), height: Math.max(1, image.naturalHeight) }
  loaded.value = true
  failed.value = false
}
function position(event: PointerEvent): { x: number; y: number } | null {
  const bounds = stage.value?.getBoundingClientRect()
  if (!bounds?.width || !bounds.height) return null
  return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }
}
function pointerDown(event: PointerEvent): void {
  if (!editable.value || event.button !== 0) return
  event.preventDefault()
  start.value = position(event)
  cursor.value = start.value
  stage.value?.focus()
  stage.value?.setPointerCapture(event.pointerId)
}
function pointerUp(event: PointerEvent): void {
  const first = start.value
  const last = position(event)
  start.value = null
  cursor.value = null
  if (!editable.value || !first || !last) return
  if (props.mode === 'point') {
    emit('create', { kind: 'point', x: first.x, y: first.y, width: 0, height: 0 })
  } else {
    const width = Math.abs(first.x - last.x)
    const height = Math.abs(first.y - last.y)
    if (width < 0.005 || height < 0.005) return
    emit('create', { kind: 'rect', x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width, height })
  }
}
function keydown(event: KeyboardEvent): void {
  if (!editable.value) return
  if (event.key === 'Enter' && event.target === stage.value) {
    event.preventDefault()
    emit('create', { kind: props.mode, x: props.mode === 'point' ? 0.5 : 0.4,
      y: props.mode === 'point' ? 0.5 : 0.4, width: props.mode === 'point' ? 0 : 0.2,
      height: props.mode === 'point' ? 0 : 0.2 })
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  const item = items.value.find(item => item.id === props.selectedId)
  if (!item) return
  event.preventDefault()
  const dx = (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0) / naturalSize.value.width
  const dy = (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0) / naturalSize.value.height
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
  emit('change', event.shiftKey && item.kind === 'rect'
    ? { ...item, width: clamp(item.width + dx, Math.min(1 / naturalSize.value.width, 1 - item.x), 1 - item.x),
      height: clamp(item.height + dy, Math.min(1 / naturalSize.value.height, 1 - item.y), 1 - item.y) }
    : { ...item, x: clamp(item.x + dx, 0, 1 - item.width), y: clamp(item.y + dy, 0, 1 - item.height) })
}
</script>

<template>
  <div class="min-w-0 max-w-full">
    <p v-if="failed" role="alert" class="text-xs text-desk-danger">图片无法显示，请重新导入。</p>
    <div ref="stage" class="relative inline-block max-w-full align-top leading-none focus-visible:outline-2 focus-visible:outline-desk-accent"
      :class="editable ? 'touch-none cursor-crosshair select-none' : ''" :tabindex="readonly || disabled ? undefined : 0"
      role="group" :aria-label="readonly ? alt : `${alt}，回车添加标注，方向键移动选中标记，Shift 加方向键调整框选大小`"
      @pointerdown="pointerDown" @pointermove="start && (cursor = position($event))" @pointerup="pointerUp"
      @pointercancel="start = null; cursor = null" @keydown="keydown">
      <img :src="src" :alt="alt" class="block h-auto max-w-full rounded-desk-sm" :style="{ maxHeight }"
        draggable="false" @load="onLoad" @error="failed = true; loaded = false" />
      <svg v-if="loaded && !failed" class="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        <rect v-for="item in items.filter(item => item.kind === 'rect')" :key="item.id"
          :x="item.x * 1000" :y="item.y * 1000" :width="item.width * 1000" :height="item.height * 1000"
          fill="none" :stroke="item.id === selectedId ? 'var(--color-desk-accent)' : 'var(--color-desk-danger)'"
          :stroke-width="item.id === selectedId ? 3 : 2" vector-effect="non-scaling-stroke" />
        <rect v-if="dragRect" :x="dragRect.x * 1000" :y="dragRect.y * 1000" :width="dragRect.width * 1000" :height="dragRect.height * 1000"
          fill="none" stroke="var(--color-desk-accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <template v-if="loaded && !failed">
        <button v-for="item in items" :key="item.id" type="button"
          class="absolute flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-desk-surface px-1 text-xs font-semibold leading-none shadow-desk-raise"
          :class="item.id === selectedId ? 'bg-desk-accent text-desk-on-accent' : 'bg-desk-danger text-desk-surface'"
          :style="{ left: `clamp(0px, calc(${item.x * 100}% - 12px), calc(100% - 24px))`, top: `clamp(0px, calc(${item.y * 100}% - 12px), calc(100% - 24px))` }"
          :aria-label="`标注 ${item.id}：${item.text || '未填写说明'}`" :aria-pressed="item.id === selectedId" :disabled="disabled"
          @pointerdown.stop @pointerup.stop @click.stop="emit('select', item.id)">{{ item.id }}</button>
      </template>
    </div>
  </div>
</template>
