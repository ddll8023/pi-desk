<!-- 图表：把分类数据点交给 chart-geometry 算出柱或折线，再交给共用的图元渲染器。
     只画单序列、不做交互与动画；刻度取整与坐标映射都在几何层收口，这里不碰数学。
     图表不绑定参数：数据是静态事实，需要随参数变化时用 diagram，而不是把图表变成计算器。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { GenuiChartNode } from '../../../../shared/genui-api'
import { layoutBarChart, layoutLineChart } from '../../genui/chart-geometry'
import { SVG_CANVAS_WIDTH } from '../../genui/svg-shapes'
import type { SvgLayout } from '../../genui/svg-shapes'
import GenuiSvgShapes from './GenuiSvgShapes.vue'

const props = defineProps<{
  readonly node: GenuiChartNode
}>()

const layout = computed<SvgLayout>(() => (
  props.node.kind === 'bar'
    ? layoutBarChart(props.node.points, props.node.unit)
    : layoutLineChart(props.node.points, props.node.unit)
))

/** 无障碍说明：标题（若有）+ 图表种类 + 结论。 */
const ariaLabel = computed(() => {
  const kindText = props.node.kind === 'bar' ? '柱状图' : '折线图'
  const title = props.node.title === undefined ? '' : `${props.node.title}，`
  return `${title}${kindText}：${layout.value.notes.join('；')}`
})
</script>

<template>
  <section class="genui-chart" :aria-label="node.title ?? (node.kind === 'bar' ? '柱状图' : '折线图')">
    <h4 v-if="node.title !== undefined" class="genui-chart-title">{{ node.title }}</h4>
    <GenuiSvgShapes
      :shapes="layout.shapes"
      :width="SVG_CANVAS_WIDTH"
      :height="layout.height"
      :aria-label="ariaLabel"
      :caption="node.caption"
      :notes="layout.notes"
    />
  </section>
</template>
