<!-- 工具结果的有界语义预览：只渲染投影提供的范围、数量、命中内容和来源，不解析原文或触发查询。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { ToolResultPresentation } from '../../../../shared/runtime-api'
import { toolResultHeadline } from '../tool-summary'

const props = defineProps<{ readonly result: ToolResultPresentation }>()
const headline = computed(() => toolResultHeadline(props.result))
</script>

<template>
  <section class="tool-result-preview" aria-label="工具结果摘要" :aria-busy="result.outcome === 'partial'">
    <div class="tool-result-heading">
      <span class="tool-result-title" :class="{ 'text-desk-danger': result.outcome === 'error' }">{{ headline }}</span>
      <span v-if="result.hasMore === true" class="tool-result-flag">还有更多结果</span>
      <span v-if="result.truncated" class="tool-result-flag">工具报告截断</span>
      <span v-if="result.outcome === 'partial'" class="tool-result-flag">非最终结果</span>
    </div>
    <p v-if="result.summary && (result.returnedCount !== null || result.totalCount !== null)" class="tool-note">{{ result.summary }}</p>
    <dl v-if="result.facts.length > 0" class="tool-args-summary tool-result-facts">
      <template v-for="entry in result.facts" :key="entry.label">
        <dt class="tool-arg-key">{{ entry.label }}</dt>
        <dd class="tool-arg-value">{{ entry.value }}</dd>
      </template>
    </dl>
    <ol v-if="result.items.length > 0" class="tool-result-list">
      <li v-for="(item, index) in result.items" :key="`${item.location ?? ''}:${item.title}:${index}`" class="tool-result-item">
        <p class="tool-result-item-title">{{ item.title }}</p>
        <p v-if="item.location" class="tool-result-location font-mono">{{ item.location }}</p>
        <p v-if="item.meta" class="tool-result-meta">{{ item.meta }}</p>
        <p v-if="item.excerpt" class="tool-result-excerpt">{{ item.excerpt }}</p>
        <p v-if="item.evidence" class="tool-result-evidence">{{ item.evidence }}</p>
      </li>
    </ol>
    <p v-if="result.note" class="tool-note">{{ result.note }}</p>
    <p v-if="result.previewTruncated" class="tool-note">这里只显示部分条目或短摘要；其余内容可展开原始结果查看。</p>
  </section>
</template>
