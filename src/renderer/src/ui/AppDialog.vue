<!--
  通用对话对话框外壳：遮罩、面板、头部标题与可选的底部操作区。

  只负责弹层本身的生命周期：`open` 变化时接管 Escape、把焦点移进面板，关闭后把焦点还给打开它的元素；
  遮罩点击与 Escape 都发出 `close`，由调用方决定是否允许关闭（保存进行中可忽略）。
  视觉沿用 ui.css 的 dialog-* 类与 dialog-fade／dialog-panel-motion 过渡，不另造一套弹层外观。
  正文与底部操作由插槽提供，本组件不持有任何业务状态。
-->
<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId, watch } from 'vue'

const props = defineProps<{
  /** 弹层由父级常驻挂载，`open` 控制进入/退出与焦点、快捷键生命周期。 */
  readonly open: boolean
  /** 面板标题，同时作为 `aria-labelledby` 的目标。 */
  readonly title: string
  /** 标题下的一句话说明；省略时不占位。 */
  readonly subtitle?: string
  /** 面板宽度类，如 `max-w-xl`；省略时按内容自适应。 */
  readonly panelClass?: string
}>()

const emit = defineEmits<{
  close: []
}>()

defineSlots<{
  /** 弹层正文。 */
  default?: () => unknown
  /** 头部右侧的附加操作（关闭入口等）。 */
  headerActions?: () => unknown
  /** 底部操作区；未提供时不渲染。 */
  footer?: () => unknown
}>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
/** 打开前的焦点元素；关闭后把焦点还给它。 */
let opener: HTMLElement | null = null

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

function attach(): void {
  const active = document.activeElement
  opener = active instanceof HTMLElement ? active : null
  window.addEventListener('keydown', onKeydown)
  void nextTick(() => { panel.value?.focus() })
}

function detach(): void {
  window.removeEventListener('keydown', onKeydown)
  const target = opener
  opener = null
  // 打开它的元素可能已被移除（例如列表项被删），此时不强行把焦点挪走。
  if (target !== null && target.isConnected) target.focus()
}

// 打开时接管 Escape 与焦点，关闭时立刻归还：同一页面可能有多个常驻实例，不能叠着响应。
watch(() => props.open, open => {
  if (open) attach()
  else detach()
}, { immediate: true })

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Transition name="dialog-fade">
    <div v-if="props.open" class="dialog-overlay" @click.self="emit('close')">
      <Transition name="dialog-panel-motion" appear>
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          class="dialog-panel"
          :class="props.panelClass"
        >
          <div class="dialog-header">
            <div>
              <h2 :id="titleId" class="dialog-title">{{ props.title }}</h2>
              <p v-if="props.subtitle !== undefined && props.subtitle !== ''" class="dialog-subtitle">
                {{ props.subtitle }}
              </p>
            </div>
            <slot name="headerActions" />
          </div>

          <div class="dialog-body">
            <slot />
          </div>

          <div v-if="$slots.footer !== undefined" class="dialog-footer">
            <slot name="footer" />
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>
