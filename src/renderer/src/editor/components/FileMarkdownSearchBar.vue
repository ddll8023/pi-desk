<!-- Markdown 共用查找界面：只传递用户意图，DOM 匹配和 ProseMirror 替换由当前视图处理。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { MarkdownSearchQuery, MarkdownSearchStatus } from '../file-markdown-view'

const props = defineProps<{
  readonly query: MarkdownSearchQuery
  readonly status: MarkdownSearchStatus
  readonly canReplace: boolean
  readonly replace: boolean
}>()
const emit = defineEmits<{
  query: [query: MarkdownSearchQuery]
  move: [step: number]
  replace: [text: string, all: boolean]
  close: []
}>()
const input = ref<HTMLInputElement | null>(null)
const replacement = ref('')
const expanded = ref(props.replace)
const statusText = computed(() => !props.query.query ? '' : props.status.total ? `${props.status.active + 1}/${props.status.total}${props.status.truncated ? '+' : ''}` : '无结果')
function focus(): void { input.value?.focus(); input.value?.select() }
function changeQuery(event: Event): void {
  if (event.target instanceof HTMLInputElement) emit('query', { ...props.query, query: event.target.value })
}
function toggleOption(key: 'caseSensitive' | 'wholeWord'): void { emit('query', { ...props.query, [key]: !props.query[key] }) }
function keydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close') }
  if (event.key === 'Enter') { event.preventDefault(); emit('move', event.shiftKey ? -1 : 1) }
}
watch(() => props.replace, value => { expanded.value = value; void nextTick(focus) })
watch(() => props.canReplace, value => { if (!value) expanded.value = false })
onMounted(() => void nextTick(focus))
defineExpose({ focus })
</script>

<template>
  <div class="file-markdown-search" role="search" aria-label="在文档中查找" @keydown="keydown">
    <div class="file-markdown-search-row">
      <button v-if="canReplace" type="button" class="file-markdown-search-button" :aria-expanded="expanded" aria-label="展开或收起替换" @click="expanded = !expanded">{{ expanded ? '⌄' : '›' }}</button>
      <input ref="input" :value="query.query" class="file-markdown-search-input" aria-label="查找内容" placeholder="查找" autocomplete="off" spellcheck="false" @input="changeQuery">
      <template v-if="canReplace">
        <button type="button" class="file-markdown-search-button" :aria-pressed="query.caseSensitive" aria-label="区分大小写" title="区分大小写" @click="toggleOption('caseSensitive')">Aa</button>
        <button type="button" class="file-markdown-search-button" :aria-pressed="query.wholeWord" aria-label="全词匹配" title="全词匹配" @click="toggleOption('wholeWord')">ab</button>
      </template>
      <span class="file-markdown-search-status" role="status">{{ statusText }}</span>
      <button type="button" class="file-markdown-search-button" :disabled="!status.total" aria-label="上一个匹配" @click="emit('move', -1)">↑</button>
      <button type="button" class="file-markdown-search-button" :disabled="!status.total" aria-label="下一个匹配" @click="emit('move', 1)">↓</button>
      <button type="button" class="file-markdown-search-button" aria-label="关闭查找" @click="emit('close')">×</button>
    </div>
    <div v-if="canReplace && expanded" class="file-markdown-search-row">
      <input v-model="replacement" class="file-markdown-search-input" aria-label="替换内容" placeholder="替换" autocomplete="off" spellcheck="false">
      <button type="button" class="file-reader-tool" :disabled="!status.total" @click="emit('replace', replacement, false)">替换</button>
      <button type="button" class="file-reader-tool" :disabled="!status.total || status.truncated" @click="emit('replace', replacement, true)">全部替换</button>
    </div>
    <p v-if="status.truncated" class="file-markdown-search-note" role="status">匹配过多，请缩小范围；全部替换暂不可用。</p>
  </div>
</template>
