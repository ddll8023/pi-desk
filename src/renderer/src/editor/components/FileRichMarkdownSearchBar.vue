<!-- 不挤动正文的查找替换浮层：选项与替换都交给编辑事务，受保护节点不作为可替换文本。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { replaceRichSearch, richSearchState, updateRichSearch } from '../file-rich-markdown-search'
const props = defineProps<{ editor: Editor; replace: boolean }>()
const emit = defineEmits<{ close: [] }>()
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const replacement = ref('')
const expanded = ref(props.replace)
const caseSensitive = ref(false)
const wholeWord = ref(false)
const revision = ref(0)
const placement = ref({ left: '0px', top: '0px', width: '480px' })
const positioned = ref(false)
let resizeObserver: ResizeObserver | null = null
function position(): void {
  const rect = props.editor.view.dom.closest('.file-markdown-scroll')?.getBoundingClientRect()
  if (!rect) return
  const width = Math.max(220, Math.min(500, rect.width - 24))
  placement.value = { left: `${Math.max(8, rect.right - width - 12)}px`, top: `${Math.max(8, rect.top + 8)}px`, width: `${width}px` }
  positioned.value = true
}
function focus(): void { input.value?.focus(); input.value?.select() }
defineExpose({ focus })
const state = computed(() => { void revision.value; return richSearchState(props.editor) })
const status = computed(() => !query.value ? '' : `${state.value?.matches.length ? (state.value.options.active + 1) : 0}/${state.value?.matches.length ?? 0}${state.value?.truncated ? '+' : ''}`)
function refresh(): void { revision.value += 1 }
function search(active = 0, reveal = true): void { updateRichSearch(props.editor, { query: query.value, caseSensitive: caseSensitive.value, wholeWord: wholeWord.value, active }, reveal) }
function move(step: number): void { const total = state.value?.matches.length ?? 0; if (total) search(((state.value?.options.active ?? 0) + step + total) % total) }
function replace(all: boolean): void { replaceRichSearch(props.editor, replacement.value, all); move(0) }
function keydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
  if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1) }
}
watch([query, caseSensitive, wholeWord], () => search())
watch(() => props.replace, value => { if (value) expanded.value = true; void nextTick(() => input.value?.focus()) })
onMounted(() => {
  props.editor.on('transaction', refresh); position(); void nextTick(focus)
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true)
  const scroller = props.editor.view.dom.closest('.file-markdown-scroll')
  if (scroller) { resizeObserver = new ResizeObserver(position); resizeObserver.observe(scroller) }
})
onBeforeUnmount(() => { resizeObserver?.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); props.editor.off('transaction', refresh); if (!props.editor.isDestroyed) updateRichSearch(props.editor, { query: '', caseSensitive: false, wholeWord: false, active: 0 }) })
</script>
<template>
  <Teleport to="body"><div v-if="positioned" class="file-rich-search" :style="placement" role="search" aria-label="查找和替换" @keydown="keydown">
    <button type="button" class="file-rich-icon" :aria-expanded="expanded" aria-label="展开替换" @click="expanded = !expanded">{{ expanded ? '⌄' : '›' }}</button>
    <div class="file-rich-search-rows">
      <div class="file-rich-search-row">
        <input ref="input" v-model="query" aria-label="查找内容" placeholder="查找" autocomplete="off" spellcheck="false">
        <button type="button" class="file-rich-icon" :aria-pressed="caseSensitive" title="区分大小写" aria-label="区分大小写" @click="caseSensitive = !caseSensitive">Aa</button>
        <button type="button" class="file-rich-icon" :aria-pressed="wholeWord" title="全词匹配" aria-label="全词匹配" @click="wholeWord = !wholeWord">ab</button>
        <span class="file-rich-search-status" role="status">{{ status }}</span>
        <button type="button" class="file-rich-icon" :disabled="!state?.matches.length" aria-label="上一个匹配" @click="move(-1)">↑</button>
        <button type="button" class="file-rich-icon" :disabled="!state?.matches.length" aria-label="下一个匹配" @click="move(1)">↓</button>
        <button type="button" class="file-rich-icon" aria-label="关闭查找" @click="emit('close')">×</button>
      </div>
      <div v-if="expanded" class="file-rich-search-row">
        <input v-model="replacement" aria-label="替换内容" placeholder="替换" autocomplete="off" spellcheck="false">
        <button type="button" :disabled="!state?.matches.length" @click="replace(false)">替换</button>
        <button type="button" :disabled="!state?.matches.length || state.truncated" @click="replace(true)">全部替换</button>
      </div>
      <p v-if="state?.truncated" role="status">匹配过多，请缩小范围；全部替换暂不可用。</p>
    </div>
  </div></Teleport>
</template>
