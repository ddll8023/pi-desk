<!-- 用量构成条：把四个 token 分项的占比画成一条横向堆叠条。
     概览的总量构成与分布行内的模型、项目构成共用它，保证两处的分项顺序与颜色一致。
     段宽用 grid 的 fr 分配，只取决于容器宽度；极小分项靠 minmax 的 2px 下限保底，
     段间再用 1px 卡片底色隔开，避免小分项在窄容器里被抹掉。
     只负责画：分母、占比文本与数值都由 usage-stats-view 先算好，这里不做任何取整或补算。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { CompositionSegment } from '../usage-stats-view'

const props = defineProps<{
  /** 构成段，顺序即绘制顺序；占比为 0 的段不画。 */
  readonly segments: readonly CompositionSegment[]
  /** 条高：md 用于概览，sm 用于列表行内的分布条。 */
  readonly size?: 'md' | 'sm'
  /** 整条的读屏描述；调用方按上下文拼成整句，不用颜色表意。 */
  readonly label: string
}>()

const sizeClass = computed(() => (props.size === 'sm' ? 'h-2' : 'h-2.5'))

/** 占比为 0 的段没有可视宽度，画出来只会剩一条保底色块，误导成分项存在用量。 */
const visibleSegments = computed(() => props.segments.filter(segment => segment.percent > 0))

/**
 * 轨道用 fr 而不是百分比宽度：占比之和恒为 100，用 fr 后整条宽度只取决于容器，
 * 不再依赖百分比在 flex 子项上的解析（列表行里曾因此只画出约行宽 15% 的条）。
 * minmax 的 2px 下限让极小分项仍有一条可见边，不会被相邻段吞掉。
 */
const columns = computed(() => visibleSegments.value
  .map(segment => `minmax(2px, ${segment.percent}fr)`)
  .join(' '))
</script>

<template>
  <div
    v-if="visibleSegments.length > 0"
    class="grid w-full overflow-hidden rounded-full bg-desk-canvas-sunken"
    :class="sizeClass"
    :style="{ gridTemplateColumns: columns }"
    role="img"
    :aria-label="label"
  >
    <div
      v-for="(segment, index) in visibleSegments"
      :key="segment.key"
      class="h-full"
      :style="{
        backgroundColor: segment.color,
        boxShadow: index < visibleSegments.length - 1
          ? 'inset -1px 0 0 0 var(--color-desk-surface)'
          : 'none'
      }"
      :title="`${segment.label}：${segment.value}（${segment.share}）`"
    ></div>
  </div>
</template>
