<!-- 标签页：并列互斥的内容，一次只显示一页，默认选中第一页。
     选中页是纯视图状态：不写文档、不参与参数提交，文档改版（新工具结果）后回到第一页。
     键盘按 ARIA tabs 模式：左右方向键循环切换、Home / End 到首末页，焦点跟着选中页走；
     未选中的页签 tabindex=-1，否则一次 Tab 要穿过所有页签才能到内容。
     页内不允许 controls（解析期就拒绝），因此这里不涉及参数上下文。 -->
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { GenuiTabsNode } from '../../../../shared/genui-api'
import GenuiNode from './GenuiNode.vue'

const props = defineProps<{
  readonly node: GenuiTabsNode
}>()

const activeIndex = ref(0)
const idPrefix = useId()

const tabs = computed(() => props.node.items)

/** 页签与面板的 id 前缀按实例区分：同一份界面里可能有多组标签页。 */
function tabId(index: number): string {
  return `${idPrefix}-tab-${index}`
}

function panelId(index: number): string {
  return `${idPrefix}-panel-${index}`
}

/** 切页并把焦点交给新页签：键盘切换后继续按 Tab 就能进入该页内容。 */
function select(index: number): void {
  if (index < 0 || index >= tabs.value.length) return
  activeIndex.value = index
  document.getElementById(tabId(index))?.focus()
}

/** 键盘导航只处理四个键，其余交回浏览器（例如 Ctrl+Tab、屏幕阅读器快捷键）。 */
function onKeydown(event: KeyboardEvent, index: number): void {
  const last = tabs.value.length - 1
  switch (event.key) {
    case 'ArrowRight':
      select(index === last ? 0 : index + 1)
      break
    case 'ArrowLeft':
      select(index === 0 ? last : index - 1)
      break
    case 'Home':
      select(0)
      break
    case 'End':
      select(last)
      break
    default:
      return
  }
  event.preventDefault()
}

// 文档改版后页数与内容都换了，旧的选中下标可能指不到原来的页，回到第一页。
watch(() => props.node, () => {
  activeIndex.value = 0
})
</script>

<template>
  <div class="genui-tabs">
    <div class="genui-tabs-list" role="tablist" :aria-label="`界面分页：${tabs.map((item) => item.label).join(' / ')}`">
      <button
        v-for="(item, index) in tabs"
        :id="tabId(index)"
        :key="index"
        type="button"
        role="tab"
        class="genui-tabs-tab"
        :class="{ 'is-active': index === activeIndex }"
        :aria-selected="index === activeIndex"
        :aria-controls="panelId(index)"
        :tabindex="index === activeIndex ? 0 : -1"
        @click="select(index)"
        @keydown="onKeydown($event, index)"
      >{{ item.label }}</button>
    </div>
    <!-- 所有页都挂载、用 v-show 切换：隐藏页里的表格排序、折叠开合等视图状态切回来时还在。 -->
    <div
      v-for="(item, index) in tabs"
      v-show="index === activeIndex"
      :id="panelId(index)"
      :key="`panel-${index}`"
      role="tabpanel"
      class="genui-tabs-panel genui-stack"
      :aria-labelledby="tabId(index)"
      tabindex="0"
    >
      <GenuiNode v-for="(child, childIndex) in item.children" :key="childIndex" :node="child" />
    </div>
  </div>
</template>
