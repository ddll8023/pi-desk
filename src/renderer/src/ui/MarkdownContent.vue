<!-- 消息、Thinking 与技能卡正文共用的安全 Markdown 展示，公式在清洗后由 KaTeX 就地渲染；复制代码或链接就地反馈，不导航、不调用桌面桥接。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copyText } from './clipboard'
import { renderMarkdown } from './markdown'
import { renderMathInto } from './markdown-math'

const props = defineProps<{
  readonly text: string
}>()

const html = computed(() => renderMarkdown(props.text))
/** 正文容器；v-html 写入后由它定位公式占位元素。 */
const body = ref<HTMLElement | null>(null)
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

/** 只在 DOM 已写入本次 html 之后渲染公式；占位元素不在本次结果里时不做任何事。 */
function renderMath(): void {
  if (body.value === null) return
  renderMathInto(body.value)
}

watch(html, renderMath, { flush: 'post' })
onMounted(renderMath)

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
    <!-- 唯一 HTML 注入点：只接收 renderMarkdown 经白名单清洗后的结果；公式节点由 KaTeX 就地构建，不经字符串注入。 -->
    <div v-if="html !== null" ref="body" class="markdown-body" @click="onContentClick" v-html="html"></div>
    <p v-else class="markdown-fallback">{{ text }}</p>
    <p v-if="html === null" role="status" class="markdown-render-note">Markdown 暂时无法渲染，已显示原文。</p>
    <p v-if="copyNotice !== ''" role="status" class="markdown-copy-notice" :class="{ 'is-error': copyFailed }">
      {{ copyNotice }}
    </p>
  </div>
</template>
