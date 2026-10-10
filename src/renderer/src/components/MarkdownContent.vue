<!-- 消息与 Thinking 共用的安全 Markdown 展示；复制代码或链接就地反馈，不导航、不调用桌面桥接。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { copyText } from '../clipboard'
import { renderMarkdown } from '../markdown'

const props = defineProps<{
  readonly text: string
}>()

const html = computed(() => renderMarkdown(props.text))
const copyNotice = ref('')
const copyFailed = ref(false)
/** 文本更新、后续复制或卸载后，丢弃旧剪贴板操作的反馈，避免串到新内容。 */
let copyRevision = 0

watch(() => props.text, () => {
  copyRevision += 1
  copyNotice.value = ''
  copyFailed.value = false
})

onBeforeUnmount(() => {
  copyRevision += 1
})

/** v-html 不会编译 Vue 指令；在当前内容根节点代理原生复制按钮的点击。 */
async function onContentClick(event: MouseEvent): Promise<void> {
  const target = event.target
  const root = event.currentTarget
  if (!(target instanceof Element) || !(root instanceof HTMLElement)) return
  const button = target.closest('button')
  if (!(button instanceof HTMLButtonElement) || !root.contains(button)) return

  let text: string
  let label: string
  if (button.classList.contains('markdown-code-copy')) {
    const code = button.closest('.markdown-code-block')?.querySelector('pre > code')
    if (code === null || code === undefined) return
    // 只取实际代码节点，不把工具条、语言标签或复制反馈写进剪贴板。
    text = code.textContent ?? ''
    label = '代码'
  } else {
    const address = button.getAttribute('data-markdown-link')
    if (address === null) return
    text = address
    label = '链接地址'
  }

  event.preventDefault()
  const revision = ++copyRevision
  copyFailed.value = false
  copyNotice.value = `正在复制${label}…`
  const copied = await copyText(text)
  if (revision !== copyRevision) return
  copyFailed.value = !copied
  copyNotice.value = copied ? `${label}已复制。` : `无法复制${label}，请手动选择文本复制。`
}
</script>

<template>
  <div class="markdown-content">
    <!-- 唯一 HTML 注入点：只接收 renderMarkdown 经白名单清洗后的结果。 -->
    <div v-if="html !== null" class="markdown-body" @click="onContentClick" v-html="html"></div>
    <p v-else class="markdown-fallback">{{ text }}</p>
    <p v-if="html === null" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
    <p v-if="copyNotice !== ''" role="status" class="markdown-copy-notice" :class="{ 'is-error': copyFailed }">
      {{ copyNotice }}
    </p>
  </div>
</template>
