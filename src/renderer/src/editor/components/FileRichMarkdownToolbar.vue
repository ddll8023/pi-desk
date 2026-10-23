<!-- 文档工具区内的格式控件：只消费格式状态并发送命令，不持有 Editor 或管理正文生命周期。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { MarkdownFormatState } from '../file-markdown-view'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import type { RichCommandId } from '../file-rich-markdown-commands'
const props = defineProps<{ state: MarkdownFormatState }>()
const emit = defineEmits<{ command: [id: RichCommandId] }>()
const toolbar = ref<HTMLElement | null>(null)
const groups: readonly (readonly { id: RichCommandId; label: string; icon: string }[])[] = [
  [{ id: 'paragraph', label: '正文', icon: '¶' }, { id: 'h1', label: '标题 1', icon: 'H1' }, { id: 'h2', label: '标题 2', icon: 'H2' }, { id: 'h3', label: '标题 3', icon: 'H3' }],
  [{ id: 'bold', label: '加粗', icon: 'B' }, { id: 'italic', label: '斜体', icon: 'I' }, { id: 'strike', label: '删除线', icon: 'S' }],
  [{ id: 'bullet', label: '无序列表', icon: '☷' }, { id: 'ordered', label: '有序列表', icon: '1.' }, { id: 'task', label: '任务清单', icon: '☑' }],
  [{ id: 'quote', label: '引用', icon: '❞' }, { id: 'link', label: '链接', icon: '↗' }, { id: 'image', label: '插入图片', icon: '▧' }]
]
function active(id: RichCommandId): boolean { return props.state.active.includes(id) }
const { trigger, popup, isOpen, position, toggle, close } = useAnchoredPopup({ width: 190, align: 'end' })
const popupStyle = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
watch(() => props.state.enabled, enabled => { if (!enabled) close() })
function more(id: RichCommandId): void { close(); emit('command', id) }
function openMore(): void { toggle(); if (isOpen.value) void nextTick(() => popup.value?.querySelector<HTMLButtonElement>('button')?.focus()) }
function menuKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); trigger.value?.focus(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(popup.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function keydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(toolbar.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
</script>
<template>
  <div ref="toolbar" class="file-rich-toolbar" role="toolbar" aria-label="Markdown 格式" @keydown="keydown">
    <div v-for="(group, index) in groups" :key="index" class="file-rich-toolbar-group">
      <button v-for="item in group" :key="item.id" type="button" class="file-rich-icon" :class="[`is-${item.id}`, { 'is-active': active(item.id) }]" :aria-label="item.label" :title="item.label" :aria-pressed="active(item.id)" :disabled="!state.enabled" @mousedown.prevent @click="emit('command', item.id)">{{ item.icon }}</button>
    </div>
    <button ref="trigger" type="button" class="file-rich-icon" aria-label="更多块" title="更多块" :aria-expanded="isOpen" :disabled="!state.enabled" @mousedown.prevent @click="openMore">⋯</button>
    <Teleport to="body"><div v-if="isOpen" ref="popup" class="file-rich-action-menu" :style="popupStyle" role="menu" aria-label="更多块" @keydown="menuKey">
      <p class="file-rich-menu-group">标题</p>
      <button type="button" role="menuitem" @mousedown.prevent @click="more('h4')">H4　标题 4</button>
      <button type="button" role="menuitem" @mousedown.prevent @click="more('h5')">H5　标题 5</button>
      <hr><button type="button" role="menuitem" @mousedown.prevent @click="more('toggle')">▸　折叠段落</button>
    </div></Teleport>
  </div>
</template>
