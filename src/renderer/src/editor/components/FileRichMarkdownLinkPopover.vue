<!-- 选区链接编辑气泡：支持地址、显示文字、移除与复制，异步浮层不借用后来移动的选区。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Editor } from '@tiptap/core'
import { useAnchoredPopup } from '../../ui/anchored-popup'
import { captureRichInsertion } from '../file-rich-markdown-image-insert'
import { copyText } from '../../ui/clipboard'
const props = defineProps<{ editor: Editor; left: number; top: number }>()
const emit = defineEmits<{ close: [restoreFocus: boolean]; notice: [message: string] }>()
const editor = props.editor
const existing = editor.isActive('link')
if (existing) editor.commands.extendMarkRange('link')
const target = captureRichInsertion(editor, () => true)
const original = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '')
const address = ref(String(editor.getAttributes('link').href ?? ''))
const label = ref(original)
const error = ref('')
const input = ref<HTMLInputElement | null>(null)
const { trigger, popup, position, open, update } = useAnchoredPopup({ width: 340, minHeight: 100, onClose: () => emit('close', false) })
const style = computed(() => ({ left: `${position.value.left}px`, top: `${position.value.top}px`, width: `${position.value.width}px`, maxHeight: `${position.value.maxHeight}px` }))
function apply(): void {
  const href = address.value.trim()
  if (!href || href.length > 2048 || /[\u0000-\u001f]/.test(href) || /^(?:\/\/|[a-z][a-z0-9+.-]*:)/i.test(href) && !/^(https?:|mailto:)/i.test(href)) { error.value = '请输入网页地址、邮件地址、标题锚点或项目内相对路径。'; return }
  const range = target.range()
  if (!range) { error.value = '原选区已变化，请重新选择。'; return }
  if (label.value !== original || range.from === range.to) editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, { type: 'text', text: label.value || href, marks: [{ type: 'link', attrs: { href } }] }).run()
  else editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).setLink({ href }).run()
  emit('close', false)
}
function remove(): void { const range = target.range(); if (range) editor.chain().focus().setTextSelection({ from: range.from, to: range.to }).unsetLink().run(); emit('close', false) }
async function copy(): Promise<void> { emit('notice', await copyText(address.value) ? '链接地址已复制。' : '无法复制链接地址。') }
watch(() => [props.left, props.top], () => void nextTick(update))
onMounted(() => { open(); void nextTick(() => { input.value?.focus(); input.value?.select() }) })
onBeforeUnmount(target.release)
</script>
<template>
  <Teleport to="body">
    <span ref="trigger" class="file-rich-caret-anchor" :style="{ left: `${left}px`, top: `${top}px` }"></span>
    <form ref="popup" class="file-rich-link-popover" :style="style" role="dialog" aria-label="编辑链接" @submit.prevent="apply" @keydown.esc.prevent.stop="emit('close', true)">
      <label>链接地址<input ref="input" v-model="address" placeholder="https:// 或文档路径" autocomplete="off" spellcheck="false"></label>
      <label>显示文字<input v-model="label" placeholder="链接文字" autocomplete="off"></label>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="file-rich-popover-actions"><button v-if="existing" type="button" @click="remove">移除链接</button><button type="button" :disabled="!address" @click="copy">复制地址</button><span></span><button type="button" @click="emit('close', true)">取消</button><button type="submit">应用</button></div>
    </form>
  </Teleport>
</template>
