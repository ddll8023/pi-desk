<!-- Markdown 操作区：按编辑能力展示格式或只读原因，阅读选项集中提供，不以焦点外框暗示编辑状态。 -->
<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import { PREVIEW_FONT_SIZES } from '../stores/project-editor'
import type { MarkdownSurfaceState } from '../file-markdown-view'

const props = defineProps<{
  readonly active: boolean
  readonly state: MarkdownSurfaceState
  readonly sourceEditable: boolean
  readonly tocOpen: boolean
  readonly hasToc: boolean
  readonly fontSize: number
  readonly showFrontmatter: boolean
}>()
const emit = defineEmits<{
  toc: []
  source: []
  fontSize: [size: number]
  frontmatter: [show: boolean]
}>()
const contextText = computed(() => {
  if (props.state.phase === 'readonly') return props.state.reason
  if (props.state.phase === 'initializing') return '正在准备编辑器，暂不能输入。'
  return ''
})
const { trigger, popup, isOpen, position, toggle, close } = useAnchoredPopup({ width: 208, align: 'end' })
const popupStyle = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
watch(() => props.active, active => { if (!active) close() })
function changeSize(event: Event): void {
  if (!(event.target instanceof HTMLSelectElement)) return
  const size = Number(event.target.value)
  if (PREVIEW_FONT_SIZES.some(value => value === size)) emit('fontSize', size)
}
function closeAndFocus(): void { close(); trigger.value?.focus() }
function openOptions(): void {
  toggle()
  if (isOpen.value) void nextTick(() => popup.value?.querySelector<HTMLButtonElement>('button')?.focus())
}
function toggleFrontmatter(): void { emit('frontmatter', !props.showFrontmatter); closeAndFocus() }
</script>

<template>
  <div class="file-reader-toolbar" aria-label="Markdown 文档操作">
    <div class="file-reader-toolbar-group">
      <button
        type="button" class="file-reader-tool" data-toc-toggle
        :class="{ 'is-active': tocOpen }" :aria-pressed="tocOpen"
        :disabled="!active || !hasToc" @click="emit('toc')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>目录
      </button>
    </div>
    <div v-if="$slots.format" class="file-reader-format"><slot name="format"></slot></div>
    <div v-if="contextText" class="file-reader-context" :class="{ 'is-readonly': state.phase === 'readonly' }" role="status">
      <span>{{ contextText }}</span>
      <button
        v-if="state.phase === 'readonly' && sourceEditable"
        type="button" class="file-reader-tool file-reader-source" :disabled="!active" @click="emit('source')"
      >源码编辑</button>
    </div>
    <div class="file-reader-toolbar-group file-reader-options">
      <label class="file-reader-size">
        <span>字号</span>
        <select class="file-editor-font-size" :value="fontSize" :disabled="!active" aria-label="阅读字号" @change="changeSize">
          <option v-for="size in PREVIEW_FONT_SIZES" :key="size" :value="size">{{ size }} px</option>
        </select>
      </label>
      <button
        ref="trigger" type="button" class="file-reader-tool"
        aria-haspopup="dialog" :aria-expanded="isOpen" aria-label="阅读选项" title="阅读选项"
        :disabled="!active" @click="openOptions"
      >⋯</button>
    </div>
    <Teleport to="body">
      <div
        v-if="isOpen" ref="popup" class="project-sidebar-menu file-editor-menu" :style="popupStyle"
        role="dialog" tabindex="-1" aria-label="阅读选项" @keydown.esc.stop.prevent="closeAndFocus"
      >
        <button type="button" class="project-sidebar-menu-item file-editor-menu-item" :aria-pressed="showFrontmatter" @click="toggleFrontmatter">
          <span class="file-editor-menu-check" aria-hidden="true">{{ showFrontmatter ? '✓' : '' }}</span>显示 Front Matter
        </button>
      </div>
    </Teleport>
  </div>
</template>
