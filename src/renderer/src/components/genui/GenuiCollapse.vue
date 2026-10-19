<!-- 折叠容器：把次要内容收进可展开的分组，默认收起，open:true 才默认展开。
     开合是纯视图状态：不写文档、不参与参数提交，也不跨挂载记住；文档改版（新工具结果）后回到声明值。
     用原生 details / summary 而不是自己实现按钮加隐藏：键盘、读屏与展开状态都由浏览器给出，
     再造一套只会多出一处会与原生语义走偏的地方。组内不允许 controls（解析期就拒绝），
     因此这里不涉及参数上下文，也不存在「收起后参数看不见却仍被提交」的情况。 -->
<script setup lang="ts">
import { ref, watch } from 'vue'
import type { GenuiCollapseNode } from '../../../../shared/genui-api'
import GenuiNode from './GenuiNode.vue'

const props = defineProps<{
  readonly node: GenuiCollapseNode
}>()

/**
 * 文档改版计数：`<details>` 的 open 由用户点击直接改 DOM 属性，值没变时 Vue 不会重新 patch，
 * 旧的开合状态会留在新版本上。文档换了就让分组重挂载，回到这一版声明的开合，
 * 与表格的排序筛选、标签页的选中页同口径（都是「改版即重置」）。
 */
const revisionToken = ref(0)

watch(() => props.node, () => {
  revisionToken.value += 1
})
</script>

<template>
  <div class="genui-collapse">
    <details
      v-for="(item, index) in node.items"
      :key="`${revisionToken}-${index}`"
      class="genui-collapse-item"
      :open="item.open === true"
    >
      <summary class="genui-collapse-summary">
        <span class="genui-collapse-title">{{ item.title }}</span>
        <svg class="genui-collapse-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </summary>
      <div class="genui-stack genui-collapse-body">
        <GenuiNode v-for="(child, childIndex) in item.children" :key="childIndex" :node="child" />
      </div>
    </details>
  </div>
</template>
