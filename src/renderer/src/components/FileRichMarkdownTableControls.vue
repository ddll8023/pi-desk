<!-- 表格行列悬浮入口与右键菜单；目标随文档变更失效，不依赖随后移动的光标。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import { useAnchoredPopup } from '../anchored-popup'
import { canRunTableAction, richTableActions, runTableAction, tableCellPosition } from '../file-rich-markdown-table'
import type { RichTableAction } from '../file-rich-markdown-table'
const props = defineProps<{ editor: Editor; active: boolean }>()
const cell = ref<number | null>(null)
const hovered = ref<HTMLTableCellElement | null>(null)
const geometry = ref({ left: 0, top: 0, row: 0, column: 0 })
const anchor = ref({ left: 0, top: 0 })
const target = ref<number | null>(null)
const { trigger, popup, position, isOpen, open, close } = useAnchoredPopup({ width: 210, minHeight: 70, maxHeightCap: 380 })
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
function update(): void {
  const element = hovered.value
  if (!props.active || !element?.isConnected) { hovered.value = null; return }
  const rect = element.getBoundingClientRect(); const table = element.closest('table')?.getBoundingClientRect()
  const clip = props.editor.view.dom.closest('.file-markdown-scroll')?.getBoundingClientRect()
  if (!table || (clip && (rect.bottom < clip.top || rect.top > clip.bottom))) { hovered.value = null; return }
  geometry.value = { left: table.left - 20, top: Math.max(table.top - 18, clip?.top ?? 0), row: rect.top + rect.height / 2 - 10, column: rect.left + rect.width / 2 - 10 }
}
function outside(event: PointerEvent): void {
  if (isOpen.value || !(event.target instanceof Element)) return
  if (!event.target.closest('.file-rich-table-handle') && !hovered.value?.closest('table')?.contains(event.target)) hovered.value = null
}
function hover(event: MouseEvent): void {
  if (isOpen.value || !(event.target instanceof Element)) return
  const element = event.target.closest<HTMLTableCellElement>('td,th')
  if (!element) { if (!hovered.value?.closest('table')?.contains(event.target)) hovered.value = null; return }
  const position = tableCellPosition(props.editor, element)
  if (position === null) return
  cell.value = position; hovered.value = element; update()
}
function menu(left: number, top: number, position: number): void {
  target.value = position; anchor.value = { left, top }
  void nextTick(() => { open(); void nextTick(() => popup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()) })
}
function context(event: MouseEvent): void {
  if (!(event.target instanceof Element)) return
  const position = tableCellPosition(props.editor, event.target)
  if (position === null) return
  event.preventDefault(); menu(event.clientX, event.clientY, position)
}
function openFromButton(event: MouseEvent): void {
  if (!(event.currentTarget instanceof HTMLElement) || cell.value === null) return
  const rect = event.currentTarget.getBoundingClientRect(); menu(rect.left, rect.bottom, cell.value)
}
function run(action: RichTableAction): void { if (target.value !== null) runTableAction(props.editor, action, target.value); close(); hovered.value = null }
function changed({ transaction }: { transaction: Transaction }): void { if (transaction.docChanged) { close(); hovered.value = null } }
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); close(); props.editor.commands.focus(undefined, { scrollIntoView: false }); return }
  if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(popup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
watch(() => props.active, active => { if (!active) { hovered.value = null; close() } })
onMounted(() => { props.editor.view.dom.addEventListener('mousemove', hover); props.editor.view.dom.addEventListener('contextmenu', context); props.editor.on('transaction', changed); window.addEventListener('scroll', update, true); window.addEventListener('resize', update); window.addEventListener('pointermove', outside) })
onBeforeUnmount(() => { if (!props.editor.isDestroyed) { props.editor.view.dom.removeEventListener('mousemove', hover); props.editor.view.dom.removeEventListener('contextmenu', context); props.editor.off('transaction', changed) }; window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); window.removeEventListener('pointermove', outside) })
</script>
<template>
  <Teleport to="body">
    <template v-if="active && hovered">
      <button type="button" class="file-rich-table-handle" :style="{ left: `${geometry.left}px`, top: `${geometry.row}px` }" aria-label="行操作" title="行操作" @mousedown.prevent @click="openFromButton">⋮</button>
      <button type="button" class="file-rich-table-handle" :style="{ left: `${geometry.column}px`, top: `${geometry.top}px` }" aria-label="列操作" title="列操作" @mousedown.prevent @click="openFromButton">⋯</button>
    </template>
    <span ref="trigger" class="file-rich-caret-anchor" :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"></span>
    <div v-if="isOpen" ref="popup" class="file-rich-action-menu" :style="style" role="menu" aria-label="表格操作" @keydown="keydown">
      <button v-for="action in richTableActions" :key="action.id" type="button" role="menuitem" :disabled="target === null || !canRunTableAction(editor, action.id, target)" :class="{ 'is-danger': action.id.includes('delete') }" @mousedown.prevent @click="run(action.id)">{{ action.label }}</button>
    </div>
  </Teleport>
</template>
