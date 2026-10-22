<!-- 本地 Unicode 表情选择器：分类与中英文搜索不联网，插入位置随原选区映射，不添加图片资产。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { captureRichInsertion } from '../file-rich-markdown-image-insert'
import { useAnchoredPopup } from '../ui/anchored-popup'
interface EmojiItem { unicode: string; label: string; search: string; group: number }
const props = defineProps<{ editor: Editor; left: number; top: number }>()
const emit = defineEmits<{ close: []; notice: [message: string] }>()
const target = captureRichInsertion(props.editor, () => true)
const activeEmoji = ref(0)
const query = ref(''); const category = ref(-1); const emojis = ref<EmojiItem[]>([]); const error = ref(''); const loading = ref(true)
const input = ref<HTMLInputElement | null>(null)
const groups = [{ id: -1, label: '全部' }, { id: 0, label: '笑脸' }, { id: 1, label: '人物' }, { id: 3, label: '动物' }, { id: 4, label: '食物' }, { id: 5, label: '旅行' }, { id: 6, label: '活动' }, { id: 7, label: '物品' }, { id: 8, label: '符号' }, { id: 9, label: '旗帜' }]
const filtered = computed(() => emojis.value.filter(item => (category.value < 0 || item.group === category.value) && item.search.includes(query.value.trim().toLocaleLowerCase())))
const { trigger, popup, position, open, update } = useAnchoredPopup({ width: 330, minHeight: 150, maxHeightCap: 380, onClose: () => emit('close') })
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
let disposed = false
function rows(value: unknown): EmojiItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const data = item as Record<string,unknown>
    const unicode = typeof data.unicode === 'string' ? data.unicode : typeof data.emoji === 'string' ? data.emoji : ''
    const label = typeof data.annotation === 'string' ? data.annotation : typeof data.label === 'string' ? data.label : unicode
    const group = typeof data.group === 'number' ? data.group : -1
    return unicode && group !== 2 ? [{ unicode, label, group, search: `${unicode} ${label} ${Array.isArray(data.tags) ? data.tags.join(' ') : ''}`.toLocaleLowerCase() }] : []
  })
}
async function load(): Promise<void> {
  try {
    const [zh, en] = await Promise.all([import('emojibase-data/zh/compact.json'), import('emojibase-data/en/compact.json')])
    if (disposed) return
    const english = new Map(rows(en.default).map(item => [item.unicode, item.search]))
    emojis.value = rows(zh.default).map(item => ({ ...item, search: `${item.search} ${english.get(item.unicode) ?? ''}` }))
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (!disposed) loading.value = false }
}
function choose(item: EmojiItem): void {
  const range = target.range()
  if (!range) { emit('notice', '原插入位置已失效。'); emit('close'); return }
  if (range.cell) props.editor.chain().focus().command(({ tr }) => { range.cell?.replaceWith(tr, props.editor.schema.text(item.unicode)); return true }).run()
  else props.editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, { type: 'text', text: item.unicode }).run()
  emit('close')
}
function gridKey(event: KeyboardEvent): void {
  if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return
  const buttons = Array.from(popup.value?.querySelectorAll<HTMLButtonElement>('.file-rich-emoji-grid button') ?? [])
  const index = buttons.findIndex(button => button === document.activeElement)
  if (index < 0) {
    if (event.key === 'ArrowDown' && event.target === input.value) { event.preventDefault(); activeEmoji.value = 0; buttons[0]?.focus() }
    return
  }
  event.preventDefault()
  const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -8 : 8
  activeEmoji.value = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + step))
  buttons[activeEmoji.value]?.focus()
}
watch([query, category], () => { activeEmoji.value = 0 })
watch(() => [props.left, props.top], () => void nextTick(update))
onMounted(() => { open(); void load(); void nextTick(() => input.value?.focus()) })
onBeforeUnmount(() => { disposed = true; target.release() })
</script>
<template>
  <Teleport to="body"><span ref="trigger" class="file-rich-caret-anchor" :style="{ left: `${left}px`, top: `${top}px` }"></span>
    <div ref="popup" class="file-rich-emoji-picker" :style="style" role="dialog" aria-label="插入表情" @keydown.esc.prevent.stop="emit('close')" @keydown="gridKey">
      <input ref="input" v-model="query" aria-label="搜索表情" placeholder="搜索表情…" autocomplete="off">
      <nav aria-label="表情分类"><button v-for="group in groups" :key="group.id" type="button" :aria-pressed="category === group.id" @click="category = group.id">{{ group.label }}</button></nav>
      <p v-if="error" role="alert">{{ error }}<button type="button" @click="error = ''; loading = true; load()">重试</button></p>
      <p v-else-if="loading" role="status">正在加载表情…</p>
      <p v-else-if="!filtered.length" role="status">没有匹配的表情。</p>
      <div class="file-rich-emoji-grid scroll-area"><button v-for="(item,index) in filtered" :key="item.unicode" type="button" :tabindex="index === activeEmoji ? 0 : -1" :aria-label="item.label" :title="item.label" @mousedown.prevent @click="choose(item)">{{ item.unicode }}</button></div>
    </div>
  </Teleport>
</template>
