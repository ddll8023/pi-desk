<!-- 结构化代码块：可搜索语言选择、代码复制，以及编辑源码下方的安全 Mermaid 实时预览。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import AppSelect from '../ui/AppSelect.vue'
import { copyText } from '../ui/clipboard'
import { renderRichDiagram } from '../file-rich-markdown-diagram'
const props = defineProps(nodeViewProps)
const languageId = useId()
const theme = window.matchMedia('(prefers-color-scheme: dark)')
const language = computed(() => String(props.node.attrs.language ?? ''))
const source = computed(() => props.node.textContent)
const preview = ref<HTMLElement | null>(null)
const previewError = ref('')
const previewLoading = ref(false)
const copyLabel = ref('复制代码')
const languages = ['javascript','typescript','jsx','tsx','python','java','c','cpp','csharp','go','rust','ruby','php','swift','kotlin','scala','shellscript','bash','powershell','sql','json','yaml','toml','xml','html','css','scss','less','markdown','dockerfile','makefile','diff','ini','lua','r','perl','dart','vue','svelte','graphql','plaintext','mermaid']
const groups = computed(() => [{ options: [{ value: '', label: '纯文本' }, ...languages.map(value => ({ value, label: value })), ...(!languages.includes(language.value) && language.value ? [{ value: language.value, label: language.value }] : [])] }])
let timer: number | null = null
let copyTimer: number | null = null
let generation = 0
let disposed = false
function select(value: string): void { props.updateAttributes({ language: value || null }); props.editor.commands.focus(undefined, { scrollIntoView: false }) }
async function copy(): Promise<void> { copyLabel.value = await copyText(source.value) ? '已复制' : '复制失败'; if (copyTimer !== null) clearTimeout(copyTimer); copyTimer = window.setTimeout(() => { copyLabel.value = '复制代码' }, 1600) }
function schedule(): void {
  generation += 1
  if (timer !== null) clearTimeout(timer)
  if (language.value.toLowerCase() !== 'mermaid') { previewLoading.value = false; previewError.value = ''; return }
  timer = window.setTimeout(() => { timer = null; void render() }, 220)
}
async function render(): Promise<void> {
  const current = ++generation
  previewError.value = ''; previewLoading.value = true
  try {
    const svg = await renderRichDiagram(source.value, theme.matches, () => !disposed && current === generation)
    if (disposed || current !== generation) return
    await nextTick()
    if (disposed || current !== generation || !preview.value) return
    const shadow = preview.value.shadowRoot ?? preview.value.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>:host{display:block;overflow:auto}svg{display:block;max-width:100%;height:auto;margin:auto}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}</style>${svg}`
  } catch (error) { if (!disposed && current === generation) { previewError.value = error instanceof Error ? error.message : String(error); preview.value?.shadowRoot?.replaceChildren() } }
  finally { if (!disposed && current === generation) previewLoading.value = false }
}
watch([source, language], schedule)
onMounted(() => { schedule(); theme.addEventListener('change', schedule) })
onBeforeUnmount(() => { disposed = true; generation += 1; if (timer !== null) clearTimeout(timer); if (copyTimer !== null) clearTimeout(copyTimer); theme.removeEventListener('change', schedule) })
</script>
<template>
  <NodeViewWrapper class="markdown-code-block file-rich-code-block">
    <div class="file-rich-code-controls" contenteditable="false">
      <button type="button" class="file-rich-icon" :aria-label="copyLabel" :title="copyLabel" @mousedown.prevent @click="copy">{{ copyLabel === '已复制' ? '✓' : '⧉' }}</button>
      <AppSelect :id="`code-language-${languageId}`" label="代码语言" style="width:126px;min-height:24px;padding:2px 6px" :groups="groups" :model-value="language" searchable search-placeholder="搜索语言…" @update:model-value="select" />
    </div>
    <pre><NodeViewContent as="code" /></pre>
    <div v-if="language.toLowerCase() === 'mermaid'" class="file-rich-diagram" contenteditable="false" :aria-busy="previewLoading">
      <p v-if="previewError" role="status">{{ previewError }}</p><p v-else-if="previewLoading" role="status">正在生成图表…</p>
      <div ref="preview" aria-label="Mermaid 图表预览"></div>
    </div>
  </NodeViewWrapper>
</template>
